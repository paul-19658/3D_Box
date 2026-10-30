/**
 * 前端诊断信息收集器。
 *
 * 设计目标：让"抓日志"变成一次点击，而不是让用户去开 devtools 翻控制台。
 *
 * 收集内容：
 * - 控制台 error / warn
 * - 未捕获异常与未处理的 Promise 拒绝
 * - Vue 的 errorHandler / warnHandler 回调
 * - 运行环境（UA、屏幕、DPR、WebGL 能力、构建版本）
 * - 关键 DOM 尺寸（视口 / canvas）与当前内置诊断状态
 *
 * 刻意不收集：用户数据、场景内容、任何密钥。日志是可以直接外发的。
 */

const MAX_ENTRIES = 200

const state = {
  started: false,
  entries: [],
  meta: {}
}

/**
 * 场景探针。
 *
 * 三维视口里的对象不在 DOM 里，自动化测试没法用选择器去读它们。
 * 但"到底动没动"这件事，只有 three.js 自己知道。所以由 SceneViewport
 * 在初始化时注册一个只读的探针函数，外部（诊断报告 / 验证脚本）就能
 * 拿到真实场景状态，而不是靠猜像素位置。
 *
 * 探针只做读取，不修改场景；注册时传 null 即可注销。
 */
let sceneProbe = null
let projectProbe = null
let editorCameraProbe = null

/**
 * 由 SceneViewport 调用，注册/注销场景探针。
 *
 * 除了主探针（返回场景快照），还可以额外注册两个小工具：
 * - projector：把世界坐标投影成画布局部像素坐标；
 * - editorCamera：读取编辑视角相机的位姿。
 * 分开注册是因为它们只服务于自动化验证，与诊断报告无关。
 */
export function registerSceneProbe(probe, helpers = {}) {
  sceneProbe = typeof probe === 'function' ? probe : null
  projectProbe = typeof helpers.project === 'function' ? helpers.project : null
  editorCameraProbe = typeof helpers.editorCamera === 'function' ? helpers.editorCamera : null
}

/** 世界坐标 → 画布局部像素坐标。探针未注册时返回 null。 */
export function projectPoint(point) {
  if (!projectProbe) return null
  try {
    return projectProbe(point)
  } catch {
    return null
  }
}

/** 编辑视角相机位姿。探针未注册时返回 null。 */
export function editorCameraState() {
  if (!editorCameraProbe) return null
  try {
    return editorCameraProbe()
  } catch {
    return null
  }
}

/**
 * 读取当前场景快照。探针本身抛错时返回 { error }，绝不让诊断把页面搞崩。
 */
export function sceneSnapshot() {
  if (!sceneProbe) return null
  try {
    return sceneProbe()
  } catch (error) {
    return { error: String(error) }
  }
}

/** 记录一条诊断信息。time 用相对启动的毫秒数，避免时区干扰。 */
export function record(level, source, message) {
  if (state.entries.length >= MAX_ENTRIES) return
  state.entries.push({
    t: Math.round(performance.now()),
    level,
    source,
    message: String(message).slice(0, 4000)
  })
}

/** 读取 WebGL 关键能力，很多"黑屏"其实是渲染上下文没起来。 */
function detectWebGL() {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
    if (!gl) return { supported: false }
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    return {
      supported: true,
      version: gl.getParameter(gl.VERSION),
      vendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : 'unknown',
      renderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : 'unknown',
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE)
    }
  } catch (error) {
    return { supported: false, error: String(error) }
  }
}

/** 采集当前页面里几处"一眼能判断好坏"的尺寸。 */
export function collectDomSnapshot() {
  const rect = (selector) => {
    const element = document.querySelector(selector)
    if (!element) return null
    const box = element.getBoundingClientRect()
    return { w: Math.round(box.width), h: Math.round(box.height) }
  }
  const canvas = document.querySelector('.viewport-canvas')
  return {
    stage: rect('.editor-stage'),
    viewport: rect('.viewport'),
    canvasCss: rect('.viewport-canvas'),
    canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
    rail: rect('.tool-rail'),
    railButtonCount: document.querySelectorAll('.rail-btn').length,
    assetRows: document.querySelectorAll('.asset-panel .list-row').length,
    hasRecoveryDialog: Boolean(document.querySelector('[aria-label="恢复未保存内容"]')),
    hasNotice: Boolean(document.querySelector('.notice'))
  }
}

