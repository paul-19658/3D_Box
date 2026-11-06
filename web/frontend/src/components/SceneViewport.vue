<template>
  <div class="viewport">
    <canvas ref="canvas" class="viewport-canvas"></canvas>
    <div class="viewport-hud">
      <button
        v-if="cameraViewActive"
        type="button"
        class="hud-pill hud-pill--camera-view"
        title="退出相机视角 (Esc)"
        @click="$emit('camera-view-change', 'exit')"
      >
        相机视角 · 退出 (Esc)
      </button>
      <button
        v-if="cameraViewMode !== 'none'"
        type="button"
        class="hud-pill"
        @click="$emit('camera-view-change', 'none')"
      >
        退出取景
      </button>
      <button
        v-if="cameraSelected"
        type="button"
        class="hud-pill"
        :class="{ 'is-on': monitorOpen }"
        @click="$emit('toggle-monitor')"
      >
        {{ monitorOpen ? '关闭监视器' : '监视器' }}
      </button>
      <span v-if="tool === 'quick-build'" class="hud-pill hud-pill--hint">
        按住拖出{{ quickBuildDraft && quickBuildDraft.kind === 'wall' ? '墙体' : '地面' }}
      </span>
      <span v-if="tool === 'paint'" class="hud-pill hud-pill--hint">
        点击面片涂色 · {{ paintScope === 'face' ? '整面' : '整物体' }}
      </span>
      <span v-if="tool === 'cut'" class="hud-pill hud-pill--hint">选择物体后调整切割平面</span>
      <span v-if="pathDraft" class="hud-pill hud-pill--hint">
        按住左键在网格上画线 · 每 {{ nodeSpacing }} 米一个节点
      </span>
    </div>

    <!--
      监视器：独立一块画布，用第二个 WebGLRenderer 从场景摄影机的视角渲染。
      不共用主渲染器是因为一个 WebGLRenderer 只能绑定一个 canvas；
      要画到两块画布上，要么走 RenderTarget 读像素（每帧回读，卡），
      要么就再开一个上下文（成本低得多）。
    -->
    <div
      v-if="monitorOpen"
      class="monitor"
      :style="{ left: `${monitorRect.x}px`, top: `${monitorRect.y}px`, width: `${monitorRect.w}px` }"
    >
      <header class="monitor__head" @pointerdown="startMonitorDrag">
        <span class="monitor__title">监视器</span>
        <span class="monitor__meta">{{ monitorLabel }}</span>
        <button type="button" class="monitor__close" title="关闭" @click="$emit('toggle-monitor')">
          ×
        </button>
      </header>
      <canvas ref="monitor" class="monitor__canvas" :style="{ height: `${monitorRect.h}px` }"></canvas>
      <div class="monitor__grip" @pointerdown="startMonitorResize"></div>
    </div>
  </div>
</template>

<script>
/**
 * 三维视口：Three.js 场景、相机控制与直接操作。
 *
 * 职责边界（重要）：
 * - 本组件只负责"把场景画出来"和"把用户手势翻译成事件"；
 * - 所有数据修改都通过 `$emit` 抛给父组件，由 Vuex action 统一提交，
 *   这样撤销 / 重做 / 自动保存的行为保持一致。
 *
 * three.js 对象不进入 Vue 响应式系统：它们放在组件实例字段里，
 * 否则深度侦测会在每帧产生大量开销。
 */

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js'

import { createGeometry } from '@/core/geometry'
import { createMannequinRig, applyMannequinPose } from '@/core/mannequin'
import { createMannequinVisual, mannequinVisualState } from '@/core/mannequin-visual'
import {
  PATH_KIND,
  PATH_NODE_SPACING,
  adjacentSegmentsFor,
  closestPointOnSegmentsToRay
} from '@/core/nav-path'
import { applyTimelinePreview, evaluateTimelineAtTime } from '@/core/timeline'
import { record } from '@/core/diagnostics'
import { FIXED_FILL_LIGHT, FIXED_HEMISPHERE_LIGHT } from '@/core/project-document'
import { resolveShadowCasterIds } from '@/core/lighting-description'
import { objectIdColor } from '@/core/object-id-color'
import { outputSize } from '@/core/video'
import { registerSceneProbe } from '@/core/diagnostics'
import {
  WASD_DEFAULTS,
  applyLookDelta,
  cameraTargetFromOrientation,
  clampDelta,
  computeFlyOffset,
  isEditableTarget,
  movementIntentFromKeys,
  navSchemeHandler,
  orientationFromCameraTarget,
  shouldRunOrbitControls
} from '@/core/camera-nav'
import { objectFocusPoint } from '@/core/camera-target'

/**
 * `TransformControls.setMode()` 接受的三个值。
 *
 * `transformMode` 还允许 `'select'`——那是"纯选择、不显示操纵器"
 * （对标 Maya 的 Q），必须在这里挡掉，不能透传给 TransformControls。
 */
const TRANSFORM_MODES = ['translate', 'rotate', 'scale']

/**
 * gizmo 拖拽的减速系数（1 = 鼠标移动多少物体就移动多少）。
 *
 * 实测当前手感是精确 1:1——60px 鼠标位移对应 0.6142 世界单位，
 * 与几何期望 `2·tan(fov/2)·距离 / 画布高度` 完全一致（1.00×），
 * 也就是说并不存在放大 bug，纯粹是"太快、不好精确定位"的手感问题。
 *
 * 取 0.5：同样的鼠标位移只走一半距离，定位精度翻倍。
 * 想更慢 / 更快改这一个常量即可（必须落在 (0, 1] 内）。
 *
 * 实现代价很小，但语义上有两点要注意：
 * 1. 只对**场景物体**减速，摄影机模型仍 1:1——它的位姿直接变成机位，
 *    减速会让取景变得迟钝，那不是用户想要的"更精细"。
 * 2. 每帧都从**按下时的快照**重新换算，而不是在上一帧结果上累乘。
 *    TransformControls 本身是按"指针相对按下点的位移"算绝对值的，
 *    所以从快照换算既不会漂移，也不会因为帧率不同而产生不同结果。
 */
const TRANSFORM_DRAG_SENSITIVITY = 0.5

let rectAreaLightReady = false

/**
 * 面光必须先初始化 LTC 查找表，否则 three.js 会静默渲染成纯环境光。
 * 默认场景主光就是面光，所以这一步不能省。
 * 只执行一次：init 会生成两张 64×64 纹理，重复调用会反复占显存。
 */
function ensureRectAreaLightSupport() {
  if (rectAreaLightReady) return
  RectAreaLightUniformsLib.init()
  rectAreaLightReady = true
}

function disposeObject(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose()
    const materials = Array.isArray(child.material) ? child.material : [child.material]
    for (const material of materials) {
      if (!material) continue
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose()
      }
      material.dispose()
    }
  })
}

/** 清空一个组并释放其几何与材质，用于"临时视图"整体重绘。 */
function clearGroup(group) {
  for (const child of [...group.children]) {
    group.remove(child)
    disposeObject(child)
  }
}

