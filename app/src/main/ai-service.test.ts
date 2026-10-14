import { describe, expect, it, vi } from 'vitest'
import type { AiChatRequest } from '../shared/desktop-api'
import { createDefaultAiSettings, type AiSettings } from '../shared/ai-settings'
import {
  describeProviderProblem,
  extractAiContent,
  prepareAiRequest,
  requestAiChat
} from './ai-service'

function settingsWith(overrides: Partial<AiSettings['providers'][number]> = {}): AiSettings {
  const settings = createDefaultAiSettings()
  settings.providers[0] = { ...settings.providers[0], apiKey: 'sk-test', ...overrides }
  return settings
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const request: AiChatRequest = { messages: [{ role: 'user', content: '搭一个房间' }] }

describe('ai-service', () => {
  it('OpenAI 风格请求包含系统提示与用户消息', () => {
    const prepared = prepareAiRequest(settingsWith(), settingsWith().providers[0], {
      messages: [{ role: 'user', content: '搭一个房间' }],
      sceneSummary: '当前有 0 个物体'
    })
    expect(prepared.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(prepared.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(prepared.body) as {
      messages: Array<{ role: string; content: string }>
      model: string
    }
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[0].content).toContain('当前有 0 个物体')
    expect(body.messages[0].content).toContain('clear_scene')
    expect(body.messages[0].content).toContain('animate_move')
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '搭一个房间' })
  })

  it('旧版 systemPrompt 含 clear_scene 时仍注入 animate_move 能力', () => {
    const settings = settingsWith()
    settings.systemPrompt = [
      '你是助手。',
      '可用 clear_scene / add_mannequin / set_camera。',
      '不要声称支持动画。'
    ].join('\n')
    const prepared = prepareAiRequest(settings, settings.providers[0], {
      messages: [{ role: 'user', content: '一个人跑步侧面跟拍' }]
    })
    const body = JSON.parse(prepared.body) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[0].content).toContain('animate_move')
    expect(body.messages[0].content).toContain('cameraFollow')
    expect(body.messages[0].content).toContain('能力提醒')
  })

  it('Anthropic 风格使用 messages 接口与系统参数', () => {
    const settings = settingsWith({
      kind: 'anthropic',
      baseUrl: '',
      model: 'claude-3-5-sonnet-latest'
    })
    const prepared = prepareAiRequest(settings, settings.providers[0], request)
    expect(prepared.url).toBe('https://api.anthropic.com/v1/messages')
    expect(prepared.headers['x-api-key']).toBe('sk-test')
    const body = JSON.parse(prepared.body) as {
      model: string
      system: string
      messages: Array<{ role: string }>
    }
    expect(body.model).toBe('claude-3-5-sonnet-latest')
    expect(body.system).toContain('小白盒')
    expect(body.messages).toHaveLength(1)
  })

  it('带图片时 OpenAI 用户消息使用多模态 content', () => {
    const prepared = prepareAiRequest(settingsWith(), settingsWith().providers[0], {
      messages: [
        { role: 'user', content: '搭一个房间' },
        { role: 'assistant', content: '已搭建' },
        { role: 'user', content: '请复核相机画面' }
      ],
      images: [{ mimeType: 'image/png', base64Data: 'abc123' }]
    })
    const body = JSON.parse(prepared.body) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const last = body.messages.at(-1)
    expect(last?.role).toBe('user')
    expect(Array.isArray(last?.content)).toBe(true)
    const parts = last?.content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts.some((part) => part.type === 'text')).toBe(true)
    expect(parts.some((part) => part.type === 'image_url')).toBe(true)
    expect(parts.find((part) => part.type === 'image_url')?.image_url?.url).toContain(
      'data:image/png;base64,abc123'
    )
  })

  it('带图片时 Anthropic 用户消息包含 image block', () => {
    const settings = settingsWith({ kind: 'anthropic', baseUrl: '' })
    const prepared = prepareAiRequest(settings, settings.providers[0], {
      messages: [{ role: 'user', content: '请复核' }],
      images: [{ mimeType: 'image/jpeg', base64Data: 'xyz' }]
    })
    const body = JSON.parse(prepared.body) as {
      messages: Array<{ role: string; content: unknown }>
    }
    const content = body.messages[0].content as Array<{ type: string; source?: { data: string } }>
    expect(content.some((part) => part.type === 'image')).toBe(true)
    expect(content.some((part) => part.type === 'text')).toBe(true)
    expect(content.find((part) => part.type === 'image')?.source?.data).toBe('xyz')
  })

  it('解析 OpenAI 与 Anthropic 的返回内容', () => {
    const openai = settingsWith()
    expect(
      extractAiContent(openai.providers[0], {
        choices: [{ message: { content: ' 步骤一 ' } }]
      })
    ).toBe('步骤一')

    const anthropic = settingsWith({ kind: 'anthropic' })
    expect(
      extractAiContent(anthropic.providers[0], {
        content: [{ text: '步骤一' }, { text: '步骤二' }]
      })
    ).toBe('步骤一步骤二')
  })

  it('缺少密钥时给出明确提示', () => {
    const settings = settingsWith({ apiKey: '' })
    expect(describeProviderProblem(settings.providers[0])).toContain('密钥')
  })

  it('缺少接口地址时给出明确提示', () => {
    const settings = settingsWith({ kind: 'custom', baseUrl: '   ' })
    expect(describeProviderProblem(settings.providers[0])).toContain('地址')
  })

  it('成功调用返回内容', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: '先放一个地面' } }] })
    )
    const result = await requestAiChat(settingsWith(), request, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(result).toEqual({ status: 'ok', content: '先放一个地面' })
  })

  it('接口返回错误状态时带出原因', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: '额度不足' } }, 429))
    const result = await requestAiChat(settingsWith(), request, new AbortController().signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toContain('429')
    expect(result.message).toContain('额度不足')
  })

  it('请求被取消时返回 cancelled', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })
    const result = await requestAiChat(settingsWith(), request, controller.signal, {
      fetchImpl: fetchImpl as unknown as typeof fetch
    })
    expect(result.status).toBe('cancelled')
  })

  it('空消息不发请求', async () => {
    const fetchImpl = vi.fn()
    const result = await requestAiChat(
      settingsWith(),
      { messages: [{ role: 'user', content: '   ' }] },
      new AbortController().signal,
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    )
    expect(result.status).toBe('error')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
