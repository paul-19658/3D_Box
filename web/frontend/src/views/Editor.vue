<template>
  <div class="editor">
    <TopBar
      :project-name="projectName"
      :is-dirty="isDirty"
      :can-undo="canUndo"
      :can-redo="canRedo"
      :theme="theme"
      :error-count="diagnosticsErrorCount"
      :preview-active="previewMode"
      :username="currentUsername"
      :is-admin="isAdmin"
      :read-only="isReadOnly"
      :read-only-banner="readOnlyBanner"
      @select-panel="setPreviewMode($event === 'preview')"
      @rename="renameProject"
      @undo="$store.commit('undoScene')"
      @redo="$store.commit('redoScene')"
      @save="$store.dispatch('saveProject', { saveAs: false })"
      @save-as="$store.dispatch('saveProject', { saveAs: true })"
      @new="$store.dispatch('newProject')"
      @open-recent="$store.commit('setRecentOpen', true)"
      @toggle-theme="toggleTheme"
      @export-image="$store.commit('setImageExportOpen', true)"
      @export-video="$store.commit('setVideoExportOpen', true)"
      @export-model="$store.commit('setModelExportOpen', true)"
      @open-ai-settings="$store.commit('setAiSettingsOpen', true)"
      @open-projects="$router.push('/projects')"
      @open-admin="$router.push('/admin')"
      @logout="handleLogout"
      @export-diagnostics="exportDiagnostics"
    />

    <!--
      预演时收起编辑侧栏与浮动面板。
      保留视口和时间轴：时间轴是"播到哪儿"的唯一指示，去掉它就成了黑盒。
    -->
    <div class="editor-body" :class="{ 'is-preview': previewMode }">
      <ToolRail
        v-if="!previewMode"
        :tool="tool"
        :transform-mode="transformMode"
        @select="setTool"
        @add="addObject"
        @add-mannequin="addMannequin"
        @add-path="beginPathDraw"
        @import="triggerImport"
        @quick-build="beginQuickBuild"
      />

      <main class="editor-stage">
        <SceneViewport
          ref="viewport"
          :objects="displayedObjects"
          :camera-state="displayedCamera"
          :preview-active="previewMode"
          :monitor-open="monitorOpen"
          :lighting="lighting"
          :selected-ids="selectedIds"
          :selected-light-id="selectedLightId"
          :transform-mode="transformMode"
          :tool="tool"
          :modeling-draft="modelingDraft"
          :quick-build-draft="quickBuildDraft"
          :cut-tool="cutTool"
          :paint-color="paintColor"
          :paint-scope="paintScope"
          :theme="theme"
          :camera-view-mode="cameraViewMode"
          :camera-selected="cameraSelected"
          :animation-time="timelineTime"
          :path-draft="pathDraft"
          :selected-path-node="selectedPathNode"
          @selection-change="handleSelection"
          @selection-clear="clearSelection"
          @object-transform="handleObjectTransform"
          @objects-transform="handleObjectsTransform"
          @light-transform="handleLightTransform"
          @camera-transform="handleCameraTransform"
          @camera-select="selectCamera"
          @quick-build-start="handleQuickBuildStart"
          @quick-build-move="handleQuickBuildMove"
          @quick-build-end="handleQuickBuildEnd"
          @paint-face="handlePaintFace"
          @cut-pick="handleCutPick"
          @camera-view-change="setCameraViewMode"
          @path-node-move="handlePathNodeMove"
          @path-node-add="handlePathNodeAdd"
          @path-node-select="handlePathNodeSelect"
          @path-draw-end="finishPathDraw"
          @toggle-monitor="$store.commit('setMonitorOpen', !monitorOpen)"
        />

        <CameraOverlay
          v-if="!previewMode"
          :camera="camera"
          @update-camera="updateCamera"
          @focus="$refs.viewport.focusView()"
        />

        <AiComposer
          v-if="!previewMode"
          :sending="aiSending"
          :verifying="aiVerifying"
          :settings="aiSettings"
          :pending-images="pendingAiImages"
          :messages="aiMessages"
          :selected-object="selectedObject"
          @send="sendAi"
          @attach-images="handleAiImages"
          @remove-image="(index) => $store.commit('removePendingAiImage', index)"
          @switch-provider="(id) => $store.dispatch('setActiveAiProvider', id)"
          @open-settings="$store.commit('setAiSettingsOpen', true)"
          @clear-messages="$store.dispatch('clearAiMessages')"
          @error="(message) => $store.dispatch('notify', { kind: 'info', message })"
        />

        <div v-if="!previewMode && tool !== 'select'" class="stage-hint">
          <span>{{ toolHint }}</span>
          <button type="button" class="btn btn--ghost" @click="setTool('select')">退出工具</button>
        </div>

        <!-- 预演 HUD：告诉用户"这是成片画幅"，并给一个明确的退出入口。 -->
        <div v-if="previewMode" class="preview-hud" role="status">
          <span class="preview-hud__badge">成片预演</span>
          <span class="preview-hud__meta">
            {{ camera.aspectWidth }}:{{ camera.aspectHeight }} ·
            {{ Math.round(camera.fovDegrees) }}°
          </span>
          <button type="button" class="btn" @click="setPreviewMode(false)">退出预演 (Esc)</button>
        </div>
      </main>

      <aside v-if="!previewMode" class="editor-sidebar">
        <AssetPanel
          :objects="objects"
          :lights="lighting.lights"
          :selected-ids="selectedIds"
          :selected-light-id="selectedLightId"
          :camera-selected="cameraSelected"
          :camera-name="camera.name || '摄影机'"
          @select-object="handleSelection"
          @select-camera="selectCamera"
          @rename-camera="renameCamera"
          @select-light="selectLight"
          @toggle-visible="toggleObjectVisible"
          @toggle-lock="toggleObjectLock"
          @rename="renameObject"
          @focus="$refs.viewport.focusView()"
        />

        <InspectorPanel
          :target="inspectorTarget"
          :object="selectedObject"
          :light="selectedLight"
          :camera="camera"
          :paint-color="paintColor"
          :paint-scope="paintScope"
          :paths="paths"
          :timeline-duration="timeline.durationSeconds"
          :object-keyframe-count="selectedObjectKeyframeCount"
          :selected-node-index="selectedNodeIndex"
          @update-object="updateObject"
          @update-light="updateLight"
          @update-camera="updateCamera"
          @delete-object="deleteSelected"
          @duplicate-object="duplicateSelected"
          @apply-preset="applyMannequinPreset"
          @update-height="updateMannequinHeight"
          @set-display-mode="setDisplayMode"
          @set-paint-color="(value) => $store.commit('setPaintColor', value)"
          @set-paint-scope="(value) => $store.commit('setPaintScope', value)"
          @apply-layout="applyLayout"
          @add-light="addLight"
          @delete-light="deleteLight"
          @path-add-node="addPathNode"
          @path-remove-node="removePathNode"
          @path-clear-nodes="clearPathNodes"
          @path-select-node="selectPathNode"
          @path-bind="bindPath"
          @path-draw-again="beginPathDrawFor"
          @clear-object-keyframes="clearObjectKeyframes"
        />
      </aside>
    </div>

    <TimelineBar
      :timeline="timeline"
      :time="timelineTime"
      :playing="timelinePlaying"
      :open="timelineOpen"
      :selected-shot-id="selectedShotId"
      :selected-keyframe-id="selectedKeyframeId"
      :selected-path-node-key="selectedPathNodeKey"
      :path-tracks="pathTracks"
      :objects="objects"
      @update-time="setTimelineTime"
      @toggle-play="togglePlay"
      @toggle-open="$store.commit('setTimelineOpen', !timelineOpen)"
      @record-camera="recordCameraShot"
      @record-object="recordObjectKeyframe"
      @select-shot="$store.commit('setSelectedShotId', $event)"
      @select-keyframe="$store.commit('setSelectedKeyframeId', $event)"
      @select-path-node="selectPathNode"
      @update-duration="updateDuration"
      @duplicate-shot="duplicateShot"
      @delete-shot="deleteShot"
      @duplicate-keyframe="duplicateKeyframe"
      @delete-keyframe="deleteKeyframe"
    />

    <input
      ref="modelInput"
      type="file"
      accept=".glb,.gltf,.obj,.mtl,.bin,.png,.jpg,.jpeg"
      multiple
      class="hidden-input"
      @change="handleModelFiles"
    />

    <RecoveryDialog v-if="recoverySnapshot" />
    <RecentDialog v-if="recentOpen" @close="$store.commit('setRecentOpen', false)" />
    <AiSettingsDialog v-if="aiSettingsOpen" @close="$store.commit('setAiSettingsOpen', false)" />
    <ImageExportDialog
      v-if="imageExportOpen"
      :viewport="$refs.viewport"
      @close="$store.commit('setImageExportOpen', false)"
    />
    <VideoExportDialog
      v-if="videoExportOpen"
      :viewport="$refs.viewport"
      @close="$store.commit('setVideoExportOpen', false)"
    />
    <ModelExportDialog
      v-if="modelExportOpen"
      :viewport="$refs.viewport"
      @close="$store.commit('setModelExportOpen', false)"
    />
  </div>
