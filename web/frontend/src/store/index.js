/**
 * Vuex store：应用唯一的状态源。
 *
 * 分层：
 * - `state`   只存数据，不放 DOM 引用或 three.js 对象；
 * - `mutations` 只做同步赋值，保持可追踪；
 * - `actions` 负责异步（读写后端、导出、AI 对话）与多步编排。
 *
 * 场景本身用"历史栈"管理：`commitScene` 推入新状态并清空重做栈，
 * 这是所有编辑操作的唯一入口，保证撤销行为一致。
 */

import Vue from 'vue'
import Vuex from 'vuex'
import { api } from '@/api/client'
import { createHistory, commitHistory, undoHistory, redoHistory } from '@/core/history'
import { createInitialScene } from '@/core/scene'
import { migrateProjectDocument, sceneFingerprint, createProjectDocument } from '@/core/project-document'
import { applyAiSceneCommands } from '@/core/apply-ai-scene-commands'
import { AI_MAX_HISTORY_MESSAGES } from '@/core/ai-defaults'
import {
  AI_AGENT_MAX_STEPS,
  AI_TOOL_DEFINITIONS,
  executeAiTool,
  summarizeToolResult
} from '@/core/ai-tools'
import { summarizeScene } from '@/core/scene'

const MAX_PENDING_IMAGES = 4

function sanitizeChatImages(images) {
  if (!Array.isArray(images) || images.length === 0) return []
  return images
    .filter(
      (image) =>
        image &&
        typeof image.mimeType === 'string' &&
        image.mimeType.startsWith('image/') &&
        typeof image.base64Data === 'string' &&
        image.base64Data.trim().length > 0
    )
    .slice(0, MAX_PENDING_IMAGES)
    .map((image) => ({
      mimeType: image.mimeType.trim().slice(0, 64),
      base64Data: image.base64Data.replace(/\s+/g, '').slice(0, 8_000_000)
    }))
}

function trimAiHistory(messages) {
  if (!Array.isArray(messages) || messages.length <= AI_MAX_HISTORY_MESSAGES) return messages || []
  return messages.slice(messages.length - AI_MAX_HISTORY_MESSAGES)
}

/** 发给模型的 tool 结果：去掉 base64，避免把截图塞进 JSON 文本。 */
function toolResultForModel(result) {
  if (!result || typeof result !== 'object') return result
  const copy = { ...result }
  if (Array.isArray(copy.images) && copy.images.length > 0) {
    copy.images = copy.images.map((image) => ({
      role: image.role,
      label: image.label,
      note: '截图已作为多模态附件上传，请直接查看图片。'
    }))
  }
  delete copy.display
  return copy
}

function waitFrames(count = 2) {
  return new Promise((resolve) => {
    const step = (left) => {
      if (left <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(() => step(left - 1))
    }
    step(count)
  })
}

Vue.use(Vuex)

const AUTOSAVE_DELAY_MS = 1500

let autosaveTimer = null

/**
 * 起始场景。
 *
 * 单独取出来是为了让"初始场景"和"已保存指纹"来自同一份对象：
 * 否则新建时就会一上来显示"有未保存修改"，用户会以为自己弄脏了文件。
 */
const initialScene = createInitialScene()

const fingerprintOf = (scene) =>
  sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline)

