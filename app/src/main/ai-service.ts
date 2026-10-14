import type { AiChatImageAttachment, AiChatRequest, AiChatResult } from '../shared/desktop-api'
import { AI_SCENE_COMMAND_SCHEMA_HINT } from '../shared/ai-scene-commands'
import {
  AI_DEFAULT_BASE_URLS,
  AI_DEFAULT_MODELS,
  findActiveProvider,
  type AiProviderConfig,
  type AiSettings
} from '../shared/ai-settings'

/**
 * 实际发起 AI 请求的服务。支持 OpenAI 风格（含各类兼容接口）与 Anthropic 风格。
 * 网络请求只会在用户主动发送消息时发生，并且只访问用户自行配置的地址。
 */

export interface AiChatDependencies {
  fetchImpl: typeof fetch
}

interface PreparedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

type OpenAiTextPart = { type: 'text'; text: string }
type OpenAiImagePart = { type: 'image_url'; image_url: { url: string } }
type OpenAiContent = string | Array<OpenAiTextPart | OpenAiImagePart>

type AnthropicTextPart = { type: 'text'; text: string }
type AnthropicImagePart = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}
type AnthropicContent = string | Array<AnthropicTextPart | AnthropicImagePart>

function resolveBaseUrl(provider: AiProviderConfig): string {
  const base = provider.baseUrl.trim() || AI_DEFAULT_BASE_URLS[provider.kind]
  return base.replace(/\/+$/, '')
}

/**
 * 返回当前接口配置不可用的原因；配置可用时返回 null。
 */
export function describeProviderProblem(provider: AiProviderConfig | null): string | null {
  if (!provider) return '还没有可用的 AI 接口，请先在设置中添加。'
  if (!resolveBaseUrl(provider)) return '接口地址为空，请在设置中填写。'
  if (provider.kind !== 'custom' && provider.apiKey.trim().length === 0) {
    return '还没有填写接口密钥，请在设置中补充。'
  }
  return null
}

function resolveModel(provider: AiProviderConfig): string {
  return provider.model.trim() || AI_DEFAULT_MODELS[provider.kind]
}

function composeUserPrompt(request: AiChatRequest): string {
  const summary = request.sceneSummary?.trim()
  if (!summary) return ''
  return `当前场景概况：\n${summary}`
}

/** 旧版本机 systemPrompt 常含 clear_scene 却缺少 animate_move，不能据此跳过 schema。 */
function needsLatestCommandSchema(prompt: string): boolean {
  return !prompt.includes('animate_move')
}

const AI_MOTION_CAPABILITY_HINT = [
  '【能力提醒·必须遵守】',
  '- 软件已支持时间轴位移与镜头跟拍。',
  '- 跑步/走路/移动：禁止只用 run/walk 姿势原地摆拍，也禁止用多个静止人台“假装”轨迹。',
  '- 必须输出 animate_move；跟拍：cameraFollow:true（侧面），或 {"mode":"orbit","orbitDegrees":360,"radius":5}（360 环绕），或 {"mode":"chase"} / {"mode":"front"}。',
  '- path 至少 2 个点。',
  '- 布置时避免穿模（人/物插入地面、墙、桌或其他人）；首次画面复核会重点检查穿模。',
  '- 用户可能附带参考图：请根据参考图的构图、站位、物体关系与镜头感觉搭建白膜场景，并输出可执行 JSON。',
  '- JSON 必须可被 JSON.parse：fovDegrees 写 50 不要 fifty；不要单引号、不要尾随逗号。'
].join('\n')

function composeSystemPrompt(settings: AiSettings, request: AiChatRequest): string {
  const prompt = settings.systemPrompt.trim()
  return [
    prompt,
    AI_MOTION_CAPABILITY_HINT,
    needsLatestCommandSchema(prompt) ? AI_SCENE_COMMAND_SCHEMA_HINT : '',
    composeUserPrompt(request)
  ]
    .filter((part) => part.length > 0)
    .join('\n\n')
}

function sanitizeImages(images: AiChatImageAttachment[] | undefined): AiChatImageAttachment[] {
  if (!images || images.length === 0) return []
  return images
    .filter(
      (image) =>
        typeof image.mimeType === 'string' &&
        image.mimeType.startsWith('image/') &&
        typeof image.base64Data === 'string' &&
        image.base64Data.trim().length > 0
    )
    .slice(0, 4)
    .map((image) => ({
      mimeType: image.mimeType.trim().slice(0, 64),
      base64Data: image.base64Data.replace(/\s+/g, '').slice(0, 8_000_000)
    }))
}

