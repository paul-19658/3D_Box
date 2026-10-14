/**
 * AI 接入配置的数据模型与校验。
 *
 * 这些配置会以本地“环境文件”的形式保存在用户电脑中（默认位于应用数据目录下的
 * `ai-environment.json`），其中包含用户自行填写的接口地址与密钥。该文件不会上传，
 * 仅在用户本机使用。
 */

import { AI_SCENE_COMMAND_SCHEMA_HINT } from './ai-scene-commands'

export const AI_SETTINGS_VERSION = 1 as const
export const AI_ENVIRONMENT_FILE_NAME = 'ai-environment.json'
export const AI_ENVIRONMENT_SCHEMA_VERSION = 1 as const

/** 目前支持的接口风格。 */
export const AI_PROVIDER_KINDS = ['openai', 'openai-compatible', 'anthropic', 'custom'] as const
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number]

export const AI_PROVIDER_KIND_LABELS: Record<AiProviderKind, string> = {
  openai: 'OpenAI 官方',
  'openai-compatible': 'OpenAI 兼容接口',
  anthropic: 'Anthropic 官方',
  custom: '自定义（高级）'
}

export interface AiProviderConfig {
  id: string
  name: string
  kind: AiProviderKind
  /** 接口根地址，例如 https://api.openai.com/v1 */
  baseUrl: string
  /** 接口密钥。保存在本机环境文件中，不会上传。 */
  apiKey: string
  /** 模型名称，例如 gpt-4o-mini、claude-3-5-sonnet-latest。 */
  model: string
  /** 采样温度，0-2。 */
  temperature: number
  /** 单次回复的最大 token 数。 */
  maxTokens: number
}

export interface AiSettings {
  version: typeof AI_SETTINGS_VERSION
  /** 当前使用的接口配置。 */
  activeProviderId: string | null
  providers: AiProviderConfig[]
  /** 发送给模型的系统提示，用于约束“搭建场景”的行为。 */
  systemPrompt: string
}

/** 当接口地址留空时，按接口风格使用的默认地址。 */
export const AI_DEFAULT_BASE_URLS: Record<AiProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  custom: ''
}

/** 当模型名称留空时，按接口风格使用的默认模型。 */
export const AI_DEFAULT_MODELS: Record<AiProviderKind, string> = {
  openai: 'gpt-4o-mini',
  'openai-compatible': 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
  custom: ''
}

export const AI_DEFAULT_SYSTEM_PROMPT = [
  '你是“小白盒”可执行场景搭建助手。小白盒用基础体（方块、圆柱、球体、墙体、地面）、人台和摄影机快速表达空间。',
  '用户用自然语言描述画面后，你必须输出可被软件自动执行的 JSON 命令；软件会直接改场景，用户可用撤销回退。',
  '用户也可能附带参考图：请结合文字与图片理解构图、站位与镜头，再输出搭建命令。',
  '软件会在首次搭建后截取摄影机画面再请你复核一次：若合格只回复 ok；若需修正再输出 JSON 命令。',
  '回答要求：',
  '1. 用简体中文先写一两句说明将要搭建什么。',
  '2. 紧接着输出严格合法的 JSON 代码块（数字用阿拉伯数字，如 50 不要 fifty；双引号；无尾随逗号）；不要只给文字步骤却不给 JSON。',
  '3. 用户说“生成/搭建/布置…场景”时，第一条命令必须是 clear_scene，避免叠在旧物体上。',
  '4. 坐标单位是米，旋转单位是度。人台围坐用 presetId "sit"，沿圆布置并朝向中心；可用矮 box 当桌子。',
  '5. 避免穿模：人台不要插进地面/墙/桌；物体之间留空隙；坐姿人台与桌面保持合理间距。',
  '6. 跑步/走路必须用 animate_move 产生位移；仅 run/walk 姿势是原地摆拍。跟拍：cameraFollow:true 或 {"mode":"orbit","orbitDegrees":360} 等。',
  '7. 复核阶段优先检查穿模；合格只回复 ok；需修正则给 JSON，不要再 clear_scene 除非必须重建。',
  '8. 不要闲聊，不要声称已经操作却不给 JSON（复核通过的 ok 除外）。',
  '',
  AI_SCENE_COMMAND_SCHEMA_HINT
].join('\n')

