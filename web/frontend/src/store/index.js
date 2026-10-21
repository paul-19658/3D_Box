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
import { extractCommandsFromReply, isVerificationPass } from '@/core/ai-commands'
import { summarizeScene } from '@/core/scene'

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
      const entry = { id: `${Date.now()}-${Math.random()}`, ...notice }
      state.notices = [...state.notices, entry]
    },
    dismissNotice(state, id) {
      state.notices = state.notices.filter((notice) => notice.id !== id)
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
      state.aiMessages = [...state.aiMessages, message]
    },
    setAiMessages(state, messages) {
      state.aiMessages = messages
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
      commit('pushNotice', notice)
      const delay = notice.kind === 'error' ? 6000 : 3200
      const id = `${Date.now()}-${Math.random()}`
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
    // AI
    // ------------------------------------------------------------------

    async sendAiMessage({ state, commit, dispatch, getters }, content) {
      if (!content || !content.trim()) return
      commit('pushAiMessage', { role: 'user', content })
      commit('setAiSending', true)
      try {
        const response = await api.ai.chat({
          messages: state.aiMessages.map(({ role, content: text }) => ({ role, content: text })),
          sceneSummary: getters.sceneSummary
        })
        if (response.status !== 'ok') {
          commit('pushAiMessage', { role: 'assistant', content: `（出错）${response.message}` })
          await dispatch('notify', { kind: 'error', message: response.message })
          return
        }
        commit('pushAiMessage', { role: 'assistant', content: response.content })

        if (isVerificationPass(response.content)) {
          await dispatch('notify', { kind: 'success', message: 'AI 复核通过，场景与描述一致。' })
          return
        }
        const commands = extractCommandsFromReply(response.content)
        if (commands.length === 0) {
          await dispatch('notify', { kind: 'info', message: 'AI 没有返回可执行的场景命令。' })
          return
        }
        await dispatch('applyAiCommands', commands)
      } catch (error) {
        await dispatch('notify', { kind: 'error', message: `AI 请求失败：${error.message}` })
      } finally {
        commit('setAiSending', false)
      }
    },

    async applyAiCommands({ commit, dispatch, getters }, commands) {
      const result = applyAiSceneCommands(getters.scene, commands)
      commit('commitScene', result.scene)
      commit('setSelection', [])
      dispatch('scheduleAutosave')
      const message =
        result.skipped.length > 0
          ? `已执行 ${result.applied} 条命令，跳过 ${result.skipped.length} 条：${result.skipped[0]}`
          : `已执行 ${result.applied} 条命令，可用撤销回退。`
      await dispatch('notify', {
        kind: result.skipped.length > 0 ? 'info' : 'success',
        message
      })
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
