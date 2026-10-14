import { Bot, ImagePlus, Send, Settings, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { AiSceneCommand } from '../../../shared/ai-scene-commands'
import {
  AI_SCENE_VERIFY_USER_PROMPT,
  isAiVerificationAccepted,
  resolveAiSceneCommandsFromReply
} from '../../../shared/ai-scene-commands'
import type { AiChatImageAttachment, AiChatMessage } from '../../../shared/desktop-api'
import type { CameraState } from '../../../shared/project-document'
import { findActiveProvider, isAiConfigured, type AiSettings } from '../../../shared/ai-settings'

/**
 * AI 输入窗口：可附带参考图；自然语言搭场景后截取相机画面再复核一次。
 */

export interface AiApplyCommandsResult {
  appliedCount: number
  warnings: string[]
  camera: CameraState
  sceneSummary: string
}

export interface AiCameraCapture {
  mimeType: string
  base64Data: string
}

interface AiPanelProps {
  settings: AiSettings | null
  filePath: string
  sceneSummary: string
  onApplyCommands: (commands: AiSceneCommand[]) => AiApplyCommandsResult
  onCaptureCameraView: (camera: CameraState) => AiCameraCapture | null
  onOpenSettings: () => void
  onClose: () => void
}

interface PendingImage {
  id: string
  mimeType: string
  base64Data: string
  previewUrl: string
  name: string
}

const EXAMPLE_PROMPTS = [
  '生成5个人围坐在一起讨论的场景',
  '一个人沿跑道向前跑，镜头从侧面跟拍',
  '一个人向前走，镜头 360 度环绕他跟随'
]

const MAX_ATTACHMENTS = 4
const MAX_IMAGE_EDGE = 1280
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

type PendingPhase = 'idle' | 'building' | 'verifying'

function buildAssistantDisplay(
  prose: string,
  applyResult: AiApplyCommandsResult | null,
  parseFailed: boolean,
  suffix?: string
): string {
  const parts: string[] = []
  if (applyResult && applyResult.appliedCount > 0) {
    parts.push(`已应用到场景（${applyResult.appliedCount} 步）。可用撤销回退。`)
  } else if (parseFailed) {
    parts.push('未能生成可执行场景指令，以下为模型原文说明。')
  }
  if (prose) parts.push(prose)
  if (applyResult?.warnings.length) {
    parts.push(`注意：${applyResult.warnings.join('；')}`)
  }
  if (suffix) parts.push(suffix)
  return parts.join('\n\n') || '（无内容）'
}

async function waitForScenePaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve())
    })
  })
  await new Promise((resolve) => window.setTimeout(resolve, 120))
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片读取失败'))
    image.src = url
  })
}