export function createDefaultProvider(
  kind: AiProviderKind = 'openai',
  id = 'default-provider'
): AiProviderConfig {
  return {
    id,
    name: kind === 'custom' ? '自定义接口' : AI_PROVIDER_KIND_LABELS[kind],
    kind,
    baseUrl: AI_DEFAULT_BASE_URLS[kind],
    apiKey: '',
    model: AI_DEFAULT_MODELS[kind],
    temperature: 0.7,
    maxTokens: 2048
  }
}

export function createDefaultAiSettings(): AiSettings {
  return {
    version: AI_SETTINGS_VERSION,
    activeProviderId: 'default-provider',
    providers: [createDefaultProvider()],
    systemPrompt: AI_DEFAULT_SYSTEM_PROMPT
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function trimString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(value, min), max)
}

function isProviderKind(value: unknown): value is AiProviderKind {
  return typeof value === 'string' && (AI_PROVIDER_KINDS as readonly string[]).includes(value)
}

/** 把任意输入规范化成合法的接口配置，无法修复时返回 null。 */
export function normalizeProviderConfig(value: unknown): AiProviderConfig | null {
  if (!isRecord(value)) return null
  const id = trimString(value.id)
  const kind = isProviderKind(value.kind) ? value.kind : null
  if (!id || !kind) return null
  const name = trimString(value.name) ?? AI_PROVIDER_KIND_LABELS[kind]
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return {
    id: id.slice(0, 120),
    name: name.slice(0, 120),
    kind,
    baseUrl: baseUrl.slice(0, 500),
    apiKey: apiKey.slice(0, 4000),
    model: model.slice(0, 200),
    temperature: clampNumber(value.temperature, 0.7, 0, 2),
    maxTokens: Math.round(clampNumber(value.maxTokens, 2048, 1, 128000))
  }
}

/**
 * 校验并规范化 AI 设置。用于读取本地环境文件。
 * 无效的整体结构会抛出错误；单个接口配置无效时会被跳过。
 */
export function parseAiSettings(value: unknown): AiSettings {
  if (!isRecord(value)) throw new Error('AI 设置不是有效对象。')
  if (value.version !== AI_SETTINGS_VERSION) throw new Error('AI 设置版本不受支持。')
  if (!Array.isArray(value.providers)) throw new Error('AI 设置缺少接口列表。')
  const providers = value.providers
    .map(normalizeProviderConfig)
    .filter((provider): provider is AiProviderConfig => provider !== null)
    .slice(0, 20)
  if (providers.length === 0) throw new Error('AI 设置至少需要一个有效接口。')
  const providerIds = new Set(providers.map((provider) => provider.id))
  const activeProviderId =
    typeof value.activeProviderId === 'string' && providerIds.has(value.activeProviderId)
      ? value.activeProviderId
      : providers[0].id
  const systemPrompt =
    typeof value.systemPrompt === 'string' && value.systemPrompt.trim().length > 0
      ? value.systemPrompt.slice(0, 20000)
      : AI_DEFAULT_SYSTEM_PROMPT
  return {
    version: AI_SETTINGS_VERSION,
    activeProviderId,
    providers,
    systemPrompt
  }
}

/** 尽最大努力把输入变成可用的设置，失败时回退到默认值。 */
export function coerceAiSettings(value: unknown): AiSettings {
  try {
    return parseAiSettings(value)
  } catch {
    return createDefaultAiSettings()
  }
}

export function findActiveProvider(settings: AiSettings): AiProviderConfig | null {
  const id = settings.activeProviderId
  if (!id) return settings.providers[0] ?? null
  return settings.providers.find((provider) => provider.id === id) ?? settings.providers[0] ?? null
}

/** 判断当前配置是否足以发起请求。 */
export function isAiConfigured(settings: AiSettings): boolean {
  const provider = findActiveProvider(settings)
  if (!provider) return false
  if (provider.kind === 'custom') return true
  return provider.apiKey.trim().length > 0
}

export function describeProvider(provider: AiProviderConfig): string {
  const model = provider.model || AI_DEFAULT_MODELS[provider.kind] || '未指定模型'
  return `${provider.name} · ${model}`
}