function toOpenAiUserContent(text: string, images: AiChatImageAttachment[]): OpenAiContent {
  if (images.length === 0) return text
  const parts: Array<OpenAiTextPart | OpenAiImagePart> = [{ type: 'text', text }]
  for (const image of images) {
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${image.mimeType};base64,${image.base64Data}` }
    })
  }
  return parts
}

function toAnthropicUserContent(text: string, images: AiChatImageAttachment[]): AnthropicContent {
  if (images.length === 0) return text
  const parts: Array<AnthropicTextPart | AnthropicImagePart> = []
  for (const image of images) {
    parts.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mimeType,
        data: image.base64Data
      }
    })
  }
  parts.push({ type: 'text', text })
  return parts
}

function toOpenAiMessages(
  settings: AiSettings,
  request: AiChatRequest
): Array<{ role: 'system' | 'user' | 'assistant'; content: OpenAiContent }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: OpenAiContent }> = []
  const system = composeSystemPrompt(settings, request)
  if (system) messages.push({ role: 'system', content: system })
  const images = sanitizeImages(request.images)
  const lastUserIndex = [...request.messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message.role === 'user' && entry.message.content.trim().length > 0)?.index
  for (const [index, message] of request.messages.entries()) {
    const content = message.content.trim()
    if (!content) continue
    if (message.role === 'user' && index === lastUserIndex && images.length > 0) {
      messages.push({ role: 'user', content: toOpenAiUserContent(content, images) })
    } else {
      messages.push({ role: message.role, content })
    }
  }
  return messages
}

function prepareOpenAiRequest(
  settings: AiSettings,
  provider: AiProviderConfig,
  request: AiChatRequest
): PreparedRequest {
  return {
    url: `${resolveBaseUrl(provider)}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${provider.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: resolveModel(provider),
      temperature: provider.temperature,
      max_tokens: provider.maxTokens,
      messages: toOpenAiMessages(settings, request)
    })
  }
}

function prepareAnthropicRequest(
  settings: AiSettings,
  provider: AiProviderConfig,
  request: AiChatRequest
): PreparedRequest {
  const system = composeSystemPrompt(settings, request)
  const images = sanitizeImages(request.images)
  const lastUserIndex = [...request.messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find((entry) => entry.message.role === 'user' && entry.message.content.trim().length > 0)?.index
  const messages = request.messages
    .map((message, index) => {
      const content = message.content.trim()
      if (!content) return null
      if (message.role === 'user' && index === lastUserIndex && images.length > 0) {
        return { role: message.role, content: toAnthropicUserContent(content, images) }
      }
      return { role: message.role, content }
    })
    .filter((message): message is NonNullable<typeof message> => message !== null)
  return {
    url: `${resolveBaseUrl(provider)}/v1/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey.trim(),
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: resolveModel(provider),
      max_tokens: provider.maxTokens,
      temperature: provider.temperature,
      system: system || undefined,
      messages
    })
  }
}

export function prepareAiRequest(
  settings: AiSettings,
  provider: AiProviderConfig,
  request: AiChatRequest
): PreparedRequest {
  if (provider.kind === 'anthropic') {
    return prepareAnthropicRequest(settings, provider, request)
  }
  return prepareOpenAiRequest(settings, provider, request)
}

function readErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const error = record.error
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim().length > 0) return message
  }
  if (typeof record.message === 'string' && record.message.trim().length > 0) {
    return record.message
  }
  return null
}

export function extractAiContent(provider: AiProviderConfig, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (provider.kind === 'anthropic') {
    if (!Array.isArray(record.content)) return null
    const text = record.content
      .map((block) =>
        block &&
        typeof block === 'object' &&
        typeof (block as Record<string, unknown>).text === 'string'
          ? ((block as Record<string, unknown>).text as string)
          : ''
      )
      .join('')
      .trim()
    return text.length > 0 ? text : null
  }
  if (!Array.isArray(record.choices) || record.choices.length === 0) return null
  const first = record.choices[0] as Record<string, unknown> | undefined
  const message = first?.message as Record<string, unknown> | undefined
  const content = message?.content
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as Record<string, unknown>).text === 'string'
          ? ((part as Record<string, unknown>).text as string)
          : ''
      )
      .join('')
      .trim()
    return text.length > 0 ? text : null
  }
  return null
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

export async function requestAiChat(
  settings: AiSettings,
  request: AiChatRequest,
  signal: AbortSignal,
  dependencies: AiChatDependencies
): Promise<AiChatResult> {
  const provider = findActiveProvider(settings)
  const problem = describeProviderProblem(provider)
  if (!provider || problem) return { status: 'error', message: problem ?? 'AI 接口不可用。' }
  const url = normalizeUrl(prepareAiRequest(settings, provider, request).url)
  if (!url) {
    return { status: 'error', message: '接口地址为空，请在设置中填写。' }
  }
  if (request.messages.every((message) => message.content.trim().length === 0)) {
    return { status: 'error', message: '请输入内容后再发送。' }
  }

  const prepared = prepareAiRequest(settings, provider, request)
  let response: Response
  try {
    response = await dependencies.fetchImpl(url, {
      method: 'POST',
      headers: prepared.headers,
      body: prepared.body,
      signal
    })
  } catch (error) {
    if (signal.aborted) return { status: 'cancelled' }
    const detail = error instanceof Error ? error.message : '未知错误'
    return { status: 'error', message: `无法连接到 AI 接口：${detail}` }
  }

  const text = await response.text().catch(() => '')
  let payload: unknown = null
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const detail = readErrorMessage(payload) ?? text.slice(0, 300) ?? ''
    return {
      status: 'error',
      message: `AI 接口返回 ${response.status}${detail ? `：${detail}` : '。'}`
    }
  }

  const content = extractAiContent(provider, payload)
  if (!content) return { status: 'error', message: 'AI 接口没有返回可用的文字内容。' }
  return { status: 'ok', content }
}
