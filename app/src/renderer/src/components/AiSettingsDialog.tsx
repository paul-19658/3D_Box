import { KeyRound, Plus, Settings, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  AI_DEFAULT_BASE_URLS,
  AI_DEFAULT_MODELS,
  AI_PROVIDER_KINDS,
  AI_PROVIDER_KIND_LABELS,
  createDefaultAiSettings,
  createDefaultProvider,
  isAiConfigured,
  type AiProviderConfig,
  type AiProviderKind,
  type AiSettings
} from '../../../shared/ai-settings'

/**
 * AI 设置对话框：编辑接口地址、密钥、模型与系统提示。
 * 配置会保存到用户电脑上的本地环境文件，不会上传。
 */

interface AiSettingsDialogProps {
  onClose: () => void
  onSaved: (settings: AiSettings, filePath: string) => void
}

function createId(): string {
  return globalThis.crypto.randomUUID()
}

export default function AiSettingsDialog({
  onClose,
  onSaved
}: AiSettingsDialogProps): React.JSX.Element {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [filePath, setFilePath] = useState<string>('')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    void window.desktopApi.ai.loadSettings().then((result) => {
      if (!active) return
      if (result.status === 'loaded') {
        setSettings(result.settings)
        setFilePath(result.filePath)
      } else {
        setLoadError(result.message)
        setSettings(createDefaultAiSettings())
      }
    })
    return () => {
      active = false
    }
  }, [])

  const activeProvider =
    settings?.providers.find((provider) => provider.id === settings.activeProviderId) ??
    settings?.providers[0] ??
    null

  const updateProvider = (id: string, patch: Partial<AiProviderConfig>): void => {
    setSettings((current) =>
      current
        ? {
            ...current,
            providers: current.providers.map((provider) =>
              provider.id === id ? { ...provider, ...patch } : provider
            )
          }
        : current
    )
  }

  const changeProviderKind = (id: string, kind: AiProviderKind): void => {
    setSettings((current) =>
      current
        ? {
            ...current,
            providers: current.providers.map((provider) => {
              if (provider.id !== id) return provider
              const baseUrl = provider.baseUrl.trim()
              const model = provider.model.trim()
              return {
                ...provider,
                kind,
                baseUrl: baseUrl.length > 0 ? baseUrl : AI_DEFAULT_BASE_URLS[kind],
                model: model.length > 0 ? model : AI_DEFAULT_MODELS[kind]
              }
            })
          }
        : current
    )
  }

  const addProvider = (): void => {
    setSettings((current) => {
      if (!current) return current
      const provider = createDefaultProvider('openai-compatible', createId())
      return {
        ...current,
        providers: [...current.providers, provider],
        activeProviderId: current.activeProviderId ?? provider.id
      }
    })
  }

  const removeProvider = (id: string): void => {
    setSettings((current) => {
      if (!current || current.providers.length <= 1) return current
      const providers = current.providers.filter((provider) => provider.id !== id)
      return {
        ...current,
        providers,
        activeProviderId:
          current.activeProviderId === id ? providers[0].id : current.activeProviderId
      }
    })
  }

  const save = async (): Promise<void> => {
    if (!settings) return
    setSaving(true)
    setSaveError(null)
    const result = await window.desktopApi.ai.saveSettings({ settings })
    setSaving(false)
    if (result.status === 'loaded') {
      onSaved(result.settings, result.filePath)
      onClose()
    } else {
      setSaveError(result.message)
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="ai-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-settings-title"
      >
        <header className="dialog-panel-header">
          <div>
            <span>保存在本机环境文件，不会上传</span>
            <h2 id="ai-settings-title">AI 接入设置</h2>
          </div>
          <button type="button" aria-label="关闭设置" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        {settings === null ? (
          <p className="ai-panel-note">正在读取本地环境文件…</p>
        ) : (
          <>
            {loadError ? <p className="ai-panel-error">{loadError}</p> : null}

            <div className="ai-settings-body">
              <section className="ai-settings-section">
                <div className="ai-settings-heading">
                  <h3>接口</h3>
                  <button type="button" onClick={addProvider}>
                    <Plus aria-hidden="true" />
                    添加接口
                  </button>
                </div>
                <div className="ai-provider-list" role="radiogroup" aria-label="选择要使用的接口">
                  {settings.providers.map((provider) => (
                    <label
                      key={provider.id}
                      className={`ai-provider-item${
                        settings.activeProviderId === provider.id ? ' is-active' : ''
                      }`}
                    >
                      <input
                        type="radio"
                        name="ai-active-provider"
                        checked={settings.activeProviderId === provider.id}
                        onChange={() => setSettings({ ...settings, activeProviderId: provider.id })}
                      />
                      <span>{provider.name}</span>
                      <small>
                        {isAiConfigured({ ...settings, activeProviderId: provider.id })
                          ? '已配置'
                          : '缺少密钥'}
                      </small>
                      <button
                        type="button"
                        aria-label={`删除接口 ${provider.name}`}
                        disabled={settings.providers.length <= 1}
                        onClick={() => removeProvider(provider.id)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </label>
                  ))}
                </div>
              </section>

              {activeProvider ? (
                <section className="ai-settings-section">
                  <div className="ai-settings-heading">
                    <h3>当前接口</h3>
                    <span>
                      <KeyRound aria-hidden="true" />
                      密钥只保存在本机
                    </span>
                  </div>
                  <div className="ai-field-grid">
                    <label>
                      <span>名称</span>
                      <input
                        type="text"
                        value={activeProvider.name}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { name: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>接口风格</span>
                      <select
                        value={activeProvider.kind}
                        onChange={(event) =>
                          changeProviderKind(
                            activeProvider.id,
                            event.target.value as AiProviderKind
                          )
                        }
                      >
                        {AI_PROVIDER_KINDS.map((kind) => (
                          <option key={kind} value={kind}>
                            {AI_PROVIDER_KIND_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="ai-field-wide">
                      <span>接口地址</span>
                      <input
                        type="text"
                        spellCheck={false}
                        placeholder={
                          AI_DEFAULT_BASE_URLS[activeProvider.kind] || 'https://example.com/v1'
                        }
                        value={activeProvider.baseUrl}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { baseUrl: event.target.value })
                        }
                      />
                    </label>
                    <label className="ai-field-wide">
                      <span>接口密钥</span>
                      <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="sk-..."
                        value={activeProvider.apiKey}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { apiKey: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>模型</span>
                      <input
                        type="text"
                        spellCheck={false}
                        placeholder={AI_DEFAULT_MODELS[activeProvider.kind] || 'model-name'}
                        value={activeProvider.model}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, { model: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>温度 {activeProvider.temperature.toFixed(1)}</span>
                      <input
                        type="range"
                        min={0}
                        max={2}
                        step={0.1}
                        value={activeProvider.temperature}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, {
                            temperature: Number(event.target.value)
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>最大回复长度</span>
                      <input
                        type="number"
                        min={1}
                        max={128000}
                        step={1}
                        value={activeProvider.maxTokens}
                        onChange={(event) =>
                          updateProvider(activeProvider.id, {
                            maxTokens: Number(event.target.value)
                          })
                        }
                      />
                    </label>
                  </div>
                </section>
              ) : null}

              <section className="ai-settings-section">
                <div className="ai-settings-heading">
                  <h3>系统提示</h3>
                  <span>约束 AI 如何帮你搭场景</span>
                </div>
                <label className="ai-field-wide">
                  <span>发送给模型的系统提示</span>
                  <textarea
                    rows={8}
                    value={settings.systemPrompt}
                    onChange={(event) =>
                      setSettings({ ...settings, systemPrompt: event.target.value })
                    }
                  />
                </label>
              </section>
            </div>

            <footer className="ai-settings-footer">
              <div className="ai-settings-path" title={filePath}>
                <Settings aria-hidden="true" />
                <span>{filePath || '本地环境文件'}</span>
              </div>
              {saveError ? <p className="ai-panel-error">{saveError}</p> : null}
              <div className="dialog-actions">
                <button className="secondary" type="button" onClick={onClose}>
                  取消
                </button>
                <button type="button" disabled={saving} onClick={() => void save()}>
                  {saving ? '保存中…' : '保存设置'}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>
  )
}
