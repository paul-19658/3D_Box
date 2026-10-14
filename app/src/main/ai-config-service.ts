import type { AiSettingsResult, SaveAiSettingsRequest } from '../shared/desktop-api'
import {
  AI_ENVIRONMENT_SCHEMA_VERSION,
  createDefaultAiSettings,
  parseAiSettings
} from '../shared/ai-settings'

/**
 * 本地“环境文件”的位置。文件默认放在应用数据目录下，保存用户填写的接口地址与密钥。
 */
export interface AiEnvironmentLocations {
  settingsFilePath: string
}

export interface AiEnvironmentDependencies {
  readOptionalFile: (filePath: string) => Promise<string | null>
  writeFileAtomic: (filePath: string, data: string) => Promise<void>
  now: () => Date
}

interface AiEnvironmentFile {
  schemaVersion: number
  savedAt: string
  settings: unknown
}

function settingsError(prefix: string, error: unknown): AiSettingsResult {
  const detail = error instanceof Error ? error.message : '未知错误'
  return { status: 'error', message: `${prefix}：${detail}` }
}

/**
 * 读取本地环境文件。文件不存在时返回带默认值的结果，方便首次使用。
 */
export async function loadAiEnvironment(
  locations: AiEnvironmentLocations,
  dependencies: AiEnvironmentDependencies
): Promise<AiSettingsResult> {
  try {
    const source = await dependencies.readOptionalFile(locations.settingsFilePath)
    if (source === null) {
      return {
        status: 'loaded',
        settings: createDefaultAiSettings(),
        filePath: locations.settingsFilePath,
        fileExists: false
      }
    }
    const parsed = JSON.parse(source) as Partial<AiEnvironmentFile>
    if (parsed.schemaVersion !== AI_ENVIRONMENT_SCHEMA_VERSION) {
      throw new Error('环境文件版本不受支持')
    }
    const settings = parseAiSettings(parsed.settings)
    return {
      status: 'loaded',
      settings,
      filePath: locations.settingsFilePath,
      fileExists: true
    }
  } catch (error) {
    return settingsError('无法读取 AI 环境文件', error)
  }
}

/**
 * 校验并写入本地环境文件。写入前会强制规范化，避免写入无效内容。
 */
export async function saveAiEnvironment(
  request: SaveAiSettingsRequest,
  locations: AiEnvironmentLocations,
  dependencies: AiEnvironmentDependencies
): Promise<AiSettingsResult> {
  try {
    const settings = parseAiSettings(request.settings)
    const file: AiEnvironmentFile = {
      schemaVersion: AI_ENVIRONMENT_SCHEMA_VERSION,
      savedAt: dependencies.now().toISOString(),
      settings
    }
    await dependencies.writeFileAtomic(
      locations.settingsFilePath,
      `${JSON.stringify(file, null, 2)}\n`
    )
    return {
      status: 'loaded',
      settings,
      filePath: locations.settingsFilePath,
      fileExists: true
    }
  } catch (error) {
    return settingsError('无法保存 AI 环境文件', error)
  }
}