/**
 * 挂载全局收集器。
 *
 * 必须在 `new Vue(...)` 之前调用：这样才能捕获挂载阶段（也就是
 * 组件 init 抛错的那段时间）的异常——那正是"黑屏"最常发生的位置。
 */
export function installDiagnostics(Vue) {
  if (state.started) return state
  state.started = true

  state.meta = {
    url: window.location.href,
    userAgent: navigator.userAgent,
    language: navigator.language,
    devicePixelRatio: window.devicePixelRatio,
    screen: { w: window.screen.width, h: window.screen.height },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    // 构建时间由 webpack DefinePlugin 注入；取不到时标注 unknown。
    buildTime:
      typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'unknown', // eslint-disable-line no-undef
    webgl: detectWebGL()
  }

  window.addEventListener('error', (event) => {
    record('error', 'window.error', event.message || String(event.error))
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    record(
      'error',
      'unhandledrejection',
      (reason && (reason.stack || reason.message)) || String(reason)
    )
  })

  const originalError = console.error
  console.error = (...args) => {
    record('error', 'console.error', args.map(String).join(' '))
    originalError.apply(console, args)
  }

  const originalWarn = console.warn
  console.warn = (...args) => {
    record('warn', 'console.warn', args.map(String).join(' '))
    originalWarn.apply(console, args)
  }

  if (Vue && Vue.config) {
    Vue.config.errorHandler = (error, vm, info) => {
      record(
        'error',
        `vue:${info}`,
        (error && (error.stack || error.message)) || String(error)
      )
    }
    Vue.config.warnHandler = (message, vm, trace) => {
      record('warn', 'vue.warn', `${message}${trace || ''}`)
    }
  }

  // 暴露一个只读钩子，供自动化脚本（CDP）读取真实场景状态。
  // 生产环境同样保留：它不包含用户数据，也不提供任何写能力。
  window.__XBH_DIAGNOSE__ = {
    scene: sceneSnapshot,
    dom: collectDomSnapshot,
    entries: () => [...state.entries],
    report: buildReport,
    clear: () => {
      state.entries.length = 0
    },
    /**
     * 把世界坐标投影到视口画布的**局部像素坐标**（相对 canvas 左上角）。
     * 验证脚本需要它来算出"某个三维点对应屏幕哪里"，否则只能靠猜像素。
     */
    project: (point) => (sceneProbe ? projectPoint(point) : null),
    /**
     * 编辑视角（OrbitControls 控制的那台相机）的位姿。
     * 时间轴预览不该动它，验证脚本靠对比这个值来判断有没有"镜头乱飞"。
     */
    editorCamera: () => (sceneProbe ? editorCameraState() : null)
  }

  return state
}

/** 组装可下载的诊断报告（纯文本，便于直接粘贴）。 */
export function buildReport() {
  const dom = collectDomSnapshot()
  const lines = []

  lines.push('=== 3D导演台 测试版 诊断报告 ===')
  lines.push(`生成时间：${new Date().toISOString()}`)
  lines.push('')
  lines.push('--- 环境 ---')
  for (const [key, value] of Object.entries(state.meta)) {
    lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
  }

  lines.push('')
  lines.push('--- DOM 尺寸 ---')
  lines.push(JSON.stringify(dom, null, 2))

  lines.push('')
  lines.push('--- 场景探针 ---')
  const scene = sceneSnapshot()
  lines.push(scene ? JSON.stringify(scene, null, 2) : '(视口未就绪，探针未注册)')

  lines.push('')
  lines.push(`--- 日志（${state.entries.length} 条）---`)
  if (state.entries.length === 0) {
    lines.push('(无 error / warn 记录)')
  } else {
    for (const entry of state.entries) {
      lines.push(`[+${entry.t}ms] [${entry.level}] [${entry.source}] ${entry.message}`)
    }
  }

  return lines.join('\n')
}

/** 把报告下载成 .txt 文件。 */
export function downloadReport() {
  const text = buildReport()
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `xiaobaihe-diagnose-${Date.now()}.txt`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
  return text
}

export function errorCount() {
  return state.entries.filter((entry) => entry.level === 'error').length
}

export function entries() {
  return state.entries
}