</template>

<script>
/**
 * 编辑器主视图：把各面板与 Vuex 连接起来。
 *
 * 所有会改变场景的操作都走 `editScene`，这是撤销与自动保存的统一入口。
 */

import TopBar from '@/components/TopBar.vue'
import ToolRail from '@/components/ToolRail.vue'
import AssetPanel from '@/components/AssetPanel.vue'
import InspectorPanel from '@/components/InspectorPanel.vue'
import TimelineBar from '@/components/TimelineBar.vue'
import CameraOverlay from '@/components/CameraOverlay.vue'
import AiComposer from '@/components/AiComposer.vue'
import AiSettingsDialog from '@/components/AiSettingsDialog.vue'
import RecoveryDialog from '@/components/RecoveryDialog.vue'
import RecentDialog from '@/components/RecentDialog.vue'
import ImageExportDialog from '@/components/ImageExportDialog.vue'
import VideoExportDialog from '@/components/VideoExportDialog.vue'
import ModelExportDialog from '@/components/ModelExportDialog.vue'
import SceneViewport from '@/components/SceneViewport.vue'

import {
  createSceneObject,
  createMannequinSceneObject,
  createSceneLight,
  createPathSceneObject
} from '@/core/scene'
import { placeNewObject, alignObjects, distributeObjects, placeOnGround } from '@/core/layout'
import { MANNEQUIN_PRESETS } from '@/core/mannequin'
import { quickBuildTransform } from '@/core/quick-build'
import { faceColorKey, surfaceTriangles } from '@/core/face-paint'
import { evaluateTimelineAtTime, applyTimelinePreview } from '@/core/timeline'
import {
  PATH_KIND,
  buildPathKeyframes,
  createPathBinding,
  pathInsertionPoint
} from '@/core/nav-path'
import { importStaticModel, analyzeModel } from '@/core/model-io'
import { createId } from '@/core/project-document'
import { downloadReport, errorCount } from '@/core/diagnostics'

