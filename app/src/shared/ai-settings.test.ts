import { describe, expect, it } from 'vitest'
import {
  AI_DEFAULT_BASE_URLS,
  AI_DEFAULT_MODELS,
  AI_DEFAULT_SYSTEM_PROMPT,
  coerceAiSettings,
  createDefaultAiSettings,
  createDefaultProvider,
  findActiveProvider,
  isAiConfigured,
  normalizeProviderConfig,
  parseAiSettings
} from './ai-settings'

describe('ai-settings', () => {
  it('默认设置包含一个可用的接口配置', () => {
    const settings = createDefaultAiSettings()
    expect(settings.version).toBe(1)
    expect(settings.providers).toHaveLength(1)
    expect(settings.activeProviderId).toBe(settings.providers[0].id)
    expect(settings.systemPrompt).toBe(AI_DEFAULT_SYSTEM_PROMPT)
  })

  it('默认接口按接口风格给出地址与模型', () => {
    const provider = createDefaultProvider('anthropic')
    expect(provider.baseUrl).toBe(AI_DEFAULT_BASE_URLS.anthropic)
    expect(provider.model).toBe(AI_DEFAULT_MODELS.anthropic)
  })

  it('规范化会裁剪空白并限制取值范围', () => {
    const provider = normalizeProviderConfig({
      id: '  demo  ',
      kind: 'openai',
      name: '   ',
      baseUrl: '  https://api.example.com/v1  ',
      apiKey: '  sk-test  ',
      model: '  gpt-4o  ',
      temperature: 9,
      maxTokens: -5
    })
    expect(provider).not.toBeNull()
    expect(provider?.id).toBe('demo')
    expect(provider?.name).toBe('OpenAI 官方')
    expect(provider?.baseUrl).toBe('https://api.example.com/v1')
    expect(provider?.apiKey).toBe('  sk-test  ')
    expect(provider?.model).toBe('gpt-4o')
    expect(provider?.temperature).toBe(2)
    expect(provider?.maxTokens).toBe(1)
  })

  it('拒绝缺少 id 或非法接口风格的配置', () => {
    expect(normalizeProviderConfig({ kind: 'openai' })).toBeNull()
    expect(normalizeProviderConfig({ id: 'x', kind: 'unknown' })).toBeNull()
    expect(normalizeProviderConfig(null)).toBeNull()
  })

  it('解析时修正失效的当前接口并回退系统提示', () => {
    const settings = parseAiSettings({
      version: 1,
      activeProviderId: 'missing',
      systemPrompt: '   ',
      providers: [{ id: 'a', kind: 'openai' }]
    })
    expect(settings.activeProviderId).toBe('a')
    expect(settings.systemPrompt).toBe(AI_DEFAULT_SYSTEM_PROMPT)
  })

  it('解析会跳过无效接口但在全部无效时抛错', () => {
    const settings = parseAiSettings({
      version: 1,
      activeProviderId: 'valid',
      providers: [{ id: 'valid', kind: 'openai' }, { kind: 'openai' }]
    })
    expect(settings.providers).toHaveLength(1)
    expect(() => parseAiSettings({ version: 1, providers: [] })).toThrow()
    expect(() => parseAiSettings({ version: 2, providers: [] })).toThrow()
  })

  it('coerceAiSettings 在结构损坏时回退默认值', () => {
    expect(coerceAiSettings(undefined).providers).toHaveLength(1)
    expect(coerceAiSettings({ version: 99 }).providers).toHaveLength(1)
  })

  it('识别当前接口与是否已配置密钥', () => {
    const settings = createDefaultAiSettings()
    const provider = findActiveProvider(settings)
    expect(provider?.id).toBe('default-provider')
    expect(isAiConfigured(settings)).toBe(false)
    settings.providers[0].apiKey = 'sk-live'
    expect(isAiConfigured(settings)).toBe(true)
  })
})