export default new Vuex.Store({
  state: {
    history: createHistory(initialScene),
    theme: 'dark',

    projectId: null,
    projectName: '未命名场景',
    // 用初始场景的指纹打底，新打开的编辑器才是"干净"状态。
    savedFingerprint: fingerprintOf(initialScene),
    savedAt: null,

    selectedIds: [],
    selectedLightId: null,
    /** 当前选中的是否是场景摄影机（与物体、灯光三选一）。 */
    cameraSelected: false,
    inspectorTarget: 'selection',
    transformMode: 'translate',

    tool: 'select',
    modelingDraft: null,
    quickBuildDraft: null,
    cutTool: null,
    /** 导航线绘制进行中的草稿（局部坐标节点）。null 表示没在画。 */
    pathDraft: null,
    /** 当前选中的导航线节点 { pathId, index }。 */
    selectedPathNode: null,
    paintScope: 'object',
    paintColor: '#ff6b6b',

    timelineTime: 0,
    timelinePlaying: false,
    selectedShotId: null,
    selectedKeyframeId: null,
    timelineOpen: true,
    /** 摄影机监视器小窗是否打开。 */
    monitorOpen: false,

    cameraViewMode: 'none',
    /**
     * 成片预演：视口不再显示编辑视角，而是以成片画幅渲染场景摄影机。
     *
     * 与 `cameraViewMode` 刻意分开：后者是"临时切到某台摄影机看一眼"，
     * 前者是"完整播放成片"。预演期间编辑工具、辅助线、拾取全部关闭。
     */
    previewMode: false,

    notices: [],
    busy: false,
    modelExportOpen: false,
    imageExportOpen: false,
    videoExportOpen: false,
    qualityReport: null,
    recentProjects: [],
    recentOpen: false,
    recoverySnapshot: null,
    pendingAction: null,

    aiMessages: [],
    aiSettings: null,
    aiSending: false,
    aiSettingsOpen: false,
    aiVerifying: false,
    pendingAiImages: [],
    aiPanelOpen: true,

    platformProfiles: null,
    videoProfileId: 'generic-16x9',
    videoValidation: null,

    meta: null
  },

  getters: {
    scene: (state) => state.history.present,
    objects: (state) => state.history.present.objects,
    camera: (state) => state.history.present.camera,
    lighting: (state) => state.history.present.lighting,
    timeline: (state) => state.history.present.timeline,
    canUndo: (state) => state.history.past.length > 0,
    canRedo: (state) => state.history.future.length > 0,
    selectedObjects: (state) =>
      state.history.present.objects.filter((object) => state.selectedIds.includes(object.id)),
    selectedLight: (state) =>
      state.history.present.lighting.lights.find((light) => light.id === state.selectedLightId) ?? null,
    isDirty: (state, getters) => {
      const scene = getters.scene
      return (
        sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline) !==
        state.savedFingerprint
      )
    },
    sceneSummary: (state, getters) => summarizeScene(getters.scene)
  },

  mutations: {
    commitScene(state, nextScene) {
      state.history = commitHistory(state.history, nextScene)
      state.savedFingerprint ||= ''
    },
    undoScene(state) {
      state.history = undoHistory(state.history)
    },
    redoScene(state) {
      state.history = redoHistory(state.history)
    },
    resetScene(state, scene) {
      state.history = createHistory(scene ?? createInitialScene())
    },
    markSaved(state, { fingerprint, savedAt, projectId, projectName }) {
      state.savedFingerprint = fingerprint
      state.savedAt = savedAt
      if (projectId !== undefined) state.projectId = projectId
      if (projectName !== undefined) state.projectName = projectName
    },
    /** 工程改名。走 mutation 而不是直接赋值，保证 devtools 里可追踪。 */
    setProjectName(state, name) {
      state.projectName = (name || '').trim() || '未命名场景'
    },

    setTheme(state, theme) {
      state.theme = theme
      try {
        window.localStorage.setItem('xiaobaihe-theme', theme)
      } catch {
        // 隐私模式下 localStorage 可能不可用，主题退回默认值即可。
      }
    },
    setSelection(state, ids) {
      state.selectedIds = ids
      if (ids.length > 0) {
        state.selectedLightId = null
        state.cameraSelected = false
      }
    },
    setSelectedLight(state, id) {
      state.selectedLightId = id
      if (id) {
        state.selectedIds = []
        state.cameraSelected = false
      }
    },
    /**
     * 选中/取消选中场景摄影机。
     *
     * 摄影机在数据上不是 objects 里的一项（它有自己的字段），
     * 但在用户心智里它就是场景里的一个可摆放对象，
     * 所以用独立的布尔量表示"当前选中的是摄影机"，与物体、灯光三选一。
     */
    setCameraSelected(state, selected) {
      state.cameraSelected = selected
      if (selected) {
        state.selectedIds = []
        state.selectedLightId = null
      }
    },
    setCameraViewMode(state, mode) {
      state.cameraViewMode = mode
    },
    /**
     * 进出"成片预演"。
     *
     * 进入预演会顺手清掉编辑态的临时视图：切割平面、导航线草稿、
     * 建模草稿都不该出现在成片里。这些状态留着不会自己消失，
     * 用户退出预演后会看到一个"莫名其妙的切割面"，很难联想到是预演留下的。
     */
    setPreviewMode(state, active) {
      state.previewMode = Boolean(active)
      if (!state.previewMode) return
      state.tool = 'select'
      state.cutTool = null
      state.quickBuildDraft = null
      state.pathDraft = null
      state.selectedPathNode = null
      state.modelingDraft = null
    },
    setInspectorTarget(state, target) {
      state.inspectorTarget = target
    },
    setTransformMode(state, mode) {
      state.transformMode = mode
    },
    setTool(state, tool) {
      state.tool = tool
    },
    setModelingDraft(state, draft) {
      state.modelingDraft = draft
    },
    setQuickBuildDraft(state, draft) {
      state.quickBuildDraft = draft
    },
    setCutTool(state, tool) {
      state.cutTool = tool
    },
    setPaintScope(state, scope) {
      state.paintScope = scope
    },
    setPaintColor(state, color) {
      state.paintColor = color
    },

    setTimelineTime(state, time) {
      state.timelineTime = time
    },
    setTimelinePlaying(state, playing) {
      state.timelinePlaying = playing
    },
    setSelectedShotId(state, id) {
      state.selectedShotId = id
    },
    setSelectedKeyframeId(state, id) {
      state.selectedKeyframeId = id
    },
    setPathDraft(state, draft) {
      state.pathDraft = draft
    },
    setSelectedPathNode(state, node) {
      state.selectedPathNode = node ? { ...node } : null
    },
    setTimelineOpen(state, open) {
      state.timelineOpen = open
    },
    setMonitorOpen(state, open) {
      state.monitorOpen = Boolean(open)
    },

    pushNotice(state, notice) {
      // id 必须由调用方传入（notify action），否则定时 dismiss 对不上号。
      const entry = {
        id: notice.id || `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        kind: notice.kind || 'info',
        message: notice.message || ''
      }
      state.notices = [...state.notices, entry].slice(-5)
    },
    dismissNotice(state, id) {
      state.notices = state.notices.filter((notice) => notice.id !== id)
    },
    clearNotices(state) {
      state.notices = []
    },
    setBusy(state, busy) {
      state.busy = busy
    },
    setModelExportOpen(state, open) {
      state.modelExportOpen = open
    },
    setImageExportOpen(state, open) {
      state.imageExportOpen = open
    },
    setVideoExportOpen(state, open) {
      state.videoExportOpen = open
    },
    setQualityReport(state, report) {
      state.qualityReport = report
    },
    setRecentProjects(state, entries) {
      state.recentProjects = entries
    },
    setRecentOpen(state, open) {
      state.recentOpen = open
    },
    setRecoverySnapshot(state, snapshot) {
      state.recoverySnapshot = snapshot
    },
    setPendingAction(state, action) {
      state.pendingAction = action
    },

    pushAiMessage(state, message) {
      state.aiMessages = trimAiHistory([...state.aiMessages, message])
    },
    setAiMessages(state, messages) {
      state.aiMessages = trimAiHistory(messages)
    },
    setAiSettings(state, settings) {
      state.aiSettings = settings
    },
    setAiSending(state, sending) {
      state.aiSending = sending
    },
    setAiSettingsOpen(state, open) {
      state.aiSettingsOpen = open
    },
    setAiVerifying(state, verifying) {
      state.aiVerifying = verifying
    },
    setPendingAiImages(state, images) {
      state.pendingAiImages = Array.isArray(images) ? images.slice(0, MAX_PENDING_IMAGES) : []
    },
    addPendingAiImages(state, images) {
      const next = [...state.pendingAiImages, ...(images || [])].slice(0, MAX_PENDING_IMAGES)
      state.pendingAiImages = next
    },
    removePendingAiImage(state, index) {
      state.pendingAiImages = state.pendingAiImages.filter((_, i) => i !== index)
    },
    setAiPanelOpen(state, open) {
      state.aiPanelOpen = Boolean(open)
    },

    setPlatformProfiles(state, profiles) {
      state.platformProfiles = profiles
    },
    setVideoProfileId(state, id) {
      state.videoProfileId = id
    },
    setVideoValidation(state, validation) {
      state.videoValidation = validation
    },
    setMeta(state, meta) {
      state.meta = meta
    }
  },

  actions: {
    notify({ commit }, notice) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
      commit('pushNotice', { ...notice, id })
      const delay = notice.kind === 'error' ? 6000 : 2800
      setTimeout(() => commit('dismissNotice', id), delay)
    },

    async bootstrap({ commit, dispatch }) {
      try {
        commit('setMeta', await api.meta())
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `无法连接后端服务：${error.message}` })
        return
      }

      try {
        const profiles = await api.platformProfiles.list()
        commit('setPlatformProfiles', profiles)
      } catch {
        // 平台规则不是核心功能，取不到时不阻塞启动。
      }

      try {
        const settings = await api.ai.settings()
        commit('setAiSettings', settings.settings)
      } catch {
        // 同上。
      }

      const theme = window.localStorage.getItem('xiaobaihe-theme')
      if (theme === 'light' || theme === 'dark') commit('setTheme', theme)

      try {
        const recovery = await api.recovery.load()
        if (recovery.status === 'found') commit('setRecoverySnapshot', recovery.snapshot)
      } catch {
        // 恢复快照读取失败不阻塞启动。
      }

      try {
        const recent = await api.recent.list()
        commit('setRecentProjects', recent.entries)
      } catch {
        // 同上。
      }
    },

    /**
     * 所有场景修改的唯一入口。
     * `update` 接收当前场景，返回新场景；返回同一引用表示无变化。
     */
    editScene({ commit, state, dispatch }, update) {
      const current = state.history.present
      const next = update(current)
      if (!next || next === current) return
      commit('commitScene', next)
      dispatch('scheduleAutosave')
    },

    scheduleAutosave({ state }) {
      if (autosaveTimer) window.clearTimeout(autosaveTimer)
      autosaveTimer = window.setTimeout(() => {
        const scene = state.history.present
        api.recovery
          .save(
            createProjectDocument({
              name: state.projectName,
              objects: scene.objects,
              camera: scene.camera,
              lighting: scene.lighting,
              timeline: scene.timeline
            }),
            state.projectId
          )
          .catch(() => {
            // 自动恢复失败是静默的：用户仍可手动保存，不应频繁打扰。
          })
      }, AUTOSAVE_DELAY_MS)
    },

    async saveProject({ state, commit, dispatch }, { saveAs = false } = {}) {
      commit('setBusy', true)
      try {
        const scene = state.history.present
        const document = createProjectDocument({
          name: state.projectName,
          objects: scene.objects,
          camera: scene.camera,
          lighting: scene.lighting,
          timeline: scene.timeline
        })
        const result = await api.projects.save(document, saveAs ? null : state.projectId)
        commit('markSaved', {
          fingerprint: sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline),
          savedAt: result.savedAt,
          projectId: result.projectId
        })
        await dispatch('notify', { kind: 'success', message: `工程已保存：${result.displayName}` })
        const recent = await api.recent.list()
        commit('setRecentProjects', recent.entries)
        return true
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `保存失败：${error.message}` })
        return false
      } finally {
        commit('setBusy', false)
      }
    },

    async openProject({ commit, dispatch }, projectId) {
      commit('setBusy', true)
      try {
        const result = await api.projects.open(projectId)
        const document = migrateProjectDocument(result.document)
        commit('resetScene', {
          objects: document.scene.objects,
          camera: document.scene.camera,
          lighting: document.scene.lighting,
          timeline: document.scene.timeline
        })
        commit('markSaved', {
          fingerprint: sceneFingerprint(
            document.scene.objects,
            document.scene.camera,
            document.scene.lighting,
            document.scene.timeline
          ),
          savedAt: document.savedAt,
          projectId,
          projectName: document.name
        })
        commit('setSelection', document.scene.objects[0] ? [document.scene.objects[0].id] : [])
        await dispatch('notify', { kind: 'success', message: `已打开工程：${document.name}` })
        const recent = await api.recent.list()
        commit('setRecentProjects', recent.entries)
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `打开失败：${error.message}` })
      } finally {
        commit('setBusy', false)
      }
    },

    newProject({ commit, dispatch }) {
      const scene = createInitialScene()
      commit('resetScene', scene)
      // 用初始场景指纹打底，新建后不应显示"有未保存修改"。
      commit('markSaved', {
        fingerprint: fingerprintOf(scene),
        savedAt: null,
        projectId: null,
        projectName: '未命名场景'
      })
      commit('setSelection', [])
      dispatch('notify', { kind: 'info', message: '已新建场景。' })
    },

    async restoreRecovery({ state, commit, dispatch }) {
      const snapshot = state.recoverySnapshot
      if (!snapshot) return
      const document = migrateProjectDocument(snapshot.document)
      commit('resetScene', {
        objects: document.scene.objects,
        camera: document.scene.camera,
        lighting: document.scene.lighting,
        timeline: document.scene.timeline
      })
      commit('markSaved', {
        fingerprint: sceneFingerprint(
          document.scene.objects,
          document.scene.camera,
          document.scene.lighting,
          document.scene.timeline
        ),
        savedAt: document.savedAt,
        projectId: snapshot.projectId ?? null,
        projectName: document.name
      })
      commit('setRecoverySnapshot', null)
      await dispatch('notify', { kind: 'success', message: '已恢复上次未保存的内容。' })
    },

    async discardRecovery({ commit, dispatch }) {
      try {
        await api.recovery.clear()
      } catch {
        // 清除失败不影响用户继续工作。
      }
      commit('setRecoverySnapshot', null)
      await dispatch('notify', { kind: 'info', message: '已放弃恢复内容，手动保存的工程不受影响。' })
    },

    async deleteProject({ commit, dispatch }, projectId) {
      try {
        await api.projects.remove(projectId)
        const recent = await api.recent.list()
        commit('setRecentProjects', recent.entries)
        await dispatch('notify', { kind: 'info', message: '工程已删除。' })
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `删除失败：${error.message}` })
      }
    },

    /**
     * 只把工程从"最近打开"里移除，不删除 .block3d 文件。
     * 与 deleteProject 区分开，避免用户误删工程。
     */
    async forgetRecentProject({ commit, dispatch }, projectId) {
      try {
        const result = await api.recent.remove(projectId)
        commit('setRecentProjects', result.entries)
        await dispatch('notify', { kind: 'info', message: '已从最近列表移除。' })
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `操作失败：${error.message}` })
      }
    },

    // ------------------------------------------------------------------
    // AI（前端驱动的 Agent Loop）
    // ------------------------------------------------------------------

    async sendAiMessage({ state, commit, dispatch, getters }, payload) {
      const options = typeof payload === 'string' ? { content: payload } : payload || {}
      const text = (options.content || '').trim()
      const viewport = options.viewport || null
      const attached = sanitizeChatImages(options.images || state.pendingAiImages)
      if (!text && attached.length === 0) return

      const content =
        text ||
        (attached.length > 0
          ? '请根据我附带的参考图，搭建对应的白膜场景（构图、站位与镜头尽量贴近参考）。'
          : '')
      const displayContent =
        attached.length > 0 ? `${content}\n\n[已附带 ${attached.length} 张参考图]` : content
      const apiUserContent =
        attached.length > 0
          ? `${content}\n\n（用户附带了 ${attached.length} 张参考图，请据此搭建。）`
          : content

      commit('pushAiMessage', { role: 'user', content: displayContent })
      commit('setPendingAiImages', [])
      commit('setAiSending', true)
      commit('setAiVerifying', false)

      // 协议消息（含 tool 角色）；UI 历史只展示可读文本。
      const loopMessages = [
        ...state.aiMessages
          .slice(0, -1)
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .filter((message) => !String(message.content || '').startsWith('⚙ '))
          .map(({ role, content: textContent }) => ({ role, content: textContent })),
        { role: 'user', content: apiUserContent }
      ]

      const budget = { capturesUsed: 0 }
      const toolContext = {
        getScene: () => getters.scene,
        commitScene: (scene) => {
          commit('commitScene', scene)
          commit('setSelection', [])
          dispatch('scheduleAutosave')
        },
        viewport,
        budget
      }

      let nextImages = attached.length > 0 ? attached : []
      let finishedSummary = ''
      let appliedAnything = false

      try {
        for (let step = 0; step < AI_AGENT_MAX_STEPS; step += 1) {
          const response = await api.ai.chat({
            messages: loopMessages,
            sceneSummary: getters.sceneSummary,
            images: nextImages.length > 0 ? nextImages : undefined,
            tools: AI_TOOL_DEFINITIONS,
            toolChoice: 'auto'
          })
          nextImages = []

          if (response.status !== 'ok') {
            commit('pushAiMessage', { role: 'assistant', content: `（出错）${response.message}` })
            await dispatch('notify', { kind: 'error', message: response.message })
            return
          }

          const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : []
          const replyText = (response.content || '').trim()

          if (toolCalls.length === 0) {
            if (replyText) {
              commit('pushAiMessage', { role: 'assistant', content: replyText })
            }
            await dispatch('notify', {
              kind: appliedAnything ? 'success' : 'info',
              message: appliedAnything
                ? 'AI 已完成场景操作，可用撤销回退。'
                : replyText || 'AI 未调用工具。'
            })
            return
          }

          loopMessages.push({
            role: 'assistant',
            content: replyText || null,
            toolCalls
          })
          if (replyText) {
            commit('pushAiMessage', { role: 'assistant', content: replyText })
          }

          // 截图前等几帧，确保 apply 后的 three.js 节点已刷新。
          const needsCapture = toolCalls.some((call) => String(call.name || '').startsWith('capture_'))
          if (needsCapture) {
            commit('setAiVerifying', true)
            await waitFrames(3)
          }

          const stepImages = []
          let calledDone = false

          for (const call of toolCalls) {
            const name = call.name || ''
            const args = call.arguments || {}
            if (typeof console !== 'undefined' && console.debug) {
              console.debug('[ai-agent] tool call', name, args)
            }
            const result = executeAiTool(name, args, toolContext)
            const display = summarizeToolResult(name, result)
            commit('pushAiMessage', { role: 'assistant', content: `⚙ ${display}` })

            if (name === 'apply_scene_commands' && result.ok) {
              appliedAnything = true
              if (result.hasTimelineAnimation) {
                commit('setTimelineTime', 0)
                commit('setTimelinePlaying', true)
              }
            }
            if (Array.isArray(result.images)) {
              for (const image of result.images) {
                if (image?.base64Data) stepImages.push(image)
              }
            }
            if (result.done) {
              calledDone = true
              finishedSummary = result.summary || display
            }

            loopMessages.push({
              role: 'tool',
              toolCallId: call.id || `tool-${step}-${name}`,
              content: JSON.stringify(toolResultForModel(result))
            })
          }

          commit('setAiVerifying', false)

          if (stepImages.length > 0) {
            nextImages = sanitizeChatImages(stepImages).slice(0, 4)
            const legend = stepImages
              .map((image, index) => `图${index + 1}：${image.label || image.role || '截图'}`)
              .join('；')
            loopMessages.push({
              role: 'user',
              content: `（系统）已附上截图：${legend}。请结合图片继续观察或修正，完成后调用 done。`
            })
          }

          if (calledDone) {
            if (finishedSummary) {
              commit('pushAiMessage', { role: 'assistant', content: finishedSummary })
            }
            await dispatch('notify', {
              kind: 'success',
              message: finishedSummary || 'AI 任务完成。'
            })
            return
          }
        }

        commit('pushAiMessage', {
          role: 'assistant',
          content: '已达到最大工具步数，停止本轮 Agent。可用撤销回退场景改动。'
        })
        await dispatch('notify', { kind: 'info', message: 'AI 达到最大步数已停止。' })
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `AI 请求失败：${error.message}` })
      } finally {
        commit('setAiSending', false)
        commit('setAiVerifying', false)
      }
    },

    async applyAiCommands({ commit, dispatch, getters }, payload) {
      const commands = Array.isArray(payload) ? payload : payload?.commands || []
      const silent = Boolean(payload && !Array.isArray(payload) && payload.silent)
      const result = applyAiSceneCommands(getters.scene, commands)
      commit('commitScene', result.scene)
      commit('setSelection', [])
      if (result.hasTimelineAnimation) {
        commit('setTimelineTime', 0)
        commit('setTimelinePlaying', true)
      }
      dispatch('scheduleAutosave')
      if (!silent) {
        const message =
          result.skipped.length > 0
            ? `已执行 ${result.applied} 条命令，跳过 ${result.skipped.length} 条：${result.skipped[0]}`
            : `已执行 ${result.applied} 条命令，可用撤销回退。`
        await dispatch('notify', {
          kind: result.skipped.length > 0 ? 'info' : 'success',
          message
        })
      }
      return result
    },

    async saveAiSettings({ commit, dispatch }, payload) {
      try {
        const result = await api.ai.saveSettings(payload)
        commit('setAiSettings', result.settings)
        await dispatch('notify', { kind: 'success', message: 'AI 设置已保存到本机。' })
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `保存设置失败：${error.message}` })
      }
    },

    /** 在输入条直接切换当前服务商（密钥沿用，空 apiKey 表示不改）。 */
    async setActiveAiProvider({ state, dispatch }, providerId) {
      const settings = state.aiSettings
      if (!settings || !providerId || settings.activeProviderId === providerId) return
      const provider = (settings.providers || []).find((item) => item.id === providerId)
      if (!provider) return
      await dispatch('saveAiSettings', {
        activeProviderId: providerId,
        systemPrompt: settings.systemPrompt,
        providers: (settings.providers || []).map((item) => {
          const copy = { ...item }
          delete copy.hasApiKey
          return { ...copy, apiKey: '' }
        })
      })
    },

    async clearAiMessages({ commit }) {
      commit('setAiMessages', [])
    },

    // ------------------------------------------------------------------
    // 导出
    // ------------------------------------------------------------------

    async exportReferenceImages({ state, commit, dispatch }, images) {
      commit('setBusy', true)
      try {
        const payloads = [
          ['白模', 'white'],
          ['深度', 'depth'],
          ['法线', 'normal'],
          ['物体分色', 'objectId'],
          ['遮罩', 'mask'],
          ['轮廓', 'outline']
        ]
        const files = []
        for (const [label, key] of payloads) {
          if (!images[key]) continue
          const result = await api.exports.save(`${state.projectName}_${label}.png`, images[key])
          files.push(result.fileName)
        }
        await dispatch('notify', {
          kind: 'success',
          message: `已导出 ${files.length} 张控制参考图。`
        })
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `导出参考图失败：${error.message}` })
      } finally {
        commit('setBusy', false)
      }
    },

    async validateVideoProfile({ state, commit }, payload) {
      if (!state.videoProfileId) return
      try {
        const validation = await api.platformProfiles.validate({
          profileId: state.videoProfileId,
          ...payload
        })
        commit('setVideoValidation', validation)
      } catch {
        commit('setVideoValidation', null)
      }
    }
  }
})