export default {
  name: 'EditorView',

  components: {
    TopBar,
    ToolRail,
    AssetPanel,
    InspectorPanel,
    TimelineBar,
    CameraOverlay,
    AiComposer,
    AiSettingsDialog,
    RecoveryDialog,
    RecentDialog,
    ImageExportDialog,
    VideoExportDialog,
    ModelExportDialog,
    SceneViewport
  },

  data() {
    return {
      quickBuildKind: 'wall',
      playbackTimer: null,
      /** 播放是否循环（仅成片预演会开启）。 */
      playbackLoop: false,
      importedModels: new Map(),
      // 只用来给 diagnosticsErrorCount 提供响应式依赖，值本身无意义。
      diagnosticsTick: 0,
      diagnosticsTimer: null
    }
  },

  computed: {
    scene() {
      return this.$store.getters.scene
    },
    objects() {
      return this.$store.getters.objects
    },
    camera() {
      return this.$store.getters.camera
    },
    lighting() {
      return this.$store.getters.lighting
    },
    timeline() {
      return this.$store.getters.timeline
    },
    selectedIds() {
      return this.$store.state.selectedIds
    },
    selectedObject() {
      const selected = this.$store.getters.selectedObjects
      return selected.length === 1 ? selected[0] : null
    },
    selectedObjectKeyframeCount() {
      const object = this.selectedObject
      if (!object) return 0
      return this.timeline.objectKeyframes.filter((keyframe) => keyframe.objectId === object.id).length
    },
    selectedLightId() {
      return this.$store.state.selectedLightId
    },
    selectedLight() {
      return this.$store.getters.selectedLight
    },
    inspectorTarget() {
      return this.$store.state.inspectorTarget
    },
    toolHint() {
      if (this.tool === 'quick-build') return '在网格上按住并拖动，即可铺出墙体或地面。'
      if (this.tool === 'paint') return '点击模型表面涂色，可在右侧切换整物体 / 整面。'
      if (this.tool === 'cut') return '先点选要切割的物体，再在工具栏调整切割平面。'
      return '拖动物体或用右侧面板精确输入数值。'
    },
    transformMode() {
      return this.$store.state.transformMode
    },
    tool() {
      return this.$store.state.tool
    },
    modelingDraft() {
      return this.$store.state.modelingDraft
    },
    quickBuildDraft() {
      return this.$store.state.quickBuildDraft
    },
    cutTool() {
      return this.$store.state.cutTool
    },
    paintColor() {
      return this.$store.state.paintColor
    },
    paintScope() {
      return this.$store.state.paintScope
    },
    theme() {
      return this.$store.state.theme
    },
    cameraViewMode() {
      return this.$store.state.cameraViewMode
    },
    previewMode() {
      return this.$store.state.previewMode
    },
    cameraSelected() {
      return this.$store.state.cameraSelected
    },
    projectName() {
      return this.$store.state.projectName
    },
    isDirty() {
      return this.$store.getters.isDirty
    },
    canUndo() {
      return this.$store.getters.canUndo
    },
    canRedo() {
      return this.$store.getters.canRedo
    },
    currentUsername() {
      return this.$store.state.currentUser?.username || ''
    },
    isAdmin() {
      return this.$store.getters.isAdmin
    },
    isReadOnly() {
      return this.$store.getters.isReadOnly
    },
    readOnlyBanner() {
      const info = this.$store.state.readOnlyProject
      return info ? `正在只读查看 ${info.ownerUsername} 的工程` : ''
    },
    aiSending() {
      return this.$store.state.aiSending
    },
    aiVerifying() {
      return this.$store.state.aiVerifying
    },
    aiSettings() {
      return this.$store.state.aiSettings
    },
    aiMessages() {
      return this.$store.state.aiMessages
    },
    pendingAiImages() {
      return this.$store.state.pendingAiImages
    },
    timelineTime() {
      return this.$store.state.timelineTime
    },
    timelinePlaying() {
      return this.$store.state.timelinePlaying
    },
    timelineOpen() {
      return this.$store.state.timelineOpen
    },
    selectedShotId() {
      return this.$store.state.selectedShotId
    },
    selectedKeyframeId() {
      return this.$store.state.selectedKeyframeId
    },
    paths() {
      return this.objects.filter((object) => object.kind === PATH_KIND)
    },
    pathDraft() {
      return this.$store.state.pathDraft
    },
    selectedPathNode() {
      return this.$store.state.selectedPathNode
    },
    selectedNodeIndex() {
      return this.selectedPathNode ? this.selectedPathNode.index : null
    },
    /** 时间轴里的导航线轨道（含每个节点的时刻）。 */
    pathTracks() {
      const keyframes = buildPathKeyframes(this.objects, this.timeline.durationSeconds)
      const byPath = new Map()
      for (const marker of keyframes) {
        const list = byPath.get(marker.objectId) ?? []
        list.push({
          key: marker.id,
          index: marker.index,
          timeSeconds: marker.timeSeconds
        })
        byPath.set(marker.objectId, list)
      }
      return this.paths.map((path) => ({
        id: path.id,
        name: path.name,
        nodes: byPath.get(path.id) ?? []
      }))
    },
    selectedPathNodeKey() {
      if (!this.selectedPathNode) return null
      return `${this.selectedPathNode.pathId}:${this.selectedPathNode.index}`
    },
    recoverySnapshot() {
      return this.$store.state.recoverySnapshot
    },
    recentOpen() {
      return this.$store.state.recentOpen
    },
    aiSettingsOpen() {
      return this.$store.state.aiSettingsOpen
    },
    imageExportOpen() {
      return this.$store.state.imageExportOpen
    },
    videoExportOpen() {
      return this.$store.state.videoExportOpen
    },
    modelExportOpen() {
      return this.$store.state.modelExportOpen
    },

    /**
     * 已捕获的错误条数，显示在顶栏"诊断"按钮上。
     *
     * diagnostics 模块刻意不是响应式的（它要能在 Vue 之外工作），
     * 所以这里主动引用 `diagnosticsTick` 建立依赖：
     * 定时器每 2 秒推进一次 tick，条数变化就能反映到 UI。
     */
    diagnosticsErrorCount() {
      // 读一下 tick 只为建立响应式依赖，不参与计算。
      void this.diagnosticsTick
      return errorCount()
    },

    /**
     * 播放或拖动时间轴时，用求值结果覆盖物体变换；
     * 停止时直接返回原始物体，保证编辑态数据不被污染。
     */
    displayedObjects() {
      /*
       * 注意这里**不能**提前 return this.objects。
       *
       * 绑定了导航线的物体，即使时间轴停在 0 秒也要被摆到路径起点上——
       * 否则用户刚绑完发现"物体没动"，会以为绑定没生效。
       * applyTimelinePreview 在没有关键帧也没有绑定时会原样返回同一个引用，
       * 所以常态下并不会产生额外开销。
       */
      return applyTimelinePreview(this.objects, this.timeline, this.timelineTime)
    },

    /**
     * 交给视口显示的场景相机位姿。
     *
     * 时间轴有镜头轨时，播放/拖动播放头应该让**场景相机**动起来——
     * 这是"预览动画"的本意。注意这里只改场景相机，不动编辑视角：
     * 编辑视角由 OrbitControls 掌管，一旦被时间轴改写，
     * 用户会看到画面突然飞到一个莫名其妙的角度（之前就是这个症状）。
     */
    displayedCamera() {
      /*
       * 预演必须**总是**走时间轴求值，不能只看 `timelineTime > 0`。
       *
       * 预演是从某一时刻开始的（通常是 0），如果它一开始停在 0，
       * 那"是否求值"就会在 0 和 0.01 之间反复跳，相机在两种来源间切换，
       * 画面会抖。预演期间统一由时间轴说了算，语义也更干净。
       */
      if (this.previewMode || this.timelinePlaying || this.timelineTime > 0) {
        return evaluateTimelineAtTime(this.timeline, this.camera, this.timelineTime).camera
      }
      return this.camera
    },

    monitorOpen() {
      return this.$store.state.monitorOpen
    }
  },

  watch: {
    timelineTime(value) {
      // 刻意不再调用 applyViewportCamera。
      // 预览只改场景相机（displayedCamera 计算属性已覆盖），
      // 编辑视角保持不动，用户才能一边看动画一边继续调机位。
      void value
    },
    objects: {
      handler() {
        // 时间轴预览会替换物体列表，此时不应把相机拉回关键帧位姿。
        this.syncImportedMeshes()
      },
      deep: false
    },
    /*
     * 进出预演时自动起停播放。
     *
     * 预演的意义就是"完整看一遍成片"，进去还得手动点播放是多余的。
     * 退出时必须停掉——否则用户回到编辑态，播放头还在后台跑，
     * 场景里的物体会一直动，看起来像"编辑状态坏了"。
     */
    previewMode(active) {
      if (active) {
        // 从头播，保证每次预演看到的都是完整成片。
        this.$store.commit('setTimelineTime', 0)
        this.startPlayback({ loop: true })
        return
      }
      this.stopPlayback()
      // 退出预演回到 0 时刻的编辑态，避免停在成片的某一帧上。
      this.$store.commit('setTimelineTime', 0)
    }
  },

  mounted() {
    // 诊断计数不是响应式数据，用低频 tick 驱动它刷新即可。
    this.diagnosticsTimer = window.setInterval(() => {
      this.diagnosticsTick += 1
    }, 2000)
    window.addEventListener('keydown', this.handleGlobalKey)
  },

  beforeDestroy() {
    this.stopPlayback()
    window.removeEventListener('keydown', this.handleGlobalKey)
    if (this.diagnosticsTimer) window.clearInterval(this.diagnosticsTimer)
  },

  methods: {
    async handleLogout() {
      const { resetAuthProbe } = await import('@/router')
      await this.$store.dispatch('logout')
      resetAuthProbe()
      this.$router.replace('/login')
    },
    edit(update) {
      this.$store.dispatch('editScene', update)
    },

    // ------------------------------------------------------------------
    // 顶栏
    // ------------------------------------------------------------------

    renameProject(name) {
      this.$store.commit('setProjectName', name)
    },
    toggleTheme() {
      this.$store.commit('setTheme', this.theme === 'dark' ? 'light' : 'dark')
    },

    /**
     * 进入 / 退出成片预演。
     *
     * 状态写在 store 里，因为"是否在预演"要影响多处：
     * 顶栏高亮、视口渲染路径、时间轴自动循环、编辑面板收起。
     * 放在组件 data 里的话，别的组件想读就得靠 prop 一层层传。
     */
    setPreviewMode(active) {
      this.$store.commit('setPreviewMode', active)
    },

    /**
     * 全局快捷键：预演时按 Esc 退出。
     *
     * 预演是全屏观看，鼠标可能不在任何按钮上；没有快捷键的话
     * 用户得先找到顶栏那个按钮才能退出来。
     */
    handleGlobalKey(event) {
      if (event.key !== 'Escape') return
      if (!this.previewMode) return
      event.preventDefault()
      this.setPreviewMode(false)
    },

    // ------------------------------------------------------------------
    // 工具与添加
    // ------------------------------------------------------------------

    /**
     * 工具条把两类操作混在一起：交互模式（选择/涂色/切割）与变换模式
     * （移动/旋转/缩放）。这里做一次分流，避免把 'translate' 当成
     * 涂色那样的 tool 传进视口——视口只认 select / quick-build / paint / cut。
     */
    setTool(tool) {
      if (tool === 'translate' || tool === 'rotate' || tool === 'scale') {
        this.$store.commit('setTransformMode', tool)
        this.$store.commit('setTool', 'select')
        return
      }
      this.$store.commit('setTool', tool)
      if (tool !== 'quick-build') this.$store.commit('setQuickBuildDraft', null)
      if (tool !== 'cut') this.$store.commit('setCutTool', null)
    },

    addObject(kind) {
      const object = placeNewObject(createSceneObject(kind, this.objects), this.objects)
      this.edit((scene) => ({ ...scene, objects: [...scene.objects, object] }))
      this.$store.commit('setSelection', [object.id])
      this.$store.commit('setInspectorTarget', 'selection')
      this.$refs.viewport?.focusView([object.id])
    },

    addMannequin() {
      const object = placeNewObject(createMannequinSceneObject(this.objects), this.objects)
      this.edit((scene) => ({ ...scene, objects: [...scene.objects, object] }))
      this.$store.commit('setSelection', [object.id])
      this.$store.commit('setInspectorTarget', 'selection')
      this.$refs.viewport?.focusView([object.id])
    },

    beginQuickBuild(kind) {
      this.quickBuildKind = kind
      this.$store.commit('setTool', 'quick-build')
      this.$store.commit('setQuickBuildDraft', { kind, start: null, end: null })
    },

    handleQuickBuildStart(point) {
      this.$store.commit('setQuickBuildDraft', {
        kind: this.quickBuildKind,
        start: point,
        end: point
      })
    },

    handleQuickBuildMove(point) {
      const draft = this.quickBuildDraft
      if (!draft || !draft.start) return
      this.$store.commit('setQuickBuildDraft', { ...draft, end: point })
    },

    handleQuickBuildEnd(point) {
      const draft = this.quickBuildDraft
      if (!draft || !draft.start) return
      const finished = { ...draft, end: point }
      const transform = quickBuildTransform(finished)
      this.$store.commit('setQuickBuildDraft', null)
      this.$store.commit('setTool', 'select')
      if (!transform) return

      const object = {
        ...createSceneObject(draft.kind, this.objects),
        ...transform
      }
      this.edit((scene) => ({ ...scene, objects: [...scene.objects, object] }))
      this.$store.commit('setSelection', [object.id])
    },

    // ------------------------------------------------------------------
    // 导航线
    // ------------------------------------------------------------------

    /**
     * 新建一条导航线并立即进入绘制模式。
     *
     * "新建 + 进入绘制"合成一步：用户点"导航线绘制"的意图就是
     * "我要画一条线"，先落一个空对象再让他去别处点选才画，
     * 中间多一步没有意义。
     */
    beginPathDraw() {
      const object = createPathSceneObject(this.objects)
      this.edit((scene) => ({ ...scene, objects: [...scene.objects, object] }))
      this.$store.commit('setSelection', [object.id])
      this.$store.commit('setInspectorTarget', 'selection')
      this.$store.commit('setSelectedPathNode', null)
      this.$store.commit('setTool', 'path-draw')
      this.$store.commit('setPathDraft', { pathId: object.id, nodes: [] })
      this.$store.dispatch('notify', {
        kind: 'info',
        message: '在网格上按住左键拖动即可画线，每 0.6 米自动落一个节点。'
      })
    },

    /** 对已有导航线继续绘制（追加到现有节点后面）。 */
    beginPathDrawFor(pathId) {
      const path = this.objects.find((object) => object.id === pathId)
      if (!path) return
      this.$store.commit('setSelection', [pathId])
      this.$store.commit('setSelectedPathNode', null)
      this.$store.commit('setTool', 'path-draw')
      this.$store.commit('setPathDraft', {
        pathId,
        nodes: (path.pathNodes ?? []).map((node) => ({ ...node }))
      })
    },

    /**
     * 绘制结束：把草稿节点写回对象。
     *
     * 少于 2 个节点画不出方向，直接丢弃草稿（否则会留下一条看不见的线，
     * 用户会以为是 bug）。空路径对象也一并删掉，不留垃圾数据。
     */
    finishPathDraw(payload) {
      const draft = this.pathDraft
      this.$store.commit('setPathDraft', null)
      this.$store.commit('setTool', 'select')
      if (!draft) return

      const nodes = (payload?.nodes ?? draft.nodes ?? []).map((node) => ({
        x: node.x,
        y: node.y ?? 0,
        z: node.z
      }))

      if (nodes.length < 2) {
        this.edit((scene) => ({
          ...scene,
          objects: scene.objects.filter((object) => object.id !== draft.pathId)
        }))
        this.$store.commit('setSelection', [])
        this.$store.dispatch('notify', { kind: 'info', message: '至少需要两个节点才能形成导航线。' })
        return
      }

      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === draft.pathId ? { ...object, pathNodes: nodes } : object
        )
      }))
      this.$store.commit('setSelection', [draft.pathId])
      this.$store.dispatch('notify', {
        kind: 'success',
        message: `导航线已生成 ${nodes.length} 个节点，已同步到时间轴。`
      })
    },

    /** 拖拽节点：只改坐标，时间轴标记由弧长比例自动跟随。 */
    handlePathNodeMove({ pathId, index, x, z, commit = true }) {
      if (commit) {
        this.edit((scene) => ({
          ...scene,
          objects: scene.objects.map((object) => {
            if (object.id !== pathId) return object
            const nodes = (object.pathNodes ?? []).map((node, nodeIndex) =>
              nodeIndex === index ? { ...node, x, y: 0, z } : node
            )
            return { ...object, pathNodes: nodes }
          })
        }))
        return
      }
      // 拖拽中间态：直接改视口里的几何，避免每帧压一次撤销栈。
      this.$refs.viewport?.previewPathNode(pathId, index, { x, y: 0, z })
    },

    /** 在最长段的中间插一个节点。 */
    addPathNode(pathId) {
      const path = this.objects.find((object) => object.id === pathId)
      if (!path) return
      const nodes = (path.pathNodes ?? []).map((node) => ({ ...node }))
      const insertion = pathInsertionPoint(nodes)
      const next = [...nodes]
      next.splice(insertion.index, 0, { ...insertion.position, y: 0 })

      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === pathId ? { ...object, pathNodes: next } : object
        )
      }))
      this.$store.commit('setSelectedPathNode', { pathId, index: insertion.index })
    },

    removePathNode({ id, index }) {
      const path = this.objects.find((object) => object.id === id)
      if (!path) return
      const nodes = (path.pathNodes ?? []).filter((_, nodeIndex) => nodeIndex !== index)
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) => (object.id === id ? { ...object, pathNodes: nodes } : object))
      }))
      this.$store.commit('setSelectedPathNode', null)
    },

    clearPathNodes(pathId) {
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === pathId ? { ...object, pathNodes: [] } : object
        )
      }))
      this.$store.commit('setSelectedPathNode', null)
    },

    selectPathNode({ pathId, index }) {
      this.$store.commit('setSelection', [pathId])
      this.$store.commit('setInspectorTarget', 'selection')
      this.$store.commit('setSelectedPathNode', { pathId, index })
    },

    /**
     * 绑定 / 解绑导航线。
     *
     * 绑定时记下物体当前的离地高度：路径节点贴地（y = 0），
     * 而方块中心在 1.1 米、人台在 0 米，不记高度的话方块会陷进地里。
     */
    bindPath({ id, pathId }) {
      const object = this.objects.find((item) => item.id === id)
      if (!object) return
      if (!pathId) {
        this.updateObject({ id, update: { pathBinding: undefined } })
        return
      }
      const path = this.objects.find((item) => item.id === pathId)
      if (!path || path.kind !== PATH_KIND) return
      if ((path.pathNodes ?? []).length < 2) {
        this.$store.dispatch('notify', {
          kind: 'error',
          message: '这条导航线还没有足够的节点，先在视口里画出来或手动加节点。'
        })
        return
      }
      // 以路径起点的高度为基准：让物体"看起来站在路径上"。
      const startY = path.position.y + (path.pathNodes[0]?.y ?? 0)
      const heightOffset = Math.max(object.position.y - startY, 0)
      this.updateObject({
        id,
        update: { pathBinding: createPathBinding(object, pathId, heightOffset) }
      })
      this.$store.dispatch('notify', {
        kind: 'success',
        message: `${object.name} 已绑定到「${path.name}」，拖动播放头看它沿路径运动。`
      })
    },

    // ------------------------------------------------------------------
    // 选择
    // ------------------------------------------------------------------

    handleSelection(ids) {
      this.$store.commit('setSelection', ids)
      this.$store.commit('setInspectorTarget', ids.length > 0 ? 'selection' : 'camera')
    },

    selectLight(id) {
      this.$store.commit('setSelectedLight', id)
      this.$store.commit('setInspectorTarget', 'light')
    },

    // ------------------------------------------------------------------
    // 对象修改
    // ------------------------------------------------------------------

    updateObject({ id, update }) {
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) => (object.id === id ? { ...object, ...update } : object))
      }))
    },

    /**
     * 物体变换。
     *
     * `commit === false` 表示这是拖拽过程中的中间态：只更新视口预览，
     * 不写撤销栈。松手时才 commit 一次，保证"拖一次 = 撤销一次"。
     */
    handleObjectTransform({ id, position, rotation, size, commit = true }) {
      const target = this.objects.find((object) => object.id === id)
      if (target?.locked) return
      const apply = (scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === id && !object.locked ? { ...object, position, rotation, size } : object
        )
      })
      if (commit) {
        this.edit(apply)
        return
      }
      // 预览：直接在视口里改对象根节点，不经过 store。
      const root = this.$refs.viewport?.rootMap?.get(id)
      if (!root) return
      root.position.set(position.x, position.y, position.z)
      root.rotation.set(
        (rotation.x * Math.PI) / 180,
        (rotation.y * Math.PI) / 180,
        (rotation.z * Math.PI) / 180
      )
      root.scale.set(size.x, size.y, size.z)
    },

    clearObjectKeyframes(objectId) {
      if (!objectId) return
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          objectKeyframes: scene.timeline.objectKeyframes.filter(
            (keyframe) => keyframe.objectId !== objectId
          )
        }
      }))
    },

    handleObjectsTransform({ delta, commit = true }) {
      if (commit === false) {
        // 多选拖拽的中间态：只移动视口节点，避免每帧写历史。
        for (const id of this.selectedIds) {
          const root = this.$refs.viewport?.rootMap?.get(id)
          if (!root) continue
          root.position.x += delta.x
          root.position.y += delta.y
          root.position.z += delta.z
        }
        return
      }
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          this.selectedIds.includes(object.id) && !object.locked
            ? {
                ...object,
                position: {
                  x: object.position.x + delta.x,
                  y: object.position.y + delta.y,
                  z: object.position.z + delta.z
                }
              }
            : object
        )
      }))
    },

    toggleObjectVisible(id) {
      const target = this.objects.find((object) => object.id === id)
      if (!target) return
      this.updateObject({ id, update: { visible: !target.visible } })
    },

    toggleObjectLock(id) {
      const target = this.objects.find((object) => object.id === id)
      if (!target) return
      this.updateObject({ id, update: { locked: !target.locked } })
    },

    renameObject({ id, name }) {
      this.updateObject({ id, update: { name } })
    },

    setDisplayMode(mode) {
      if (!this.selectedObject) return
      this.updateObject({ id: this.selectedObject.id, update: { displayMode: mode } })
    },

    deleteSelected() {
      const ids = new Set(this.selectedIds)
      if (ids.size === 0) return
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.filter((object) => !ids.has(object.id)),
        timeline: {
          ...scene.timeline,
          objectKeyframes: scene.timeline.objectKeyframes.filter((keyframe) => !ids.has(keyframe.objectId))
        }
      }))
      this.$store.commit('setSelection', [])
    },

    duplicateSelected() {
      const selected = this.objects.filter((object) => this.selectedIds.includes(object.id))
      if (selected.length === 0) return
      const clones = selected.map((object) => ({
        ...JSON.parse(JSON.stringify(object)),
        id: createId(),
        name: `${object.name} 副本`,
        position: { ...object.position, x: object.position.x + 1 }
      }))
      this.edit((scene) => ({ ...scene, objects: [...scene.objects, ...clones] }))
      this.$store.commit(
        'setSelection',
        clones.map((clone) => clone.id)
      )
    },

    applyLayout(operation) {
      const ids = new Set(this.selectedIds)
      this.edit((scene) => {
        let objects = scene.objects
        if (operation === 'align-x') objects = alignObjects(objects, ids, 'x', 'center')
        else if (operation === 'align-z') objects = alignObjects(objects, ids, 'z', 'center')
        else if (operation === 'distribute-x') objects = distributeObjects(objects, ids, 'x')
        else if (operation === 'distribute-z') objects = distributeObjects(objects, ids, 'z')
        else if (operation === 'ground') objects = placeOnGround(objects, ids)
        return { ...scene, objects }
      })
    },

    // ------------------------------------------------------------------
    // 人台
    // ------------------------------------------------------------------

    applyMannequinPreset({ id, presetId }) {
      const preset = MANNEQUIN_PRESETS.find((item) => item.id === presetId)
      if (!preset) return
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === id && object.mannequin
            ? {
                ...object,
                mannequin: {
                  ...object.mannequin,
                  presetId,
                  pose: JSON.parse(JSON.stringify(preset.pose)),
                  manualJoints: []
                }
              }
            : object
        )
      }))
    },

    updateMannequinHeight({ id, heightMeters }) {
      const height = Math.min(Math.max(heightMeters, 1.2), 2.2)
      this.edit((scene) => ({
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === id
            ? {
                ...object,
                size: { ...object.size, y: height },
                mannequin: object.mannequin ? { ...object.mannequin, heightMeters: height } : null
              }
            : object
        )
      }))
    },

    // ------------------------------------------------------------------
    // 面涂色
    // ------------------------------------------------------------------

    handlePaintFace({ objectId, triangle, color, scope }) {
      const object = this.objects.find((item) => item.id === objectId)
      if (!object) return
      if (scope === 'object') {
        this.updateObject({ id: objectId, update: { colorOverride: color, faceColors: undefined } })
        return
      }
      // 整面涂色：先算出这一组连通三角形，再逐块写入颜色。
      const root = this.$refs.viewport?.rootMap?.get(objectId)
      let triangles = [triangle]
      if (root) {
        root.traverse((child) => {
          if (!child.isMesh || triangles.length > 1) return
          const region = surfaceTriangles(child.geometry, triangle)
          if (region.length > 0) triangles = region
        })
      }
      const faceColors = { ...(object.faceColors ?? {}) }
      for (const index of triangles) faceColors[faceColorKey('0', index)] = color
      this.updateObject({ id: objectId, update: { faceColors } })
    },

    // ------------------------------------------------------------------
    // 切割
    // ------------------------------------------------------------------

    handleCutPick(objectId) {
      const object = this.objects.find((item) => item.id === objectId)
      if (!object) return
      this.$store.commit('setCutTool', {
        objectId,
        axis: 'y',
        offset: 0,
        keep: 'positive'
      })
    },

    // ------------------------------------------------------------------
    // 相机
    // ------------------------------------------------------------------

    updateCamera(update) {
      this.edit((scene) => ({ ...scene, camera: { ...scene.camera, ...update } }))
    },

    /** 选中场景摄影机：与物体、灯光三选一。 */
    selectCamera() {
      this.$store.commit('setCameraSelected', true)
      this.$store.commit('setInspectorTarget', 'camera')
    },

    /** 摄影机改名（资产列表里直接编辑）。 */
    renameCamera(name) {
      const trimmed = (name || '').trim()
      if (!trimmed) return
      this.updateCamera({ name: trimmed })
    },

    /** 导出诊断日志，供用户把日志发回来定位问题。 */
    exportDiagnostics() {
      const text = downloadReport()
      this.$store.dispatch('notify', {
        kind: 'info',
        message: `诊断日志已下载（${text.split('\n').length} 行）。`
      })
    },

    /** 点击空白处取消选择。 */
    clearSelection() {
      this.$store.commit('setSelection', [])
      this.$store.commit('setSelectedLight', null)
      this.$store.commit('setCameraSelected', false)
      this.$store.commit('setInspectorTarget', 'camera')
    },

    /**
     * 操作摄影机模型：平移改机位，旋转改朝向。
     *
     * `target` 由视口按"原注视距离 + 新视线方向"算出，
     * 因此旋转机身时取景方向与距离同时保持合理，不会让目标点乱跳。
     */
    handleCameraTransform({ position, target, commit = true }) {
      if (commit === false) {
        const helper = this.$refs.viewport?.cameraHelper
        if (helper && position) helper.position.set(position.x, position.y, position.z)
        // 旋转过程中的朝向预览交给视口自己处理（它会 lookAt 当前 target）。
        return
      }
      const update = {}
      if (position) update.position = position
      if (target) update.target = target
      if (Object.keys(update).length > 0) this.updateCamera(update)
    },

    setCameraViewMode(mode) {
      this.$store.commit('setCameraViewMode', mode)
      if (mode !== 'none') this.$refs.viewport?.applyCameraState(this.camera)
    },


    // ------------------------------------------------------------------
    // 灯光
    // ------------------------------------------------------------------

    addLight(kind) {
      if (this.lighting.lights.length >= 8) {
        this.$store.dispatch('notify', {
          kind: 'error',
          message: '当前场景最多使用 8 盏可编辑灯光。'
        })
        return
      }
      const light = createSceneLight(kind, this.lighting.lights)
      this.edit((scene) => ({ ...scene, lighting: { lights: [...scene.lighting.lights, light] } }))
      this.$store.commit('setSelectedLight', light.id)
      this.$store.commit('setInspectorTarget', 'light')
    },

    updateLight({ id, update }) {
      this.edit((scene) => ({
        ...scene,
        lighting: {
          lights: scene.lighting.lights.map((light) => (light.id === id ? { ...light, ...update } : light))
        }
      }))
    },

    handleLightTransform({ id, position, commit = true }) {
      if (commit === false) {
        const light = this.$refs.viewport?.lightMap?.get(id)
        if (light) light.position.set(position.x, position.y, position.z)
        return
      }
      this.updateLight({ id, update: { position } })
    },

    deleteLight(id) {
      this.edit((scene) => ({
        ...scene,
        lighting: { lights: scene.lighting.lights.filter((light) => light.id !== id) }
      }))
      this.$store.commit('setSelectedLight', null)
      this.$store.commit('setInspectorTarget', 'camera')
    },

    // ------------------------------------------------------------------
    // 时间轴
    // ------------------------------------------------------------------

    setTimelineTime(time) {
      this.$store.commit('setTimelinePlaying', false)
      this.$store.commit('setTimelineTime', time)
      // 不再把时间轴求值结果塞进编辑相机。
      // 拖动播放头只是"预览场景动画"，编辑视角必须保持不动。
    },

    togglePlay() {
      if (this.timelinePlaying) {
        this.stopPlayback()
        return
      }
      this.startPlayback()
    },

    /**
     * 开始播放时间轴。
     *
     * `loop` 只给成片预演用：预演是"看整段成片"，放完不该停在一个定格的尾帧上。
     * 循环时把计时基准重置到当前轮起点，而不是让 `elapsed` 无限增长——
     * 后者在播放几小时后会让浮点数精度明显下降，且 `startTime + elapsed`
     * 一旦超出 duration 就需要取模，反而更容易算错。
     */
    startPlayback({ loop = false } = {}) {
      this.$store.commit('setTimelinePlaying', true)
      if (this.playbackTimer) cancelAnimationFrame(this.playbackTimer)
      this.playbackLoop = loop
      const duration = this.timeline.durationSeconds
      let startedAt = performance.now()
      let startTime = this.timelineTime >= duration ? 0 : this.timelineTime
      const step = () => {
        const elapsed = (performance.now() - startedAt) / 1000
        let next = startTime + elapsed
        if (next >= duration) {
          if (!this.playbackLoop) {
            this.$store.commit('setTimelineTime', duration)
            this.stopPlayback()
            return
          }
          // 循环：把超出部分接回开头，避免丢掉这一帧的时间。
          next -= duration
          startedAt = performance.now()
          startTime = next
        }
        this.$store.commit('setTimelineTime', next)
        this.playbackTimer = requestAnimationFrame(step)
      }
      this.playbackTimer = requestAnimationFrame(step)
    },

    stopPlayback() {
      this.$store.commit('setTimelinePlaying', false)
      if (this.playbackTimer) cancelAnimationFrame(this.playbackTimer)
      this.playbackTimer = null
      this.playbackLoop = false
    },

    recordCameraShot() {
      const shot = {
        id: createId(),
        name: `镜头 ${String(this.timeline.cameraShots.length + 1).padStart(2, '0')}`,
        timeSeconds: this.timelineTime,
        transition: this.timeline.cameraShots.length === 0 ? 'cut' : 'smooth',
        camera: JSON.parse(JSON.stringify(this.camera))
      }
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          cameraShots: [...scene.timeline.cameraShots, shot].sort((a, b) => a.timeSeconds - b.timeSeconds)
        }
      }))
      this.$store.commit('setSelectedShotId', shot.id)
    },

    recordObjectKeyframe() {
      if (!this.selectedObject) {
        this.$store.dispatch('notify', { kind: 'info', message: '请先选中一个物体。' })
        return
      }
      const object = this.selectedObject
      const keyframe = {
        id: createId(),
        objectId: object.id,
        timeSeconds: this.timelineTime,
        interpolation: 'smooth',
        transform: {
          position: { ...object.position },
          rotation: { ...object.rotation },
          size: { ...object.size },
          mannequinPose: object.mannequin ? JSON.parse(JSON.stringify(object.mannequin.pose)) : undefined,
          mannequinPresetId: object.mannequin?.presetId
        }
      }
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          objectKeyframes: [...scene.timeline.objectKeyframes, keyframe].sort(
            (a, b) => a.timeSeconds - b.timeSeconds
          )
        }
      }))
      this.$store.commit('setSelectedKeyframeId', keyframe.id)
    },

    updateDuration(durationSeconds) {
      const duration = Math.max(durationSeconds, 1)
      this.edit((scene) => ({
        ...scene,
        timeline: { ...scene.timeline, durationSeconds: duration }
      }))
    },

    duplicateShot(id) {
      const source = this.timeline.cameraShots.find((shot) => shot.id === id)
      if (!source) return
      const copy = {
        ...JSON.parse(JSON.stringify(source)),
        id: createId(),
        name: `${source.name} 副本`,
        timeSeconds: Math.min(source.timeSeconds + 0.5, this.timeline.durationSeconds)
      }
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          cameraShots: [...scene.timeline.cameraShots, copy].sort((a, b) => a.timeSeconds - b.timeSeconds)
        }
      }))
      this.$store.commit('setSelectedShotId', copy.id)
    },

    deleteShot(id) {
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          cameraShots: scene.timeline.cameraShots.filter((shot) => shot.id !== id)
        }
      }))
      this.$store.commit('setSelectedShotId', null)
    },

    duplicateKeyframe(id) {
      const source = this.timeline.objectKeyframes.find((keyframe) => keyframe.id === id)
      if (!source) return
      const copy = {
        ...JSON.parse(JSON.stringify(source)),
        id: createId(),
        timeSeconds: Math.min(source.timeSeconds + 0.5, this.timeline.durationSeconds)
      }
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          objectKeyframes: [...scene.timeline.objectKeyframes, copy].sort(
            (a, b) => a.timeSeconds - b.timeSeconds
          )
        }
      }))
      this.$store.commit('setSelectedKeyframeId', copy.id)
    },

    deleteKeyframe(id) {
      this.edit((scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          objectKeyframes: scene.timeline.objectKeyframes.filter((keyframe) => keyframe.id !== id)
        }
      }))
      this.$store.commit('setSelectedKeyframeId', null)
    },

    // ------------------------------------------------------------------
    // 导入
    // ------------------------------------------------------------------

    triggerImport() {
      this.$refs.modelInput.click()
    },

    async handleModelFiles(event) {
      const files = [...event.target.files]
      event.target.value = ''
      if (files.length === 0) return

      const primary = files.find((file) => /\.(glb|gltf|obj)$/i.test(file.name))
      if (!primary) {
        this.$store.dispatch('notify', { kind: 'error', message: '请选择 GLB、GLTF 或 OBJ 文件。' })
        return
      }
      const format = primary.name.split('.').pop().toLowerCase()
      const resources = []
      for (const file of files) {
        if (file === primary) continue
        resources.push({
          name: file.name,
          data: /\.(bin|glb)$/i.test(file.name) ? await file.arrayBuffer() : await file.text()
        })
      }

      this.$store.commit('setBusy', true)
      try {
        const data =
          format === 'obj' || format === 'gltf' ? await primary.text() : await primary.arrayBuffer()
        const root = await importStaticModel(data, format, resources)
        const report = analyzeModel(root)
        if (report.issues.some((issue) => issue.severity === 'error')) {
          throw new Error(report.issues.find((issue) => issue.severity === 'error').message)
        }
        const asset = {
          format,
          sourceName: primary.name,
          report
        }
        const object = {
          ...createSceneObject('box', this.objects),
          kind: 'imported',
          name: primary.name,
          importedAsset: asset,
          previewQuality: 'original',
          exportQuality: 'original'
        }
        this.edit((scene) => ({ ...scene, objects: [...scene.objects, object] }))
        this.importedModels.set(object.id, root)
        this.$store.commit('setSelection', [object.id])
        this.$store.dispatch('notify', {
          kind: report.triangleCount > 500_000 ? 'info' : 'success',
          message: `已导入 ${primary.name}，共 ${report.triangleCount.toLocaleString()} 个三角面。`
        })
      } catch (error) {
        this.$store.dispatch('notify', { kind: 'error', message: `导入失败：${error.message}` })
      } finally {
        this.$store.commit('setBusy', false)
      }
    },

    // ------------------------------------------------------------------
    // AI
    // ------------------------------------------------------------------

    async sendAi(content) {
      await this.$store.dispatch('sendAiMessage', {
        content,
        // Agent 截图 / 时间轴工具在浏览器视口上执行。
        viewport: this.$refs.viewport || null
      })
    },

    handleAiImages(images) {
      this.$store.commit('addPendingAiImages', images)
      this.$store.dispatch('notify', {
        kind: 'info',
        message: `已附加 ${images.length} 张参考图，将随下一条消息发送。`
      })
    },

    // ------------------------------------------------------------------
    // 导入模型网格同步
    // ------------------------------------------------------------------

    /**
     * 把已解析的导入模型交给视口。
     *
     * 视口重建物体（例如撤销、重新加载）后会丢失真实网格，
     * 因此每次物体列表变化都要重新注入一次，否则只剩占位方块。
     */
    syncImportedMeshes() {
      const viewport = this.$refs.viewport
      if (!viewport) return
      for (const [objectId, root] of this.importedModels) {
        if (this.objects.some((object) => object.id === objectId)) {
          viewport.setImportedMesh(objectId, root)
        }
      }
    }
  }
}
</script>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-0);
}

.editor-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.editor-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg-0);
}

/*
 * 预演 HUD 浮在视口左下角。
 * 放左下是因为成片画面居中、四周是黑边，左下角几乎不会压到主体内容。
 */
.preview-hud {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: rgba(12, 15, 17, 0.82);
  color: var(--text-0);
  font-size: 12px;
  backdrop-filter: blur(6px);
}

.preview-hud__badge {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--accent-strong);
  color: #fff;
  font-weight: 600;
}

.preview-hud__meta {
  color: var(--text-2);
}

.editor-sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  min-height: 0;
  border-left: 1px solid var(--line);
  background: var(--bg-1);
  flex: none;
}

.stage-hint {
  position: absolute;
  top: 12px;
  left: 50%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 6px 14px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: var(--panel-blur);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow-panel);
  color: var(--text-1);
  font-size: 12px;
  transform: translateX(-50%);
}

.stage-hint .btn {
  height: 22px;
  font-size: 11px;
}

</style>