async function compressImageFile(file: File): Promise<PendingImage | null> {
  const mime = ACCEPTED_TYPES.has(file.type) ? file.type : 'image/jpeg'
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await loadImageElement(objectUrl)
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.width, image.height, 1))
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(image, 0, 0, width, height)
    const outputType = mime === 'image/png' ? 'image/png' : 'image/jpeg'
    const dataUrl = canvas.toDataURL(outputType, outputType === 'image/jpeg' ? 0.85 : undefined)
    const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl)
    if (!match) return null
    return {
      id: globalThis.crypto.randomUUID(),
      mimeType: match[1],
      base64Data: match[2],
      previewUrl: dataUrl,
      name: file.name || '参考图'
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export default function AiPanel({
  settings,
  filePath,
  sceneSummary,
  onApplyCommands,
  onCaptureCameraView,
  onOpenSettings,
  onClose
}: AiPanelProps): React.JSX.Element {
  const [messages, setMessages] = useState<AiChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  const [pendingPhase, setPendingPhase] = useState<PendingPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [includeScene, setIncludeScene] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const configured = settings ? isAiConfigured(settings) : false
  const provider = settings ? findActiveProvider(settings) : null
  const pending = pendingPhase !== 'idle'
  const canSend = !pending && (draft.trim().length > 0 || pendingImages.length > 0)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, pendingPhase, pendingImages])

  const addFiles = async (files: FileList | File[]): Promise<void> => {
    const list = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (list.length === 0) {
      setError('请选择图片文件（JPG / PNG / WebP / GIF）。')
      return
    }
    setError(null)
    const room = MAX_ATTACHMENTS - pendingImages.length
    if (room <= 0) {
      setError(`最多附带 ${MAX_ATTACHMENTS} 张参考图。`)
      return
    }
    const next: PendingImage[] = []
    for (const file of list.slice(0, room)) {
      try {
        const attachment = await compressImageFile(file)
        if (attachment) next.push(attachment)
      } catch {
        // skip broken file
      }
    }
    if (next.length === 0) {
      setError('图片读取失败，请换一张再试。')
      return
    }
    setPendingImages((current) => [...current, ...next].slice(0, MAX_ATTACHMENTS))
  }

  const removePendingImage = (id: string): void => {
    setPendingImages((current) => current.filter((image) => image.id !== id))
  }

  const runVerification = async (
    conversation: AiChatMessage[],
    applyResult: AiApplyCommandsResult,
    userGoal: string
  ): Promise<void> => {
    setPendingPhase('verifying')
    await waitForScenePaint()
    const capture = onCaptureCameraView(applyResult.camera)
    if (!capture?.base64Data) {
      setMessages([
        ...conversation,
        {
          role: 'assistant',
          content: buildAssistantDisplay(
            '',
            applyResult,
            false,
            '已搭建，但未能截取相机画面，跳过复核。'
          )
        }
      ])
      return
    }

    const images: AiChatImageAttachment[] = [
      { mimeType: capture.mimeType, base64Data: capture.base64Data }
    ]
    const verifyUserContent = [
      `用户原始需求：${userGoal}`,
      AI_SCENE_VERIFY_USER_PROMPT
    ].join('\n\n')
    const verifyMessages: AiChatMessage[] = [
      ...conversation,
      { role: 'user', content: verifyUserContent }
    ]
    const verifyResult = await window.desktopApi.ai.chat({
      messages: verifyMessages,
      sceneSummary: applyResult.sceneSummary,
      images
    })

    if (verifyResult.status === 'cancelled') return
    if (verifyResult.status === 'error') {
      setMessages([
        ...conversation,
        {
          role: 'assistant',
          content: buildAssistantDisplay(
            '',
            applyResult,
            false,
            `首次搭建已完成，但复核失败：${verifyResult.message}`
          )
        }
      ])
      setError(verifyResult.message)
      return
    }

    const resolved = resolveAiSceneCommandsFromReply(verifyResult.content)
    if (resolved.commands.length > 0) {
      const fixResult = onApplyCommands(resolved.commands)
      setMessages([
        ...conversation,
        {
          role: 'assistant',
          content: buildAssistantDisplay(
            resolved.prose,
            applyResult,
            false,
            fixResult.appliedCount > 0
              ? `复核后已修正（${fixResult.appliedCount} 步）。${
                  fixResult.warnings.length ? `注意：${fixResult.warnings.join('；')}` : ''
                }`
              : '复核提出了修正，但未能应用有效命令。'
          )
        }
      ])
      return
    }

    if (isAiVerificationAccepted(verifyResult.content)) {
      setMessages([
        ...conversation,
        {
          role: 'assistant',
          content: buildAssistantDisplay(
            resolved.prose && !/^ok$/i.test(resolved.prose.trim()) ? resolved.prose : '',
            applyResult,
            false,
            '复核通过（ok）。'
          )
        }
      ])
      return
    }

    setMessages([
      ...conversation,
      {
        role: 'assistant',
        content: buildAssistantDisplay(
          resolved.prose || verifyResult.content,
          applyResult,
          false,
          '复核结束（未给出可执行修正，也未明确 ok）。'
        )
      }
    ])
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if ((!text && pendingImages.length === 0) || pending) return
    const attachments = pendingImages.map(
      (image): AiChatImageAttachment => ({
        mimeType: image.mimeType,
        base64Data: image.base64Data
      })
    )
    const content =
      text ||
      (attachments.length > 0
        ? '请根据我附带的参考图，搭建对应的白膜场景（构图、站位与镜头尽量贴近参考）。'
        : '')
    const displayContent =
      attachments.length > 0
        ? `${content}\n\n[已附带 ${attachments.length} 张参考图]`
        : content
    const nextMessages: AiChatMessage[] = [...messages, { role: 'user', content: displayContent }]
    setMessages(nextMessages)
    setDraft('')
    setPendingImages([])
    setError(null)
    setPendingPhase('building')
    const result = await window.desktopApi.ai.chat({
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            attachments.length > 0
              ? `${content}\n\n（用户附带了 ${attachments.length} 张参考图，请据此搭建。）`
              : content
        }
      ],
      sceneSummary: includeScene ? sceneSummary : undefined,
      images: attachments.length > 0 ? attachments : undefined
    })
    if (result.status === 'cancelled') {
      setPendingPhase('idle')
      return
    }
    if (result.status === 'error') {
      setPendingPhase('idle')
      setError(result.message)
      return
    }

    const resolved = resolveAiSceneCommandsFromReply(result.content)
    if (resolved.commands.length === 0) {
      setPendingPhase('idle')
      setMessages([
        ...nextMessages,
        {
          role: 'assistant',
          content: buildAssistantDisplay(resolved.prose || result.content, null, true)
        }
      ])
      return
    }

    const applyResult = onApplyCommands(resolved.commands)
    const firstAssistant: AiChatMessage = {
      role: 'assistant',
      content: buildAssistantDisplay(resolved.prose, applyResult, false)
    }
    const conversation = [...nextMessages, firstAssistant]
    setMessages(conversation)

    if (applyResult.appliedCount > 0) {
      try {
        await runVerification(conversation, applyResult, content)
      } finally {
        setPendingPhase('idle')
      }
      return
    }

    setPendingPhase('idle')
  }

  const cancel = (): void => {
    void window.desktopApi.ai.cancelChat()
  }

  const clear = (): void => {
    setMessages([])
    setPendingImages([])
    setError(null)
  }

  const pendingLabel =
    pendingPhase === 'verifying' ? '正在查看相机画面并复核…' : '正在思考…'

  return (
    <aside className="ai-panel" aria-label="AI 输入窗口">
      <header className="ai-panel-header">
        <div>
          <span>
            <Sparkles aria-hidden="true" />
            {provider ? provider.name : '尚未配置'}
          </span>
          <h2>AI 搭场景</h2>
        </div>
        <div className="ai-panel-header-actions">
          <button type="button" aria-label="打开 AI 设置" onClick={onOpenSettings}>
            <Settings aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="清空对话"
            disabled={(messages.length === 0 && pendingImages.length === 0) || pending}
            onClick={clear}
          >
            <Trash2 aria-hidden="true" />
          </button>
          <button type="button" aria-label="关闭 AI 窗口" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      {!configured ? (
        <div className="ai-panel-setup">
          <p>还没有可用的 AI 接口。请在设置里填写接口地址与密钥，配置会保存在本机环境文件中。</p>
          <p className="ai-panel-path" title={filePath}>
            {filePath || '本地环境文件'}
          </p>
          <button type="button" onClick={onOpenSettings}>
            <Settings aria-hidden="true" />
            打开 AI 设置
          </button>
        </div>
      ) : (
        <>
          <div className="ai-panel-messages" ref={listRef}>
            {messages.length === 0 && !pending ? (
              <div className="ai-panel-empty">
                <Bot aria-hidden="true" />
                <p>
                  可文字描述，也可上传/粘贴参考图。AI 会生成到场景并自动复核一次；需使用支持看图的模型。
                </p>
                <div className="ai-panel-examples">
                  {EXAMPLE_PROMPTS.map((example) => (
                    <button key={example} type="button" onClick={() => setDraft(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {messages.map((message, index) => (
              <div key={index} className={`ai-message ai-message-${message.role}`}>
                <span>{message.role === 'user' ? '你' : (provider?.name ?? 'AI')}</span>
                <p>{message.content}</p>
              </div>
            ))}

            {pending ? (
              <div className="ai-message ai-message-assistant ai-message-pending">
                <span>{provider?.name ?? 'AI'}</span>
                <p>{pendingLabel}</p>
              </div>
            ) : null}

            {error ? <p className="ai-panel-error">{error}</p> : null}
          </div>

          <div className="ai-panel-composer">
            <label className="ai-panel-scene-toggle">
              <input
                type="checkbox"
                checked={includeScene}
                onChange={(event) => setIncludeScene(event.target.checked)}
              />
              <span>附带当前场景信息</span>
            </label>

            {pendingImages.length > 0 ? (
              <div className="ai-panel-attachments" aria-label="待发送参考图">
                {pendingImages.map((image) => (
                  <div key={image.id} className="ai-panel-attachment">
                    <img src={image.previewUrl} alt={image.name} />
                    <button
                      type="button"
                      aria-label={`移除 ${image.name}`}
                      disabled={pending}
                      onClick={() => removePendingImage(image.id)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <textarea
              rows={3}
              placeholder="描述场景，或先上传/粘贴参考图再说明需求"
              value={draft}
              disabled={pending}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => {
                const files = event.clipboardData?.files
                if (!files || files.length === 0) return
                const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
                if (images.length === 0) return
                event.preventDefault()
                void addFiles(images)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <div className="ai-panel-composer-actions">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/gif"
                multiple
                hidden
                onChange={(event) => {
                  const files = event.target.files
                  if (files && files.length > 0) void addFiles(files)
                  event.target.value = ''
                }}
              />
              <button
                className="secondary"
                type="button"
                aria-label="上传参考图"
                disabled={pending || pendingImages.length >= MAX_ATTACHMENTS}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImagePlus aria-hidden="true" />
                图片
              </button>
              {pending ? (
                <button className="secondary" type="button" onClick={cancel}>
                  停止
                </button>
              ) : (
                <button type="button" disabled={!canSend} onClick={() => void send()}>
                  <Send aria-hidden="true" />
                  发送
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