export default {
  name: 'SceneViewport',

  props: {
    objects: { type: Array, required: true },
    cameraState: { type: Object, required: true },
    lighting: { type: Object, required: true },
    selectedIds: { type: Array, default: () => [] },
    selectedLightId: { type: String, default: null },
    transformMode: { type: String, default: 'translate' },
    tool: { type: String, default: 'select' },
    modelingDraft: { type: Object, default: null },
    quickBuildDraft: { type: Object, default: null },
    cutTool: { type: Object, default: null },
    paintColor: { type: String, default: '#ff6b6b' },
    paintScope: { type: String, default: 'object' },
    theme: { type: String, default: 'dark' },
    cameraViewMode: { type: String, default: 'none' },
    /**
     * 相机视角导航：视口锁定为场景摄影机的眼睛，导航手势写回相机属性。
     *
     * 与 `cameraViewMode` 的区别见 store 里的注释：那个只读取景，这个会改相机。
     */
    cameraViewActive: { type: Boolean, default: false },
    /** 导航方案标识（`wasd` / `orbit`），实现见 core/camera-nav.js。 */
    cameraNavScheme: { type: String, default: 'wasd' },
    /** 场景摄影机是否被选中——决定高亮与是否挂载控制柄。 */
    cameraSelected: { type: Boolean, default: false },
    /** 是否显示"摄影机监视器"小窗。 */
    monitorOpen: { type: Boolean, default: false },
    /**
     * 成片预演：视口不再渲染编辑视角，而是按成片画幅渲染场景摄影机。
     *
     * 预演必须与导出画面**同源**——同一台相机、同一套求值、同一份画幅。
     * 否则用户看到的"预演"和最终导出的视频对不上，
     * 而这个差异只能在拿到成片时才发现，反馈链路太长了。
     */
    previewActive: { type: Boolean, default: false },
    /**
     * 时间轴当前时间（秒）。人台动作靠它驱动：
     * 与原版一致，播放头一动，所选动作的循环画面就跟着走。
     */
    animationTime: { type: Number, default: 0 },
    /**
     * 导航线绘制草稿：{ pathId, nodes: [{x,y,z}] }。
     * 非空时左键手势变成"按住画线"，不再转动视角、也不再拾取物体。
     */
    pathDraft: { type: Object, default: null },
    /** 当前选中的导航线节点 { pathId, index }，用于高亮。 */
    selectedPathNode: { type: Object, default: null }
  },

  data() {
    return {
      ready: false,
      canvasWidth: 0,
      canvasHeight: 0,
      /** 容器尺寸监听器（见 mounted 里的说明）。 */
      resizeObserver: null,
      // 监视器窗体的位置与尺寸。位置是相对视口左上角的像素值。
      monitorRect: { x: 0, y: 0, w: 268, h: 151 },
      monitorReady: false,
      /** 预演画面在视口里的实际像素区域（其余部分是黑边），供探针读取。 */
      previewRect: null,
      /** 导出进行中：暂停主渲染循环，避免与逐帧导出互相踩。 */
      exporting: false,
      /** 当前是否处于"手势独占"（拖拽造物 / 画线）——期间 OrbitControls 必须禁用。 */
      exclusiveGestureActive: false
    }
  },

  computed: {
    /** 绘制提示里显示的节点间距（米）。 */
    nodeSpacing() {
      return PATH_NODE_SPACING
    },
    /** 监视器标题右侧的提示：画幅比 + 当前是否与主视图同源。 */
    monitorLabel() {
      const state = this.cameraState
      if (!state) return ''
      return `${state.aspectWidth}:${state.aspectHeight} · ${Math.round(state.fovDegrees)}°`
    }
  },

  watch: {
    objects: { handler: 'rebuildObjects', deep: true },
    lighting: { handler: 'rebuildLights', deep: true },
    // 绘制草稿与选中节点只影响导航线的辅助显示，重建路径组即可。
    pathDraft: 'rebuildPaths',
    selectedPathNode: 'rebuildPaths',
    selectedLightId: 'rebuildLights',
    theme: ['applyTheme', 'rebuildCameraHelper'],
    transformMode: 'attachTransformControls',
    selectedIds: 'attachTransformControls',
    modelingDraft: { handler: 'renderModelingDraft', deep: true },
    cutTool: { handler: 'renderCutPlane', deep: true },
    // 相机位姿、视场角、画幅任一变化都要重画摄影机模型与视锥。
    cameraState: { handler: 'rebuildCameraHelper', deep: true },
    cameraSelected: ['rebuildCameraHelper', 'attachTransformControls'],
    /*
     * 导航方案变化时重建导航状态。
     *
     * 必须由组件自己响应 prop 变化，而不是让父组件在 commit 之后同步调用：
     * Vue 的 props 是异步更新的，父组件紧接着调用时这里读到的 `cameraNavScheme`
     * 还是旧值，`beginCameraView()` 就会按旧方案设置 `controls.enabled`。
     * 从 wasd 切到 orbit 时 OrbitControls 被误设成禁用 → 环绕完全失效，
     * 只剩中键转向，表现就是"只能转动镜头本身的旋转属性"。
     */
    cameraNavScheme() {
      if (this.cameraViewActive) this.resetCameraNavState()
    },
    /*
     * 进出相机视角：重画相机模型（进入时要隐藏它，退出时恢复），
     * 并把 gizmo 摘掉——相机视角里不该有可拖动的控制柄，
     * 否则中键拖拽会被 TransformControls 抢先。
     */
    cameraViewActive() {
      this.rebuildCameraHelper()
      /*
       * 两种情况都调 `attachTransformControls()`：它内部会跳过
       * "场景相机自身"的控制柄，但**物体与灯光的控制柄照常挂载**——
       * 取景时用户仍然需要直接摆物体（这是"事件优先级"需求的前提）。
       * 之前这里写的是 `transformControls?.detach()`，会让物体 gizmo
       * 在进入相机视角的瞬间消失，且不会自动恢复。
       */
      this.attachTransformControls()
    },
    // 监视器开合时画布才刚出现在 DOM 里，必须等下一帧再初始化渲染器。
    monitorOpen(value) {
      if (value) this.$nextTick(() => this.initMonitor())
      else this.disposeMonitor()
    },
    /*
     * 进出预演时收回编辑手柄。
     *
     * 控制柄与选中框会在预演期间被 `withEditorOverlaysHidden()` 临时隐藏，
     * 但 gizmo 仍然"挂"在物体上、仍然会在 pointerdown 时抢事件。
     * 预演里不该有任何可拖动的东西，所以直接把挂钩摘掉，
     * 退出时再由 attachTransformControls 按当前选中恢复。
     */
    previewActive(active) {
      /*
       * 进出预演会隐藏/显示工具栏与侧边栏 → 视口尺寸变化。
       *
       * ResizeObserver 一般能兜住，但它在"下一帧之前"才回调；而预演的第一帧
       * 可能在这之前就画了。那次画出来的尺寸还是旧的，canvas 被 CSS 拉伸
       * （实测 1.2862×，即"画面扁扁的"）。所以这里显式补一次。
       */
      this.$nextTick(() => this.handleResize())
      if (active) {
        // 预演期间禁止一切编辑手势：拾取会选中物体、拖拽会改数据。
        this.controls.enabled = false
        this.transformControls?.detach()
        this.updateSelectionHelper()
        return
      }
      // 退出预演必须解锁，否则用户会觉得"镜头忽然不能转了"。
      this.controls.enabled = true
      this.attachTransformControls()
      this.updateSelectionHelper()
    },
    /*
     * 时间轴一动就重放人台动作。
     *
     * 不能放到 animate() 里每帧无条件重放：updateMannequinVisual 会
     * 遍历所有骨骼并做四元数运算，没人台时是纯浪费；
     * 而且拖动播放头时 Vue 会合并同一帧内的多次改动，放在 watch 里
     * 天然就是一帧一次。
     */
    animationTime: 'refreshMannequinActions'
  },

  mounted() {
    this.init()
    window.addEventListener('resize', this.handleResize)
    /*
     * 只监听 window.resize 是不够的：**布局变了但窗口没变**同样会改变
     * 视口尺寸。典型场景就是进入成片预演——工具栏和侧边栏被 v-if 隐藏，
     * 视口从 1244 变宽到 1600，但没触发 window.resize。
     *
     * 而 canvas 的 CSS 是 `width/height: 100%`（见 styles/index.css），
     * 绘制缓冲却由 `renderer.setSize(w, h, false)` 决定（第三参数 false =
     * **不改样式**）。于是缓冲停留在 1244×750、CSS 盒子变成 1600×750，
     * 浏览器把画面横向拉伸 —— 实测 1.2862×，用户看到的就是"画面扁扁的"。
     *
     * 用 ResizeObserver 盯住容器本身，任何布局变化都能补上。
     */
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize())
      this.resizeObserver.observe(this.$el)
    }
    this.handleResize()
  },

  beforeDestroy() {
    window.removeEventListener('resize', this.handleResize)
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    this.disposeAll()
  },

  methods: {
    init() {
      const canvas = this.$refs.canvas
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      this.renderer = renderer

      ensureRectAreaLightSupport()

      const scene = new THREE.Scene()
      this.scene = scene

      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
      camera.position.set(7.5, 5.5, 8.5)
      this.camera = camera

      const controls = new OrbitControls(camera, canvas)
      controls.enableDamping = true
      controls.dampingFactor = 0.075
      controls.screenSpacePanning = true
      controls.minDistance = 1.2
      controls.maxDistance = 180
      controls.target.set(0, 1, 0)
      // 左键拖拽环绕镜头（直觉操作），右键平移，滚轮推拉。
      // 之前把 LEFT 设成 PAN，用户必须按中键才能转视角，手感完全不对。
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      }
      // 触屏：单指环绕、双指推拉+平移。
      controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
      this.controls = controls

      // 组结构固定：对象 / 灯光 / 辅助图形分离，导出时只取对象组。
      this.objectGroup = new THREE.Group()
      scene.add(this.objectGroup)

      this.userLightGroup = new THREE.Group()
      scene.add(this.userLightGroup)

      this.guideGroup = new THREE.Group()
      scene.add(this.guideGroup)

      // 建模草稿与切割平面单独成组：它们是"临时视图"，不参与导出。
      this.modelingGroup = new THREE.Group()
      scene.add(this.modelingGroup)

      this.cutGroup = new THREE.Group()
      scene.add(this.cutGroup)

      /*
       * 导航线的显示单独成组，且挂在 scene 上（不是 objectGroup）。
       *
       * 原因：objectGroup 是"导出时只取这一组"的语义，
       * 而导航线是辅助引导线，不该出现在导出的模型里。
       * 放在 guideGroup 又会和灯光辅助混在一起被 clearGroup 清掉。
       */
      this.pathGroup = new THREE.Group()
      scene.add(this.pathGroup)

      this.buildEnvironment()

      this.transformControls = new TransformControls(camera, canvas)
      this.transformControls.size = 0.85
      this.transformControls.addEventListener('dragging-changed', (event) => {
        /*
         * 拖 gizmo 时锁住 OrbitControls，避免同一次拖拽既摆物体又转镜头。
         *
         * 松手后的解锁**不能**简单写 `controls.enabled = true`：
         * `wasd` 相机视角下相机归导航独占，OrbitControls 必须保持关闭，
         * 否则拖完物体导航就被悄悄交还给 OrbitControls，
         * 表现为"拖过一次物体后 WASD 不灵了 / 视角开始自己转"。
         */
        controls.enabled = event.value
          ? false
          : shouldRunOrbitControls(this.cameraViewActive, this.cameraNavScheme)
        // 记录拖拽状态：重建摄影机模型时据此跳过销毁，
        // 否则拖到一半控制柄会突然脱手。
        this.transformDragging = event.value
        // 按下时快照原始变换，供 `dampTransformDuringDrag()` 做减速换算。
        this.dragStartTransform = event.value ? this.snapshotTransform() : null
        // 松手时才提交一次，这样"拖动一次 = 一次撤销"。
        if (!event.value) this.emitTransform(true)
      })
      // 拖拽过程中只发预览，不写历史。
      this.transformControls.addEventListener('objectChange', () => {
        this.dampTransformDuringDrag()
        this.emitTransform(false)
      })
      // 拖拽过程中只发预览，不写历史。
      this.transformControls.addEventListener('objectChange', () => this.emitTransform(false))
      scene.add(this.transformControls.getHelper())

      /*
       * 预演专用相机。
       *
       * 为什么不复用 `this.camera`：编辑相机归 OrbitControls 管，
       * 复用的话每帧都要写它的位姿，用户退出预演后视角就回不去了
       * （还得额外存快照、还原、处理阻尼残量）。
       * 单开一台成本极低，也让"预演不许动编辑视角"成为结构性事实。
       */
      this.previewCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 2000)

      this.raycaster = new THREE.Raycaster()
      this.pointer = new THREE.Vector2()

      canvas.addEventListener('pointerdown', this.handlePointerDown)
      canvas.addEventListener('pointermove', this.handlePointerMove)
      canvas.addEventListener('pointerup', this.handlePointerUp)
      canvas.addEventListener('contextmenu', this.preventContextMenu)

      // 不用 THREE.Clock：动画完全由时间轴驱动，不需要墙钟时间，
      // 而且它已被 three.js 标记为弃用（会污染控制台）。
      this.importedModels = new Map()

      // 顺序很关键：rebuildObjects / rebuildLights / attachTransformControls
      // 都会在最前面检查 `if (!this.ready) return`，因此 ready 必须先置真。
      // 之前 ready 放在这些调用之后，导致默认灯光根本没有被创建——
      // 场景里只剩环境光，画面自然一片黑。
      this.ready = true

      this.rebuildObjects()
      this.rebuildLights()
      this.rebuildPaths()
      this.rebuildCameraHelper()
      this.attachTransformControls()

      // 必须在第一帧之前量一次尺寸：canvas 是替换元素，未显式设置时
      // 会保持 300×150 的默认内联尺寸，导致画面被压成一小块。
      this.handleResize()

      // 注册只读场景探针。三维内容不在 DOM 里，自动化验证脚本没法
      // 用选择器去判断"控制柄在屏幕的哪个像素"，只能靠 three.js 自己算。
      registerSceneProbe(() => this.describeScene(), {
        project: (point) => this.projectToCanvas(point),
        editorCamera: () => this.describeEditorCamera()
      })

      this.animate()
    },

    // ------------------------------------------------------------------
    // 诊断探针（只读）
    // ------------------------------------------------------------------

    /** 世界坐标 → 相对视口的屏幕坐标（clientX/clientY 语义）。 */
    projectToScreen(worldPoint) {
      const canvas = this.$refs.canvas
      if (!canvas || !this.camera) return null
      const projected = worldPoint.clone().project(this.camera)
      const rect = canvas.getBoundingClientRect()
      return {
        x: rect.left + ((projected.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - projected.y) / 2) * rect.height,
        inFront: projected.z < 1
      }
    },

    /**
     * 世界坐标 → 画布**局部**像素坐标（相对 canvas 左上角，不含滚动偏移）。
     * 验证脚本拿到这个值后加上 canvas 的 rect.left/top，即可派发指针事件。
     */
    projectToCanvas(worldPoint) {
      const canvas = this.$refs.canvas
      if (!canvas || !this.camera || !worldPoint) return null
      // 投影前先刷新矩阵世界：相机可能刚被 focusView / 时间轴改过，
      // 不刷新会拿到上一帧的变换，投影结果就是错的。
      this.camera.updateMatrixWorld()
      const projected = new THREE.Vector3(worldPoint.x, worldPoint.y, worldPoint.z).project(this.camera)
      const rect = canvas.getBoundingClientRect()
      return {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((1 - projected.y) / 2) * rect.height,
        inFront: projected.z < 1
      }
    },

    /**
     * 摄影机模型朝向自检。
     *
     * 返回两个方向的点积：模型本地 -Z（即视锥朝向）与"位置→target"方向。
     * 正常情况下这个值应当接近 **1**（视锥指向目标）；
     * 如果接近 -1，就说明视锥背对目标——那正是"视锥背对物体、
     * 监视器里却有画面"的成因（监视器用的是真相机，不受模型朝向影响）。
     */
    describeCameraHelper() {
      const helper = this.cameraHelper
      const state = this.cameraState
      if (!helper || !state) return null

      helper.updateMatrixWorld(true)
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(helper.quaternion).normalize()
      const toTarget = new THREE.Vector3(
        state.target.x - state.position.x,
        state.target.y - state.position.y,
        state.target.z - state.position.z
      )
      if (toTarget.lengthSq() === 0) return null
      toTarget.normalize()

      const round = (value) => Math.round(value * 1000) / 1000
      const dot = helper.userData.targetDot
      return {
        forward: { x: round(forward.x), y: round(forward.y), z: round(forward.z) },
        toTarget: { x: round(toTarget.x), y: round(toTarget.y), z: round(toTarget.z) },
        // 1 = 视锥正对目标；-1 = 完全背对。
        facingDot: round(forward.dot(toTarget)),
        // 目标点标记在世界空间里离 target 有多远（用于确认它没被旋转错位）。
        targetDotDistance: dot ? round(dot.getWorldPosition(new THREE.Vector3()).distanceTo(
          new THREE.Vector3(state.target.x, state.target.y, state.target.z)
        )) : null
      }
    },

    /** 编辑视角相机的位姿快照，供验证脚本判断"时间轴有没有把镜头带走"。 */
    describeEditorCamera() {
      if (!this.camera) return null
      const round = (value) => Math.round(value * 1000) / 1000
      return {
        position: {
          x: round(this.camera.position.x),
          y: round(this.camera.position.y),
          z: round(this.camera.position.z)
        },
        target: {
          x: round(this.controls?.target.x ?? 0),
          y: round(this.controls?.target.y ?? 0),
          z: round(this.controls?.target.z ?? 0)
        },
        // 导出会临时改 aspect 再还原。把它暴露出来，验证脚本才能确认
        // "导完视频视口没有变形"——这是最容易漏掉且最难靠肉眼发现的回归。
        aspect: round(this.camera.aspect),
        fov: round(this.camera.fov),
        // 造物/画线手势期间会临时禁用 OrbitControls。合成 PointerEvent
        // 驱动不了 OrbitControls（它依赖真实 pointer capture），所以
        // "镜头有没有被锁死"只能靠读这两个字段判断，不能靠模拟拖拽。
        controlsEnabled: Boolean(this.controls && this.controls.enabled),
        exclusiveGesture: Boolean(this.exclusiveGestureActive)
      }
    },

    /**
     * 算出控制柄各轴手柄当前所在的屏幕位置。
     *
     * 为什么不能直接投影拾取网格：picker 里的每个手柄虽然带着
     * `[0.3, 0, 0]` 这类偏移，但 TransformControls 在 updateMatrixWorld
     * 里会对每个 handle 执行 `position.copy(worldPosition)` —— 也就是说
     * 运行时它们的世界坐标全都被压回到控制柄中心，只有 `scale` 在变。
     * 直接投影得到的是一堆重合在中心的点，没法用来定位。
     *
     * 因此这里按 TransformControls 自己的公式复算手柄端点：
     *   factor = distance(pivot, camera) * min(1.9 * tan(fov/2), 7)
     *   scale  = factor * controls.size / 4
     * 平移拾取锥在局部坐标里沿轴从 0 铺到 0.6（几何被烘焙进顶点），
     * 取 0.45 * scale 处的点，既在锥体内部、又离中心足够远，
     * 投影到屏幕就是"屏幕上该往哪拖、拖多远"。
     *
     * 这条公式只在探针里用于生成验证脚本的抓取点，不参与渲染。
     */
    describeGizmoHandles() {
      const controls = this.transformControls
      const pivot = controls?.object
      if (!controls || !pivot || !this.camera || !this.scene) return null

      this.scene.updateMatrixWorld(true)
      const centerWorld = new THREE.Vector3()
      pivot.getWorldPosition(centerWorld)
      const center = this.projectToScreen(centerWorld)
      if (!center) return null

      // 与 TransformControls.updateMatrixWorld 保持同一套缩放。
      const cameraPosition = new THREE.Vector3()
      this.camera.getWorldPosition(cameraPosition)
      const distanceToCamera = centerWorld.distanceTo(cameraPosition)
      const factor =
        distanceToCamera * Math.min(1.9 * Math.tan((Math.PI * this.camera.fov) / 360), 7)
      const scale = (factor * (controls.size ?? 1)) / 4

      // 控制柄朝向：space 为 'local' 时跟随物体自身姿态，否则用世界轴。
      // 注意属性是 `space`，不是 `mode`（mode 指的是 translate/rotate/scale）。
      const orientation = controls.space === 'local' ? pivot.quaternion : null
      const axes = {
        X: new THREE.Vector3(1, 0, 0),
        Y: new THREE.Vector3(0, 1, 0),
        Z: new THREE.Vector3(0, 0, 1)
      }

      const handles = []
      for (const [axis, direction] of Object.entries(axes)) {
        const tip = direction.clone().multiplyScalar(scale * 0.5)
        if (orientation) tip.applyQuaternion(orientation)
        tip.add(centerWorld)

        const screen = this.projectToScreen(tip)
        if (!screen) continue

        const offsetX = screen.x - center.x
        const offsetY = screen.y - center.y
        const pixelDistance = Math.hypot(offsetX, offsetY)
        // 轴几乎正对镜头时投影会退化成一个点，这种轴本来也点不中，跳过。
        if (pixelDistance < 6) continue

        handles.push({
          axis,
          x: Math.round(screen.x),
          y: Math.round(screen.y),
          distance: Math.round(pixelDistance),
          // 屏幕上的推进方向 = 中心指向轴端点。轴箭头沿轴摆放，
          // 所以"从中心往外推"等价于"沿轴推"。
          dx: Math.round((offsetX / pixelDistance) * 1000) / 1000,
          dy: Math.round((offsetY / pixelDistance) * 1000) / 1000
        })
      }

      return {
        mode: controls.mode,
        center: { x: Math.round(center.x), y: Math.round(center.y) },
        handles
      }
    },

    /**
     * 人台状态快照，供验证脚本判定"外观到底有没有加载出来"。
     *
     * 三个关键观测点：
     * - `visualReady`：GLB 是否已挂载（否则只是白模控制骨架）
     * - `meshCount`：外观的网格数量（0 说明模型是空的）
     * - `actionClip` / `actionTime`：当前播的是哪段动作、播到第几秒
     */
    describeMannequin(root) {
      if (!root || root.userData.kind !== 'mannequin') return null
      const visual = root.userData.mannequinVisual
      if (!visual) {
        return {
          visualReady: false,
          pending: Boolean(root.userData.mannequinVisualPending),
          meshCount: 0,
          boneCount: 0,
          actionClip: null,
          actionTime: null
        }
      }

      let meshCount = 0
      visual.root.traverse((child) => {
        if (child instanceof THREE.Mesh) meshCount += 1
      })

      const round = (value) => Math.round(value * 1000) / 1000
      const clipName = visual.root.userData.mannequinActionClip ?? null
      // actionClips 的键是**预设 id**（stand/sit/...），不是片段名
      // （Idle_Loop/...）。按片段名查会永远拿不到，导致时长恒为 null。
      const presetId = root.userData.mannequinVisualState?.presetId ?? null
      const clip = presetId ? visual.actionClips.get(presetId) : null
      return {
        visualReady: true,
        pending: false,
        meshCount,
        boneCount: visual.bones.size,
        // 这两个值由外观层在播放时写入，直接读即可。
        actionClip: clipName,
        actionTime:
          visual.root.userData.mannequinActionTime === undefined
            ? null
            : round(visual.root.userData.mannequinActionTime),
        /*
         * 片段时长必须暴露出来。
         * actionTime 是"循环内时间"（对时长取模），只有知道时长，
         * 外部才能验证它确实等于 时间轴时间 % 时长 —— 否则跨过多个
         * 循环周期后，数值看起来像是随机跳的，无法判定对错。
         */
        actionDuration: clip ? round(clip.duration) : null,
        // 预设 id 用来确认"选的动作"和"播的动作"是一致的。
        presetId
      }
    },

    /** 给诊断报告与验证脚本用的场景快照。纯读取，不改变任何状态。 */
    describeScene() {
      const round = (value) => Math.round(value * 1000) / 1000
      const objects = []
      if (this.rootMap) {
        for (const [id, root] of this.rootMap.entries()) {
          // 数据源里的同一项：名字、绑定关系这些"只在数据里"的字段要从这里取。
          const data = this.objects.find((item) => item.id === id)
          objects.push({
            id,
            name: data?.name ?? root.name,
            kind: root.userData.kind ?? data?.kind ?? null,
            visible: root.visible,
            position: { x: round(root.position.x), y: round(root.position.y), z: round(root.position.z) },
            rotation: {
              x: round(THREE.MathUtils.radToDeg(root.rotation.x)),
              y: round(THREE.MathUtils.radToDeg(root.rotation.y)),
              z: round(THREE.MathUtils.radToDeg(root.rotation.z))
            },
            // 人台专属的观测值：外观是否就绪、当前播的是哪段动作。
            mannequin: this.describeMannequin(root),
            // 绑定了哪条导航线（验证脚本靠它判定绑定是否生效）。
            pathBinding: data?.pathBinding?.pathId ?? null
          })
        }
      }

      return {
        ready: this.ready,
        objectCount: objects.length,
        objects,
        /*
         * 导航线单独列出来。
         *
         * 它们不在 rootMap 里（没有网格根节点，避免选区框变成一个小点），
         * 所以上面那个 objects 数组里看不到它们。验证脚本要核对
         * "节点数 / 世界坐标 / 屏幕位置"就必须从这里读。
         */
        paths: (this.pathGroup?.children ?? []).map((group) => ({
          id: group.userData.pathId,
          draft: Boolean(group.userData.isDraft),
          nodeCount: group.children.filter((child) => child.userData?.pathNodeIndex !== undefined).length,
          nodes: group.children
            .filter((child) => child.userData?.pathNodeIndex !== undefined)
            .sort((first, second) => first.userData.pathNodeIndex - second.userData.pathNodeIndex)
            .map((child) => ({
              index: child.userData.pathNodeIndex,
              position: {
                x: round(child.position.x),
                y: round(child.position.y),
                z: round(child.position.z)
              },
              screen: this.projectToCanvas(child.position)
            }))
        })),
        selectedIds: [...this.selectedIds],
        cameraSelected: this.cameraSelected,
        transformMode: this.transformMode,
        /*
         * 成片预演状态。
         *
         * 验证脚本不能靠"截图看起来像成片"来判断——黑边和画幅比
         * 在缩略图里根本分不出来。这里直接给出：
         *   - active：是否在预演；
         *   - rect：预演画面在视口里的真实像素区域（由 renderPreviewFrame 写入）；
         *   - expectedRatio：相机预设的画幅比，用来核对 rect 有没有按画幅裁切；
         *   - camera：预演相机的位姿（用它对比"是不是场景摄影机的那台"）。
         */
        preview: {
          active: Boolean(this.previewActive),
          rect: this.previewRect ? { ...this.previewRect } : null,
          expectedRatio: this.cameraState.aspectWidth / this.cameraState.aspectHeight,
          camera: this.previewCamera
            ? {
                position: {
                  x: round(this.previewCamera.position.x),
                  y: round(this.previewCamera.position.y),
                  z: round(this.previewCamera.position.z)
                },
                fov: round(this.previewCamera.fov),
                aspect: round(this.previewCamera.aspect)
              }
            : null
        },
        gizmoAttached: Boolean(this.transformControls?.object),
        gizmoDragging: Boolean(this.transformControls?.dragging),
        gizmoAxis: this.transformControls?.axis ?? null,
        gizmo: this.describeGizmoHandles(),
        // 摄影机模型的朝向自检数据。
        // 视锥必须朝着 target，否则就会出现"视锥背对物体、监视器却有画面"。
        cameraHelper: this.describeCameraHelper(),
        sceneCamera: {
          position: {
            x: round(this.cameraState.position.x),
            y: round(this.cameraState.position.y),
            z: round(this.cameraState.position.z)
          },
          target: {
            x: round(this.cameraState.target.x),
            y: round(this.cameraState.target.y),
            z: round(this.cameraState.target.z)
          }
        }
      }
    },

    buildEnvironment() {
      const scene = this.scene

      // 地面：真实几何体，阴影直接落在它上面。
      // 不再叠"看不见的阴影承接面"——那会让阴影凭空出现在没有实体的区域。
      const groundMaterial = new THREE.MeshStandardMaterial({
        color: this.theme === 'dark' ? '#2a3238' : '#eef1f2',
        roughness: 0.98,
        metalness: 0,
        transparent: true,
        // 深色主题下原来只有 0.42 的不透明度 + 极暗底色，与背景几乎同色，
        // 视觉上就是"没有地面"。提高不透明度让基线可辨。
        opacity: this.theme === 'dark' ? 0.78 : 0.72,
        depthWrite: false,
        side: THREE.DoubleSide
      })
      this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), groundMaterial)
      this.ground.rotation.x = -Math.PI / 2
      // 略低于参考网格与用户 floor 底板，避免与共面的地板发生 Z-fighting 闪烁。
      this.ground.position.y = -0.08
      this.ground.receiveShadow = true
      this.ground.renderOrder = -2
      scene.add(this.ground)

      this.grid = this.createGrid()
      scene.add(this.grid)

      this.hemisphere = new THREE.HemisphereLight(
        FIXED_HEMISPHERE_LIGHT.skyColor,
        FIXED_HEMISPHERE_LIGHT.groundColor,
        FIXED_HEMISPHERE_LIGHT.intensity
      )
      scene.add(this.hemisphere)

      this.fillLight = new THREE.DirectionalLight(FIXED_FILL_LIGHT.color, FIXED_FILL_LIGHT.intensity)
      this.fillLight.position.set(
        FIXED_FILL_LIGHT.position.x,
        FIXED_FILL_LIGHT.position.y,
        FIXED_FILL_LIGHT.position.z
      )
      scene.add(this.fillLight)

      scene.fog = new THREE.Fog(this.theme === 'dark' ? '#07090b' : '#dfe4e6', 40, 260)
      this.applyTheme(this.theme)
    },

    /**
     * 基线参考网格。
     *
     * 设计要点：
     * - 分两级：0.5m 细网格负责近处尺度感，5m 粗网格负责远处方向感；
     * - 颜色比之前明显提亮，深色主题下才有"地面基线"的作用；
     * - 轴线用红/蓝区分 X / Z，方便判断朝向；
     * - 所有线条都关掉深度写入，避免与地面互相遮挡闪烁。
     */
    createGrid() {
      const group = new THREE.Group()
      group.name = '参考网格'

      const makeGrid = (size, divisions, color, opacity) => {
        const grid = new THREE.GridHelper(size, divisions, color, color)
        grid.material.transparent = true
        grid.material.opacity = opacity
        grid.material.depthWrite = false
        return grid
      }

      // 细网格：600m 内每 0.5m 一格。远处会因雾衰减，不必担心过密。
      group.add(makeGrid(600, 1200, this.theme === 'dark' ? 0x3f4a52 : 0xc2cbce, 0.55))
      // 粗网格：每 5m 一格，加深一档，用来快速估距离。
      group.add(makeGrid(600, 120, this.theme === 'dark' ? 0x5b6a74 : 0x9aa6ab, 0.85))

      group.position.y = 0.002
      group.renderOrder = -1

      // 轴线：用颜色标出 X / Z 正方向，方便判断朝向。
      const axisLength = 200
      const xGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-axisLength, 0.004, 0),
        new THREE.Vector3(axisLength, 0.004, 0)
      ])
      const zGeometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0.004, -axisLength),
        new THREE.Vector3(0, 0.004, axisLength)
      ])
      const xLine = new THREE.Line(
        xGeometry,
        new THREE.LineBasicMaterial({
          color: 0xff5f6d,
          transparent: true,
          opacity: 0.75,
          depthWrite: false
        })
      )
      const zLine = new THREE.Line(
        zGeometry,
        new THREE.LineBasicMaterial({
          color: 0x5b9dff,
          transparent: true,
          opacity: 0.75,
          depthWrite: false
        })
      )
      group.add(xLine, zLine)
      return group
    },

    applyTheme(theme) {
      if (!this.scene) return
      this.scene.background = new THREE.Color(theme === 'dark' ? '#080a0c' : '#f4f6f7')
      if (this.scene.fog) this.scene.fog.color.set(theme === 'dark' ? '#07090b' : '#dfe4e6')
      if (this.ground) {
        this.ground.material.color.set(theme === 'dark' ? '#2a3238' : '#eef1f2')
        this.ground.material.opacity = theme === 'dark' ? 0.78 : 0.72
      }
      if (this.grid) {
        // 注意：网格是直接挂在 scene 上的（不是 guideGroup），
        // 之前从 guideGroup 移除等于没移除，会导致旧网格留在场景里越积越多。
        this.scene.remove(this.grid)
        disposeObject(this.grid)
        this.grid = this.createGrid()
        this.scene.add(this.grid)
      }
    },

    // ------------------------------------------------------------------
    // 对象构建
    // ------------------------------------------------------------------

    rebuildObjects() {
      if (!this.ready) return
      const group = this.objectGroup
      const previous = new Map()
      for (const child of [...group.children]) {
        if (child.userData.objectId) previous.set(child.userData.objectId, child)
      }
      const keep = new Set()

      for (const object of this.objects) {
        /*
         * 导航线不建根节点：它没有网格，画法完全由 pathGroup 负责。
         * 如果在这里也建一个空 Group，selectionBox 会围绕一个"零尺寸盒子"
         * 画出一个点，看起来像误选中了什么东西。
         */
        if (object.kind === PATH_KIND) continue
        keep.add(object.id)
        const existing = previous.get(object.id)
        if (existing && existing.userData.kind === object.kind && object.kind !== 'imported') {
          this.applyObjectTransform(existing, object)
          this.applyObjectAppearance(existing, object)
          continue
        }
        if (existing) {
          group.remove(existing)
          disposeObject(existing)
        }
        const root = this.createObjectRoot(object)
        group.add(root)
        this.rootMap = this.rootMap || new Map()
        this.rootMap.set(object.id, root)
      }

      for (const [id, child] of previous) {
        if (keep.has(id)) continue
        group.remove(child)
        disposeObject(child)
        this.rootMap?.delete(id)
      }
      /*
       * 导航线的可视化必须跟着 objects 一起重建。
       *
       * 一开始只把 rebuildPaths 挂在 pathDraft / selectedPathNode 上，
       * 结果是：拖动节点松手后 store 提交了新坐标，但折线还画在原处
       * （只有拖动过程中的 previewPathNode 临时改过几何）。
       * 用户会看到"节点已经移过去了，线还留在原地"。
       */
      this.rebuildPaths()
      this.updateSelectionHelper()
    },

    /**
     * 时间轴变化时重放所有人台动作。
     *
     * 动作时间取 `this.animationTime`，与时间轴完全同步：
     * 播放 → 连续变化 → 动作连贯；拖播放头 → 跳到对应帧。
     */
    refreshMannequinActions() {
      if (!this.ready || !this.rootMap) return
      for (const [id, root] of this.rootMap.entries()) {
        if (root.userData.kind !== 'mannequin') continue
        const data = this.objects.find((item) => item.id === id)
        if (!data?.mannequin) continue
        applyMannequinPose(root, data.mannequin.pose, mannequinVisualState(data.mannequin, this.animationTime))
      }
    },

    // ------------------------------------------------------------------
    // 导航线
    // ------------------------------------------------------------------

    /**
     * 重建所有导航线的可视化。
     *
     * 画法：折线（Line）+ 每个节点一个小球 + 选中节点一个高亮环。
     *
     * 为什么不把节点做成可被 TransformControls 抓的对象：
     * 节点只能在"路径上"滑动（相邻两段之间），自由三轴平移会立刻
     * 破坏"节点沿着线走"这个心智模型。所以用自定义的射线投影拖拽，
     * 见 startPathNodeDrag。
     */
    rebuildPaths() {
      if (!this.ready || !this.pathGroup) return
      clearGroup(this.pathGroup)
      this.pathHitMap = new Map()

      // 绘制中的草稿优先画：它还没写进 objects，但用户必须看得见。
      const draft = this.pathDraft
      const draftNodes = this.pathDraftNodes ?? draft?.nodes ?? []
      if (draft && draftNodes.length > 0) {
        this.pathDraftNodes = draftNodes
        this.buildPathVisual(`draft:${draft.pathId}`, draftNodes, { draft: true })
      }

      // 材质与几何在所有路径间共享：一条场景里可能有几十个节点，
      // 每个都新建材质会让 draw call 与显存都白白翻倍。
      const lineMaterial = new THREE.LineBasicMaterial({ color: 0x4b93ff })
      const nodeGeometry = new THREE.SphereGeometry(1, 16, 12)
      const nodeMaterial = new THREE.MeshBasicMaterial({ color: 0x4b93ff })
      const activeMaterial = new THREE.MeshBasicMaterial({ color: 0xffb020 })
      this.pathNodeGeometry = nodeGeometry

      for (const object of this.objects) {
        if (object.kind !== 'path') continue
        this.buildPathVisual(object.id, this.pathWorldNodes(object), {
          lineMaterial,
          nodeGeometry,
          nodeMaterial,
          activeMaterial
        })
      }

      // 立刻按当前相机距离缩放一次，避免第一帧大小不对。
      this.updatePathNodeScale()
    },

    /**
     * 画一条导航线（折线 + 节点球）。
     *
     * 抽出来是因为"绘制中的草稿"和"已提交的路径"要画得一模一样，
     * 否则松手瞬间线的粗细、节点大小会跳一下。
     */
    buildPathVisual(pathId, worldNodes, options = {}) {
      if (!worldNodes || worldNodes.length === 0) return
      const lineMaterial =
        options.lineMaterial ?? new THREE.LineBasicMaterial({ color: 0x4b93ff })
      const nodeGeometry = options.nodeGeometry ?? new THREE.SphereGeometry(1, 16, 12)
      const nodeMaterial = options.nodeMaterial ?? new THREE.MeshBasicMaterial({ color: 0x4b93ff })
      const activeMaterial = options.activeMaterial ?? new THREE.MeshBasicMaterial({ color: 0xffb020 })

      const group = new THREE.Group()
      group.userData.pathId = pathId
      group.userData.isDraft = Boolean(options.draft)

      if (worldNodes.length >= 2) {
        const points = worldNodes.map((node) => new THREE.Vector3(node.x, node.y, node.z))
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial)
        line.userData.pathId = pathId
        group.add(line)
      }

      worldNodes.forEach((node, index) => {
        const selected =
          !options.draft &&
          this.selectedPathNode?.pathId === pathId &&
          this.selectedPathNode?.index === index
        const sphere = new THREE.Mesh(nodeGeometry, selected ? activeMaterial : nodeMaterial)
        sphere.position.set(node.x, node.y, node.z)
        // 节点球体按到相机的距离恒定缩放，见 updatePathNodeScale。
        sphere.userData.pathId = pathId
        sphere.userData.pathNodeIndex = index
        sphere.userData.baseRadius = options.draft ? 0.085 : 0.11
        group.add(sphere)

        /*
         * 记录节点的世界坐标供拾取使用。
         *
         * 不用射线打网格：节点球是按相机距离动态缩放的，半径换算回
         * 屏幕像素很绕；而且"点节点"的容错本来就该比"刚好命中球面"宽松。
         * 草稿不登记，免得画线途中误抓到自己的临时节点。
         */
        if (!options.draft) this.pathHitMap.set(`${pathId}:${index}`, node)
      })

      this.pathGroup.add(group)
    },

    /**
     * 节点球体按"到相机的距离"缩放，保证屏幕上大小恒定。
     *
     * 不做这一步的话，离得远时节点只有一两个像素，根本点不中；
     * 离得近又会变成一个大球挡住视线。
     */
    updatePathNodeScale() {
      if (!this.pathGroup || !this.camera) return
      this.camera.updateMatrixWorld()
      const cameraPosition = new THREE.Vector3()
      this.camera.getWorldPosition(cameraPosition)
      const worldPoint = new THREE.Vector3()
      for (const group of this.pathGroup.children) {
        for (const child of group.children) {
          if (!child.userData?.baseRadius) continue
          child.getWorldPosition(worldPoint)
          const distance = worldPoint.distanceTo(cameraPosition)
          // 与 gizmo 同一套思路：距离 × tan(fov/2) 得到"1 个世界单位在屏幕上多高"，
          // 再乘一个系数换成想要的像素感。
          // 系数 0.34 是调出来的：再大节点球会挡住被绑定的物体，再小又不好点中。
          const scale =
            child.userData.baseRadius * distance * Math.tan((Math.PI * this.camera.fov) / 360) * 0.34
          child.scale.setScalar(Math.max(scale, 1e-4))
        }
      }
    },

    /** 导航线节点的世界坐标（路径对象位置 + 局部节点）。 */
    pathWorldNodes(object) {
      const origin = object.position ?? { x: 0, y: 0, z: 0 }
      return (object.pathNodes ?? []).map((node) => ({
        x: origin.x + node.x,
        y: origin.y + (node.y ?? 0),
        z: origin.z + node.z
      }))
    },

    /**
     * 异步把人台外观（GLB 蒙皮模型）挂到已有对象根节点上。
     *
     * 为什么是"挂上去"而不是"创建时一起建"：
     * GLB 有 7MB，解析要几百毫秒。如果等它加载完再返回 root，
     * 整个场景重建都会被阻塞。所以先用控制骨架占位，外观就绪后
     * 增量挂载，并重放一次姿势让它对齐。
     *
     * 每个对象各自 clone 一份：多人台要能独立摆姿势。
     */
    attachMannequinVisual(root, object) {
      // 已经挂过就不再申请一次：GLB 是共享缓存，重复调用会 clone 出
      // 第二份模型叠在同一个位置（表现出来是人物"重影"、面数翻倍）。
      if (root.userData.mannequinVisual || root.userData.mannequinVisualPending) return
      root.userData.mannequinVisualPending = true

      const objectId = object.id
      // 注意：不能把 createObjectRoot 里那份 material 传进来。
      // 那里创建完就会 dispose（控制骨架已经克隆过自己的副本），
      // 而 GLB 要几百毫秒后才加载完，届时拿到的是一份已释放的材质。
      // 这里按颜色新建一份，生命周期完全归外观自己管。
      const visualMaterial = new THREE.MeshStandardMaterial({
        color: object.color,
        roughness: 0.86,
        metalness: 0
      })
      createMannequinVisual(visualMaterial)
        .then((visual) => {
          visualMaterial.dispose()
          // 期间对象可能已被删除或重建，这里必须重新确认。
          if (!this.rootMap || this.rootMap.get(objectId) !== root) {
            // 对象在加载期间被删除/重建了：这份外观没人要，释放掉。
            root.userData.mannequinVisualPending = false
            disposeObject(visual.root)
            return
          }
          visual.root.traverse((child) => {
            child.userData.objectId = objectId
          })
          root.userData.mannequinVisualPending = false
          root.userData.mannequinVisual = visual
          root.add(visual.root)
          // 外观就绪后重放姿势：此刻才真正有了"看起来像人"的姿态。
          const data = this.objects.find((item) => item.id === objectId)
          if (data?.kind === 'mannequin' && data.mannequin) {
            applyMannequinPose(
              root,
              data.mannequin.pose,
              mannequinVisualState(data.mannequin, this.animationTime)
            )
          }

          /*
           * 移除控制骨架的可见网格，只保留关节 group。
           *
           * 骨架原本是"占位 + 可抓"两用。现在外观来了，两者会重叠：
           * 白模胶囊体套在人体模型外面，看起来像穿了一层壳。
           * 但关节 group 不能删——它们是姿势计算与手柄定位的锚点，
           * 而且 jointNode 本身没有几何体，删掉 mesh 不会影响它们。
           */
          const rig = root.userData.mannequinRig
          if (rig) {
            const controlMeshes = []
            rig.root.traverse((child) => {
              if (child instanceof THREE.Mesh) controlMeshes.push(child)
            })
            for (const mesh of controlMeshes) {
              mesh.removeFromParent()
              disposeObject(mesh)
            }
          }
        })
        .catch((error) => {
          // 外观加载失败不该让人台消失：控制骨架仍然可用，
          // 只是退化成白模几何体。记录一条便于排查。
          // 同时清掉 pending，让后续重建能再试一次。
          root.userData.mannequinVisualPending = false
          visualMaterial.dispose()
          record('warn', 'mannequin-visual', `人台外观加载失败：${error?.message || error}`)
        })
    },

    createObjectRoot(object) {
      const root = new THREE.Group()
      root.userData.objectId = object.id
      root.userData.kind = object.kind

      if (object.kind === 'mannequin') {
        const material = new THREE.MeshStandardMaterial({
          color: object.color,
          roughness: 0.86,
          metalness: 0
        })
        const rig = createMannequinRig(material)
        rig.root.traverse((child) => {
          child.userData.objectId = object.id
        })
        root.add(rig.root)
        root.userData.mannequinRig = rig
        /*
         * 这三个字段必须挂在对象根上，缺一不可：
         * - mannequinJoints / mannequinHandles 是 applyMannequinPose
         *   用来驱动外观骨骼的锚点；少了它们，外观会一直停在静止姿势，
         *   表现出来就是"人台加载出来了，但选什么动作都不动"。
         * - mannequinRig 供外观就绪后摘除白模网格时使用。
         */
        root.userData.mannequinJoints = rig.joints
        root.userData.mannequinHandles = rig.handles
        applyMannequinPose(root, object.mannequin?.pose, mannequinVisualState(object.mannequin, this.animationTime))
        // 外观层是异步的（GLB 有 7MB），先用控制骨架占位，
        // 加载完成后把外观挂到同一个 root 上再重放一次姿势。
        this.attachMannequinVisual(root, object)
        material.dispose()
      } else if (object.kind === 'imported' && object.importedAsset) {
        // 导入模型的网格在导入时已解析，这里用包围盒占位。
        // 真实网格由父组件通过 setImportedMesh 注入，避免在视口里重复解析文件。
        const placeholder = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshStandardMaterial({
            color: object.color,
            roughness: 0.9,
            metalness: 0,
            transparent: true,
            opacity: 0.35
          })
        )
        placeholder.castShadow = true
        placeholder.receiveShadow = true
        placeholder.userData.objectId = object.id
        root.add(placeholder)
        const cached = this.importedModels?.get(object.id)
        if (cached) this.setImportedMesh(object.id, cached)
      } else {
        const material = new THREE.MeshStandardMaterial({
          color: object.colorOverride || object.color,
          roughness: 0.82,
          metalness: 0,
          side: THREE.DoubleSide,
          transparent: (object.displayMode ?? 'solid') !== 'solid',
          opacity:
            object.displayMode === 'transparent' ? 0.34 : object.displayMode === 'wireframe' ? 0.62 : 1
        })
        // floor 与系统地面接近时，用 polygonOffset 再压一层深度冲突。
        if (object.kind === 'floor') {
          material.polygonOffset = true
          material.polygonOffsetFactor = 1
          material.polygonOffsetUnits = 1
        }
        const mesh = new THREE.Mesh(createGeometry(object), material)
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.userData.objectId = object.id
        root.add(mesh)
      }

      this.applyObjectTransform(root, object)
      this.applyObjectAppearance(root, object)
      return root
    },

    applyObjectTransform(root, object) {
      root.position.set(object.position.x, object.position.y, object.position.z)
      root.rotation.set(
        THREE.MathUtils.degToRad(object.rotation.x),
        THREE.MathUtils.degToRad(object.rotation.y),
        THREE.MathUtils.degToRad(object.rotation.z)
      )
      root.scale.set(object.size.x, object.size.y, object.size.z)
      root.visible = object.visible
      if (object.kind === 'mannequin' && object.mannequin) {
        applyMannequinPose(
          root,
          object.mannequin.pose,
          mannequinVisualState(object.mannequin, this.animationTime)
        )
      }
    },

    applyObjectAppearance(root, object) {
      root.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return
        const materials = Array.isArray(child.material) ? child.material : [child.material]
        for (const material of materials) {
          if (!material) continue
          if (material.color && object.kind !== 'mannequin') {
            material.color.set(object.colorOverride || object.color)
          } else if (material.color && object.kind === 'mannequin') {
            material.color.set(object.color)
          }
          if (object.displayMode && object.displayMode !== 'solid') {
            material.transparent = true
            material.opacity = object.displayMode === 'transparent' ? 0.34 : 0.62
            material.depthWrite = false
            if ('wireframe' in material) material.wireframe = object.displayMode === 'wireframe'
            material.needsUpdate = true
          }
        }
      })
    },

    // ------------------------------------------------------------------
    // 灯光
    // ------------------------------------------------------------------

    rebuildLights() {
      if (!this.ready) return
      const group = this.userLightGroup
      for (const child of [...group.children]) {
        group.remove(child)
        disposeObject(child)
      }
      for (const child of [...this.guideGroup.children]) {
        if (child.userData.lightGuide) {
          this.guideGroup.remove(child)
          disposeObject(child)
        }
      }

      this.lightMap = new Map()
      // 阴影名额与实际渲染、文字描述共用同一份判定，避免"描述说投影但画面没有"。
      const shadowCasterIds = resolveShadowCasterIds(this.lighting.lights)

      for (const data of this.lighting.lights) {
        const color = new THREE.Color(data.color)
        const castShadow = shadowCasterIds.has(data.id)
        const target = new THREE.Object3D()
        target.position.set(data.target.x, data.target.y, data.target.z)
        group.add(target)

        let light
        if (data.kind === 'point') {
          light = new THREE.PointLight(color, data.intensity, 0, 2)
          light.castShadow = castShadow
          light.shadow.mapSize.set(1024, 1024)
          light.shadow.bias = -0.0006
          light.shadow.normalBias = 0.02
          light.shadow.radius = 2.4
        } else if (data.kind === 'spot') {
          light = new THREE.SpotLight(
            color,
            data.intensity,
            0,
            THREE.MathUtils.degToRad(data.angleDegrees),
            0.28,
            2
          )
          light.target = target
          light.castShadow = castShadow
          light.shadow.mapSize.set(1024, 1024)
          light.shadow.bias = -0.00035
          light.shadow.normalBias = 0.02
          light.shadow.radius = 2.2
        } else if (data.kind === 'sun') {
          light = new THREE.DirectionalLight(color, data.intensity)
          light.target = target
          light.castShadow = castShadow
          light.shadow.mapSize.set(2048, 2048)
          light.shadow.camera.left = -16
          light.shadow.camera.right = 16
          light.shadow.camera.top = 16
          light.shadow.camera.bottom = -16
          light.shadow.camera.near = 0.1
          light.shadow.camera.far = 80
          light.shadow.bias = -0.0003
          light.shadow.normalBias = 0.02
        } else {
          // 面光在 three.js 中不支持阴影，它的"可见性"由发光面板与方向射线表达。
          light = new THREE.RectAreaLight(
            color,
            data.intensity,
            Math.max(data.size, 0.1),
            Math.max(data.size, 0.1)
          )
          light.lookAt(data.target.x, data.target.y, data.target.z)
        }

        light.name = data.name
        light.position.set(data.position.x, data.position.y, data.position.z)
        light.visible = data.visible
        light.userData.lightId = data.id
        group.add(light)
        this.lightMap.set(data.id, light)

        this.createLightGuide(data, castShadow)
      }
    },

    createLightGuide(data, castShadow) {
      const guide = new THREE.Group()
      guide.userData.lightGuide = true
      guide.userData.lightId = data.id
      guide.visible = data.visible

      const selected = this.selectedLightId === data.id
      const guideColor = new THREE.Color(selected ? '#ffb020' : this.theme === 'dark' ? '#f3f6f5' : '#111820')

      // 光源本体：用灯光颜色上色的实心球，一眼看出"灯在这里"。
      const radius = Math.max(Math.min(data.size, 0.5), 0.16)
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(radius, 16, 12),
        new THREE.MeshBasicMaterial({
          color: data.color,
          depthTest: false,
          transparent: true,
          opacity: selected ? 1 : 0.9
        })
      )
      marker.position.set(data.position.x, data.position.y, data.position.z)
      marker.renderOrder = 845
      marker.userData.lightId = data.id
      guide.add(marker)

      // 方向射线：从灯指向目标，用虚线表达"光往哪照"。
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(data.position.x, data.position.y, data.position.z),
          new THREE.Vector3(data.target.x, data.target.y, data.target.z)
        ]),
        new THREE.LineDashedMaterial({
          color: data.color,
          dashSize: 0.28,
          gapSize: 0.18,
          transparent: true,
          opacity: selected ? 1 : 0.78,
          depthTest: false
        })
      )
      ray.computeLineDistances()
      ray.renderOrder = 844
      guide.add(ray)

      // 落地垂线：让高位光源的高度可读。
      if (data.position.y > 0.02) {
        const drop = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(data.position.x, data.position.y, data.position.z),
            new THREE.Vector3(data.position.x, 0, data.position.z)
          ]),
          new THREE.LineDashedMaterial({
            color: guideColor,
            dashSize: 0.16,
            gapSize: 0.14,
            transparent: true,
            opacity: 0.5,
            depthTest: false
          })
        )
        drop.computeLineDistances()
        drop.renderOrder = 843
        guide.add(drop)
      }

      // 面光的发光面板轮廓。
      if (data.kind === 'area') {
        const plane = new THREE.PlaneGeometry(data.size, data.size)
        const outline = new THREE.LineSegments(
          new THREE.EdgesGeometry(plane),
          new THREE.LineBasicMaterial({ color: guideColor, transparent: true, opacity: 0.8 })
        )
        plane.dispose()
        outline.position.set(data.position.x, data.position.y, data.position.z)
        outline.lookAt(data.target.x, data.target.y, data.target.z)
        outline.renderOrder = 842
        guide.add(outline)
      }

      // 投影能力标记：投射阴影的灯用一个空心环区分，便于用户理解为何有的灯没有影子。
      if (castShadow) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(radius * 1.35, radius * 1.6, 24),
          new THREE.MeshBasicMaterial({
            color: '#ffd166',
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.8,
            depthTest: false
          })
        )
        ring.position.set(data.position.x, data.position.y, data.position.z)
        ring.renderOrder = 846
        guide.add(ring)
      }

      this.guideGroup.add(guide)
    },

    // ------------------------------------------------------------------
    // 场景摄影机（可选中、可拖拽）
    // ------------------------------------------------------------------

    /**
     * 给摄影机模型定位与定向。
     *
     * 关键点：`Object3D.lookAt()` 与 `Camera.lookAt()` 的语义**不一样**。
     *   - Camera：让 -Z 指向目标（因为相机沿 -Z 看）；
     *   - 普通 Object3D / Group：让 +Z 指向目标（贴图/正面朝外）。
     *
     * cameraHelper 是 Group，如果直接 `group.lookAt(target)`，
     * 它的 +Z 指向目标；而机身、镜头、视锥全都画在 -Z 一侧，
     * 结果就是**整台机器和视锥都背对着目标**——
     * 但监视器用的是真正的相机（-Z 朝目标），画面是对的，
     * 于是出现"视锥背对物体、监视器里却有物体"的矛盾现象。
     *
     * 解决办法：仍然用 lookAt（此时 +Z 朝目标），再绕 Y 轴翻 180°，
     * 让 -Z 朝目标，与相机语义一致。这样三处（模型、视锥、监视器）
     * 共用同一套约定，不会再互相打架。
     */
    poseCameraHelper(helper, state) {
      helper.position.set(state.position.x, state.position.y, state.position.z)
      helper.lookAt(state.target.x, state.target.y, state.target.z)
      helper.rotateY(Math.PI)

      // 目标点标记是 helper 的子节点，用的是**本地坐标**。
      // 翻转之后本地 -Z 恰好指向目标，所以目标点在本地空间里就是 (0, 0, -距离)。
      // 不能直接把世界偏移量塞进来——那会被 helper 自身的旋转再转一次。
      const dot = helper.userData.targetDot
      if (dot) {
        const distance = Math.hypot(
          state.target.x - state.position.x,
          state.target.y - state.position.y,
          state.target.z - state.position.z
        )
        dot.position.set(0, 0, -distance)
      }
      return helper
    },

    /**
     * 构建/更新场景摄影机的可视模型。
     *
     * 桌面版把这台摄影机只画成两根线，看不出朝向，也不好点选。
     * 这里改成"机身 + 镜头 + 视锥"，并把可点击区域做成一个隐形的包围盒，
     * 让用户能像选物体一样直接点中它、拖动它。
     */
    rebuildCameraHelper() {
      if (!this.ready) return

      /*
       * 相机视角下隐藏相机自身模型。
       *
       * 相机视角把编辑相机搬到场景相机的眼睛位置，此时相机模型正好
       * 罩在观察者身上——机壳和视锥会糊住整个画面，近裁剪面还会把它
       * 切成几片乱飘的多边形。Maya 的 look through camera 同样会隐藏
       * 该相机自身，这是通行做法。
       */
      if (this.cameraViewActive) {
        if (this.cameraHelper) this.cameraHelper.visible = false
        return
      }
      if (this.cameraHelper) this.cameraHelper.visible = true

      // 正在拖拽摄影机时不重建：拖拽会把新位置写回 store，
      // store 变化又会触发本函数，如果这里把对象换掉，
      // TransformControls 会立刻失去挂载目标，拖拽中途断掉。
      // 此时只需同步位姿，其余保持不变。
      if (this.transformDragging && this.cameraHelper) {
        this.poseCameraHelper(this.cameraHelper, this.cameraState)
        return
      }

      const state = this.cameraState

      /*
       * 快速路径：只有位置/朝向变了（时间轴播放、拖拽），
       * 机身、镜头、视锥的几何都可以原样复用，只改位姿。
       *
       * 为什么必须有这条路：播放时 displayedCamera 每帧都在变，
       * 走下面的全量重建会每帧新建并销毁十几个几何体与材质，
       * 实测直接掉到个位数帧率，而且 GC 压力极大。
       *
       * 判断依据是"造型参数"：视场角、画幅比、选中高亮、主题。
       * 这四项任何一个变了，视锥形状或颜色就不同，必须重建。
       */
      const shapeKey = `${state.fovDegrees}|${state.aspectWidth}:${state.aspectHeight}|${this.cameraSelected}|${this.theme}`
      // 注意：只有"造型没变"才走快速路径。视锥长度是跟着 target 距离算的，
      // 距离变了视锥就该变长——所以这里把距离也纳入签名。
      const distanceKey = String(
        Math.round(
          Math.hypot(
            state.target.x - state.position.x,
            state.target.y - state.position.y,
            state.target.z - state.position.z
          ) * 100
        ) / 100
      )
      if (this.cameraHelper && this.cameraHelperShapeKey === `${shapeKey}|${distanceKey}`) {
        // 控制柄挂在这个 helper 上，只改位姿即可，不需要重新 attach。
        this.poseCameraHelper(this.cameraHelper, state)
        return
      }

      if (this.cameraHelper) {
        // 重建前必须先摘掉控制柄。
        // TransformControls 每帧会检查 `controls.object.parent === null`，
        // 一旦命中就打印 "The attached 3D object must be a part of the scene graph."
        // 我们这里是"先 remove 再 add"，中间那一瞬间父节点就是 null——
        // 相机位置每变一次就报一条，诊断面板里的错误数就是这么攒出来的。
        const controls = this.transformControls
        const attachedToHelper = controls?.object === this.cameraHelper
        if (attachedToHelper) controls.detach()

        this.guideGroup.remove(this.cameraHelper)
        disposeObject(this.cameraHelper)
        this.cameraHelper = null
      }

      const color = new THREE.Color(
        this.cameraSelected ? '#ffb020' : this.theme === 'dark' ? '#7fd1ff' : '#1d6fb8'
      )

      const helper = new THREE.Group()
      helper.name = '场景摄影机'
      helper.userData.cameraHelper = true
      this.poseCameraHelper(helper, state)

      const bodyMaterial = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        depthTest: false
      })
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.62), bodyMaterial)
      body.renderOrder = 850
      helper.add(body)

      const lens = new THREE.Mesh(
        new THREE.CylinderGeometry(0.16, 0.2, 0.34, 16),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false })
      )
      lens.rotation.x = Math.PI / 2
      lens.position.z = -0.42
      lens.renderOrder = 850
      helper.add(lens)

      // 视锥：用四条棱线画出取景范围，直观表达"这台机器拍到哪里"。
      const distance = Math.max(
        Math.hypot(
          state.target.x - state.position.x,
          state.target.y - state.position.y,
          state.target.z - state.position.z
        ),
        2
      )
      const halfHeight = Math.tan(THREE.MathUtils.degToRad(state.fovDegrees) / 2) * distance
      const halfWidth = halfHeight * (state.aspectWidth / state.aspectHeight)
      const apex = new THREE.Vector3(0, 0, -0.4)
      const corners = [
        new THREE.Vector3(-halfWidth, -halfHeight, -distance),
        new THREE.Vector3(halfWidth, -halfHeight, -distance),
        new THREE.Vector3(halfWidth, halfHeight, -distance),
        new THREE.Vector3(-halfWidth, halfHeight, -distance)
      ]
      const frustumPoints = []
      for (let index = 0; index < 4; index += 1) {
        frustumPoints.push(apex, corners[index])
        frustumPoints.push(corners[index], corners[(index + 1) % 4])
      }
      const frustum = new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(frustumPoints),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.42, depthWrite: false })
      )
      frustum.renderOrder = 848
      helper.add(frustum)

      // 目标点标记：让用户知道"镜头对准哪儿"。
      // 用本地坐标 (0,0,-distance)：helper 已翻转为"本地 -Z 指向目标"，
      // 直接塞世界偏移会被自身的旋转再转一次，位置就错了。
      const targetDot = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 12, 9),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthTest: false })
      )
      targetDot.position.set(0, 0, -distance)
      targetDot.renderOrder = 850
      helper.add(targetDot)
      // 记下引用：快速路径里要单独更新它的相对坐标。
      helper.userData.targetDot = targetDot

      this.cameraHelper = helper
      // 记下造型签名：下一帧若只有位置变化，就走快速路径复用这套几何。
      this.cameraHelperShapeKey = `${shapeKey}|${distanceKey}`
      this.guideGroup.add(helper)

      // 重新挂载控制柄（上面为了安全重建先 detach 过）。
      // 只在摄影机仍处于选中态时挂，避免抢走物体/灯光的选择。
      if (this.cameraSelected) this.attachTransformControls()
    },

    /**
     * 命中测试：鼠标射线是否落在场景摄影机的可视模型上（没有则 null）。
     *
     * 这里必须用**鼠标射线**（raycaster），不能用相机视线方向。
     * 之前的实现是拿 `camera.getWorldDirection()` 当射线——那永远是从
     * 屏幕正中心发出去的一条线，只有当摄影机模型恰好落在画面正中时才
     * 判得中，所以表现成"在画面里点摄影机没反应"。
     *
     * 判定分两级，先粗后细：
     * 1. 机身/镜头的实体包围盒求交（与视觉一致，最直观）；
     * 2. 视锥线框只做"离射线够近"的距离判断（线框太细，精确求交太苛刻）。
     */
    pickSceneCamera() {
      if (!this.cameraHelper || !this.raycaster) return null

      /*
       * 相机视角下**绝不**拾取场景摄影机自身。
       *
       * 必须在这里拦，而不是靠"把相机模型 visible 设成 false"：
       * three.js 的 Raycaster 并不检查 `visible`（只查 layers），
       * 隐藏的机身照样会被射线打中。而相机视角下编辑相机就在相机原点，
       * 机身、镜头、视锥全罩在观察者身上，于是随便点一下都会命中它：
       *   camera-select → cameraSelected=true → attachTransformControls()
       *   把控制柄挂到相机模型上、顺手关掉 OrbitControls。
       * 结果就是"环绕方案下只能转动镜头本身的旋转属性"。
       */
      if (this.cameraViewActive) return null

      // 第一级：机身、镜头这些实体。它们就是用户看到并想去点的部分。
      const solids = []
      this.cameraHelper.traverse((child) => {
        if (child instanceof THREE.Mesh && child.visible) solids.push(child)
      })
      if (solids.length > 0) {
        const hits = this.raycaster.intersectObjects(solids, false)
        if (hits.length > 0) return hits[0].point.clone()
      }

      // 第二级：摄影机原点附近的容错范围。
      // 用"点到射线的垂直距离"，阈值随距离放大，保证远处的摄影机也点得中。
      const state = this.cameraState
      if (!state) return null
      const origin = this.raycaster.ray.origin
      const direction = this.raycaster.ray.direction
      const point = new THREE.Vector3(state.position.x, state.position.y, state.position.z)
      const toPoint = point.clone().sub(origin)
      const along = toPoint.dot(direction)
      if (along <= 0) return null
      const closest = origin.clone().addScaledVector(direction, along)
      const threshold = Math.max(0.5, along * 0.04)
      return point.distanceTo(closest) <= threshold ? point : null
    },

    // ------------------------------------------------------------------
    // 监视器（选中摄影机所见画面）
    // ------------------------------------------------------------------

    /**
     * 初始化监视器渲染器。
     *
     * 用第二个 WebGLRenderer：一个渲染器只能绑定一个 canvas。
     * 监视器尺寸小、像素少，额外上下文的开销可以接受，
     * 而且省掉了每帧从 RenderTarget 回读像素的高昂代价。
     */
    initMonitor() {
      const canvas = this.$refs.monitor
      if (!canvas || !this.scene) return
      if (this.monitorRenderer) return

      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        /*
         * 监视器必须开 preserveDrawingBuffer。
         *
         * 默认值是 false：浏览器在合成完成后就丢弃绘制缓冲，
         * 于是任何"在别的任务里再读像素"的操作（截图、自动化断言、
         * 用户右键存图）都会拿到一张全黑的图。
         * 监视器窗口小、分辨率低，保留缓冲的代价可以接受。
         */
        preserveDrawingBuffer: true
      })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.shadowMap.enabled = true
      renderer.shadowMap.type = THREE.PCFSoftShadowMap
      renderer.toneMapping = THREE.ACESFilmicToneMapping
      renderer.toneMappingExposure = 1.05
      this.monitorRenderer = renderer

      // 监视器专用相机：位姿每帧从场景相机同步，不参与任何编辑交互。
      this.monitorCamera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 2000)

      // 首次打开时放到右上角，避开左上角的 HUD 提示条。
      const aspect = this.cameraState.aspectWidth / this.cameraState.aspectHeight
      const width = this.monitorRect.w
      this.monitorRect = {
        x: Math.max(this.$el.clientWidth - width - 16, 16),
        y: 16,
        w: width,
        h: Math.round(width / aspect)
      }

      this.monitorReady = true
      this.renderMonitor()
    },

    disposeMonitor() {
      this.monitorReady = false
      if (this.monitorRenderer) {
        this.monitorRenderer.dispose()
        this.monitorRenderer = null
      }
      this.monitorCamera = null
    },

    /**
     * 渲染一帧监视器画面。
     *
     * 关键：渲染前临时隐藏 guideGroup（摄影机模型、灯光示意、网格辅助都在里面），
     * 否则会拍到"另一个自己"——这在取景预览里是明显的穿帮。
     * 与导出参考图的处理方式保持一致。
     */
    renderMonitor() {
      if (!this.monitorReady || !this.monitorRenderer || !this.monitorCamera) return
      const canvas = this.$refs.monitor
      if (!canvas) return

      const width = Math.max(canvas.clientWidth, 1)
      const height = Math.max(canvas.clientHeight, 1)
      this.monitorRenderer.setSize(width, height, false)

      const state = this.cameraState
      const camera = this.monitorCamera
      camera.position.set(state.position.x, state.position.y, state.position.z)
      camera.up.set(0, 1, 0)
      camera.lookAt(state.target.x, state.target.y, state.target.z)
      camera.fov = state.fovDegrees
      camera.aspect = state.aspectWidth / state.aspectHeight
      camera.updateProjectionMatrix()

      const guideVisibility = this.guideGroup.visible
      this.guideGroup.visible = false
      this.monitorRenderer.render(this.scene, camera)
      this.guideGroup.visible = guideVisibility
    },

    /** 拖动监视器标题栏。 */
    startMonitorDrag(event) {
      if (event.target.closest('.monitor__close')) return
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const originX = this.monitorRect.x
      const originY = this.monitorRect.y
      const move = (moveEvent) => {
        const maxX = Math.max(this.$el.clientWidth - this.monitorRect.w, 0)
        const maxY = Math.max(this.$el.clientHeight - 40, 0)
        this.monitorRect = {
          ...this.monitorRect,
          x: Math.min(Math.max(originX + moveEvent.clientX - startX, 0), maxX),
          y: Math.min(Math.max(originY + moveEvent.clientY - startY, 0), maxY)
        }
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },

    /** 拖动右下角手柄缩放监视器，始终保持场景相机本身的画幅比。 */
    startMonitorResize(event) {
      event.preventDefault()
      event.stopPropagation()
      const startX = event.clientX
      const originW = this.monitorRect.w
      const aspect = this.cameraState.aspectWidth / this.cameraState.aspectHeight
      const move = (moveEvent) => {
        const width = Math.min(Math.max(originW + (moveEvent.clientX - startX), 140), 640)
        this.monitorRect = { ...this.monitorRect, w: Math.round(width), h: Math.round(width / aspect) }
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        this.$nextTick(() => this.renderMonitor())
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },

    // ------------------------------------------------------------------
    // 选择与变换
    // ------------------------------------------------------------------

    attachTransformControls() {
      if (!this.ready) return
      const controls = this.transformControls
      controls.detach()
      /*
       * 预演期间**绝不**挂控制柄。
       *
       * 这一条必须在最前面，而不是只在 previewActive 的 watch 里 detach 一次。
       * 原因：进入预演会让 `cameraState` 变成时间轴求值的相机，
       * 而 `cameraState` 的 watcher 会重建摄影机模型，`rebuildCameraHelper()`
       * 末尾又会调 `attachTransformControls()` —— 于是刚摘掉的控制柄
       * 又被挂回去了，成片里出现一组箭头。
       *
       * 在函数入口拦住，比在每个调用点加条件可靠得多：
       * 以后新增任何调用 `attachTransformControls()` 的地方都自动安全。
       */
      if (this.previewActive) {
        this.updateSelectionHelper()
        return
      }

      /*
       * 相机视角下**照样挂物体/灯光的控制柄**，只不挂"场景相机自身"的。
       *
       * 上一版在这里整体 return，导致取景时完全没法摆物体；但当时那样做是有
       * 原因的：相机视角把编辑相机搬到场景相机的眼睛位置，机身正好罩在观察者
       * 身上，一旦把控制柄挂到相机模型上，拖动就变成"转相机自身"并顶掉导航。
       * 所以正确的收窄方式是：**跳过 cameraSelected 分支**，其余照旧。
       */
      const allowCameraHelperGizmo = !this.cameraViewActive

      /*
       * `transformMode === 'select'` 表示"纯选择、不显示操纵器"（对标 Maya 的 Q）。
       * `TransformControls.setMode()` 只接受 translate/rotate/scale，
       * 传其它值会报警并把控制柄留在原地，所以这里必须先摘掉。
       */
      if (!TRANSFORM_MODES.includes(this.transformMode)) {
        controls.detach()
        this.updateSelectionHelper()
        return
      }

      // 选中摄影机时把控制柄挂到摄影机模型上。
      // 平移改机位；旋转改朝向（把旋转量折算成新的 target），两者都写回场景相机。
      if (this.cameraSelected && allowCameraHelperGizmo) {
        if (this.cameraHelper) {
          controls.setMode(this.transformMode)
          controls.attach(this.cameraHelper)
        }
        this.updateSelectionHelper()
        return
      }

      if (this.selectedLightId) {
        const light = this.lightMap?.get(this.selectedLightId)
        const data = this.lighting.lights.find((item) => item.id === this.selectedLightId)
        if (light && data && data.visible && !data.locked) {
          controls.setMode('translate')
          controls.attach(light)
        }
        this.updateSelectionHelper()
        return
      }

      const roots = this.selectedIds
        .map((id) => {
          const data = this.objects.find((item) => item.id === id)
          if (!data || data.locked || !data.visible) return null
          return this.rootMap?.get(id)
        })
        .filter((root) => root && root.visible)
      if (roots.length === 0) {
        this.updateSelectionHelper()
        return
      }
      if (roots.length === 1) {
        controls.setMode(this.transformMode)
        controls.attach(roots[0])
      } else {
        // 多选时把控制柄挂在选中点的中心，拖动后按增量分发到各物体。
        const box = new THREE.Box3()
        for (const root of roots) box.expandByObject(root)
        const center = box.getCenter(new THREE.Vector3())
        if (!this.pivot) {
          this.pivot = new THREE.Object3D()
          this.scene.add(this.pivot)
        }
        this.pivot.position.copy(center)
        this.pivot.userData.multiSelect = true
        controls.setMode(this.transformMode)
        controls.attach(this.pivot)
      }
      this.updateSelectionHelper()
    },

    updateSelectionHelper() {
      if (this.selectionBox) {
        this.scene.remove(this.selectionBox)
        this.selectionBox.geometry.dispose()
        this.selectionBox.material.dispose()
        this.selectionBox = null
      }
      if (this.selectedIds.length === 0 || this.selectedLightId) return
      const box = new THREE.Box3()
      let count = 0
      for (const id of this.selectedIds) {
        const root = this.rootMap?.get(id)
        if (!root || !root.visible) continue
        box.expandByObject(root)
        count += 1
      }
      if (count === 0) return
      this.selectionBox = new THREE.Box3Helper(box, 0xffb020)
      this.selectionBox.renderOrder = 830
      this.scene.add(this.selectionBox)
    },

    /**
     * 给本次 gizmo 拖拽要影响的节点做一份原始变换快照。
     *
     * 只快照**场景物体**（`rootMap` 里的根节点）以及多选用的 `pivot`；
     * 摄影机模型不快照 → 不参与减速，保持 1:1 取景手感。
     */
    snapshotTransform() {
      const target = this.transformControls?.object
      if (!target) return null
      // 摄影机模型 / 灯光不在减速范围内（见 TRANSFORM_DRAG_SENSITIVITY 注释）。
      if (target === this.cameraHelper) return null
      if (this.selectedLightId) return null

      const isMultiPivot = Boolean(target.userData?.multiSelect)
      if (!isMultiPivot && !target.userData?.objectId) return null

      if (isMultiPivot) {
        /*
         * 多选：控制柄挂在 `pivot` 上，真正的位移由父组件按增量分发。
         * 这里只需要把 pivot 的起始位置记下来，减速在 pivot 上做即可。
         */
        return {
          multi: true,
          target,
          position: target.position.clone()
        }
      }

      return {
        multi: false,
        target,
        position: target.position.clone(),
        quaternion: target.quaternion.clone(),
        scale: target.scale.clone()
      }
    },

    /**
     * 把 TransformControls 算出的「原始」变换按减速系数折回一部分。
     *
     * 关键是**每次都从按下时的快照换算**，而不是在上一帧结果上累乘：
     * TransformControls 是按"指针相对按下点的位移"算绝对值的，
     * 从快照换算既不会漂移，也不受帧率影响。
     */
    dampTransformDuringDrag() {
      const start = this.dragStartTransform
      if (!start || !this.transformDragging) return
      const target = this.transformControls?.object
      if (!target || target !== start.target) return
      const k = TRANSFORM_DRAG_SENSITIVITY

      // 位移：线性插值回起点方向。
      target.position.set(
        start.position.x + (target.position.x - start.position.x) * k,
        start.position.y + (target.position.y - start.position.y) * k,
        start.position.z + (target.position.z - start.position.z) * k
      )

      if (start.multi) return

      /*
       * 旋转：沿最短弧把"起始朝向 → 原始朝向"的转角按比例缩小。
       * 用 slerp 而不是对欧拉角做插值——欧拉角插值会在某些姿态下走偏，
       * 甚至出现万向锁跳变。
       *
       * 必须先把原始朝向**拷贝出来**再 `copy(start)`：
       * `slerp()` 是原地修改，若直接 `copy(start).slerp(target, k)`，
       * 此时 target 已被覆盖成 start，等于"和自己插值"，
       * 结果是永远转不动（实测转角恒为 0°）。
       */
      const rawQuaternion = target.quaternion.clone()
      target.quaternion.copy(start.quaternion).slerp(rawQuaternion, k)

      // 缩放：按比例折回（缩放是乘性的，用线性插值就够了，且不会越界）。
      target.scale.set(
        start.scale.x + (target.scale.x - start.scale.x) * k,
        start.scale.y + (target.scale.y - start.scale.y) * k,
        start.scale.z + (target.scale.z - start.scale.z) * k
      )
    },

    /**
     * 上报当前控制柄的位置。
     *
     * `commit` 为 false 时只更新视口内的临时显示（拖拽过程中），
     * 为 true 时才把结果写回场景。这样"拖动一次"在撤销栈里只留一帧，
     * 不会出现按几十次 Ctrl+Z 才回到原位的情况。
     */
    emitTransform(commit = true) {
      if (!this.ready) return
      if (this.selectedLightId) {
        const light = this.lightMap?.get(this.selectedLightId)
        if (!light) return
        this.$emit('light-transform', {
          id: this.selectedLightId,
          position: { x: light.position.x, y: light.position.y, z: light.position.z },
          commit
        })
        return
      }

      // 操作场景摄影机：平移改机位，旋转改朝向。
      //
      // helper 在构建时用 `lookAt(target)` 对齐过，因此它的本地 -Z 就是视线方向。
      // 旋转后取「位置 + 视线方向 × 原距离」作为新 target，
      // 这样用户旋转机身时，取景方向跟着转，但注视距离保持不变——
      // 手感更接近真实的摇镜头，而不是让目标点乱跳。
      if (this.cameraSelected && this.cameraHelper) {
        const helper = this.cameraHelper
        const state = this.cameraState
        const position = { x: helper.position.x, y: helper.position.y, z: helper.position.z }

        const distance = Math.hypot(
          state.target.x - state.position.x,
          state.target.y - state.position.y,
          state.target.z - state.position.z
        )
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(helper.quaternion).normalize()
        const target = {
          x: position.x + direction.x * distance,
          y: position.y + direction.y * distance,
          z: position.z + direction.z * distance
        }

        this.$emit('camera-transform', { position, target, commit })
        return
      }

      if (this.selectedIds.length === 1) {
        const root = this.rootMap?.get(this.selectedIds[0])
        if (!root) return
        this.$emit('object-transform', {
          id: this.selectedIds[0],
          position: { x: root.position.x, y: root.position.y, z: root.position.z },
          rotation: {
            x: THREE.MathUtils.radToDeg(root.rotation.x),
            y: THREE.MathUtils.radToDeg(root.rotation.y),
            z: THREE.MathUtils.radToDeg(root.rotation.z)
          },
          size: { x: root.scale.x, y: root.scale.y, z: root.scale.z },
          commit
        })
        return
      }

      if (this.selectedIds.length > 1 && this.pivot) {
        // 多选拖动：把控制柄的累计位移分发给每个选中物体。
        const position = this.pivot.position
        const previous = this.pivot.userData.previousPosition
        if (previous) {
          const delta = {
            x: position.x - previous.x,
            y: position.y - previous.y,
            z: position.z - previous.z
          }
          if (Math.abs(delta.x) + Math.abs(delta.y) + Math.abs(delta.z) > 1e-6) {
            this.$emit('objects-transform', { delta, commit })
          }
        }
        this.pivot.userData.previousPosition = position.clone()
      }
    },

    // ------------------------------------------------------------------
    // 指针交互
    // ------------------------------------------------------------------

    updatePointer(event) {
      const rect = this.$refs.canvas.getBoundingClientRect()
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      this.raycaster.setFromCamera(this.pointer, this.camera)
    },

    pickObject() {
      const candidates = []
      this.objectGroup.traverse((child) => {
        if (child instanceof THREE.Mesh && child.visible) candidates.push(child)
      })
      const hits = this.raycaster.intersectObjects(candidates, false)
      for (const hit of hits) {
        if (!hit.object.visible) continue
        return hit
      }
      return null
    },

    pickGround() {
      if (!this.ground) return null
      const hits = this.raycaster.intersectObject(this.ground, false)
      return hits.length > 0 ? hits[0].point.clone() : null
    },

    /**
     * 指针是否正落在变换控制柄（gizmo）上。
     *
     * 关键判断，缺了它会直接导致"gizmo 拖不动"：
     * gizmo 不属于 objectGroup，射线拾取必然落空，
     * 于是这里会被当成"点了空白"而清空选中，
     * 进而触发 selectedIds 变化 → attachTransformControls → detach()，
     * 控制柄在拖动途中就被摘掉了，表现就是"怎么拖都没反应"。
     *
     * `axis` 在悬停/拖拽控制柄时非空，是 three.js 官方提供的判定方式。
     */
    isPointerOnGizmo() {
      return Boolean(this.transformControls?.axis) || Boolean(this.transformControls?.dragging)
    },

    /**
     * 进入"手势独占"：锁住 OrbitControls，并捕获指针。
     *
     * 为什么需要指针捕获：
     * 拖拽造物/画线时，指针很容易移出 canvas 边界（尤其是拖到画面边缘时）。
     * 一旦移出，`pointerup` 会落在别的元素上，canvas 收不到，
     * `controls.enabled` 就永久停在 false —— 用户会觉得"镜头突然不能转了"，
     * 而且不刷新页面恢复不了。
     *
     * `setPointerCapture` 把后续事件强制路由回 canvas，松手必定能收到。
     */
    beginExclusiveGesture(event) {
      this.controls.enabled = false
      this.exclusiveGestureActive = true
      try {
        this.$refs.canvas?.setPointerCapture?.(event.pointerId)
      } catch {
        // 合成事件没有真实 pointerId，捕获会失败；此时靠 pointerup 兜底即可。
      }
    },

    /** 退出"手势独占"：解锁镜头并释放捕获。可重复调用。 */
    endExclusiveGesture(event) {
      if (!this.exclusiveGestureActive) return
      this.exclusiveGestureActive = false
      this.controls.enabled = true
      try {
        if (event) this.$refs.canvas?.releasePointerCapture?.(event.pointerId)
      } catch {
        // 没捕获过就没什么可释放的。
      }
    },

    /**
     * 指针按下。
     *
     * 左键同时承担两件事：拖拽环绕镜头、点击选择物体。
     * 这里只记录起点，真正的选择在 pointerup 时判断"是否几乎没有移动"，
     * 否则每次转动视角都会顺手把选中项清空——这是上一版最影响手感的问题。
     */
    handlePointerDown(event) {
      /*
       * 预演期间视口只负责"播放成片"，不接受任何编辑手势。
       *
       * 这一条必须放在最前面：否则左键拖拽会转动编辑相机（预演用的是
       * 另一台相机，转了也看不出来），点击还会悄悄改动选中项——
       * 用户退出预演时发现选中的东西变了，却找不到是什么时候点的。
       */
      if (this.previewActive) return

      /*
       * ============ 指针事件优先级（从上到下，先命中先处理）============
       *
       * 1. 预演：不接受任何编辑手势（上面已返回）。
       * 2. **控制柄（gizmo）**：优先级最高。用户明确把指针放在某根轴上了，
       *    意图就是"拖这个物体/灯光"，不该被任何导航手势抢走。
       * 3. 相机视角的中键 / 左键：转视角或点选。
       * 4. 右键：交给 OrbitControls 平移。
       * 5. 常规拾取与造物手势。
       *
       * 第 2 条**必须排在相机视角分支之前**：否则相机视角下拖 gizmo 会被
       * 当成"转视角"，表现就是"取景时摆不动物体"。
       */
      if (this.isPointerOnGizmo()) return

      /*
       * 相机视角下的中键拖拽 = 转向。
       *
       * 必须排在 OrbitControls 之前处理：OrbitControls 的中键是 DOLLY，
       * 不拦的话同一次拖拽既转向又推拉，画面会又转又缩。
       * 中键还要 preventDefault，否则浏览器会进入"自动滚动"模式。
       */
      if (this.cameraViewActive && event.button === 1) {
        event.preventDefault()
        this.beginNavLook(event)
        return
      }

      /*
       * 相机视角下的左键：**拖拽=转视角，点按=选中物体**。
       *
       * 按下时先不做判定，只记起点：
       * - 指针移动超过阈值 → 当成拖拽，走和镜头转向同一条路径；
       * - 松手时几乎没动 → 当成点按，在 `handlePointerUp` 里做拾取。
       *
       * 不能在按下时直接拾取：那样每次想转视角都会顺手改掉选中项
       * （用户看到的是"一转镜头选中的东西就变了"）。
       * 也不能在移动后就放弃选中：用户就是想"点一下选中"，
       * 而手抖 1~2px 是常态，所以阈值用项目里既有的 4px。
       */
      if (this.cameraViewActive && event.button === 0) {
        this.pointerDownAt = { x: event.clientX, y: event.clientY }
        this.navPressPending = true
        this.updatePointer(event)
        return
      }

      if (event.button === 2) {
        // 右键交给 OrbitControls 做平移，不参与拾取。
        return
      }

      this.pointerDownAt = { x: event.clientX, y: event.clientY }
      this.updatePointer(event)

      /*
       * 一、导航线绘制优先于一切拾取。
       *
       * 同时必须把 OrbitControls 关掉：否则按住左键画线时视角会跟着转，
       * 用户看到的是"线在乱飞"。松手时（handlePointerUp）再打开。
       */
      if (this.pathDraft) {
        this.beginExclusiveGesture(event)
        this.pathDrafting = true
        const point = this.pickGround()
        this.pathDraftNodes = point ? [{ x: point.x, y: 0, z: point.z }] : []
        this.rebuildPaths()
        return
      }

      /*
       * 二、拖拽造物（quick-build）同样要"手势独占"。
       *
       * 这里必须排在摄影机 / 物体拾取**之前**，理由有两个：
       *
       * 1. 用户按下左键的意图是"拉出墙体/地面"，不是"选东西"。
       *    如果先走拾取，一旦指针下方正好是摄影机模型或某个物体，
       *    就会变成选中它，顺手把手势打断——表现是"拖一半就没了"。
       * 2. 必须 `controls.enabled = false`。OrbitControls 的左键是 ROTATE，
       *    不禁用的话同一次拖拽会同时铺墙和转镜头，
       *    用户看到的是"墙在生成，画面却在打转"。
       *
       * 松手时在 handlePointerUp 里统一恢复。
       */
      if (this.tool === 'quick-build' && this.quickBuildDraft) {
        this.beginExclusiveGesture(event)
        const point = this.pickGround()
        if (point) this.$emit('quick-build-start', { x: point.x, y: 0, z: point.z })
        return
      }

      // 三、点在导航线节点球上：进入"沿路径滑动"拖拽。
      const pathNode = this.pickPathNode()
      if (pathNode) {
        this.startPathNodeDrag(pathNode)
        return
      }

      // 四、摄影机与物体按"谁离镜头更近"决定选中谁。
      //
      // 不能让摄影机无条件优先：用户把方块挡在摄影机前面时，
      // 点方块应该选中方块。也不能让物体优先：摄影机的机身往往
      // 就悬在物体附近，反过来说会点不中摄影机。
      //
      // 另外这里不能加 `if (!this.cameraSelected)` 的前置条件——
      // 那样在摄影机已选中时再点它，逻辑会继续往下走到 pickObject，
      // 落空后发出 selection-clear，刚选中的摄影机立刻被取消选中。
      this.selectAtPointer(event)
    },

    /**
     * 按指针位置做一次拾取与选中。
     *
     * 从 `handlePointerDown` 里抽出来，是因为相机视角下左键要区分
     * "点按=选中"与"按住=拖拽转视角"：选中必须发生在**松手**且没有拖动时，
     * 所以同一段逻辑要在 `handlePointerUp` 里也能调用。
     */
    selectAtPointer(event) {
      const cameraPoint = this.pickSceneCamera()
      const hit = this.pickObject()
      const cameraDistance = cameraPoint ? cameraPoint.distanceTo(this.raycaster.ray.origin) : Infinity
      const objectDistance = hit ? hit.distance : Infinity

      if (cameraPoint && cameraDistance <= objectDistance) {
        this.$emit('camera-select')
        return
      }

      if (this.tool === 'paint' && hit) {
        this.$emit('paint-face', {
          objectId: hit.object.userData.objectId,
          triangle: hit.faceIndex,
          color: this.paintColor,
          scope: this.paintScope
        })
        return
      }

      if (this.tool === 'cut' && this.cutTool && hit) {
        this.$emit('cut-pick', hit.object.userData.objectId)
        return
      }

      if (!hit) {
        // 点空白：交给父组件统一清空物体 / 灯光 / 摄影机三种选中状态。
        if (!event.shiftKey && event.button === 0) this.$emit('selection-clear')
        return
      }
      const objectId = hit.object.userData.objectId
      if (!objectId) return

      if (event.shiftKey) {
        const next = this.selectedIds.includes(objectId)
          ? this.selectedIds.filter((id) => id !== objectId)
          : [...this.selectedIds, objectId]
        this.$emit('selection-change', next)
      } else if (!this.selectedIds.includes(objectId)) {
        this.$emit('selection-change', [objectId])
      }
    },

    // ------------------------------------------------------------------
    // 导航线绘制与节点拖拽
    // ------------------------------------------------------------------

    /**
     * 拾取"指针下方的导航线节点"。
     *
     * 不用射线打小球网格，而是把每个节点投影到屏幕上比像素距离。
     * 原因：小球是按相机距离动态缩放的，半径换算回屏幕像素很绕；
     * 而且用户点节点时容错本来就该比"刚好命中球面"宽松一些。
     */
    pickPathNode() {
      if (!this.pathGroup || !this.pathGroup.children.length) return null
      const canvas = this.$refs.canvas
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const pointerX = this.pointer.x
      const pointerY = this.pointer.y
      const cameraPosition = new THREE.Vector3()
      this.camera.getWorldPosition(cameraPosition)

      let best = null
      for (const [key, node] of this.pathHitMap ?? []) {
        const projected = new THREE.Vector3(node.x, node.y, node.z).project(this.camera)
        if (projected.z >= 1) continue
        const ndcDistance = Math.hypot(projected.x - pointerX, projected.y - pointerY)
        // 距离越远，节点的屏幕半径越小，容差也跟着收紧，避免远处误选。
        const worldDistance = new THREE.Vector3(node.x, node.y, node.z).distanceTo(cameraPosition)
        const tolerance = Math.min(0.045, (0.11 * 1.6) / Math.max(worldDistance, 0.001))
        if (ndcDistance > tolerance) continue
        if (!best || ndcDistance < best.distance) {
          const [pathId, indexText] = key.split(':')
          best = { pathId, index: Number(indexText), distance: ndcDistance }
        }
      }
      void rect
      return best
    },

    /**
     * 开始拖拽一个导航线节点。
     *
     * 拖拽被限制在"相邻两段"上（相邻段 = 前一段 + 后一段）。
     * 这样节点只能沿线滑动，符合"节点沿导航线移动"的语义；
     * 如果放开全路径投影，指针扫过远处时节点会跳到线另一头。
     */
    startPathNodeDrag(hit) {
      const object = this.objects.find((item) => item.id === hit.pathId)
      if (!object) return
      const worldNodes = this.pathWorldNodes(object)
      if (hit.index < 0 || hit.index >= worldNodes.length) return

      const segments = adjacentSegmentsFor(worldNodes, hit.index)
      if (segments.length === 0) return

      this.controls.enabled = false
      this.pathNodeDrag = { pathId: hit.pathId, index: hit.index, segments }
      this.$emit('path-node-select', { pathId: hit.pathId, index: hit.index })
    },

    /** 拖拽过程中：把指针射线投影到相邻段上，得到新的节点位置。 */
    updatePathNodeDrag() {
      const drag = this.pathNodeDrag
      if (!drag) return
      const object = this.objects.find((item) => item.id === drag.pathId)
      if (!object) return
      const worldNodes = this.pathWorldNodes(object)
      const hit = closestPointOnSegmentsToRay(
        worldNodes,
        drag.segments,
        this.raycaster.ray.origin,
        this.raycaster.ray.direction
      )
      if (!hit) return

      // 转回局部坐标（路径对象位置是唯一参与的变换）。
      const origin = object.position
      const local = {
        x: hit.position.x - origin.x,
        y: 0,
        z: hit.position.z - origin.z
      }
      this.previewPathNode(drag.pathId, drag.index, local)
      this.$emit('path-node-move', {
        pathId: drag.pathId,
        index: drag.index,
        x: local.x,
        z: local.z,
        commit: false
      })
    },

    /**
     * 只改视口里的几何，不动 store。
     * 拖拽期间每帧走一次，用来做"零延迟"的视觉反馈。
     */
    previewPathNode(pathId, index, local) {
      const group = this.pathGroup?.children.find((child) => child.userData.pathId === pathId)
      if (!group) return
      const origin = this.objects.find((item) => item.id === pathId)?.position ?? { x: 0, y: 0, z: 0 }
      const world = new THREE.Vector3(origin.x + local.x, origin.y + (local.y ?? 0), origin.z + local.z)

      for (const child of group.children) {
        if (child.userData?.pathNodeIndex === index) child.position.copy(world)
      }
      // 折线要整条重建：改一个顶点就要重算 position 属性。
      const line = group.children.find((child) => child.type === 'Line')
      if (line) {
        const nodes = []
        const sphereByIndex = new Map()
        for (const child of group.children) {
          if (child.userData?.pathNodeIndex === undefined) continue
          sphereByIndex.set(child.userData.pathNodeIndex, child.position)
        }
        for (const key of [...sphereByIndex.keys()].sort((a, b) => a - b)) {
          nodes.push(sphereByIndex.get(key).clone())
        }
        line.geometry.dispose()
        line.geometry = new THREE.BufferGeometry().setFromPoints(nodes)
      }
      this.updatePathNodeScale()
    },

    /** 结束拖拽：提交一次，撤销栈里只留一帧。 */
    finishPathNodeDrag() {
      const drag = this.pathNodeDrag
      if (!drag) return
      this.pathNodeDrag = null
      this.controls.enabled = true

      const object = this.objects.find((item) => item.id === drag.pathId)
      const worldNodes = object ? this.pathWorldNodes(object) : []
      // previewPathNode 已经把位置画出来了，这里直接读回当前几何即可，
      // 避免"松手时射线又动了一下"导致提交值和看到的不一致。
      const group = this.pathGroup?.children.find((child) => child.userData.pathId === drag.pathId)
      const sphere = group?.children.find((child) => child.userData?.pathNodeIndex === drag.index)
      if (!sphere || !object) {
        this.rebuildPaths()
        return
      }
      const origin = object.position
      this.$emit('path-node-move', {
        pathId: drag.pathId,
        index: drag.index,
        x: sphere.position.x - origin.x,
        z: sphere.position.z - origin.z,
        commit: true
      })
      void worldNodes
    },

    /**
     * 绘制中：把指针位置追加成节点，按固定间距采样。
     *
     * 采样的意义：原始 pointermove 每秒几十个点，直接全存下来
     * 会让路径节点密到"每隔几厘米一个"，时间轴轨道也会被挤成一团。
     * 只有离上一个节点超过 PATH_NODE_SPACING 才落新节点。
     */
    appendPathDraftPoint(point) {
      if (!this.pathDraftNodes) this.pathDraftNodes = []
      const nodes = this.pathDraftNodes
      const last = nodes[nodes.length - 1]
      if (last && Math.hypot(point.x - last.x, point.z - last.z) < PATH_NODE_SPACING) return
      nodes.push({ x: point.x, y: 0, z: point.z })
      this.rebuildPaths()
    },

    handlePointerMove(event) {
      /*
       * 相机视角左键：超过阈值才认定为"拖拽转视角"。
       *
       * 一旦越过阈值就转入正常的 look 拖拽流程，并清掉"待选中"标记——
       * 否则松手时会顺手把拖拽起点处的物体选中，用户会觉得"转个视角怎么选中变了"。
       */
      if (this.navPressPending && !this.navState?.dragging) {
        const distance = this.pointerDownAt
          ? Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y)
          : Infinity
        if (distance > 4) {
          this.navPressPending = false
          this.beginNavLook(event)
        }
      }

      // 相机视角转向优先：中键/左键拖拽期间不做任何拾取或造物手势。
      if (this.navState?.dragging) {
        this.updateNavLook(event)
        return
      }

      if (this.pathNodeDrag) {
        this.updatePointer(event)
        this.updatePathNodeDrag()
        return
      }

      if (this.pathDrafting) {
        this.updatePointer(event)
        const point = this.pickGround()
        if (point) this.appendPathDraftPoint({ x: point.x, y: 0, z: point.z })
        return
      }

      if (this.tool !== 'quick-build' || !this.quickBuildDraft) return
      this.updatePointer(event)
      const point = this.pickGround()
      if (point) this.$emit('quick-build-move', { x: point.x, y: 0, z: point.z })
    },

    /**
     * 判断这次按下→抬起是否算"点击"而不是"拖拽"。
     * 阈值 4px：手抖在这个范围内仍按点击处理，转动视角一定会超过。
     */
    isClickGesture(event) {
      if (!this.pointerDownAt) return true
      const distance = Math.hypot(event.clientX - this.pointerDownAt.x, event.clientY - this.pointerDownAt.y)
      return distance <= 4
    },

    handlePointerUp(event) {
      /*
       * 相机视角左键松手：拖过就是转视角的收尾，没拖过就是"点按选中"。
       *
       * 顺序很重要：先处理拖拽收尾（提交一次撤销），再处理点按拾取。
       */
      if (this.navPressPending) {
        this.navPressPending = false
        this.pointerDownAt = null
        this.updatePointer(event)
        this.selectAtPointer(event)
        return
      }

      // 中键 / 左键转向结束：提交一次，保证"拖一次 = 撤销一次"。
      if (this.navState?.dragging) {
        this.endNavLook(event)
        return
      }

      const wasClick = this.isClickGesture(event)
      this.pointerDownAt = null

      if (this.pathNodeDrag) {
        this.finishPathNodeDrag()
        return
      }

      if (this.pathDrafting) {
        this.pathDrafting = false
        this.endExclusiveGesture(event)
        this.updatePointer(event)
        const point = this.pickGround()
        if (point) this.appendPathDraftPoint({ x: point.x, y: 0, z: point.z })
        const nodes = [...(this.pathDraftNodes ?? [])]
        this.pathDraftNodes = null
        this.$emit('path-draw-end', { nodes })
        return
      }

      if (this.tool === 'quick-build' && this.quickBuildDraft) {
        this.updatePointer(event)
        const point = this.pickGround()
        // 拖拽造物期间视角被锁住了，松手必须解锁，否则用户再也转不动镜头。
        this.endExclusiveGesture(event)
        if (point) this.$emit('quick-build-end', { x: point.x, y: 0, z: point.z })
        return
      }

      /*
       * 兜底解锁。
       *
       * 正常情况下 quick-build / 画线分支已经在上面 return 掉了。
       * 但如果用户在手势中切走了工具、或组件在拖拽途中被销毁，
       * 这里必须把"手势独占"清掉——否则 OrbitControls 会一直是 disabled，
       * 表现为"镜头彻底不能转"，而且没有任何提示，用户只能刷新页面。
       */
      this.endExclusiveGesture(event)

      // 拖拽过视角就不再重复拾取：松开鼠标时镜头已经移动，
      // 按当前位置再拾一次会误选到扫过的物体，体验上像是"乱选"。
      if (!wasClick) return
    },

    preventContextMenu(event) {
      event.preventDefault()
    },

    // ------------------------------------------------------------------
    // 循环与尺寸
    // ------------------------------------------------------------------

    handleResize() {
      if (!this.renderer) return
      const container = this.$el
      const width = container.clientWidth
      const height = container.clientHeight
      if (width === 0 || height === 0) return
      /*
       * 尺寸没变就直接返回：ResizeObserver 会在很多与本视口无关的重排里被触发，
       * 每次重建投影矩阵是白费功夫。
       */
      if (width === this.canvasWidth && height === this.canvasHeight) return
      this.canvasWidth = width
      this.canvasHeight = height
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(width, height, false)
    },

    animate() {
      this.animationFrame = requestAnimationFrame(this.animate)
      if (!this.renderer) return
      /*
       * 导出期间暂停主循环。
       *
       * captureFrameToCanvas 会临时改渲染器尺寸并手动 render 一次；
       * 如果这里同时还在渲染，两处会互相踩：屏幕上闪、相机被阻尼挪动、
       * 成片出现无法解释的抖动。
       */
      if (this.exporting) return
      // 相机视角飞行：必须在 controls.update() 之前推进，
      // 否则本帧的位移要等下一帧才反映到画面上（手感发黏）。
      this.stepCameraView()
      /*
       * OrbitControls 在 `wasd` 相机视角下必须停跑。
       *
       * 它的 update() 会 `camera.lookAt(target)` 并按 `position - target`
       * 反推球坐标再写回位置，于是：朝向被强制指回旧 target（中键转向
       * 看不到效果），相机飞近注视点时球坐标退化、被钉死在 target 上
       * （表现为"往前飞一段后突然不动"）。这两条都实测复现过。
       */
      if (shouldRunOrbitControls(this.cameraViewActive, this.cameraNavScheme)) {
        /*
         * 环绕方案下每帧同步轴心：绑定了物体时轴心就是物体位置，
         * 物体一动（导航线 / 关键帧动画）相机就跟着走，这就是"锁定并跟随"。
         * 必须在 controls.update() 之前写，否则本帧要等下一帧才生效。
         */
        if (this.cameraViewActive) this.applyOrbitPivot(false)
        this.controls.update()
      }
      // 地面与网格跟随相机中心，形成"无限地面"效果。
      const gridX = Math.round(this.controls.target.x / 20) * 20
      const gridZ = Math.round(this.controls.target.z / 20) * 20
      this.ground.position.set(gridX, 0, gridZ)
      this.grid.position.set(gridX, 0, gridZ)
      // 节点球按相机距离缩放：每帧一次很便宜（几个球），
      // 但缺了它拖动视角时节点大小会"随距离呼吸"，很难点中。
      if (this.pathGroup?.children.length) this.updatePathNodeScale()

      /*
       * 成片预演：不走编辑视角，按成片画幅渲染场景摄影机。
       *
       * 这里刻意**复用导出时的同一套东西**：
       *   - 相机位姿来自 `cameraState`（父组件已用时间轴求值过）；
       *   - 画幅来自 `aspectWidth : aspectHeight`（与 outputSize 同源）；
       *   - 辅助对象用 `withEditorOverlaysHidden()`（与导出共用一个清单）。
       * 所以"预演看到的"和"导出得到的"是同一张图，只是尺寸不同。
       *
       * 为什么用 scissor 而不是把相机 aspect 改成画幅：
       * 视口的物理宽高比是固定的（用户窗口决定）。要显示 16:9 的成片，
       * 只能"在视口里框出一块 16:9 的区域"，其余部分留黑边——
       * 这正是所有剪辑软件的预览窗做法。
       */
      if (this.previewActive) {
        this.renderPreviewFrame()
        return
      }

      this.renderer.render(this.scene, this.camera)

      // 监视器跟随主循环一起刷新。
      // 它是"选中摄影机所见"，因此只要相机位姿变了就必须重画——
      // 相机位姿每帧都可能被时间轴或 gizmo 改动，逐帧渲染最省心。
      // 窗口未打开时 monitorReady 为 false，这里是一次布尔判断，开销可忽略。
      if (this.monitorReady) this.renderMonitor()
    },

    /**
     * 渲染一帧成片预演。
     *
     * 布局：画面按成片画幅等比缩放后居中，四周补黑边。
     * 渲染内容与导出完全一致——不只是一台相机，连"哪些对象算辅助"
     * 都走同一个 `editorOverlays()` 清单。
     */
    renderPreviewFrame() {
      const renderer = this.renderer
      if (!renderer) return
      const camera = this.previewCamera
      if (!camera) return

      const state = this.cameraState
      const ratio = state.aspectWidth / state.aspectHeight
      const size = renderer.getSize(new THREE.Vector2())
      const maxWidth = size.x * 0.96
      const maxHeight = size.y * 0.96
      const width = Math.round(Math.min(maxWidth, maxHeight * ratio))
      const height = Math.round(width / ratio)
      const left = Math.round((size.x - width) / 2)
      const bottom = Math.round((size.y - height) / 2)
      this.previewRect = { left, bottom, width, height }

      // 相机与监视器同一套取位逻辑：position / target / fov / 画幅。
      camera.position.set(state.position.x, state.position.y, state.position.z)
      camera.up.set(0, 1, 0)
      camera.lookAt(state.target.x, state.target.y, state.target.z)
      camera.fov = state.fovDegrees
      camera.aspect = ratio
      camera.updateProjectionMatrix()

      renderer.setScissorTest(false)
      // 黑边用中性深色，浅色主题下也不会刺眼。
      renderer.setClearColor(0x0b0e10, 1)
      renderer.clear()
      renderer.setViewport(left, bottom, width, height)
      renderer.setScissor(left, bottom, width, height)
      renderer.setScissorTest(true)
      this.withEditorOverlaysHidden(() => renderer.render(this.scene, camera))
      renderer.setScissorTest(false)
      renderer.setViewport(0, 0, size.x, size.y)
      /*
       * 恢复主题清屏色。
       *
       * **不能调 `applyTheme()`**：它内部会 `remove + dispose` 旧网格、
       * 再 `createGrid()` 建一个新的。放在每帧调用的渲染路径里，
       * 等于每帧重建一次网格几何与材质——预演会立刻掉到个位数帧率，
       * 而且显存在持续分配与释放。
       * 这里只需要把清屏色推回主题值，一行就够。
       */
      renderer.setClearColor(this.theme === 'dark' ? 0x080a0c : 0xf4f6f7, 1)
    },

    // ------------------------------------------------------------------
    // 临时视图：建模草稿与切割平面
    // ------------------------------------------------------------------

    /**
     * 渲染画布建模草稿。
     *
     * 草稿是"半成品"，因此用独立的高亮材质，并且不参与导出：
     * 导出时只取 objectGroup，草稿留在 modelingGroup 里。
     */
    renderModelingDraft(draft) {
      if (!this.modelingGroup) return
      clearGroup(this.modelingGroup)
      if (!draft) return

      const vertexMaterial = new THREE.MeshBasicMaterial({ color: '#ffb020' })
      const edgeMaterial = new THREE.LineBasicMaterial({ color: '#2f7cf6' })
      const faceMaterial = new THREE.MeshBasicMaterial({
        color: '#4b93ff',
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false
      })

      const points = draft.vertices.map((vertex) => {
        const point = new THREE.Vector3(vertex.x, vertex.y, vertex.z)
        if (draft.objectTransform) {
          point.applyMatrix4(
            new THREE.Matrix4().compose(
              new THREE.Vector3(
                draft.objectTransform.position.x,
                draft.objectTransform.position.y,
                draft.objectTransform.position.z
              ),
              new THREE.Quaternion().setFromEuler(
                new THREE.Euler(
                  THREE.MathUtils.degToRad(draft.objectTransform.rotation.x),
                  THREE.MathUtils.degToRad(draft.objectTransform.rotation.y),
                  THREE.MathUtils.degToRad(draft.objectTransform.rotation.z)
                )
              ),
              new THREE.Vector3(1, 1, 1)
            )
          )
        }
        return point
      })

      for (const point of points) {
        const handle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 9), vertexMaterial)
        handle.position.copy(point)
        handle.renderOrder = 860
        this.modelingGroup.add(handle)
      }

      for (const [first, second] of draft.edges) {
        if (!points[first] || !points[second]) continue
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([points[first], points[second]]),
          edgeMaterial
        )
        line.renderOrder = 858
        this.modelingGroup.add(line)
      }

      for (const face of draft.faces) {
        const trianglePoints = []
        for (let index = 1; index < face.length - 1; index += 1) {
          const a = points[face[0]]
          const b = points[face[index]]
          const c = points[face[index + 1]]
          if (!a || !b || !c) continue
          trianglePoints.push(a, b, c)
        }
        if (trianglePoints.length === 0) continue
        const geometry = new THREE.BufferGeometry().setFromPoints(trianglePoints)
        const mesh = new THREE.Mesh(geometry, faceMaterial)
        mesh.renderOrder = 856
        this.modelingGroup.add(mesh)
      }
    },

    /**
     * 渲染切割平面：一个半透明方形 + 边框。
     * 平面朝向与物体无关联，只看轴与偏移，因此可以直接摆在世界空间。
     */
    renderCutPlane(cutTool) {
      if (!this.cutGroup) return
      clearGroup(this.cutGroup)
      if (!cutTool) return

      const size = 8
      const geometry = new THREE.PlaneGeometry(size, size)
      const plane = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: '#ff5f6d',
          transparent: true,
          opacity: 0.14,
          side: THREE.DoubleSide,
          depthWrite: false
        })
      )
      const border = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: '#ff5f6d' })
      )

      const offset = cutTool.offset || 0
      if (cutTool.axis === 'x') {
        plane.rotation.y = Math.PI / 2
        border.rotation.y = Math.PI / 2
        plane.position.x = offset
        border.position.x = offset
      } else if (cutTool.axis === 'z') {
        plane.rotation.x = Math.PI / 2
        border.rotation.x = Math.PI / 2
        plane.position.z = offset
        border.position.z = offset
      } else {
        plane.rotation.x = -Math.PI / 2
        border.rotation.x = -Math.PI / 2
        plane.position.y = offset
        border.position.y = offset
      }
      this.cutGroup.add(plane, border)
    },

    // ------------------------------------------------------------------
    // 供父组件调用的能力
    // ------------------------------------------------------------------

    /**
     * 注入导入模型的真实网格。
     *
     * 解析在 `model-io.js` 里完成（可能很慢），视口只负责替换占位体，
     * 这样切换选择或改颜色时不会重复解析文件。
     */
    setImportedMesh(objectId, root) {
      if (!root || !this.rootMap) return
      this.importedModels.set(objectId, root)
      const container = this.rootMap.get(objectId)
      if (!container) return

      for (const child of [...container.children]) {
        container.remove(child)
        disposeObject(child)
      }
      root.traverse((child) => {
        child.userData.objectId = objectId
        if (child instanceof THREE.Mesh) {
          child.castShadow = true
          child.receiveShadow = true
        }
      })
      container.add(root)
      this.applyObjectAppearance(container, this.objects.find((item) => item.id === objectId) || {})
    },

    /** 把场景（仅可见物体）导出为模型文件。 */
    async exportSceneModel(format) {
      const { exportStaticModel } = await import('@/core/model-io')
      // 克隆一份，避免导出器顺手改动真实节点（例如 onlyVisible 时改 visible）。
      const clone = this.objectGroup.clone(true)
      clone.position.set(0, 0, 0)
      clone.rotation.set(0, 0, 0)
      clone.scale.set(1, 1, 1)
      return exportStaticModel(clone, format)
    },

    /**
     * 把相机调整到能看全当前场景的位置。
     *
     * 场景摄影机也纳入取景范围：它同样是场景里的对象，
     * 如果对准场景后它还留在画面外，用户就会以为"没有摄影机"，
     * 更谈不上点它（这正是"画面里点不中摄影机"的一部分原因）。
     */
    focusView(objectIds) {
      const ids = objectIds && objectIds.length > 0 ? objectIds : this.selectedIds
      const box = new THREE.Box3()
      let count = 0
      for (const object of this.objects) {
        if (ids.length > 0 && !ids.includes(object.id)) continue
        const root = this.rootMap?.get(object.id)
        if (!root || !root.visible) continue
        box.expandByObject(root)
        count += 1
      }

      // 只在"没有指定要聚焦的物体"时把摄影机算进来，
      // 否则用户聚焦某个物体时会被远处的摄影机把视野拉走。
      if (ids.length === 0 && this.cameraHelper) {
        box.expandByObject(this.cameraHelper)
        count += 1
      }

      if (count === 0) {
        box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(4, 2, 4))
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const distance = Math.max(sphere.radius * 2.8, 3)
      const direction = new THREE.Vector3(0.62, 0.48, 0.78).normalize()
      this.camera.position.copy(sphere.center).addScaledVector(direction, distance)
      this.controls.target.copy(sphere.center)
      this.controls.update()
      // 取景后立刻同步矩阵，否则后续投影/拾取会用到上一帧的矩阵。
      this.camera.updateMatrixWorld()
    },

    /** 切到"摄影机视角"：把编辑相机对齐到场景相机的位姿。 */
    applyCameraState(state) {
      if (!this.camera) return
      this.camera.position.set(state.position.x, state.position.y, state.position.z)
      this.controls.target.set(state.target.x, state.target.y, state.target.z)
      this.camera.fov = state.fovDegrees
      this.camera.updateProjectionMatrix()
      this.controls.update()
    },

    // ------------------------------------------------------------------
    // 相机视角导航
    // ------------------------------------------------------------------

    /**
     * 拖拽期间"看向目标"的**实时**位置。
     *
     * 为什么需要它：拖 gizmo 时 `handleObjectTransform(commit:false)` 只改
     * 视口里的 three.js 根节点、**不写 store**（否则每帧写历史会灌满撤销栈）。
     * 于是 `cameraState`（父组件解算好的相机）里的看向点仍是拖拽开始前的旧值，
     * 轴心/瞄准都跟着不动——用户看到的是"拖的时候镜头不动，一松手镜头瞬移过去"。
     *
     * 这里直接从正在被拖的节点读实时位置来解算，就能做到每帧平滑跟随。
     * 只在"被拖的正是绑定物体"时生效；其余时刻返回 null，由调用方回退到
     * 父组件解算好的值（那条路径是导出/预览共用的，必须保持一致）。
     */
    liveBoundTarget() {
      const state = this.cameraState
      if (!state?.targetObjectId) return null
      if (state.lookAtEnabled === false) return null
      // 只在拖拽期间需要实时值；松手后 store 已经更新，走常规路径即可。
      if (!this.transformDragging) return null
      const dragged = this.transformControls?.object
      if (!dragged || dragged.userData?.objectId !== state.targetObjectId) return null
      const data = this.objects?.find((object) => object.id === state.targetObjectId)
      if (!data) return null
      /*
       * 只替换位置，其余字段（kind / size）沿用 store 数据——它们在一次
       * 位置拖拽里不会变，但 `objectFocusPoint` 需要它们来算竖直偏移
       * （人台、导入模型的 position 在底部，必须抬升半个高度）。
       */
      return objectFocusPoint({
        ...data,
        position: { x: dragged.position.x, y: dragged.position.y, z: dragged.position.z }
      })
    },

    /**
     * `orbit` 方案（Maya 环绕）的环绕轴心。
     *
     * 两条规则：
     * 1. **未绑定物体时轴心是世界原点 (0,0,0)** —— 这是 Maya tumble pivot 的
     *    默认值。不用"相机当前看向点"做轴心，是因为那个点会随着上一次运镜
     *    漂到任意位置，用户根本无法预期自己会绕着哪儿转。
     * 2. **绑定了物体时轴心是该物体的位置** —— 这样物体一动（走导航线、
     *    播关键帧），轴心跟着走，相机就实现了"锁定并跟随"。
     *
     * 注意 `cameraState` 是父组件已经解算过绑定的相机，所以这里直接读它的
     * `target` 就是物体的位置；未绑定时它等于静态 target，因此要用
     * `targetObjectId` 区分这两种情况。
     */
    orbitPivotPoint() {
      // 拖拽绑定物体期间用实时位置，否则镜头要等松手才跟过去。
      const live = this.liveBoundTarget()
      if (live) return live
      const state = this.cameraState
      if (!state) return { x: 0, y: 0, z: 0 }
      /*
       * 只有**绑定生效**时才用物体位置做轴心。
       * 关掉"看向物体"开关后绑定关系仍在，但相机应当回到世界原点环绕——
       * 否则会出现"开关关了、轴心还在跟物体跑"的不一致。
       */
      if (state.targetObjectId && state.lookAtEnabled !== false) return state.target
      return { x: 0, y: 0, z: 0 }
    },

    /**
     * 把环绕轴心写进 OrbitControls。
     *
     * **相机不跟随物体平移，只是持续"看向"轴心。**
     * 物体移动时只更新 `controls.target`：`OrbitControls.update()` 会按
     * `position - target` 反推球坐标再写回位置，位置因此**保持不变**，
     * 而它每帧末尾的 `lookAt(target)` 让视线跟到新目标上。
     * 代价是环绕半径会随物体距离变化——这是"只看不跟"的固有语义。
     *
     * 注意：曾经这里还有一套"机位与轴心一起平移"的刚性跟随（可选开关）。
     * 它已被移除——用户要的是"镜头单纯的看向 target"。
     * 如果以后要重新加回平移跟随，务必记住：**必须机位与轴心一起平移**，
     * 只改 target 反而会被 `update()` 把相机按在原地。
     *
     * `snap=true`（进入环绕 / 切换方案的那一刻）额外把视线立刻对准轴心：
     * 不做的话画面还停在旧朝向，要拖一下才"跳"过去。
     */
    applyOrbitPivot(snap) {
      if (!this.controls || !this.camera) return
      const pivot = this.orbitPivotPoint()

      /*
       * 轴心与机位距离过近时**不动轴心**。
       *
       * 物体走到相机跟前时 `|position - target| → 0`，`lookAt` 的方向退化、
       * 球坐标半径趋零，相机可能被钉死或抖动。此时保持上一帧的轴心更稳，
       * 物体擦身而过后自然恢复。
       */
      const radius = Math.hypot(
        this.camera.position.x - pivot.x,
        this.camera.position.y - pivot.y,
        this.camera.position.z - pivot.z
      )
      if (radius < 0.05) return

      this.controls.target.set(pivot.x, pivot.y, pivot.z)

      if (!snap) return
      this.camera.lookAt(pivot.x, pivot.y, pivot.z)
      // navState 也要同步：切回 wasd 时朝向必须连续，否则会突然转一下。
      if (this.navState) {
        const orientation = orientationFromCameraTarget({
          position: {
            x: this.camera.position.x,
            y: this.camera.position.y,
            z: this.camera.position.z
          },
          target: pivot
        })
        this.navState.yaw = orientation.yaw
        this.navState.pitch = orientation.pitch
        this.navState.distance = Math.max(orientation.distance, 1)
      }
    },

    /**
     * 进入相机视角：初始化导航内部状态。
     *
     * 为什么要单独记 yaw/pitch/distance 而不是每帧从 `controls` 反推：
     * 飞行时相机位置由我们自己推进（不经过 OrbitControls），
     * 而 OrbitControls 的 target 会被它自己的阻尼逻辑改写。
     * 自持一份朝向状态，才能保证"往前飞"始终朝着当前视线方向。
     */
    beginCameraView() {
      if (!this.camera) return
      const orientation = orientationFromCameraTarget(this.cameraState)
      this.navState = {
        yaw: orientation.yaw,
        pitch: orientation.pitch,
        distance: Math.max(orientation.distance, 1),
        dragging: false,
        lastX: 0,
        lastY: 0,
        pointerId: null
      }
      this.navKeys = { forward: false, backward: false, left: false, right: false, up: false, down: false, boost: false }
      this.navLastTime = null
      /*
       * `wasd` 方案必须让 OrbitControls 彻底让位（见 core/camera-nav.js 里
       * `ownsCamera` 的说明）：它的 update() 会每帧 lookAt(target) 并
       * 按 position-target 反推球坐标写回位置，导致朝向被覆盖、
       * 相机飞近注视点时还会塌陷卡死。
       * `orbit` 方案反过来——就是让 OrbitControls 驱动，因此保持启用。
       */
      const handler = navSchemeHandler(this.cameraNavScheme)
      if (this.controls) this.controls.enabled = !handler.ownsCamera
      if (!handler.ownsCamera) this.attachOrbitWriteBack()
      else this.detachOrbitWriteBack()
      /*
       * 环绕方案：轴心默认世界原点，并把视线立刻对准它；
       * 飞行方案：朝向由 navState 决定。
       * 两条路径互斥，走错就会"画面朝向和导航状态不一致"。
       */
      if (handler.ownsCamera) this.applyNavOrientation()
      else this.applyOrbitPivot(true)
      window.addEventListener('keydown', this.handleNavKeyDown)
      window.addEventListener('keyup', this.handleNavKeyUp)
      window.addEventListener('blur', this.handleNavBlur)
    },

    /** 退出相机视角：停掉接管，把编辑视角交还 OrbitControls。 */
    endCameraView() {
      this.navState = null
      this.navKeys = null
      this.navLastTime = null
      this.navPressPending = false
      this.detachOrbitWriteBack()
      window.removeEventListener('keydown', this.handleNavKeyDown)
      window.removeEventListener('keyup', this.handleNavKeyUp)
      window.removeEventListener('blur', this.handleNavBlur)
      if (this.controls) this.controls.enabled = true
    },

    /**
     * 把导航朝向写进相机与 OrbitControls 的注视点。
     *
     * 三件事必须同时做，少一件就会出问题：
     * 1. `camera.lookAt` —— 画面方向真的转过去（只改 store 的话用户看不到变化）；
     * 2. 同步 `controls.target` —— 否则退出相机视角时 OrbitControls
     *    会从旧 target 重新推导，视角突然跳一下；
     * 3. 保持注视距离 —— 不能让 target 塌到机位上，否则球坐标退化。
     */
    applyNavOrientation() {
      if (!this.camera || !this.navState) return
      /*
       * 相机绑定了物体时，朝向由**物体位置**决定，而不是 navState 的 yaw/pitch。
       *
       * 这是"飞行模式下只重新对准"的落点：WASD 仍可自由移动机位，
       * 但镜头始终盯着被绑定物体（相当于一条 aim 约束）。此时中键/左键
       * 转向不会改变朝向——转不开是预期行为，不是 bug。
       *
       * 拖拽期间用实时位置（`liveBoundTarget`），这样拖动绑定物体时
       * 镜头每帧都跟着重新瞄准，而不是松手才跳过去。
       */
      const live = this.liveBoundTarget()
      const bound =
        live ??
        (this.cameraState?.targetObjectId && this.cameraState.lookAtEnabled !== false
          ? this.cameraState.target
          : null)
      const resolved = bound
        ? { target: bound }
        : cameraTargetFromOrientation({
            position: {
              x: this.camera.position.x,
              y: this.camera.position.y,
              z: this.camera.position.z
            },
            yaw: this.navState.yaw,
            pitch: this.navState.pitch,
            distance: this.navState.distance
          })
      this.camera.lookAt(resolved.target.x, resolved.target.y, resolved.target.z)
      if (this.controls) {
        this.controls.target.set(resolved.target.x, resolved.target.y, resolved.target.z)
      }
      /*
       * 绑定状态下把 navState 反算回真实朝向，保证解除绑定的那一刻
       * 画面不会突然跳到"上一次转向留下的旧 yaw/pitch"。
       */
      if (bound) {
        const orientation = orientationFromCameraTarget({
          position: {
            x: this.camera.position.x,
            y: this.camera.position.y,
            z: this.camera.position.z
          },
          target: bound
        })
        this.navState.yaw = orientation.yaw
        this.navState.pitch = orientation.pitch
        this.navState.distance = Math.max(orientation.distance, 1)
      }
    },

    /**
     * `orbit` 方案：OrbitControls 转完相机后，把结果写回场景相机。
     *
     * 与 `wasd` 的关键区别：这里的朝向不是由 `navState.yaw/pitch` 决定的，
     * 而是由 OrbitControls 自己算出来的。因此：
     * - 写回的 `target` 必须取 `controls.target`（真正的环绕轴心），
     *   不能再用 `navState` 里的 yaw/pitch 反算——那是**过期**的方向，
     *   会得到一个和画面完全无关的注视点；
     * - 写完再把 `navState` 从真实位姿反算回来，保证切回 `wasd` 时
     *   朝向是连续的，不会突然跳一下。
     *
     * 用节流提交：OrbitControls 拖拽过程中会连续触发 change，
     * 每次都提交会灌满撤销栈；攒到停手 260ms 再提交一次。
     */
    publishOrbitCamera(commit) {
      if (!this.camera || !this.controls) return
      const position = {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z
      }
      const target = {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z
      }
      if (this.navState) {
        const orientation = orientationFromCameraTarget({ position, target })
        this.navState.yaw = orientation.yaw
        this.navState.pitch = orientation.pitch
        this.navState.distance = Math.max(orientation.distance, 1)
      }
      this.$emit('camera-transform', { position, target, commit })
    },

    attachOrbitWriteBack() {
      if (!this.controls || this.orbitWriteBack) return
      /*
       * 拖拽过程中：只更新视口显示，不写历史。
       * 每帧都提交会把撤销栈灌满，用户按一次 Ctrl+Z 只退回一帧。
       */
      this.orbitWriteBack = () => {
        if (!this.cameraViewActive) return
        this.publishOrbitCamera(false)
      }
      /*
       * 松手（`end`）立刻提交一次。
       *
       * 这里**不能**只靠节流计时器：环绕默认开着阻尼，松手后相机会继续
       * 缓动一小段，`change` 会持续触发、不断重置计时器，提交迟迟不发生
       * （表现为"环绕了但场景相机没动"）。`end` 是 OrbitControls 给出的
       * 明确"操作结束"信号，用它落库最可靠。
       */
      this.orbitCommit = () => {
        if (!this.cameraViewActive) return
        if (this.navCommitTimer) {
          window.clearTimeout(this.navCommitTimer)
          this.navCommitTimer = null
        }
        this.publishOrbitCamera(true)
      }
      this.controls.addEventListener('change', this.orbitWriteBack)
      this.controls.addEventListener('end', this.orbitCommit)
    },

    detachOrbitWriteBack() {
      if (!this.controls) return
      if (this.orbitWriteBack) {
        this.controls.removeEventListener('change', this.orbitWriteBack)
        this.orbitWriteBack = null
      }
      if (this.orbitCommit) {
        this.controls.removeEventListener('end', this.orbitCommit)
        this.orbitCommit = null
      }
    },

    /** 切换导航方案时重置内部状态，避免残留上一次的朝向与按键。 */
    resetCameraNavState() {
      if (!this.cameraViewActive) return
      this.endCameraView()
      this.beginCameraView()
    },

    /**
     * WASD 按键按下。
     *
     * 必须先排除"正在输入"的元素：编辑器里有工程名输入框和大量
     * 数值输入框，用户在框里打 wasd 会被当成相机移动。
     */
    handleNavKeyDown(event) {
      if (isEditableTarget(event.target)) return
      if (!this.navKeys) return
      const key = event.key.toLowerCase()
      // 方案决定是否消费键盘：`orbit` 方案下 WASD 完全不参与。
      if (!navSchemeHandler(this.cameraNavScheme).consumesKeyboard) return
      const mapping = {
        w: 'forward',
        arrowup: 'forward',
        s: 'backward',
        arrowdown: 'backward',
        a: 'left',
        arrowleft: 'left',
        d: 'right',
        arrowright: 'right',
        q: 'down',
        e: 'up'
      }
      const field = mapping[key]
      if (field) {
        this.navKeys[field] = true
        // 阻止方向键滚动页面；WASD 不 preventDefault，避免干扰浏览器快捷键。
        if (key.startsWith('arrow')) event.preventDefault()
        return
      }
      if (key === 'shift') this.navKeys.boost = true
    },

    handleNavKeyUp(event) {
      if (!this.navKeys) return
      const key = event.key.toLowerCase()
      const mapping = {
        w: 'forward',
        arrowup: 'forward',
        s: 'backward',
        arrowdown: 'backward',
        a: 'left',
        arrowleft: 'left',
        d: 'right',
        arrowright: 'right',
        q: 'down',
        e: 'up'
      }
      const field = mapping[key]
      if (field) this.navKeys[field] = false
      if (key === 'shift') this.navKeys.boost = false
    },

    /**
     * 失焦时清空按键。
     *
     * 用户在按住 W 时切走窗口，keyup 收不到，回来后相机会一直往前飞。
     */
    handleNavBlur() {
      if (!this.navKeys) return
      for (const field of Object.keys(this.navKeys)) this.navKeys[field] = false
    },

    /** 中键按下：开始拖拽转向。 */
    beginNavLook(event) {
      if (!this.navState) return
      if (!navSchemeHandler(this.cameraNavScheme).consumesPointerLook) return
      this.navState.dragging = true
      this.navState.pointerId = event.pointerId
      this.navState.lastX = event.clientX
      this.navState.lastY = event.clientY
      this.$refs.canvas?.setPointerCapture?.(event.pointerId)
    },

    /** 中键拖拽中：更新朝向，并把新位姿发给父组件（不写历史）。 */
    updateNavLook(event) {
      if (!this.navState?.dragging || event.pointerId !== this.navState.pointerId) return
      const deltaX = event.clientX - this.navState.lastX
      const deltaY = event.clientY - this.navState.lastY
      this.navState.lastX = event.clientX
      this.navState.lastY = event.clientY
      const next = applyLookDelta({
        yaw: this.navState.yaw,
        pitch: this.navState.pitch,
        deltaX,
        deltaY
      })
      this.navState.yaw = next.yaw
      this.navState.pitch = next.pitch
      // 必须立刻把朝向应用到相机：只 emit 的话父组件只挪了相机模型，
      // 用户拖中键时画面根本不会转（store 变了但看不到）。
      this.applyNavOrientation()
      this.publishNavCamera(false)
    },

    /** 中键松开：提交一次，保证"拖一次 = 撤销一次"。 */
    endNavLook(event) {
      if (!this.navState?.dragging) return
      if (event && event.pointerId !== this.navState.pointerId) return
      this.navState.dragging = false
      this.navState.pointerId = null
      this.publishNavCamera(true)
    },

    /**
     * 把当前导航状态推给父组件。
     *
     * `commit=false` 时父组件只更新视口显示，不写 store——
     * 否则每帧写一次历史，用户按一次 Ctrl+Z 只能退一帧。
     */
    publishNavCamera(commit) {
      if (!this.camera) return
      const position = {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z
      }
      const resolved = cameraTargetFromOrientation({
        position,
        yaw: this.navState?.yaw ?? 0,
        pitch: this.navState?.pitch ?? 0,
        distance: this.navState?.distance ?? 1
      })
      this.$emit('camera-transform', { position: resolved.position, target: resolved.target, commit })
    },

    /**
     * 每帧推进飞行移动。
     *
     * 位移按**秒**计算（见 core/camera-nav.js），因此不同帧率下
     * 同样的按键时长位移一致；帧间隔还做了上限保护，
     * 避免切走标签页再回来时相机瞬移。
     */
    stepCameraView() {
      if (!this.cameraViewActive || !this.navState || !this.navKeys || !this.camera) return
      const now = performance.now()
      const deltaSeconds = this.navLastTime === null ? 0 : clampDelta((now - this.navLastTime) / 1000)
      this.navLastTime = now

      if (!navSchemeHandler(this.cameraNavScheme).consumesKeyboard) return

      const intent = movementIntentFromKeys(this.navKeys)
      const moving = intent.x !== 0 || intent.y !== 0 || intent.z !== 0

      if (moving) {
        const quaternion = [
          this.camera.quaternion.x,
          this.camera.quaternion.y,
          this.camera.quaternion.z,
          this.camera.quaternion.w
        ]
        const offset = computeFlyOffset({
          deltaSeconds,
          intent,
          boost: this.navKeys.boost,
          quaternion,
          speed: WASD_DEFAULTS
        })
        this.camera.position.set(
          this.camera.position.x + offset.x,
          this.camera.position.y + offset.y,
          this.camera.position.z + offset.z
        )
      }

      /*
       * 朝向**每帧都同步**，而不是只在移动时同步。
       *
       * 因为相机可能绑定了物体：用户按住 gizmo 拖动该物体时并没有按 WASD，
       * 但镜头必须跟着物体实时重新瞄准。若把这一步放在 `moving` 分支里，
       * 就会出现"拖物体时镜头不动、松手才瞬移"——正是要修的症状。
       */
      this.applyNavOrientation()

      if (!moving) return
      // 飞行中每帧只更新视口显示，松手/停手时不提交——
      // 键盘移动没有"松手"这一刻，因此改用节流提交（见 publishNavCameraThrottled）。
      this.publishNavCamera(false)
      this.publishNavCameraThrottled()
    },

    /**
     * 键盘飞行与环绕都没有明确的"操作结束"信号，因此用静默计时提交：
     * 停止操作 260ms 后提交一次，把这段连续操作合并成一次撤销。
     *
     * 提交时必须按当前方案分派：`wasd` 用 navState 的 yaw/pitch 反算 target，
     * `orbit` 必须用 `controls.target`。用错的话 store 里的相机朝向会和画面不一致。
     */
    publishNavCameraThrottled() {
      if (this.navCommitTimer) window.clearTimeout(this.navCommitTimer)
      this.navCommitTimer = window.setTimeout(() => {
        this.navCommitTimer = null
        if (!this.cameraViewActive) return
        if (navSchemeHandler(this.cameraNavScheme).ownsCamera) this.publishNavCamera(true)
        else this.publishOrbitCamera(true)
      }, 260)
    },

    /** 导出当前编辑视角画面为 base64 PNG。 */
    captureImageBase64(maxDimension = 1920) {
      return this.renderToSize(maxDimension, (canvas) => canvas.toDataURL('image/png').split(',')[1])
    },

    /**
     * 临时切到指定场景相机位姿拍一帧，再还原编辑视角。
     * 用于 AI 复核：看「目标摄影机」成片构图，而不打乱用户当前的 Orbit 视角。
     */
    captureFromCameraState(state, maxDimension = 1024) {
      if (!this.ready || !this.camera || !this.controls || !state?.position || !state?.target) {
        return null
      }
      const saved = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        fov: this.camera.fov
      }
      try {
        this.camera.position.set(state.position.x, state.position.y, state.position.z)
        this.controls.target.set(state.target.x, state.target.y, state.target.z)
        if (typeof state.fovDegrees === 'number' && Number.isFinite(state.fovDegrees)) {
          this.camera.fov = state.fovDegrees
        }
        this.camera.updateProjectionMatrix()
        this.controls.update()
        this.camera.updateMatrixWorld(true)
        return this.captureImageBase64(maxDimension)
      } finally {
        this.camera.position.copy(saved.position)
        this.controls.target.copy(saved.target)
        this.camera.fov = saved.fov
        this.camera.updateProjectionMatrix()
        this.controls.update()
        this.camera.updateMatrixWorld(true)
      }
    },

    /**
     * AI 复核截图：沿时间轴均匀抽 N 个时刻，每个时刻各拍
     *   1. 目标/成片摄影机（可能被墙挡住或拍空）
     *   2. 主视角总览（框住该时刻物体，看整场站位）
     *
     * 只改渲染用的临时位姿，拍完还原编辑相机与物体变换。
     *
     * @param {object|number} options 兼容旧调用：数字当作 maxDimension
     * @param {number} [options.maxDimension=768]
     * @param {number} [options.sampleCount=5]
     * @param {object} [options.timeline] 场景时间轴；缺省则只拍当前静止画面
     * @param {object} [options.baseCamera] 场景相机底稿，默认用 cameraState
     */
    captureVerifyViews(options = {}) {
      if (!this.ready || !this.camera || !this.controls) return []

      const opts = typeof options === 'number' ? { maxDimension: options } : options || {}
      const maxDimension = opts.maxDimension ?? 768
      const sampleCount = Math.max(1, Math.min(opts.sampleCount ?? 5, 8))
      const timeline = opts.timeline || null
      const baseCamera = opts.baseCamera || this.cameraState
      const duration = Math.max(0, Number(timeline?.durationSeconds) || 0)

      const sampleTimes =
        duration <= 0.05 || !timeline
          ? [0]
          : Array.from({ length: sampleCount }, (_, index) =>
              sampleCount === 1 ? 0 : (duration * index) / (sampleCount - 1)
            )

      const savedEditor = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        fov: this.camera.fov
      }

      const images = []
      try {
        for (const timeSeconds of sampleTimes) {
          if (timeline) {
            this.applyTimelineFrame(timeline, timeSeconds)
          }
          const frameCamera = timeline
            ? evaluateTimelineAtTime(timeline, baseCamera, timeSeconds, this.objects).camera
            : baseCamera
          const timeLabel = `${timeSeconds.toFixed(1)}s`

          const targetData = this.captureFromCameraState(frameCamera, maxDimension)
          if (targetData) {
            images.push({
              mimeType: 'image/png',
              base64Data: targetData,
              role: 'target',
              timeSeconds,
              label: `t=${timeLabel} 目标摄影机`
            })
          }

          const allIds = (this.objects || []).map((object) => object.id).filter(Boolean)
          // focusView 基于当前 three 节点包围盒；物体已由 applyTimelineFrame 摆到该时刻。
          this.focusView(allIds.length > 0 ? allIds : undefined)
          const overviewData = this.captureImageBase64(maxDimension)
          if (overviewData) {
            images.push({
              mimeType: 'image/png',
              base64Data: overviewData,
              role: 'overview',
              timeSeconds,
              label: `t=${timeLabel} 主视角总览`
            })
          }
        }
      } finally {
        if (timeline) this.restoreObjectTransforms()
        this.camera.position.copy(savedEditor.position)
        this.controls.target.copy(savedEditor.target)
        this.camera.fov = savedEditor.fov
        this.camera.updateProjectionMatrix()
        this.controls.update()
        this.camera.updateMatrixWorld(true)
      }

      return images
    },

    /**
     * 生成六通道控制图。
     *
     * 实现方式：临时替换材质 / 场景后逐张渲染，再恢复。
     * 不用后处理管线，是因为每种通道的语义差异大，直接替换更可控。
     */
    captureControlPasses(maxDimension = 1920) {
      const renderer = this.renderer
      const scene = this.scene
      const camera = this.camera
      const originalSize = renderer.getSize(new THREE.Vector2())
      const originalPixelRatio = renderer.getPixelRatio()
      const originalBackground = scene.background
      const originalFog = scene.fog
      const originalOverride = scene.overrideMaterial
      const originalGround = this.ground.visible
      /*
       * 六通道图同样必须清掉编辑辅助。
       *
       * 这里之前手写 `guideGroup.visible = false`，漏掉了控制柄与选中框
       * （它们直接挂在 scene 上，不在 guideGroup 里）。参考图是喂给 AI 的，
       * 带着橙色选框和箭头会让模型把"编辑器 UI"当成场景内容学进去。
       * 复用 editorOverlays() 这份清单，就不会再各漏一个。
       */
      const overlays = this.editorOverlays()
      const overlayVisibility = overlays.map((overlay) => overlay.visible)
      // 相机的宽高比也要跟着导出尺寸走，否则六通道图会被横向拉伸。
      const originalAspect = camera.aspect
      const size = outputSize(this.cameraState, maxDimension)

      const encode = () => renderer.domElement.toDataURL('image/png').split(',')[1] || ''
      const whiteMaterial = new THREE.MeshStandardMaterial({
        color: '#dfe3e1',
        roughness: 0.86,
        metalness: 0
      })
      const normalMaterial = new THREE.MeshNormalMaterial()
      const maskMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' })
      const idMaterials = new Map()

      try {
        for (const overlay of overlays) overlay.visible = false
        renderer.setPixelRatio(1)
        renderer.setSize(size.width, size.height, false)
        camera.aspect = size.width / size.height
        camera.updateProjectionMatrix()

        // 1. 白模
        scene.background = new THREE.Color('#f5f6f6')
        scene.fog = null
        scene.overrideMaterial = whiteMaterial
        renderer.toneMapping = THREE.ACESFilmicToneMapping
        renderer.render(scene, camera)
        const white = encode()

        // 2. 深度：用线性深度材质，近处白、远处黑。
        // 归一化范围取场景物体实际深度，而不是相机 near/far（默认 0.1~2000），
        // 否则室内场景物体只占视锥极小一段，整张图会接近纯白。
        this.ground.visible = false
        const depthMaterial = this.createDepthMaterial(camera)
        scene.background = new THREE.Color('#000000')
        scene.overrideMaterial = depthMaterial
        renderer.toneMapping = THREE.NoToneMapping
        renderer.render(scene, camera)
        const depth = encode()
        depthMaterial.dispose()

        // 3. 法线
        scene.overrideMaterial = normalMaterial
        renderer.render(scene, camera)
        const normal = encode()

        // 4. 物体分色：每个物体一种稳定颜色。
        scene.overrideMaterial = null
        for (const object of this.objects) {
          const root = this.rootMap?.get(object.id)
          if (!root || !root.visible) continue
          const material = new THREE.MeshBasicMaterial({ color: objectIdColor(object.id) })
          idMaterials.set(object.id, material)
          root.traverse((child) => {
            if (!(child instanceof THREE.Mesh)) return
            child.userData.originalMaterial = child.material
            child.material = material
          })
        }
        renderer.render(scene, camera)
        const objectId = encode()
        for (const [id, material] of idMaterials) {
          const root = this.rootMap?.get(id)
          root?.traverse((child) => {
            if (!(child instanceof THREE.Mesh) || !child.userData.originalMaterial) return
            child.material = child.userData.originalMaterial
            delete child.userData.originalMaterial
          })
          material.dispose()
        }

        // 5. 遮罩
        scene.overrideMaterial = maskMaterial
        renderer.render(scene, camera)
        const mask = encode()

        // 6. 轮廓：单独搭一个场景，用背面扩张 + 边缘线。
        const outline = this.renderOutline(camera)
        return { white, depth, normal, objectId, mask, outline, width: size.width, height: size.height }
      } finally {
        scene.background = originalBackground
        scene.fog = originalFog
        scene.overrideMaterial = originalOverride
        this.ground.visible = originalGround
        overlays.forEach((overlay, index) => {
          overlay.visible = overlayVisibility[index]
        })
        camera.aspect = originalAspect
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(originalPixelRatio)
        renderer.setSize(originalSize.x, originalSize.y, false)
        whiteMaterial.dispose()
        normalMaterial.dispose()
        maskMaterial.dispose()
      }
    },

    renderOutline(camera) {
      const renderer = this.renderer
      const outlineScene = new THREE.Scene()
      outlineScene.background = new THREE.Color('#ffffff')
      const edgeMaterial = new THREE.LineBasicMaterial({ color: '#111111' })
      const silhouetteMaterial = new THREE.MeshBasicMaterial({
        color: '#111111',
        side: THREE.BackSide
      })
      const fillMaterial = new THREE.MeshBasicMaterial({ color: '#ffffff' })

      this.objectGroup.updateMatrixWorld(true)
      const added = []
      this.objectGroup.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.visible) return
        const silhouette = new THREE.Mesh(child.geometry, silhouetteMaterial)
        silhouette.matrix.copy(
          child.matrixWorld.clone().multiply(new THREE.Matrix4().makeScale(1.018, 1.018, 1.018))
        )
        silhouette.matrixAutoUpdate = false
        const fill = new THREE.Mesh(child.geometry, fillMaterial)
        fill.matrix.copy(child.matrixWorld)
        fill.matrixAutoUpdate = false
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(child.geometry, 28), edgeMaterial)
        edges.matrix.copy(child.matrixWorld)
        edges.matrixAutoUpdate = false
        outlineScene.add(silhouette, fill, edges)
        added.push({ silhouette, fill, edges })
      })

      renderer.render(outlineScene, camera)
      const outline = renderer.domElement.toDataURL('image/png').split(',')[1] || ''

      for (const item of added) {
        outlineScene.remove(item.silhouette, item.fill, item.edges)
        item.edges.geometry.dispose()
      }
      edgeMaterial.dispose()
      silhouetteMaterial.dispose()
      fillMaterial.dispose()
      return outline
    },

    /**
     * 计算 objectGroup 在给定相机下的 view-space 深度范围。
     * 用于深度图可视化归一化，避免被相机 far=2000 稀释成一片白。
     */
    sceneDepthRange(camera) {
      camera.updateMatrixWorld(true)
      this.objectGroup.updateMatrixWorld(true)
      const viewMatrix = camera.matrixWorldInverse
      const box = new THREE.Box3()
      const corner = new THREE.Vector3()
      let minDepth = Infinity
      let maxDepth = -Infinity

      this.objectGroup.traverse((child) => {
        if (!(child instanceof THREE.Mesh) || !child.visible) return
        box.setFromObject(child)
        if (box.isEmpty()) return
        const { min, max } = box
        for (const x of [min.x, max.x]) {
          for (const y of [min.y, max.y]) {
            for (const z of [min.z, max.z]) {
              corner.set(x, y, z).applyMatrix4(viewMatrix)
              const depth = -corner.z
              if (!(depth > 0)) continue
              if (depth < minDepth) minDepth = depth
              if (depth > maxDepth) maxDepth = depth
            }
          }
        }
      })

      if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || maxDepth <= minDepth) {
        return { near: camera.near, far: camera.far }
      }

      const span = Math.max(maxDepth - minDepth, 1e-3)
      const pad = span * 0.05
      return {
        near: Math.max(camera.near, minDepth - pad),
        far: Math.min(camera.far, maxDepth + pad)
      }
    },

    createDepthMaterial(camera = this.camera) {
      const { near, far } = this.sceneDepthRange(camera)
      return new THREE.ShaderMaterial({
        uniforms: { nearValue: { value: near }, farValue: { value: far } },
        vertexShader: `
          varying float vDepth;
          void main() {
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            vDepth = -viewPosition.z;
            gl_Position = projectionMatrix * viewPosition;
          }
        `,
        fragmentShader: `
          uniform float nearValue;
          uniform float farValue;
          varying float vDepth;
          void main() {
            float linear = clamp((vDepth - nearValue) / max(farValue - nearValue, 1e-5), 0.0, 1.0);
            float value = 1.0 - linear;
            gl_FragColor = vec4(vec3(value), 1.0);
          }
        `
      })
    },

    /**
     * 临时把"导出尺寸"应用到渲染器与相机，跑完自动还原。
     *
     * **必须同时改 `camera.aspect`**，这是最容易漏的一步：
     * 只改渲染器尺寸的话，投影矩阵仍然按视口的宽高比计算，
     * 渲染出来的画面会被横向拉伸。导出的画幅（16:9 / 9:16 / 1:1）
     * 与视口的宽高比几乎永远不同，所以这一步不是"边界情况"，而是常态。
     *
     * 之前的 `renderToSize` 就漏了这一句：720×406 的视频里，
     * 方块看起来比编辑时胖了一圈。
     */
    /**
     * 收集"只属于编辑器、不属于成片"的对象。
     *
     * 为什么要单独收一份清单，而不是继续手写 `guideGroup.visible = false`：
     * 有两个辅助对象**没有**挂在 guideGroup 下，而是直接 add 到 scene：
     *
     *   - 控制柄：`scene.add(this.transformControls.getHelper())`
     *   - 选中框：`scene.add(this.selectionBox)`
     *
     * 之前导出只隐藏了 guideGroup / grid / pathGroup，于是"选中一个物体后
     * 导出的成片里会带着一个橙色线框和一组箭头"。这个 bug 很难自查：
     * 用户会以为是自己没取消选中，而导出的那一刻根本没机会看到。
     * 收成一份清单后，导出与预演共用，不会再各自漏一个。
     */
    editorOverlays() {
      const overlays = [this.guideGroup, this.grid, this.pathGroup]
      const gizmoHelper = this.transformControls?.getHelper?.()
      if (gizmoHelper) overlays.push(gizmoHelper)
      if (this.selectionBox) overlays.push(this.selectionBox)
      return overlays.filter(Boolean)
    },

    /** 临时隐藏所有编辑辅助，跑完自动还原。 */
    withEditorOverlaysHidden(run) {
      const overlays = this.editorOverlays()
      const visibility = overlays.map((overlay) => overlay.visible)
      for (const overlay of overlays) overlay.visible = false
      try {
        return run()
      } finally {
        overlays.forEach((overlay, index) => {
          overlay.visible = visibility[index]
        })
      }
    },

    withOutputSize(width, height, run) {
      const renderer = this.renderer
      const camera = this.camera
      if (!renderer || !camera) return null

      const originalSize = renderer.getSize(new THREE.Vector2())
      const originalPixelRatio = renderer.getPixelRatio()
      const originalAspect = camera.aspect

      try {
        renderer.setPixelRatio(1)
        renderer.setSize(width, height, false)
        camera.aspect = width / height
        camera.updateProjectionMatrix()
        // 辅助图形（灯光标记、网格轴线、导航线、控制柄、选中框）
        // 一律不进导出画面。清单见 editorOverlays()。
        return this.withEditorOverlaysHidden(() => {
          renderer.render(this.scene, camera)
          return run(renderer.domElement, { width, height })
        })
      } finally {
        camera.aspect = originalAspect
        camera.updateProjectionMatrix()
        renderer.setPixelRatio(originalPixelRatio)
        renderer.setSize(originalSize.x, originalSize.y, false)
      }
    },

    renderToSize(maxDimension, read) {
      const size = outputSize(this.cameraState, maxDimension)
      return this.withOutputSize(size.width, size.height, (canvas) => read(canvas, size))
    },

    /**
     * 按 store 里的原始数据复位所有物体节点。
     *
     * 导出流程会逐帧改写物体变换；导出结束后必须还原，
     * 否则场景会停在最后一帧，用户会以为"导出把场景改坏了"。
     */
    restoreObjectTransforms() {
      if (!this.ready || !this.rootMap) return
      for (const object of this.objects) {
        const root = this.rootMap.get(object.id)
        if (!root) continue
        this.applyObjectTransform(root, object)
      }
      this.scene?.updateMatrixWorld(true)
      this.updateSelectionHelper()
    },

    /**
     * 把时间轴某一时刻的**完整状态**应用到视口：相机位姿 + 所有物体变换。
     *
     * 这是导出流程的核心，也是最容易漏的一步。
     *
     * 之前的实现只有 `applyCameraState(frame.camera)`，
     * 算出来的 `frame.objectTransforms` 从头到尾没人用——
     * 于是每一帧的相机在动、物体却始终停在编辑时的位置，
     * 导出来的视频就是"一张静态图配上轻微运镜"。
     *
     * 物体变换不能只改 store（那会触发重建、并且污染编辑态数据），
     * 必须直接写 three.js 节点的 position / rotation / scale。
     * 这里复用 `applyTimelinePreview`，保证与编辑时的预览走**同一套求值逻辑**，
     * 否则"所见"和"所得"迟早会分叉。
     */
    applyTimelineFrame(timeline, timeSeconds) {
      if (!this.ready || !this.rootMap) return
      const objects = applyTimelinePreview(this.objects, timeline, timeSeconds)
      for (const object of objects) {
        const root = this.rootMap.get(object.id)
        if (!root) continue
        root.position.set(object.position.x, object.position.y, object.position.z)
        root.rotation.set(
          THREE.MathUtils.degToRad(object.rotation.x),
          THREE.MathUtils.degToRad(object.rotation.y),
          THREE.MathUtils.degToRad(object.rotation.z)
        )
        root.scale.set(object.size.x, object.size.y, object.size.z)
        // 人台还要重放姿势，否则动作永远是静止的定格。
        if (object.kind === 'mannequin' && object.mannequin) {
          applyMannequinPose(
            root,
            object.mannequin.pose,
            mannequinVisualState(object.mannequin, timeSeconds)
          )
        }
      }
      // 手动刷新矩阵：导出是逐帧手动 render，没有主循环帮我们更新世界矩阵。
      this.scene.updateMatrixWorld(true)
    },

    /**
     * 把当前场景按指定尺寸渲染一帧，并**画进调用方提供的 2D 画布**。
     *
     * 为什么不是直接把 WebGL 画布交给 VideoEncoder：
     * 主渲染器没开 `preserveDrawingBuffer`，它的绘制缓冲在"当前任务结束、
     * 浏览器合成"之后就被清掉了。把 WebGL 画布对象传出去、等编码器
     * 异步去读，读到的是空白。
     *
     * 所以这里在同一段同步代码里 render → drawImage 到一块普通的 2D 画布。
     * 2D 画布的像素永远可读，VideoFrame 从它构造也最稳。
     *
     * 画布由调用方复用（每帧新建一块 1280×720 的画布会带来可观的 GC 压力）。
     */
    captureFrameToCanvas(canvas, width, height) {
      if (!canvas) return null
      /*
       * 复用 withOutputSize：它会把 camera.aspect 一起改成导出宽高比。
       * 少了这一步，画面会被横向拉伸（导出画幅几乎从不等于视口宽高比）。
       */
      return this.withOutputSize(width, height, (source) => {
        if (canvas.width !== width) canvas.width = width
        if (canvas.height !== height) canvas.height = height
        const context = canvas.getContext('2d')
        context.clearRect(0, 0, width, height)
        // 直接从 WebGL 画布拷到 2D 画布：同一段同步代码里完成，像素必定可读。
        context.drawImage(source, 0, 0, width, height)
        return canvas
      })
    },

    /**
     * 开始 / 结束"导出模式"。
     *
     * 导出期间必须停掉主循环的渲染：`captureFrameToCanvas` 会临时改
     * 渲染器的尺寸，如果 animate() 同时在跑，它会以导出尺寸再渲染一次到
     * 屏幕画布上——用户看到的是画面疯狂闪烁 + 帧率抖动，
     * 而且 OrbitControls 的阻尼残量可能在两帧之间把相机挪走，导致
     * 成片里出现无法解释的抖动。
     */
    setExporting(active) {
      this.exporting = Boolean(active)
    },

    disposeAll() {
      // 注销探针：组件销毁后不能再让外部读到半拆解的 three.js 对象。
      registerSceneProbe(null, {})
      this.disposeMonitor()
      // 相机视角的键盘监听与提交计时器必须清掉：
      // 组件销毁后键盘监听还在，会对着已拆解的相机继续算位移。
      this.endCameraView()
      if (this.navCommitTimer) {
        window.clearTimeout(this.navCommitTimer)
        this.navCommitTimer = null
      }
      cancelAnimationFrame(this.animationFrame)
      const canvas = this.$refs.canvas
      if (canvas) {
        canvas.removeEventListener('pointerdown', this.handlePointerDown)
        canvas.removeEventListener('pointermove', this.handlePointerMove)
        canvas.removeEventListener('pointerup', this.handlePointerUp)
        canvas.removeEventListener('contextmenu', this.preventContextMenu)
      }
      this.transformControls?.dispose()
      this.controls?.dispose()
      disposeObject(this.objectGroup)
      disposeObject(this.userLightGroup)
      disposeObject(this.guideGroup)
      disposeObject(this.modelingGroup)
      disposeObject(this.cutGroup)
      disposeObject(this.pathGroup)
      this.importedModels?.clear()
      this.scene?.clear()
      this.renderer?.dispose()
      this.ready = false
    }
  }
}
</script>
