<template>
  <div class="viewport">
    <canvas ref="canvas" class="viewport-canvas"></canvas>
    <div class="viewport-hud">
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
import { applyTimelinePreview } from '@/core/timeline'
import { record } from '@/core/diagnostics'
import { FIXED_FILL_LIGHT, FIXED_HEMISPHERE_LIGHT } from '@/core/project-document'
import { resolveShadowCasterIds } from '@/core/lighting-description'
import { objectIdColor } from '@/core/object-id-color'
import { outputSize } from '@/core/video'
import { registerSceneProbe } from '@/core/diagnostics'

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
    this.handleResize()
  },

  beforeDestroy() {
    window.removeEventListener('resize', this.handleResize)
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
        controls.enabled = !event.value
        // 记录拖拽状态：重建摄影机模型时据此跳过销毁，
        // 否则拖到一半控制柄会突然脱手。
        this.transformDragging = event.value
        // 松手时才提交一次，这样"拖动一次 = 一次撤销"。
        if (!event.value) this.emitTransform(true)
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
        const mesh = new THREE.Mesh(
          createGeometry(object),
          new THREE.MeshStandardMaterial({
            color: object.colorOverride || object.color,
            roughness: 0.82,
            metalness: 0,
            side: THREE.DoubleSide,
            transparent: (object.displayMode ?? 'solid') !== 'solid',
            opacity:
              object.displayMode === 'transparent' ? 0.34 : object.displayMode === 'wireframe' ? 0.62 : 1
          })
        )
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

      // 选中摄影机时把控制柄挂到摄影机模型上。
      // 平移改机位；旋转改朝向（把旋转量折算成新的 target），两者都写回场景相机。
      if (this.cameraSelected) {
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

      const roots = this.selectedIds.map((id) => this.rootMap?.get(id)).filter((root) => root && root.visible)
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
      if (event.button === 2) {
        // 右键交给 OrbitControls 做平移，不参与拾取。
        return
      }

      // 落在控制柄上：整段交互交给 TransformControls，不做任何拾取。
      if (this.isPointerOnGizmo()) return

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
      this.controls.update()
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

    /** 导出当前画面为 base64 PNG。 */
    captureImageBase64(maxDimension = 1920) {
      return this.renderToSize(maxDimension, (canvas) => canvas.toDataURL('image/png').split(',')[1])
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
        const depthMaterial = this.createDepthMaterial()
        this.ground.visible = false
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

    createDepthMaterial() {
      const camera = this.camera
      const near = camera.near
      const far = camera.far
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
            float linear = clamp((vDepth - nearValue) / (farValue - nearValue), 0.0, 1.0);
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
