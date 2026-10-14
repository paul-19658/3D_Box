import { describe, expect, it, vi } from 'vitest'
import { createDefaultAiSettings } from '../shared/ai-settings'
import {
  loadAiEnvironment,
  saveAiEnvironment,
  type AiEnvironmentDependencies,
  type AiEnvironmentLocations
} from './ai-config-service'

const locations: AiEnvironmentLocations = {
  settingsFilePath: 'C:\\UserData\\ai-environment.json'
}

function createMemoryDependencies(seed?: string): {
  dependencies: AiEnvironmentDependencies
  files: Map<string, string>
  writeFileAtomic: ReturnType<typeof vi.fn>
} {
  const files = new Map<string, string>()
  if (seed !== undefined) files.set(locations.settingsFilePath, seed)
  const writeFileAtomic = vi.fn(async (filePath: string, data: string) => {
    files.set(filePath, data)
  })
  return {
    files,
    writeFileAtomic,
    dependencies: {
      readOptionalFile: async (filePath) => files.get(filePath) ?? null,
      writeFileAtomic,
      now: () => new Date('2026-10-10T08:00:00.000Z')
    }
  }
}

describe('ai-config-service', () => {
  it('文件不存在时返回带默认值的结果', async () => {
    const { dependencies } = createMemoryDependencies()
    const result = await loadAiEnvironment(locations, dependencies)
    expect(result.status).toBe('loaded')
    if (result.status !== 'loaded') return
    expect(result.fileExists).toBe(false)
    expect(result.filePath).toBe(locations.settingsFilePath)
    expect(result.settings.providers).toHaveLength(1)
  })

  it('保存后可以重新读取同样的配置', async () => {
    const { dependencies, files } = createMemoryDependencies()
    const settings = createDefaultAiSettings()
    settings.providers[0].apiKey = 'sk-secret'
    settings.providers[0].model = 'gpt-4o'
    const saved = await saveAiEnvironment({ settings }, locations, dependencies)
    expect(saved.status).toBe('loaded')
    expect(files.get(locations.settingsFilePath)).toContain('sk-secret')

    const loaded = await loadAiEnvironment(locations, dependencies)
    expect(loaded.status).toBe('loaded')
    if (loaded.status !== 'loaded') return
    expect(loaded.settings.providers[0].apiKey).toBe('sk-secret')
    expect(loaded.settings.providers[0].model).toBe('gpt-4o')
  })

  it('保存的密钥不会被裁剪空白以外的内容', async () => {
    const { dependencies } = createMemoryDependencies()
    const settings = createDefaultAiSettings()
    settings.providers[0].apiKey = 'sk-with  space'
    await saveAiEnvironment({ settings }, locations, dependencies)
    const loaded = await loadAiEnvironment(locations, dependencies)
    if (loaded.status !== 'loaded') throw new Error('expected loaded')
    expect(loaded.settings.providers[0].apiKey).toBe('sk-with  space')
  })

  it('遇到损坏的 JSON 时返回错误', async () => {
    const { dependencies } = createMemoryDependencies('{ not json')
    const result = await loadAiEnvironment(locations, dependencies)
    expect(result.status).toBe('error')
  })

  it('遇到不支持的版本时返回错误', async () => {
    const { dependencies } = createMemoryDependencies(
      JSON.stringify({ schemaVersion: 99, settings: createDefaultAiSettings() })
    )
    const result = await loadAiEnvironment(locations, dependencies)
    expect(result.status).toBe('error')
  })

  it('保存时会拒绝无效配置', async () => {
    const { dependencies, writeFileAtomic } = createMemoryDependencies()
    const settings = createDefaultAiSettings()
    settings.providers = []
    const result = await saveAiEnvironment({ settings }, locations, dependencies)
    expect(result.status).toBe('error')
    expect(writeFileAtomic).not.toHaveBeenCalled()
  })
})
