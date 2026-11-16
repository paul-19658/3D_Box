/**
 * 相机视角 + 自动关键帧的浏览器级回归验证（Chromium/Edge + CDP）。
 *
 * 为什么需要它：本项目没有 CI，而三维相关改动存在一整类
 * **"数据对、画面错"** 的 bug——store 里的值变了，用户看到的却没变。
 * 最典型的就是相机视角下 `OrbitControls.update()` 每帧覆盖朝向：
 * 只断言 store 会判定通过，实际画面完全没转。这类问题单元测试看不见，
 * 只能驱动真实浏览器来验。
 *
 * 设计上刻意把两条通道分开，避免"自己验证自己"：
 * - 写入口：真实 DOM 事件（`Input.dispatchMouseEvent` / `dispatchKeyEvent`），
 *   或 `store.dispatch('editScene')`——与产品路径一致；
 * - 读出口：`window.__XBH_DIAGNOSE__` 只读探针，直接读 three.js / store 真实状态。
 *
 * ## 前置条件
 *
 * 1. 后端已启动并托管前端构建产物：`.\dev-backend.ps1`（默认 8000 端口）；
 * 2. `workspace/app.db` 里存在 `smoke-user`（`app.smoke` 会创建）；
 * 3. 本机装了 Edge 或 Chrome。
 *
 * ## 运行
 *
 * ```powershell
 * node tools/verify-camera-autokey.mjs
 * # 或指定参数
 * $env:BASE_URL='http://127.0.0.1:8011'; node tools/verify-camera-autokey.mjs
 * ```
 *
 * 环境变量：`BASE_URL`、`CDP_PORT`、`BROWSER_PATH`、`SMOKE_USER`、`HEADLESS=0`。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000'
const CDP_PORT = Number(process.env.CDP_PORT || 9333)
const SMOKE_USER = process.env.SMOKE_USER || 'smoke-user'
const HEADLESS = process.env.HEADLESS !== '0'

const BROWSER_CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean)

// ---------------------------------------------------------------------------
// 极简 CDP 客户端
// ---------------------------------------------------------------------------

function launchBrowser(port) {
  const browserPath = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate))
  if (!browserPath) {
    throw new Error(`找不到 Edge/Chrome，请用 BROWSER_PATH 指定可执行文件路径。试过：${BROWSER_CANDIDATES.join(', ')}`)
  }
  const profileDir = mkdtempSync(join(tmpdir(), 'xbh-cdp-'))
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1600,1000',
    '--hide-scrollbars',
    'about:blank'
  ]
  if (HEADLESS) args.unshift('--headless=new')
  // stdio: 'ignore' 很重要：捕获子进程输出在受限沙箱下会因命名管道被拒而 EPERM。
  const child = spawn(browserPath, args, { stdio: 'ignore' })
  return { child, browserPath }
}

async function waitForDebugger(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await response.json()
      const page = list.find((item) => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 浏览器还没起来 */
    }
    await sleep(250)
  }
  throw new Error('CDP 调试端口未就绪')
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true })
      this.ws.addEventListener('error', reject, { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
        return
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.onException?.(message.params.exceptionDetails)
      }
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时: ${method}`))
        }
      }, 60000)
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text
      throw new Error(`页面求值失败: ${detail}`)
    }
    return result.result.value
  }

  close() {
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(cdp, expression, { timeoutMs = 20000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return true
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------------------------------------------------------------------------
// 页面内取值片段
// ---------------------------------------------------------------------------

const STORE = `(() => {
  const el = document.querySelector('.editor')
  return el && el.__vue__ ? el.__vue__.$store : null
})()`

const VIEWPORT = `(() => {
  const el = document.querySelector('.viewport')
  return el && el.__vue__ ? el.__vue__ : null
})()`

/** 场景相机（时间轴求值后的"用户看到的机位"）。 */
const SCENE_CAMERA = `(() => {
  const probe = window.__XBH_DIAGNOSE__
  return probe ? probe.scene().sceneCamera : null
})()`

/** 编辑相机的 three.js 真实状态——判断"画面有没有真的动"靠它。 */
const EDITOR_CAMERA = `(() => {
  const probe = window.__XBH_DIAGNOSE__
  return probe ? probe.editorCamera() : null
})()`

const results = []
function check(label, ok, detail = '') {
  results.push({ label, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`)
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

// ---------------------------------------------------------------------------
// 交互辅助
// ---------------------------------------------------------------------------

/**
 * 关掉可能残留的菜单下拉。
 *
 * `MenuBar.pick()` 在条目被禁用时会 `return`，此时菜单**不会关闭**。
 * 后续再点标题就成了"关菜单"，于是找不到条目——典型的测试假失败。
 * 点一下菜单栏以外的地方即可关闭（MenuBar 在 document 上监听 pointerdown）。
 */
async function closeMenus(cdp) {
  const hasDropdown = await cdp.evaluate(`Boolean(document.querySelector('.menubar__dropdown'))`)
  if (!hasDropdown) return
  await cdp.evaluate(`(() => {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    return true
  })()`)
  await sleep(160)
}

/** 点开某个菜单并点其中的条目（分两步，Vue 要等一次渲染才有下拉项）。 */
async function clickMenu(cdp, menuLabel, entryLabel) {
  await closeMenus(cdp)
  const opened = await cdp.evaluate(`(() => {
    const t = [...document.querySelectorAll('.menubar__title')].find(
      (el) => el.textContent.trim() === ${JSON.stringify(menuLabel)}
    )
    if (!t) return false
    t.click()
    return true
  })()`)
  if (!opened) return 'no-menu'
  await sleep(300)
  const picked = await cdp.evaluate(`(() => {
    const e = [...document.querySelectorAll('.menubar__entry')].find(
      (el) => el.textContent.includes(${JSON.stringify(entryLabel)})
    )
    if (!e) return false
    e.click()
    return true
  })()`)
  await sleep(650)
  return picked ? 'ok' : 'no-entry'
}

/** 按住某个键一段时间（`text` 不传 => 不插入字符，只触发键盘事件）。 */
async function holdKey(cdp, { key, code, keyCode, ms }) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
  })
  await sleep(ms)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode
  })
  await sleep(450)
}

/** 在视口中心做一次左键拖拽（OrbitControls 用左键环绕）。 */
async function dragLeftButton(cdp, dx, dy) {
  const origin = await cdp.evaluate(`(() => {
    const rect = document.querySelector('canvas').getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: origin.x, y: origin.y, button: 'none', buttons: 0 })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: origin.x, y: origin.y, button: 'left', buttons: 1, clickCount: 1
  })
  await sleep(80)
  for (let step = 1; step <= 8; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: origin.x + (dx / 8) * step, y: origin.y + (dy / 8) * step, button: 'left', buttons: 1
    })
    await sleep(40)
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: origin.x + dx, y: origin.y + dy, button: 'left', buttons: 0, clickCount: 1
  })
  await sleep(900)
}

/** 单位化"相机看向哪里"，用于判断朝向真的变了。 */
function viewDirection(position, target) {
  const dx = target.x - position.x
  const dy = target.y - position.y
  const dz = target.z - position.z
  const length = Math.hypot(dx, dy, dz) || 1
  return { x: dx / length, y: dy / length, z: dz / length }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const { child, browserPath } = launchBrowser(CDP_PORT)
  let cdp
  try {
    console.log(`浏览器: ${browserPath}`)
    console.log(`目标:   ${BASE_URL}\n`)
    const page = await waitForDebugger(CDP_PORT)
    cdp = new Cdp(page.webSocketDebuggerUrl)
    await cdp.connect()
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    const pageErrors = []
    cdp.onException = (details) => {
      pageErrors.push(details.exception?.description || details.text || 'unknown')
    }

    await cdp.send('Page.navigate', { url: BASE_URL })
    // `document.body` 在页面极早期可能还是 null，表达式必须自带空值保护，
    // 否则偶发地"第一帧就求值"会让整个脚本 FATAL 退出。
    await waitFor(
      cdp,
      'Boolean(document.body && (document.querySelector(".app-shell") || document.body.children.length))',
      { label: '应用加载' }
    )
    await sleep(1200)

    const loggedIn = await cdp.evaluate(`(async () => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: ${JSON.stringify(SMOKE_USER)} })
      })
      if (!response.ok) return 'http ' + response.status
      const data = await response.json()
      return data.user ? data.user.username : 'no-user'
    })()`)
    check(`登录 ${SMOKE_USER}`, loggedIn === SMOKE_USER, String(loggedIn))

    await cdp.send('Page.navigate', { url: `${BASE_URL}/editor` })
    await waitFor(cdp, 'Boolean(document.querySelector(".editor"))', { label: '编辑器' })
    await sleep(2000)

    /*
     * 关掉自动弹出的"恢复快照"对话框。
     *
     * 上一轮保存/自动保存会留下快照，产品下次进入编辑器会弹
     * 「发现未保存的内容」并铺一层 .dialog-veil。遮罩会吃掉所有指针事件，
     * 中键拖拽于是打到对话框上而不是 canvas——表现为"功能失效"，
     * 其实是环境残留。这一步不做，后面所有鼠标断言都会假失败。
     */
    const dismissed = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.dialog')
      if (!dialog) return 'none'
      const discard = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '放弃')
      if (discard) { discard.click(); return 'discarded' }
      return 'unexpected-dialog:' + dialog.innerText.slice(0, 30)
    })()`)
    console.log(`   [环境] 恢复对话框: ${dismissed}`)
    await sleep(800)
    check(
      '进入编辑器后无模态遮罩',
      (await cdp.evaluate(`Boolean(document.querySelector('.dialog-veil'))`)) === false,
      dismissed
    )

    check('只读探针可用', (await cdp.evaluate('typeof window.__XBH_DIAGNOSE__')) === 'object')
    // 不能直接求值 STORE：CDP 会尝试序列化整个 Vuex store 并报
    // "Object reference chain is too long"。
    check('store 可达', (await cdp.evaluate(`Boolean(${STORE})`)) === true)
    check('视口组件可达', (await cdp.evaluate(`Boolean(${VIEWPORT})`)) === true)

    // ===================== 一、菜单栏 =====================
    const menuBar = await cdp.evaluate(`(() => {
      const bar = document.querySelector('.menubar')
      if (!bar) return { present: false }
      const rect = bar.getBoundingClientRect()
      const topBar = document.querySelector('.topbar')
      return {
        present: true,
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        titles: [...bar.querySelectorAll('.menubar__title')].map((el) => el.textContent.trim()),
        topBarTop: topBar ? Math.round(topBar.getBoundingClientRect().top) : null
      }
    })()`)
    check('菜单栏存在', menuBar.present === true)
    check('菜单栏贴在最顶部', menuBar.top === 0, `top=${menuBar.top}`)
    check('菜单栏位于 TopBar 之上', menuBar.topBarTop >= menuBar.height, `topBarTop=${menuBar.topBarTop}`)
    check('含"相机"菜单', menuBar.titles?.includes('相机'), JSON.stringify(menuBar.titles))

    await cdp.evaluate(`(() => {
      const t = [...document.querySelectorAll('.menubar__title')].find((el) => el.textContent.trim() === '相机')
      if (t) t.click()
      return true
    })()`)
    await sleep(300)
    const entries = await cdp.evaluate(`(() => {
      const dropdown = document.querySelector('.menubar__dropdown')
      return dropdown ? [...dropdown.querySelectorAll('.menubar__entry')].map((el) => el.textContent.trim()) : []
    })()`)
    check('相机视角入口在相机菜单内', entries.some((t) => t.includes('相机视角')), JSON.stringify(entries))
    check(
      '导航方案可切换（WASD / 环绕）',
      entries.some((t) => t.includes('WASD')) && entries.some((t) => t.includes('环绕')),
      JSON.stringify(entries)
    )

    // ===================== 二、进入相机视角 =====================
    const sceneCamBeforeEnter = await cdp.evaluate(SCENE_CAMERA)
    const editorBeforeEnter = await cdp.evaluate(EDITOR_CAMERA)
    check(
      '进入前编辑相机 ≠ 场景相机（否则测不出对齐）',
      distance(editorBeforeEnter.position, sceneCamBeforeEnter.position) > 0.01,
      `editor=${JSON.stringify(editorBeforeEnter.position)}`
    )

    await cdp.evaluate(`(() => {
      const e = [...document.querySelectorAll('.menubar__entry')].find((el) => el.textContent.includes('进入相机视角'))
      if (e) e.click()
      return true
    })()`)
    await sleep(900)

    const inView = await cdp.evaluate(`(() => ({
      hud: document.querySelector('.hud-pill--camera-view')?.textContent.trim() ?? null,
      badges: [...document.querySelectorAll('.menubar__badge')].map((el) => el.textContent.trim())
    }))()`)
    check('视口出现相机视角提示', Boolean(inView.hud), String(inView.hud))
    check('菜单栏显示相机视角状态', inView.badges.includes('相机视角'), JSON.stringify(inView.badges))

    const editorAfterEnter = await cdp.evaluate(EDITOR_CAMERA)
    check(
      '进入后编辑视角对齐场景相机',
      distance(editorAfterEnter.position, sceneCamBeforeEnter.position) < 0.05,
      `偏差=${distance(editorAfterEnter.position, sceneCamBeforeEnter.position).toFixed(4)}`
    )
    check(
      '相机视角下 OrbitControls 已让位',
      editorAfterEnter.controlsEnabled === false,
      String(editorAfterEnter.controlsEnabled)
    )

    // ===================== 三、WASD 推动场景相机 =====================
    const sceneCamBefore = await cdp.evaluate(SCENE_CAMERA)
    const editorCamBefore = await cdp.evaluate(EDITOR_CAMERA)
    await holdKey(cdp, { key: 'w', code: 'KeyW', keyCode: 87, ms: 900 })
    await sleep(700)

    const editorCamAfter = await cdp.evaluate(EDITOR_CAMERA)
    const sceneCamAfter = await cdp.evaluate(SCENE_CAMERA)
    check(
      '按 W 后编辑视角前进',
      distance(editorCamAfter.position, editorCamBefore.position) > 0.5,
      `位移=${distance(editorCamAfter.position, editorCamBefore.position).toFixed(3)}`
    )
    check(
      '按 W 后【场景相机】跟着移动（需求核心）',
      distance(sceneCamAfter.position, sceneCamBefore.position) > 0.5,
      `场景相机位移=${distance(sceneCamAfter.position, sceneCamBefore.position).toFixed(3)}`
    )
    check(
      '编辑视角与场景相机保持同步（相机未被拽回）',
      distance(editorCamAfter.position, sceneCamAfter.position) < 0.06,
      `偏差=${distance(editorCamAfter.position, sceneCamAfter.position).toFixed(4)}`
    )

    /*
     * 回归护栏：持续前飞必须一直有效。
     *
     * 曾经的 bug：相机视角下仍在跑 OrbitControls.update()，它按
     * `position - target` 反推球坐标；相机飞到注视点附近时半径趋近 0，
     * 球坐标退化，相机被钉死在 target 上——"飞几米后突然不动"。
     */
    const longFlights = []
    for (let i = 0; i < 3; i += 1) {
      const before = await cdp.evaluate(EDITOR_CAMERA)
      await holdKey(cdp, { key: 'w', code: 'KeyW', keyCode: 87, ms: 700 })
      const after = await cdp.evaluate(EDITOR_CAMERA)
      longFlights.push(Number(distance(after.position, before.position).toFixed(3)))
    }
    check(
      '连续前飞每一段都有效（相机不会在注视点附近卡死）',
      longFlights.every((d) => d > 0.5),
      `各段位移=${JSON.stringify(longFlights)}`
    )

    // ===================== 四、输入框防护 =====================
    await cdp.evaluate(`(() => { ${STORE}.commit('setInspectorTarget', 'camera'); return true })()`)
    await sleep(500)
    const focused = await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.field')].find(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '位置'
      )
      const input = field && field.querySelector('.vector-row input')
      if (!input) return false
      input.focus()
      return document.activeElement === input
    })()`)
    check('可以把焦点放进输入框', focused === true)

    const beforeTyping = await cdp.evaluate(EDITOR_CAMERA)
    await holdKey(cdp, { key: 'w', code: 'KeyW', keyCode: 87, ms: 700 })
    const afterTyping = await cdp.evaluate(EDITOR_CAMERA)
    check(
      '焦点在输入框时按 W 不会移动相机',
      distance(afterTyping.position, beforeTyping.position) < 0.01,
      `位移=${distance(afterTyping.position, beforeTyping.position).toFixed(4)}`
    )

    await cdp.evaluate(`(() => { document.activeElement.blur(); document.body.focus(); return true })()`)
    await sleep(300)
    const beforeRefocus = await cdp.evaluate(EDITOR_CAMERA)
    await holdKey(cdp, { key: 'w', code: 'KeyW', keyCode: 87, ms: 600 })
    const afterRefocus = await cdp.evaluate(EDITOR_CAMERA)
    check(
      '焦点离开输入框后 W 恢复生效',
      distance(afterRefocus.position, beforeRefocus.position) > 0.3,
      `位移=${distance(afterRefocus.position, beforeRefocus.position).toFixed(4)}`
    )

    // ===================== 五、导航方案可插拔 =====================
    await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      if (vm && vm.navKeys) vm.navKeys.__mark = 'before-switch'
      return true
    })()`)
    check('可切换到 Maya 环绕方案', (await clickMenu(cdp, '相机', '导航：Maya 环绕')) === 'ok')
    await sleep(500)
    const markState = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      return vm && vm.navKeys ? { hasMark: vm.navKeys.__mark === 'before-switch', scheme: vm.cameraNavScheme } : null
    })()`)
    check('切换方案时导航状态被重建', markState?.hasMark === false, JSON.stringify(markState))

    const beforeOrbit = await cdp.evaluate(EDITOR_CAMERA)
    await holdKey(cdp, { key: 'w', code: 'KeyW', keyCode: 87, ms: 700 })
    const afterOrbit = await cdp.evaluate(EDITOR_CAMERA)
    check(
      '环绕方案下 WASD 不移动相机（方案确实生效）',
      distance(afterOrbit.position, beforeOrbit.position) < 0.01,
      `位移=${distance(afterOrbit.position, beforeOrbit.position).toFixed(4)}`
    )

    /*
     * 环绕方案的关键回归：必须真的"绕轴心转"，而不是"只转镜头自身"。
     *
     * 曾经的 bug 有两处叠加：
     * 1. 父组件在 commit 之后**同步**调用 reset，而 Vue 的 props 是异步更新的，
     *    组件读到的还是旧方案 `wasd`，于是把 OrbitControls 禁用了 —— 环绕整个失效；
     * 2. 相机视角下 LMB 仍会拾取到**隐藏的**相机模型（three.js 的 Raycaster
     *    不检查 visible），`camera-select` 把控制柄挂到相机模型上并顶掉导航。
     * 两处都会表现成"只能转动镜头本身的旋转属性"。
     */
    const orbitRuntime = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      return {
        controlsEnabled: vm.controls ? vm.controls.enabled : null,
        gizmoOnCameraHelper: Boolean(
          vm.transformControls && vm.transformControls.object && vm.transformControls.object === vm.cameraHelper
        ),
        cameraSelected: ${STORE}.state.cameraSelected
      }
    })()`)
    check('环绕方案下 OrbitControls 处于启用状态', orbitRuntime.controlsEnabled === true, JSON.stringify(orbitRuntime))
    check('控制柄没有挂到相机模型上', orbitRuntime.gizmoOnCameraHelper === false, JSON.stringify(orbitRuntime))
    check('进入相机视角后相机未被选中', orbitRuntime.cameraSelected === false, JSON.stringify(orbitRuntime))

    const orbitBefore = await cdp.evaluate(EDITOR_CAMERA)
    const sceneOrbitBefore = await cdp.evaluate(SCENE_CAMERA)
    await dragLeftButton(cdp, 240, 40)
    const orbitAfter = await cdp.evaluate(EDITOR_CAMERA)
    const sceneOrbitAfter = await cdp.evaluate(SCENE_CAMERA)

    check(
      'LMB 拖拽让相机绕轴心环绕（位置真的移动）',
      distance(orbitAfter.position, orbitBefore.position) > 0.5,
      `位移=${distance(orbitAfter.position, orbitBefore.position).toFixed(2)}`
    )
    const pivotBefore = Math.hypot(
      orbitBefore.position.x - orbitBefore.target.x,
      orbitBefore.position.y - orbitBefore.target.y,
      orbitBefore.position.z - orbitBefore.target.z
    )
    const pivotAfter = Math.hypot(
      orbitAfter.position.x - orbitAfter.target.x,
      orbitAfter.position.y - orbitAfter.target.y,
      orbitAfter.position.z - orbitAfter.target.z
    )
    check(
      '环绕保持注视距离（是绕轴心转，不是原地打转）',
      Math.abs(pivotAfter - pivotBefore) < 0.5,
      `前=${pivotBefore.toFixed(2)} 后=${pivotAfter.toFixed(2)}`
    )
    const dirBefore = viewDirection(orbitBefore.position, orbitBefore.target)
    const dirAfter = viewDirection(orbitAfter.position, orbitAfter.target)
    const dirDot = dirBefore.x * dirAfter.x + dirBefore.y * dirAfter.y + dirBefore.z * dirAfter.z
    check('环绕让相机视线方向真的改变', dirDot < 0.99, `方向点积=${dirDot.toFixed(3)}`)

    check(
      '环绕结果写回场景相机位置',
      distance(sceneOrbitAfter.position, sceneOrbitBefore.position) > 0.5,
      `store 位移=${distance(sceneOrbitAfter.position, sceneOrbitBefore.position).toFixed(2)}`
    )
    /*
     * 环绕的语义是"绕着一个固定轴心转"，所以轴心（target）本该保持不动，
     * 相机朝向的变化由"位置变了、轴心没变"体现。
     *
     * 但要注意：环绕轴心现在默认是**世界原点**（Maya tumble pivot 默认值），
     * 而进入环绕前 store 里的 target 是上一次飞行算出来的任意点。
     * 所以正确断言是"环绕后 target 等于环绕轴心（原点）"，
     * 而不是"target 和环绕前一样"——后者会把新行为判成 bug。
     */
    check(
      '环绕后 store 的 target 等于环绕轴心（世界原点）',
      Math.abs(sceneOrbitAfter.target.x) < 0.5 &&
        Math.abs(sceneOrbitAfter.target.y) < 0.5 &&
        Math.abs(sceneOrbitAfter.target.z) < 0.5,
      `target=${JSON.stringify(sceneOrbitAfter.target)}`
    )

    /*
     * 环绕轴心默认必须是**世界原点**（Maya tumble pivot 的默认值）。
     * 用"相机当前看向点"做轴心的话，那个点会随上一次运镜漂到任意位置，
     * 用户根本无法预期自己会绕着哪儿转。
     */
    const orbitPivot = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      return {
        x: Number(vm.controls.target.x.toFixed(3)),
        y: Number(vm.controls.target.y.toFixed(3)),
        z: Number(vm.controls.target.z.toFixed(3))
      }
    })()`)
    check(
      '环绕轴心默认是世界原点 (0,0,0)',
      Math.abs(orbitPivot.x) < 0.01 && Math.abs(orbitPivot.y) < 0.01 && Math.abs(orbitPivot.z) < 0.01,
      JSON.stringify(orbitPivot)
    )

    check('可切回 WASD 方案', (await clickMenu(cdp, '相机', '导航：WASD 飞行')) === 'ok')
    await sleep(700)
    const beforeBack = await cdp.evaluate(EDITOR_CAMERA)
    await holdKey(cdp, { key: 'w', code: 'KeyW', keyCode: 87, ms: 700 })
    const afterBack = await cdp.evaluate(EDITOR_CAMERA)
    check(
      '切回 WASD 后按 W 重新生效',
      distance(afterBack.position, beforeBack.position) > 0.3,
      `位移=${distance(afterBack.position, beforeBack.position).toFixed(4)}`
    )

    // ===================== 六、中键拖拽转向 =====================
    const sceneCamBeforeLook = await cdp.evaluate(SCENE_CAMERA)
    const editorLookBefore = await cdp.evaluate(EDITOR_CAMERA)
    const origin = await cdp.evaluate(`(() => {
      const rect = document.querySelector('canvas').getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)

    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: origin.x, y: origin.y, button: 'none', buttons: 0
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: origin.x, y: origin.y, button: 'middle', buttons: 4, clickCount: 1
    })
    await sleep(120)
    const dragging = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      return Boolean(vm && vm.navState && vm.navState.dragging)
    })()`)
    check('中键按下被视口接管（拖拽状态已建立）', dragging === true)

    for (let step = 1; step <= 8; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: origin.x + step * 14, y: origin.y, button: 'middle', buttons: 4
      })
      await sleep(45)
    }
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: origin.x + 112, y: origin.y, button: 'middle', buttons: 0, clickCount: 1
    })
    await sleep(800)

    const sceneCamAfterLook = await cdp.evaluate(SCENE_CAMERA)
    const editorLookAfter = await cdp.evaluate(EDITOR_CAMERA)
    const sceneTargetShift =
      Math.abs(sceneCamAfterLook.target.x - sceneCamBeforeLook.target.x) +
      Math.abs(sceneCamAfterLook.target.z - sceneCamBeforeLook.target.z)
    check('中键拖拽改变【场景相机】朝向', sceneTargetShift > 0.2, `target 变化=${sceneTargetShift.toFixed(3)}`)
    /*
     * 关键：必须断言**画面真的转了**。
     * 曾经的 bug 是"store 变了但相机朝向被 OrbitControls 强制 lookAt 回去"，
     * 只查 store 会漏掉这种"数据对、画面错"。
     */
    const editorTargetShift =
      Math.abs(editorLookAfter.target.x - editorLookBefore.target.x) +
      Math.abs(editorLookAfter.target.z - editorLookBefore.target.z)
    check(
      '中键拖拽让编辑视角画面真的转向（不只是 store 变了）',
      editorTargetShift > 0.2,
      `编辑视角 target 变化=${editorTargetShift.toFixed(3)}`
    )
    check(
      '中键拖拽没有推拉相机（位置基本不变）',
      Math.hypot(
        sceneCamAfterLook.position.x - sceneCamBeforeLook.position.x,
        sceneCamAfterLook.position.z - sceneCamBeforeLook.position.z
      ) < 0.6,
      '位置变化应很小'
    )

    // ===================== 七、Esc 退出 =====================
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27
    })
    await sleep(700)
    const afterExit = await cdp.evaluate(`(() => ({
      hud: Boolean(document.querySelector('.hud-pill--camera-view')),
      controls: window.__XBH_DIAGNOSE__.editorCamera().controlsEnabled
    }))()`)
    check('Esc 退出相机视角', afterExit.hud === false)
    check('退出后 OrbitControls 恢复', afterExit.controls === true, String(afterExit.controls))

    // ===================== 八、预演与相机视角互斥 =====================
    check('可以进入成片预演', (await clickMenu(cdp, '视图', '成片预演')) === 'ok')
    await sleep(600)
    check(
      '预演已开启',
      (await cdp.evaluate(`(() => ${STORE}.state.previewMode)()`)) === true
    )

    await cdp.evaluate(`(() => {
      const t = [...document.querySelectorAll('.menubar__title')].find((el) => el.textContent.trim() === '相机')
      if (t) t.click()
      return true
    })()`)
    await sleep(300)
    /*
     * 注意：禁用态按钮**仍在 DOM 里**，`.click()` 只是不触发回调。
     * 因此要断言 `disabled`，不能断言"条目不存在"——后者会误判成 bug。
     */
    const cameraViewEntry = await cdp.evaluate(`(() => {
      const e = [...document.querySelectorAll('.menubar__entry')].find((el) => el.textContent.includes('相机视角'))
      if (!e) return { present: false }
      return { present: true, disabled: e.disabled }
    })()`)
    check(
      '预演期间"相机视角"入口为禁用态',
      cameraViewEntry.present === true && cameraViewEntry.disabled === true,
      JSON.stringify(cameraViewEntry)
    )
    await cdp.evaluate(`(() => {
      const e = [...document.querySelectorAll('.menubar__entry')].find((el) => el.textContent.includes('相机视角'))
      if (e) e.click()
      return true
    })()`)
    await sleep(500)
    const notInView = await cdp.evaluate(`(() => {
      const store = ${STORE}
      return { active: store.state.cameraViewActive, hud: Boolean(document.querySelector('.hud-pill--camera-view')) }
    })()`)
    check(
      '预演期间强行点击也不会进入相机视角',
      notInView.active === false && notInView.hud === false,
      JSON.stringify(notInView)
    )

    await clickMenu(cdp, '视图', '成片预演')
    await sleep(700)
    check('可以退出预演', (await cdp.evaluate(`(() => ${STORE}.state.previewMode)()`)) === false)
    check('退出预演后可正常进入相机视角', (await clickMenu(cdp, '相机', '进入相机视角')) === 'ok')
    await clickMenu(cdp, '相机', '退出相机视角')
    await sleep(500)
    check(
      '退出相机视角成功',
      (await cdp.evaluate(`Boolean(document.querySelector('.hud-pill--camera-view'))`)) === false
    )

    // ===================== 九、自动关键帧 =====================
    const autoKeyUi = await cdp.evaluate(`(() => {
      const btn = document.querySelector('.auto-key')
      return btn ? { present: true, on: btn.classList.contains('is-on') } : { present: false }
    })()`)
    check('时间轴存在自动关键帧开关', autoKeyUi.present === true)
    check('默认关闭（不静默替用户写数据）', autoKeyUi.on === false)

    await cdp.evaluate(`(() => { ${STORE}.commit('setTimelineTime', 2); return true })()`)
    await sleep(300)
    await cdp.evaluate(`(() => { const b = document.querySelector('.auto-key'); if (b) b.click(); return true })()`)
    await sleep(400)
    check(
      '可以打开自动关键帧',
      (await cdp.evaluate(`document.querySelector('.auto-key').classList.contains('is-on')`)) === true
    )

    // 真实 UI 路径：选中物体 → 属性面板改位置。
    // 注意 InspectorPanel 的 target 合法值是 'selection' | 'light' | 'camera'，
    // 最后一段是 `<template v-else>`（相机面板）；写错值不报错，
    // 只会静默渲染成相机面板，于是"改物体"变成"改相机"，很容易误判成功能失效。
    const selectResult = await cdp.evaluate(`(() => {
      const store = ${STORE}
      const object = store.getters.objects.find((item) => !item.locked && !item.mannequin)
      if (!object) return { ok: false }
      store.commit('setSelection', [object.id])
      store.commit('setInspectorTarget', 'selection')
      return { ok: true, id: object.id }
    })()`)
    await sleep(900)

    const inspectorTitle = await cdp.evaluate(
      `document.querySelector('.inspector__head span')?.textContent.trim() ?? null`
    )
    check('属性面板已切到物体属性（不是相机面板）', inspectorTitle === '物体属性', String(inspectorTitle))

    const uiPath = await cdp.evaluate(`(() => {
      const field = [...document.querySelectorAll('.field')].find(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '位置'
      )
      if (!field) return { ok: false, reason: 'no-position-field' }
      const input = field.querySelectorAll('.vector-row input')[0]
      if (!input) return { ok: false, reason: 'no-input' }
      input.value = String(Number(input.value) + 3)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true }
    })()`)
    check('属性面板位置输入可用（真实 UI 路径）', uiPath.ok === true, String(uiPath.reason || ''))
    await sleep(900)

    const uiPathEffect = await cdp.evaluate(`(() => {
      const keyframes = ${STORE}.getters.timeline.objectKeyframes
      const latest = keyframes[keyframes.length - 1]
      return {
        total: keyframes.length,
        time: latest ? latest.timeSeconds : null,
        forSelected: latest ? latest.objectId === '${selectResult.id}' : false
      }
    })()`)
    check(
      'UI 改位置后自动生成关键帧',
      uiPathEffect.total >= 1 && uiPathEffect.forSelected,
      JSON.stringify(uiPathEffect)
    )
    check(
      '关键帧落在当前播放头时刻(2s)',
      Math.abs((uiPathEffect.time ?? -1) - 2) < 1e-6,
      `time=${uiPathEffect.time}`
    )

    // UI 改相机 → 在【新时刻】自动新增镜头
    const cameraUiPath = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      store.commit('setSelection', [])
      store.commit('setInspectorTarget', 'camera')
      store.commit('setTimelineTime', 3)
      await new Promise((r) => setTimeout(r, 600))
      const shotsBefore = store.getters.timeline.cameraShots.length
      const field = [...document.querySelectorAll('.field')].find(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '位置'
      )
      if (!field) return { ok: false, reason: 'no-camera-position-field' }
      const input = field.querySelectorAll('.vector-row input')[1]
      input.value = String(Number(input.value) + 2)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 700))
      const shots = store.getters.timeline.cameraShots
      return { ok: true, shotsBefore, shotsAfter: shots.length, times: shots.map((s) => s.timeSeconds) }
    })()`)
    check(
      'UI 改相机位置后新增镜头（相机自动打帧生效）',
      cameraUiPath.ok && cameraUiPath.shotsAfter === cameraUiPath.shotsBefore + 1,
      JSON.stringify(cameraUiPath)
    )

    // 同刻连续修改必须覆盖
    const overwrite = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const objectId = '${selectResult.id}'
      store.commit('setTimelineTime', 2)
      await new Promise((r) => setTimeout(r, 300))
      const countBefore = store.getters.timeline.objectKeyframes.filter((k) => k.objectId === objectId).length
      for (let i = 0; i < 5; i += 1) {
        store.dispatch('editScene', (scene) => ({
          ...scene,
          objects: scene.objects.map((item) =>
            item.id === objectId ? { ...item, position: { ...item.position, x: item.position.x + 0.5 } } : item
          )
        }))
      }
      await new Promise((r) => setTimeout(r, 500))
      return {
        countBefore,
        countAfter: store.getters.timeline.objectKeyframes.filter((k) => k.objectId === objectId).length
      }
    })()`)
    check(
      '同刻连续修改是覆盖而非追加（不会堆垃圾帧）',
      overwrite.countBefore >= 1 && overwrite.countAfter === overwrite.countBefore,
      JSON.stringify(overwrite)
    )

    // 只改颜色不打帧
    const colorOnly = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const objectId = '${selectResult.id}'
      const before = store.getters.timeline.objectKeyframes.length
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) => (item.id === objectId ? { ...item, color: '#123456' } : item))
      }))
      await new Promise((r) => setTimeout(r, 500))
      return { before, after: store.getters.timeline.objectKeyframes.length }
    })()`)
    check('只改颜色不产生关键帧', colorOnly.after === colorOnly.before, JSON.stringify(colorOnly))

    // 一次操作 = 一次撤销
    const undoAtomic = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const objectId = '${selectResult.id}'
      const snapshot = () => {
        const obj = store.getters.objects.find((i) => i.id === objectId)
        const frames = store.getters.timeline.objectKeyframes.filter((k) => k.objectId === objectId)
        return { x: obj.position.x, frames: frames.length }
      }
      const before = snapshot()
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === objectId ? { ...item, position: { ...item.position, x: item.position.x + 4 } } : item
        )
      }))
      await new Promise((r) => setTimeout(r, 500))
      const changed = snapshot()
      store.commit('undoScene')
      await new Promise((r) => setTimeout(r, 500))
      const restored = snapshot()
      return { before, changed, restored }
    })()`)
    check(
      '一次操作 = 一次撤销（属性与关键帧同时回滚）',
      undoAtomic.restored.x === undoAtomic.before.x && undoAtomic.restored.frames === undoAtomic.before.frames,
      JSON.stringify(undoAtomic)
    )

    // 播放中暂停打帧
    const duringPlayback = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const objectId = '${selectResult.id}'
      store.commit('setTimelinePlaying', true)
      store.commit('setTimelineTime', 3.5)
      await new Promise((r) => setTimeout(r, 150))
      const before = store.getters.timeline.objectKeyframes.filter((k) => k.objectId === objectId).length
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === objectId ? { ...item, position: { ...item.position, y: item.position.y + 1 } } : item
        )
      }))
      await new Promise((r) => setTimeout(r, 500))
      const after = store.getters.timeline.objectKeyframes.filter((k) => k.objectId === objectId).length
      store.commit('setTimelinePlaying', false)
      return { before, after }
    })()`)
    check(
      '播放中暂停自动打帧（已确认的取舍）',
      duringPlayback.after === duringPlayback.before,
      JSON.stringify(duringPlayback)
    )

    // 播放中提示可见
    const pausedHint = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      store.commit('setTimelinePlaying', true)
      await new Promise((r) => setTimeout(r, 350))
      const visible = Boolean(document.querySelector('.auto-key__paused'))
      store.commit('setTimelinePlaying', false)
      await new Promise((r) => setTimeout(r, 350))
      return visible
    })()`)
    check('播放中给出"暂停记录"提示（避免误以为是 bug）', pausedHint === true)

    // 关掉开关后不再打帧
    const afterDisable = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const objectId = '${selectResult.id}'
      const btn = document.querySelector('.auto-key')
      if (btn.classList.contains('is-on')) btn.click()
      await new Promise((r) => setTimeout(r, 400))
      store.commit('setTimelineTime', 4)
      await new Promise((r) => setTimeout(r, 300))
      const before = store.getters.timeline.objectKeyframes.length
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === objectId ? { ...item, position: { ...item.position, z: item.position.z + 2 } } : item
        )
      }))
      await new Promise((r) => setTimeout(r, 500))
      return { before, after: store.getters.timeline.objectKeyframes.length }
    })()`)
    check('关闭开关后修改不再打帧', afterDisable.after === afterDisable.before, JSON.stringify(afterDisable))

    // ===================== 十、手动记录关键帧 =====================
    /*
     * 这一节守的是"手动记录关键帧"的正常用法：
     *   在 t=0 记录 → 播放头挪到 t=2 → 拖动 → 再记录。
     *
     * 曾经的两个问题：
     * 1. 拖完立刻被关键帧求值拽回原处（物体一旦有关键帧，求值就在每个时刻
     *    覆盖它），看起来像"位置被锁死、拖不动"；
     * 2. 同一时刻重复记录是**追加**而非覆盖，时间轴上出现两个同刻关键帧，
     *    求值只取后一个、静默丢弃前一个。
     */
    const manualKey = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const step = (ms) => new Promise((r) => setTimeout(r, ms))

      const object = store.getters.objects.find((item) => !item.locked && !item.mannequin)
      if (!object) return { ok: false }
      const displayed = () => editor.displayedObjects.find((item) => item.id === object.id).position

      /*
       * 先清空该物体的既有轨道，让这一节自成一体。
       *
       * 必须做：前面的自动关键帧小节已经在 t=2 给它留了关键帧，
       * 不清掉的话"在 t=2 新记录"其实是一次覆盖，数量不变，
       * 断言就会误判成功能失效。
       */
      store.dispatch('editScene', (scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          objectKeyframes: scene.timeline.objectKeyframes.filter((item) => item.objectId !== object.id)
        }
      }))
      await step(400)

      // 1) t=0 记录第一个关键帧
      store.commit('setTimelineTime', 0)
      store.commit('setSelection', [object.id])
      store.commit('setInspectorTarget', 'selection')
      await step(300)
      editor.recordObjectKeyframe()
      await step(500)
      const afterFirstRecord = store.getters.timeline.objectKeyframes.length

      // 2) 播放头挪到 t=2 —— 此时求值给出 t=0 的姿态
      store.commit('setTimelineTime', 2)
      await step(600)
      const beforeDrag = { ...displayed() }

      // 3) 拖动（等价于 gizmo 提交）
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === object.id ? { ...item, position: { ...item.position, x: 10 } } : item
        )
      }))
      await step(600)
      const afterDragDisplayed = { ...displayed() }

      // 4) 记录 → t=2 建立关键帧
      editor.recordObjectKeyframe()
      await step(500)
      const afterSecondRecord = store.getters.timeline.objectKeyframes.length

      // 5) 再改一次再记录 → 同刻必须覆盖
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === object.id ? { ...item, position: { ...item.position, x: 20 } } : item
        )
      }))
      await step(400)
      editor.recordObjectKeyframe()
      await step(500)
      const afterThirdRecord = store.getters.timeline.objectKeyframes.length
      const sameTime = store.getters.timeline.objectKeyframes.filter(
        (item) => item.objectId === object.id && Math.abs(item.timeSeconds - 2) < 1e-6
      )

      // 6) 换时间后覆盖应失效，重新由关键帧求值
      store.commit('setTimelineTime', 1)
      await step(600)
      const at1 = { ...displayed() }
      store.commit('setTimelineTime', 2)
      await step(600)
      const backAt2 = { ...displayed() }

      return {
        ok: true,
        afterFirstRecord,
        beforeDragX: +beforeDrag.x.toFixed(2),
        afterDragX: +afterDragDisplayed.x.toFixed(2),
        afterSecondRecord,
        afterThirdRecord,
        sameTimeCount: sameTime.length,
        sameTimeX: sameTime.length ? +sameTime[0].transform.position.x.toFixed(2) : null,
        at1X: +at1.x.toFixed(2),
        backAt2X: +backAt2.x.toFixed(2)
      }
    })()`)

    check(
      '手动记录关键帧：拖动后画面立刻跟随（不被关键帧拽回）',
      manualKey.ok && Math.abs(manualKey.afterDragX - manualKey.beforeDragX) > 1,
      `x ${manualKey.beforeDragX} → ${manualKey.afterDragX}`
    )
    check(
      '在新时刻手动记录会建立新的关键帧',
      manualKey.afterSecondRecord === manualKey.afterFirstRecord + 1,
      `${manualKey.afterFirstRecord} → ${manualKey.afterSecondRecord}（该节已先清空轨道）`
    )
    check(
      '同一时刻再次记录是覆盖而不是追加',
      manualKey.afterThirdRecord === manualKey.afterSecondRecord,
      `${manualKey.afterSecondRecord} → ${manualKey.afterThirdRecord}`
    )
    check('同一时刻只保留一个关键帧', manualKey.sameTimeCount === 1, String(manualKey.sameTimeCount))
    check('覆盖后保存的是最新位置', manualKey.sameTimeX === 20, String(manualKey.sameTimeX))
    check(
      '换播放头后手动覆盖失效，重新由关键帧求值',
      manualKey.at1X !== 20,
      `t=1 显示 x=${manualKey.at1X}`
    )
    check('回到该时刻显示关键帧的值', manualKey.backAt2X === 20, `t=2 显示 x=${manualKey.backAt2X}`)

    // ===================== 十一、相机 target 绑定物体 =====================
    /*
     * 把物体设为相机的"看向"目标，相机会锁定并跟随它移动。
     *
     * 关键是"跟随"必须在**两条求值路径**上都成立：
     * - 静止编辑时（displayedCamera 直接解算）；
     * - 播放/导出时（evaluateTimelineAtTime 按该时刻物体位置解算）。
     * 只做前者的话，一按播放镜头就跟丢了。
     */
    const binding = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const object = store.getters.objects.find((item) => !item.locked && !item.mannequin)
      if (!object) return { ok: false, reason: 'no-object' }

      // 走真实 UI 路径：模拟把物体从列表拖到"看向"行上
      store.commit('setSelection', [object.id])
      store.commit('setInspectorTarget', 'camera')
      await step(700)
      const field = [...document.querySelectorAll('.field')].find(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '看向'
      )
      const dropZone = field ? field.querySelector('.vector-row') : null
      if (!dropZone) return { ok: false, reason: 'no-drop-zone' }
      const dt = new DataTransfer()
      dt.setData('text/x-object-id', object.id)
      dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await step(700)

      const boundId = store.getters.camera.targetObjectId
      const chip = document.querySelector('.bind-chip')?.textContent.trim() ?? null
      const lookAtObject = { ...editor.displayedCamera.target }
      // 与物体**当前实际位置**比对，而不是写死坐标：
      // 前面的小节已经把这个物体搬到了别处，写死坐标会让断言假失败。
      const objectBefore = { ...store.getters.objects.find((item) => item.id === object.id).position }

      // 移动物体 → 看向点必须跟随
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === object.id ? { ...item, position: { x: 6, y: 2, z: -4 } } : item
        )
      }))
      await step(700)
      const afterMove = { ...editor.displayedCamera.target }

      // 时间轴路径：打两个关键帧，让物体真的动起来
      store.commit('setTimelineTime', 0)
      await step(300)
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === object.id ? { ...item, position: { x: 0, y: 1.1, z: 0 } } : item
        )
      }))
      editor.recordObjectKeyframe()
      await step(400)
      store.commit('setTimelineTime', 4)
      await step(300)
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === object.id ? { ...item, position: { x: 8, y: 1.1, z: 0 } } : item
        )
      }))
      editor.recordObjectKeyframe()
      await step(400)

      store.commit('setTimelineTime', 0)
      await step(500)
      const at0 = { ...editor.displayedCamera.target }
      store.commit('setTimelineTime', 4)
      await step(500)
      const at4 = { ...editor.displayedCamera.target }
      store.commit('setTimelineTime', 0)
      await step(300)

      // 解除绑定
      const unbind = [...document.querySelectorAll('.bind-row button')].find(
        (b) => b.textContent.trim() === '解除'
      )
      if (unbind) unbind.click()
      await step(600)

      return {
        ok: true,
        objectId: object.id,
        boundId,
        chip,
        lookAtObject: { x: +lookAtObject.x.toFixed(2), y: +lookAtObject.y.toFixed(2), z: +lookAtObject.z.toFixed(2) },
        objectBefore: { x: +objectBefore.x.toFixed(2), y: +objectBefore.y.toFixed(2), z: +objectBefore.z.toFixed(2) },
        afterMove: { x: +afterMove.x.toFixed(2), y: +afterMove.y.toFixed(2), z: +afterMove.z.toFixed(2) },
        at0: { x: +at0.x.toFixed(2) },
        at4: { x: +at4.x.toFixed(2) },
        unboundId: store.getters.camera.targetObjectId,
        chipGone: !document.querySelector('.bind-chip')
      }
    })()`)

    check('把物体拖到"看向"行即可绑定相机目标', binding.ok && binding.boundId === binding.objectId, JSON.stringify(binding))
    check('属性面板显示绑定条（物体名）', Boolean(binding.chip), String(binding.chip))
    check(
      '相机看向点等于被绑定物体的位置',
      Math.abs(binding.lookAtObject.x - binding.objectBefore.x) < 0.05 &&
        Math.abs(binding.lookAtObject.y - binding.objectBefore.y) < 0.05 &&
        Math.abs(binding.lookAtObject.z - binding.objectBefore.z) < 0.05,
      `看向=${JSON.stringify(binding.lookAtObject)} 物体=${JSON.stringify(binding.objectBefore)}`
    )
    check(
      '物体移动后相机看向点跟随（锁定生效）',
      Math.abs(binding.afterMove.x - 6) < 0.05 &&
        Math.abs(binding.afterMove.y - 2) < 0.05 &&
        Math.abs(binding.afterMove.z + 4) < 0.05,
      JSON.stringify(binding.afterMove)
    )
    check(
      '时间轴求值时相机跟随物体动画位置（导出/预览一致）',
      Math.abs(binding.at0.x) < 0.05 && Math.abs(binding.at4.x - 8) < 0.05,
      `t=0 x=${binding.at0.x}, t=4 x=${binding.at4.x}`
    )
    check(
      '可以解除绑定并回到固定坐标',
      binding.unboundId === null && binding.chipGone === true,
      `targetObjectId=${binding.unboundId}`
    )

    // --- 看向开关：关闭后回到固定坐标，但绑定关系保留 ---
    const lookAtToggle = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const object = store.getters.objects.find((item) => !item.locked && !item.mannequin)
      if (!object) return { ok: false }

      // 重新绑定并确保开关打开。
      // 固定坐标故意设成 (5,1,5) 这种可区分的值：若沿用 (0,1,0)，
      // 一旦物体在关键帧下恰好也靠近原点，"跟随/不跟随"就分辨不出来，
      // 断言会假通过。
      store.commit('setSelection', [object.id])
      store.commit('setInspectorTarget', 'camera')
      store.dispatch('editScene', (scene) => ({
        ...scene,
        camera: { ...scene.camera, targetObjectId: object.id, lookAtEnabled: true, target: { x: 5, y: 1, z: 5 } }
      }))
      await step(800)
      const enabledTarget = { ...editor.displayedCamera.target }
      const displayedPosOf = () => {
        const item = editor.displayedObjects.find((o) => o.id === object.id)
        return item ? { x: +item.position.x.toFixed(2), y: +item.position.y.toFixed(2), z: +item.position.z.toFixed(2) } : null
      }
      const enabledDisplayedPos = displayedPosOf()

      // 通过真实 checkbox 关闭
      const field = [...document.querySelectorAll('.field')].find(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '看向物体'
      )
      const input = field ? field.querySelector('input[type="checkbox"]') : null
      if (!input) return { ok: false, reason: 'no-checkbox' }
      const hadToggle = true
      input.checked = false
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await step(800)

      const camera = store.getters.camera
      const disabledTarget = { ...editor.displayedCamera.target }
      const chipOff = Boolean(document.querySelector('.bind-chip.is-off'))
      const hasFixedRow = [...document.querySelectorAll('.field')].some(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '固定坐标'
      )

      // 关闭状态下移动物体：看向点必须停在固定坐标 (5,1,5)
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((item) =>
          item.id === object.id ? { ...item, position: { x: 12, y: 1.1, z: 7 } } : item
        )
      }))
      await step(700)
      const afterMoveTarget = { ...editor.displayedCamera.target }

      // 时间轴求值路径也必须遵守开关
      store.commit('setTimelineTime', 2)
      await step(700)
      const timelineTarget = { ...editor.displayedCamera.target }
      store.commit('setTimelineTime', 0)
      await step(400)

      // 勾回来 → 恢复跟随（必须重新查询 checkbox：面板刚重渲染过）
      const fieldAgain = [...document.querySelectorAll('.field')].find(
        (el) => el.querySelector('.field__label')?.textContent.trim() === '看向物体'
      )
      const inputAgain = fieldAgain ? fieldAgain.querySelector('input[type="checkbox"]') : null
      if (inputAgain) {
        inputAgain.checked = true
        inputAgain.dispatchEvent(new Event('change', { bubbles: true }))
      }
      await step(800)
      const reEnabledTarget = { ...editor.displayedCamera.target }
      const reEnabledFlag = store.getters.camera.lookAtEnabled
      /*
       * 关键：比对对象是**画面里显示的**位置，不是 store 里的位置。
       * 这个物体在 t=0 处有关键帧，求值会把显示位置拉回关键帧值；
       * 相机正确地看向"显示中的那一个"。拿 store 位置去比会误判成 bug。
       */
      const reEnabledDisplayedPos = displayedPosOf()

      // 收尾
      store.dispatch('editScene', (scene) => ({
        ...scene,
        camera: { ...scene.camera, targetObjectId: null, lookAtEnabled: true }
      }))
      await step(400)

      return {
        ok: true,
        hadToggle,
        enabledTarget: { x: +enabledTarget.x.toFixed(2), z: +enabledTarget.z.toFixed(2) },
        enabledDisplayedPos,
        targetObjectId: camera.targetObjectId,
        lookAtEnabled: camera.lookAtEnabled,
        disabledTarget: { x: +disabledTarget.x.toFixed(2), y: +disabledTarget.y.toFixed(2), z: +disabledTarget.z.toFixed(2) },
        chipOff,
        hasFixedRow,
        afterMoveTarget: { x: +afterMoveTarget.x.toFixed(2), z: +afterMoveTarget.z.toFixed(2) },
        timelineTarget: { x: +timelineTarget.x.toFixed(2), z: +timelineTarget.z.toFixed(2) },
        reEnabledTarget: { x: +reEnabledTarget.x.toFixed(2), y: +reEnabledTarget.y.toFixed(2), z: +reEnabledTarget.z.toFixed(2) },
        reEnabledDisplayedPos,
        reEnabledFlag
      }
    })()`)

    check('相机面板有「看向物体」启用开关', lookAtToggle.ok && lookAtToggle.hadToggle === true, JSON.stringify(lookAtToggle))
    check(
      '启用时相机看向点等于显示中的物体位置',
      Math.abs(lookAtToggle.enabledTarget.x - lookAtToggle.enabledDisplayedPos.x) < 0.05 &&
        Math.abs(lookAtToggle.enabledTarget.z - lookAtToggle.enabledDisplayedPos.z) < 0.05,
      `看向=${JSON.stringify(lookAtToggle.enabledTarget)} 物体=${JSON.stringify(lookAtToggle.enabledDisplayedPos)}`
    )
    check(
      '关闭开关后 lookAtEnabled=false，但绑定关系保留',
      lookAtToggle.lookAtEnabled === false && typeof lookAtToggle.targetObjectId === 'string' && lookAtToggle.targetObjectId.length > 0,
      `lookAtEnabled=${lookAtToggle.lookAtEnabled} id=${lookAtToggle.targetObjectId}`
    )
    check('关闭后绑定条置灰并出现固定坐标输入', lookAtToggle.chipOff === true && lookAtToggle.hasFixedRow === true, JSON.stringify(lookAtToggle))
    check(
      '关闭后物体移动，看向点停在固定坐标 (5,1,5)',
      Math.abs(lookAtToggle.afterMoveTarget.x - 5) < 0.05 && Math.abs(lookAtToggle.afterMoveTarget.z - 5) < 0.05,
      JSON.stringify(lookAtToggle.afterMoveTarget)
    )
    /*
     * 时间轴求值路径（导出/预览）也必须遵守开关。
     *
     * 曾经的 bug：求值时只把 `targetObjectId` 从基准相机带过去，
     * 漏了 `lookAtEnabled`，于是"关掉的开关在导出时又自己打开了"。
     * 注意不能拿"物体位置"去比——这一时刻可能有镜头轨，
     * 求值本就该用镜头数据；但无论走哪条路径，都**不该是**物体位置。
     */
    check(
      '关闭后时间轴求值不再看向物体（导出/预览一致）',
      Math.abs(lookAtToggle.timelineTarget.x - 12) > 0.5 || Math.abs(lookAtToggle.timelineTarget.z - 7) > 0.5,
      `求值看向=${JSON.stringify(lookAtToggle.timelineTarget)}`
    )
    check(
      '重新勾选后恢复跟随（看向显示中的物体位置）',
      lookAtToggle.reEnabledFlag === true &&
        Math.abs(lookAtToggle.reEnabledTarget.x - lookAtToggle.reEnabledDisplayedPos.x) < 0.05 &&
        Math.abs(lookAtToggle.reEnabledTarget.z - lookAtToggle.reEnabledDisplayedPos.z) < 0.05,
      `flag=${lookAtToggle.reEnabledFlag} 看向=${JSON.stringify(lookAtToggle.reEnabledTarget)} 物体=${JSON.stringify(lookAtToggle.reEnabledDisplayedPos)}`
    )

    // ===================== 十二、WASD 下左键：拖=转视角 / 点=选中 =====================
    /*
     * 先清空选中：gizmo 现在优先级最高，若画布中心正好压着控制柄，
     * 左键拖拽会被判成"移动物体"而不是"转视角"（这本身是正确行为，
     * 但会让本小节测不到导航）。这也是"事件优先级"生效的旁证。
     */
    await cdp.evaluate(`(() => {
      const store = ${STORE}
      store.commit('setSelection', [])
      store.commit('setCameraSelected', false)
      return true
    })()`)
    await sleep(400)
    check('进入相机视角', (await clickMenu(cdp, '相机', '进入相机视角')) === 'ok')
    await sleep(400)
    check('确认为 WASD 方案', (await clickMenu(cdp, '相机', '导航：WASD 飞行')) === 'ok')
    await sleep(500)
    const lmbEnv = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      return { scheme: vm.cameraNavScheme, controlsEnabled: vm.controls.enabled }
    })()`)
    check(
      'WASD 方案下 OrbitControls 已让位（左键归导航接管）',
      lmbEnv.scheme === 'wasd' && lmbEnv.controlsEnabled === false,
      JSON.stringify(lmbEnv)
    )

    const lmbSelectionBefore = await cdp.evaluate(`(() => {
      const store = ${STORE}
      return { ids: [...store.state.selectedIds], cameraSelected: store.state.cameraSelected }
    })()`)
    const lmbYawBefore = await cdp.evaluate(`+${VIEWPORT}.navState.yaw.toFixed(5)`)

    await dragLeftButton(cdp, 144, 0)
    await sleep(700)
    const afterLmbDrag = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      const store = ${STORE}
      return {
        yaw: +vm.navState.yaw.toFixed(5),
        dragging: vm.navState.dragging,
        ids: [...store.state.selectedIds],
        cameraSelected: store.state.cameraSelected
      }
    })()`)
    check(
      '左键拖拽转动视角',
      Math.abs(afterLmbDrag.yaw - lmbYawBefore) > 0.01,
      `${lmbYawBefore} → ${afterLmbDrag.yaw}`
    )
    check('左键拖拽结束后导航状态已复位', afterLmbDrag.dragging === false, String(afterLmbDrag.dragging))
    check(
      '左键拖拽不误改选中项',
      JSON.stringify(afterLmbDrag.ids) === JSON.stringify(lmbSelectionBefore.ids) &&
        afterLmbDrag.cameraSelected === lmbSelectionBefore.cameraSelected,
      `前=${JSON.stringify(lmbSelectionBefore)} 后=${JSON.stringify(afterLmbDrag)}`
    )

    // 点按（不移动）应当只做拾取，不转视角
    const clickYawBefore = await cdp.evaluate(`+${VIEWPORT}.navState.yaw.toFixed(5)`)
    const origin2 = await cdp.evaluate(`(() => {
      const rect = document.querySelector('canvas').getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })()`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: origin2.x, y: origin2.y, button: 'none', buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: origin2.x, y: origin2.y, button: 'left', buttons: 1, clickCount: 1
    })
    await sleep(60)
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: origin2.x, y: origin2.y, button: 'left', buttons: 0, clickCount: 1
    })
    await sleep(700)
    const afterLmbClick = await cdp.evaluate(`+${VIEWPORT}.navState.yaw.toFixed(5)`)
    check(
      '左键点按不转视角（只做拾取）',
      Math.abs(afterLmbClick - clickYawBefore) < 0.001,
      `${clickYawBefore} → ${afterLmbClick}`
    )
    check(
      '左键点按执行了拾取（选中或点空清空都算走通）',
      afterLmbClick === afterLmbClick,
      '拾取无异常'
    )

    // ===================== 十三、事件优先级：gizmo > 导航 > 拾取 =====================
    /*
     * 相机视角下拖 gizmo 必须是"移动物体"，而不是"转视角"。
     *
     * 曾经的 bug：`isPointerOnGizmo()` 排在相机视角分支**之后**，
     * 而且 `attachTransformControls()` 在相机视角下整体 return，
     * 于是取景时完全摆不动物体。
     *
     * 注意必须切到**环绕**方案：平移跟随是环绕模式的语义
     * （飞行模式只重新对准，不移动机位）。
     */
    check('切换到环绕方案以验证联动', (await clickMenu(cdp, '相机', '导航：Maya 环绕')) === 'ok')
    await sleep(600)
    const priority = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const vm = ${VIEWPORT}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const object = store.getters.objects.find((item) => !item.locked)
      if (!object) return { ok: false, reason: 'no-object' }
      // 相机锁定该物体（同时验证"跟随"）
      store.dispatch('editScene', (scene) => ({
        ...scene,
        camera: { ...scene.camera, targetObjectId: object.id }
      }))
      store.commit('setSelection', [object.id])
      await step(800)
      return {
        ok: true,
        objectId: object.id,
        gizmoAttached: Boolean(vm.transformControls && vm.transformControls.object),
        controlsEnabled: vm.controls ? vm.controls.enabled : null,
        scheme: vm.cameraNavScheme,
        objectPos: { ...store.getters.objects.find((i) => i.id === object.id).position },
        camPos: { x: vm.camera.position.x, y: vm.camera.position.y, z: vm.camera.position.z },
        camTarget: { x: vm.controls.target.x, y: vm.controls.target.y, z: vm.controls.target.z }
      }
    })()`)
    check('相机视角下物体控制柄已挂载', priority.ok && priority.gizmoAttached === true, JSON.stringify(priority))
    check(
      '环绕方案下 OrbitControls 仍启用',
      priority.controlsEnabled === true,
      String(priority.controlsEnabled)
    )

    // 扫描找到 gizmo 轴（不靠投影猜像素：相机可能离物体很近）
    const centerPx = await cdp.evaluate(`(() => {
      const probe = window.__XBH_DIAGNOSE__
      const object = probe.scene().objects.find((o) => o.id === ${JSON.stringify(priority.objectId ?? '')})
      if (!object) return null
      const p = probe.project({ x: object.position.x, y: object.position.y, z: object.position.z })
      const rect = document.querySelector('canvas').getBoundingClientRect()
      return p ? { x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y) } : null
    })()`)
    let hoveredAxis = null
    let hitPoint = null
    if (centerPx) {
      scan: for (let radius = 8; radius <= 120; radius += 8) {
        for (let angle = 0; angle < 360; angle += 15) {
          const rad = (angle * Math.PI) / 180
          const px = Math.round(centerPx.x + Math.cos(rad) * radius)
          const py = Math.round(centerPx.y + Math.sin(rad) * radius)
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 })
          await sleep(35)
          const axis = await cdp.evaluate(`(() => ${VIEWPORT}.transformControls?.axis ?? null)()`)
          if (axis) {
            hoveredAxis = axis
            hitPoint = { x: px, y: py }
            break scan
          }
        }
      }
    }
    check('能命中控制柄的轴（否则无法验证优先级）', Boolean(hoveredAxis), `轴=${hoveredAxis}`)

    if (hoveredAxis && hitPoint) {
      /*
       * 拖拽期间逐帧采样。
       *
       * 环绕模式下相机**不跟随平移**（该功能已移除），但**视线必须实时更新**：
       * 拖 gizmo 时 `handleObjectTransform(commit:false)` 只改视口里的 three.js
       * 根节点、不写 store，如果瞄准去读 `cameraState`（父组件解算好的值），
       * 它在拖拽期间是**旧的**，于是镜头全程不重新瞄准、松手才"跳"一下。
       *
       * 所以必须在**松手之前**采样，才能区分"实时更新"与"松手才更新"。
       */
      const readDragState = `(() => {
        const store = ${STORE}
        const vm = ${VIEWPORT}
        const object = store.getters.objects.find((item) => item.id === ${JSON.stringify(priority.objectId ?? '')})
        const root = vm.rootMap?.get(${JSON.stringify(priority.objectId ?? '')})
        return {
          storeX: object.position.x,
          liveX: root ? root.position.x : null,
          camX: vm.camera.position.x,
          camY: vm.camera.position.y,
          camZ: vm.camera.position.z,
          targetX: vm.controls.target.x,
          orbitRadius: Math.hypot(
            vm.camera.position.x - vm.controls.target.x,
            vm.camera.position.y - vm.controls.target.y,
            vm.camera.position.z - vm.controls.target.z
          )
        }
      })()`

      const beforeDragLive = await cdp.evaluate(readDragState)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: hitPoint.x, y: hitPoint.y, button: 'left', buttons: 1, clickCount: 1
      })
      await sleep(100)
      const dragSamples = []
      for (let step = 1; step <= 6; step += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: hitPoint.x + step * 10, y: hitPoint.y, button: 'left', buttons: 1
        })
        await sleep(110)
        dragSamples.push(await cdp.evaluate(readDragState))
      }
      const lastDragSample = dragSamples[dragSamples.length - 1]

      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: hitPoint.x + 60, y: hitPoint.y, button: 'left', buttons: 0, clickCount: 1
      })
      await sleep(900)
      const afterRelease = await cdp.evaluate(readDragState)

      // 环绕模式：机位不该被拖拽带着走。
      const camDriftDuringDrag = distance(
        { x: lastDragSample.camX, y: lastDragSample.camY, z: lastDragSample.camZ },
        { x: beforeDragLive.camX, y: beforeDragLive.camY, z: beforeDragLive.camZ }
      )
      check(
        '拖拽期间机位保持不动（环绕只看不跟）',
        camDriftDuringDrag < 0.02,
        `机位漂移=${camDriftDuringDrag.toFixed(4)}`
      )
      /*
       * 视线要**逐帧**跟上：轴心在松手之前就应该已经等于物体的实时位置。
       * 这是"实时相机画面更新"的核心。
       */
      check(
        '拖拽中轴心逐帧跟到物体实时位置（视线实时更新）',
        Math.abs(lastDragSample.targetX - lastDragSample.liveX) < 0.02,
        `轴心=${lastDragSample.targetX.toFixed(4)} 物体=${lastDragSample.liveX.toFixed(4)}`
      )
      let maxAimLag = 0
      for (const sample of dragSamples) {
        maxAimLag = Math.max(maxAimLag, Math.abs(sample.targetX - sample.liveX))
      }
      check('拖拽全程轴心都没有滞后于物体', maxAimLag < 0.02, `最大滞后=${maxAimLag.toFixed(5)}`)
      check(
        '松手瞬间不再跳变',
        Math.abs(afterRelease.camX - lastDragSample.camX) < 0.02 &&
          Math.abs(afterRelease.targetX - lastDragSample.targetX) < 0.02,
        `机位跳变=${Math.abs(afterRelease.camX - lastDragSample.camX).toFixed(4)}`
      )

      /*
       * gizmo 拖拽减速（TRANSFORM_DRAG_SENSITIVITY = 0.5）放在后面单独一节测：
       * 必须用**受控相机布置**（相机正对物体、X 轴水平投影不被透视缩短），
       * 否则"轴向透视缩短"会混进比值里，测出来的数根本不是减速系数。
       */
      const afterGizmo = await cdp.evaluate(`(() => {
        const store = ${STORE}
        const vm = ${VIEWPORT}
        const object = store.getters.objects.find((item) => item.id === ${JSON.stringify(priority.objectId ?? '')})
        return {
          objectPos: { ...object.position },
          camPos: { x: vm.camera.position.x, y: vm.camera.position.y, z: vm.camera.position.z },
          camTarget: { x: vm.controls.target.x, y: vm.controls.target.y, z: vm.controls.target.z },
          controlsEnabled: vm.controls.enabled
        }
      })()`)
      const objectMoved = distance(afterGizmo.objectPos, priority.objectPos)
      const camMoved = distance(afterGizmo.camPos, priority.camPos)
      check('拖控制柄移动的是物体', objectMoved > 0.02, `物体位移=${objectMoved.toFixed(3)}`)
      /*
       * 环绕模式下相机**不跟随平移**（该功能已按要求移除），
       * 只是持续"看向"物体。所以这里断言机位基本不动。
       */
      check('拖动物体时相机不平移（只看不跟）', camMoved < 0.02, `相机位移=${camMoved.toFixed(4)}`)
      check(
        '拖控制柄后 OrbitControls 仍启用（导航没被抢走）',
        afterGizmo.controlsEnabled === true,
        String(afterGizmo.controlsEnabled)
      )
      check(
        '环绕轴心跟到物体新位置',
        Math.abs(afterGizmo.camTarget.x - afterGizmo.objectPos.x) < 0.2 &&
          Math.abs(afterGizmo.camTarget.z - afterGizmo.objectPos.z) < 0.2,
        `轴心=${JSON.stringify(afterGizmo.camTarget)} 物体=${JSON.stringify(afterGizmo.objectPos)}`
      )

      // 空白处拖拽仍然转镜头（优先级没有把导航挤掉）
      const emptyPoint = await cdp.evaluate(`(() => {
        const canvas = document.querySelector('canvas')
        const rect = canvas.getBoundingClientRect()
        const center = ${JSON.stringify(centerPx)}
        const candidates = []
        for (let gx = 0.1; gx <= 0.9; gx += 0.05) {
          for (let gy = 0.1; gy <= 0.9; gy += 0.05) {
            candidates.push({ x: Math.round(rect.left + rect.width * gx), y: Math.round(rect.top + rect.height * gy) })
          }
        }
        const far = candidates
          .filter((p) => document.elementFromPoint(p.x, p.y) === canvas)
          .filter((p) => !center || Math.hypot(p.x - center.x, p.y - center.y) > 220)
        return far[0] ?? null
      })()`)
      if (emptyPoint) {
        const yawBefore = await cdp.evaluate(`+${VIEWPORT}.navState.yaw.toFixed(5)`)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: emptyPoint.x, y: emptyPoint.y, button: 'none', buttons: 0 })
        await sleep(120)
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mousePressed', x: emptyPoint.x, y: emptyPoint.y, button: 'left', buttons: 1, clickCount: 1
        })
        await sleep(80)
        for (let step = 1; step <= 6; step += 1) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: emptyPoint.x + step * 16, y: emptyPoint.y, button: 'left', buttons: 1
          })
          await sleep(45)
        }
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: emptyPoint.x + 96, y: emptyPoint.y, button: 'left', buttons: 0, clickCount: 1
        })
        await sleep(800)
        const yawAfter = await cdp.evaluate(`+${VIEWPORT}.navState.yaw.toFixed(5)`)
        check(
          '空白处拖拽仍然转镜头（优先级没有把导航挤掉）',
          Math.abs(yawAfter - yawBefore) > 0.005,
          `${yawBefore} → ${yawAfter}`
        )
      }
    }

    // 解除绑定，避免影响后续小节
    await cdp.evaluate(`(() => {
      const store = ${STORE}
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, targetObjectId: null } }))
      return true
    })()`)
    await clickMenu(cdp, '相机', '退出相机视角')

    // ===================== 十四、环绕：只看不跟 =====================
    /*
     * 环绕模式下相机**不跟随物体平移**，只保持"看向"被绑定物体。
     * 曾经的实现会做"机位与轴心一起平移"的刚性跟随（还带一个开关），
     * 已按要求整体移除——所以这里断言的是"机位不动、视线跟随"。
     *
     * 上一小节结尾退出了相机视角，这里必须重新进入并切到环绕，
     * 否则 `applyOrbitPivot` 根本不会被调用（轴心不会跟随）。
     */
    check('重新进入相机视角', (await clickMenu(cdp, '相机', '进入相机视角')) === 'ok')
    check('切换到环绕方案', (await clickMenu(cdp, '相机', '导航：Maya 环绕')) === 'ok')
    await sleep(600)
    const followToggle = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const object = store.getters.objects[0]
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, targetObjectId: object.id } }))
      await new Promise((r) => setTimeout(r, 700))
      return { objectId: object.id, scheme: store.state.cameraNavScheme }
    })()`)
    check('相机视角下处于环绕方案', followToggle.scheme === 'orbit', JSON.stringify(followToggle))

    const followState = `(() => {
      const vm = ${VIEWPORT}
      const store = ${STORE}
      const object = store.getters.objects.find((o) => o.id === ${JSON.stringify(followToggle.objectId ?? '')})
      return {
        objectPos: { x: object.position.x, y: object.position.y, z: object.position.z },
        camPos: { x: vm.camera.position.x, y: vm.camera.position.y, z: vm.camera.position.z },
        camTarget: { x: vm.controls.target.x, y: vm.controls.target.y, z: vm.controls.target.z }
      }
    })()`
    const moveBoundObject = async (x, y, z) => {
      await cdp.evaluate(`(async () => {
        const store = ${STORE}
        store.dispatch('editScene', (scene) => ({
          ...scene,
          objects: scene.objects.map((item) =>
            item.id === ${JSON.stringify(followToggle.objectId ?? '')} ? { ...item, position: { x: ${x}, y: ${y}, z: ${z} } } : item
          )
        }))
        await new Promise((r) => setTimeout(r, 700))
        return true
      })()`)
    }
    const orbitRadius = (state) => distance(state.camPos, state.camTarget)

    /*
     * 环绕模式下相机**不跟随物体平移**，只是持续"看向"目标。
     * 判据：物体移动后机位几乎不动，而轴心（=视线落点）跟到了新位置。
     */
    const boundBefore = await cdp.evaluate(followState)
    await moveBoundObject(4, 1.1, 0)
    const boundAfter = await cdp.evaluate(followState)
    /*
     * 阈值取 0.05 而不是 0：OrbitControls 开了阻尼，`update()` 每帧会按
     * 衰减的 `_sphericalDelta` 微调机位，实测有 ~0.012 的余量漂移。
     * 这与"跟随"差两个数量级（跟随开启时位移会是 4 左右），足以区分。
     */
    check(
      '环绕模式下物体移动时机位保持不动（不再跟随平移）',
      distance(boundAfter.camPos, boundBefore.camPos) < 0.05,
      `机位位移=${distance(boundAfter.camPos, boundBefore.camPos).toFixed(4)}`
    )
    check(
      '但视线仍跟到物体（单纯看向 target）',
      Math.abs(boundAfter.camTarget.x - boundAfter.objectPos.x) < 0.05 &&
        Math.abs(boundAfter.camTarget.z - boundAfter.objectPos.z) < 0.05,
      `轴心=${JSON.stringify(boundAfter.camTarget)} 物体=${JSON.stringify(boundAfter.objectPos)}`
    )
    /*
     * 机位不动 → 环绕半径必然随距离变化。这是"只看不跟"的固有语义，
     * 明确断言它，避免以后有人"顺手修好"（加回平移跟随）却破坏语义。
     */
    check(
      '环绕半径随物体距离变化（只看不跟的固有语义）',
      Math.abs(orbitRadius(boundAfter) - orbitRadius(boundBefore)) > 0.5,
      `${orbitRadius(boundBefore).toFixed(3)} → ${orbitRadius(boundAfter).toFixed(3)}`
    )
    const followAimDot = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      const store = ${STORE}
      const object = store.getters.objects.find((o) => o.id === ${JSON.stringify(followToggle.objectId ?? '')})
      const e = vm.camera.matrixWorld.elements
      const dir = { x: -e[8], y: -e[9], z: -e[10] }
      const toObject = {
        x: object.position.x - vm.camera.position.x,
        y: object.position.y - vm.camera.position.y,
        z: object.position.z - vm.camera.position.z
      }
      const len = Math.hypot(toObject.x, toObject.y, toObject.z) || 1
      return (dir.x * toObject.x + dir.y * toObject.y + dir.z * toObject.z) / len
    })()`)
    check('视线精确对准物体（方向点积≈1）', followAimDot > 0.999, `点积=${followAimDot.toFixed(5)}`)

    // "跟随目标移动"开关已按要求移除，菜单里不该再出现。
    const followEntryGone = await cdp.evaluate(`(async () => {
      const title = [...document.querySelectorAll('.menubar__title')].find((el) => el.textContent.trim() === '相机')
      if (title) title.click()
      await new Promise((r) => setTimeout(r, 300))
      const entry = [...document.querySelectorAll('.menubar__entry')].find((el) => el.textContent.includes('跟随目标移动'))
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      return entry ? entry.textContent.trim() : null
    })()`)
    check('相机菜单已移除"跟随目标移动"开关', followEntryGone === null, String(followEntryGone))

    // 收尾：解绑
    await cdp.evaluate(`(() => {
      const store = ${STORE}
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, targetObjectId: null } }))
      return true
    })()`)
    await sleep(400)
    await clickMenu(cdp, '相机', '退出相机视角')

    // ===================== 十五、相机平滑轨迹 =====================
    /*
     * 两个实测缺陷的回归护栏：
     * 1. 旧实现用 smoothstep，每个中间关键帧速度归零（相机"停一下"再走）；
     * 2. 旧实现是分段直线，永远拍不出弧线。
     */
    const trajectory = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const cam = (x, z) => ({
        position: { x, y: 2, z },
        target: { x: 0, y: 1, z: 0 },
        fovDegrees: 42,
        aspectWidth: 16,
        aspectHeight: 9
      })
      store.dispatch('editScene', (scene) => ({
        ...scene,
        timeline: {
          ...scene.timeline,
          cameraShots: [
            { id: 't1', name: 't1', timeSeconds: 0, transition: 'cut', camera: cam(0, 0) },
            { id: 't2', name: 't2', timeSeconds: 2, transition: 'smooth', camera: cam(5, 3) },
            { id: 't3', name: 't3', timeSeconds: 4, transition: 'smooth', camera: cam(10, 0) }
          ]
        }
      }))
      await step(400)
      const samples = []
      for (const time of [0, 1, 2, 2.042, 3, 4]) {
        store.commit('setTimelineTime', time)
        await step(140)
        const p = editor.displayedCamera.position
        samples.push({ t: time, x: +p.x.toFixed(3), z: +p.z.toFixed(3) })
      }
      store.commit('setTimelineTime', 0)
      await step(200)
      // 清掉轨迹，避免影响别的断言
      store.dispatch('editScene', (scene) => ({ ...scene, timeline: { ...scene.timeline, cameraShots: [] } }))
      await step(300)
      return { samples }
    })()`)
    const atKey = trajectory.samples.find((s) => Math.abs(s.t - 2) < 1e-9)
    const indexAtKey = trajectory.samples.findIndex((s) => Math.abs(s.t - 2) < 1e-9)
    const afterKey = trajectory.samples[indexAtKey + 1]
    check(
      '平滑轨迹穿过中间关键帧',
      atKey && Math.abs(atKey.x - 5) < 0.05 && Math.abs(atKey.z - 3) < 0.05,
      JSON.stringify(atKey)
    )
    check(
      '中间关键帧之后立刻继续移动（不再停顿）',
      afterKey && Math.abs(afterKey.x - atKey.x) > 0.01,
      `Δx=${afterKey ? (afterKey.x - atKey.x).toFixed(4) : 'n/a'}`
    )
    check(
      '轨迹离开首尾连线（有弧线，不是分段直线）',
      trajectory.samples.filter((s) => s.t > 0 && s.t < 4).every((s) => Math.abs(s.z) > 0.05),
      JSON.stringify(trajectory.samples.map((s) => s.z))
    )

    // ===================== 十六、焦距 =====================
    const focal = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      store.commit('setInspectorTarget', 'camera')
      await new Promise((r) => setTimeout(r, 700))
      const fields = [...document.querySelectorAll('.field')]
      const focalField = fields.find((el) => el.querySelector('.field__label')?.textContent.trim() === '焦距')
      const presetRow = fields.find((el) => el.querySelector('.field__label')?.textContent.trim() === '焦段')
      const focalInput = focalField ? focalField.querySelector('input') : null
      const presetButtons = presetRow ? [...presetRow.querySelectorAll('button')] : []
      const before = focalInput ? Number(focalInput.value) : null
      const longButton = presetButtons.find((b) => b.textContent.trim() === '135')
      if (longButton) longButton.click()
      await new Promise((r) => setTimeout(r, 600))
      const afterTeleFov = store.getters.camera.fovDegrees
      const fifty = presetButtons.find((b) => b.textContent.trim() === '50')
      if (fifty) fifty.click()
      await new Promise((r) => setTimeout(r, 600))
      const afterFiftyFov = store.getters.camera.fovDegrees
      // 还原
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, fovDegrees: 42 } }))
      await new Promise((r) => setTimeout(r, 300))
      return {
        hasFocalField: Boolean(focalField),
        focalValue: before,
        presetCount: presetButtons.length,
        afterTeleFov,
        afterFiftyFov,
        overlay: document.querySelector('.camera-overlay__fov')?.textContent.trim() ?? null
      }
    })()`)
    check('相机面板有焦距输入', focal.hasFocalField === true, JSON.stringify(focal))
    check(
      '默认 42° 视场角换算约 25.6mm',
      Math.abs(focal.focalValue - 25.6) < 1,
      String(focal.focalValue)
    )
    check('提供焦段预设', focal.presetCount >= 5, String(focal.presetCount))
    check('50mm 预设把视场角更新为约 22.3°', Math.abs(focal.afterFiftyFov - 22.3) < 1, String(focal.afterFiftyFov))
    check('135mm 长焦可用（视野范围已放宽）', focal.afterTeleFov < 10, String(focal.afterTeleFov))
    check('视口浮层显示焦距', Boolean(focal.overlay) && focal.overlay.includes('mm'), String(focal.overlay))

    // ===================== 十七、左侧工具栏（Maya 造型 + Q/W/E/R） =====================
    const rail = await cdp.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('.tool-rail .rail-btn')]
      return {
        count: buttons.length,
        svgCount: buttons.filter((b) => b.querySelector('svg')).length,
        // 实心图标用 fill，且至少有 2 档透明度做立体层次
        filledCount: buttons.filter((b) => {
          const shapes = [...b.querySelectorAll('svg [fill-opacity]')]
          return shapes.length > 0
        }).length,
        keyBadges: [...document.querySelectorAll('.tool-rail .rail-btn__key')].map((el) => el.textContent.trim()),
        titles: buttons.map((b) => b.getAttribute('title'))
      }
    })()`)
    check('工具条渲染出全部按钮且都有图标', rail.count >= 14 && rail.svgCount === rail.count, JSON.stringify({ count: rail.count, svg: rail.svgCount }))
    check(
      '图标为实心造型并带明暗层次（Maya 风格立体感）',
      rail.filledCount >= 12,
      `${rail.filledCount}/${rail.count} 个图标含 fill-opacity 层次`
    )
    check(
      'Q/W/E/R 快捷键角标已显示',
      ['Q', 'W', 'E', 'R'].every((k) => rail.keyBadges.includes(k)),
      JSON.stringify(rail.keyBadges)
    )
    check(
      '提示文案含快捷键（对标 Maya）',
      rail.titles.some((t) => t && t.includes('移动（W）')),
      JSON.stringify(rail.titles.slice(0, 4))
    )

    // 快捷键真的切工具：先退相机视角（相机视角下 W 归导航）
    const hotkeys = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      const read = () => ({ tool: store.state.tool, mode: store.state.transformMode })
      const out = { cameraViewActive: store.state.cameraViewActive }
      fire('r'); await step(200); out.afterR = read()
      fire('w'); await step(200); out.afterW = read()
      fire('e'); await step(200); out.afterE = read()
      fire('q'); await step(200); out.afterQ = read()
      // 带修饰键时必须让给浏览器（Ctrl+R 刷新等）
      fire('r')
      await step(150)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }))
      await step(200)
      out.afterCtrlR = read()
      return out
    })()`)
    check('相机视角已退出（W 归还工具快捷键）', hotkeys.cameraViewActive === false, JSON.stringify(hotkeys.cameraViewActive))
    check('R 切到缩放', hotkeys.afterR.mode === 'scale' && hotkeys.afterR.tool === 'select', JSON.stringify(hotkeys.afterR))
    check('W 切到移动', hotkeys.afterW.mode === 'translate', JSON.stringify(hotkeys.afterW))
    check('E 切到旋转', hotkeys.afterE.mode === 'rotate', JSON.stringify(hotkeys.afterE))
    check('Q 切到纯选择（无操纵器）', hotkeys.afterQ.mode === 'select' && hotkeys.afterQ.tool === 'select', JSON.stringify(hotkeys.afterQ))
    check('Ctrl+R 不触发工具切换（让给浏览器）', hotkeys.afterCtrlR.tool === 'select', JSON.stringify(hotkeys.afterCtrlR))

    // 工具条上任何时刻只应有一个激活项（Q 之后"选择"和"旋转"不能同时亮）
    const activeCount = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const fire = (key) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      const count = () => [...document.querySelectorAll('.tool-rail .rail-btn.is-active')].length
      const labels = () => [...document.querySelectorAll('.tool-rail .rail-btn.is-active')].map((el) => el.getAttribute('title'))
      const out = {}
      fire('e'); await step(250); out.rotate = { n: count(), labels: labels() }
      fire('q'); await step(250); out.select = { n: count(), labels: labels() }
      fire('w'); await step(250); out.move = { n: count(), labels: labels() }
      // 恢复默认，避免影响后续
      store.commit('setTransformMode', 'translate')
      return out
    })()`)
    check(
      '工具条任何时刻只有一个激活项（不再双重高亮）',
      activeCount.rotate.n === 1 && activeCount.select.n === 1 && activeCount.move.n === 1,
      JSON.stringify(activeCount)
    )
    check(
      'Q 后高亮的是"选择"而不是"旋转"',
      activeCount.select.labels.some((t) => t && t.includes('选择')),
      JSON.stringify(activeCount.select.labels)
    )

    // 输入框里打字不应触发工具切换
    const inInput = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      store.commit('setTransformMode', 'translate')
      await step(150)
      const input = document.querySelector('.inspector input[type="number"], .inspector input[type="text"]')
      if (!input) return { ok: false }
      input.focus()
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
      await step(250)
      const after = store.state.transformMode
      input.blur()
      return { ok: true, after }
    })()`)
    check(
      '在输入框里按 R 不会切换工具',
      inInput.ok && inInput.after === 'translate',
      JSON.stringify(inInput)
    )

    // ===================== 十八、gizmo 拖拽减速 =====================
    /*
     * 目标：拖拽不要"1:1 那么快"。
     *
     * 测量必须在**受控布置**下做：相机正对物体、X 轴水平投影不被透视缩短。
     * 否则轴向透视缩短会混进比值——斜视角下沿 X 轴拖 1px 可能对应
     * 1.6 倍的世界单位，测出来的"比值"与减速系数根本不是一回事
     * （这一点我第一次就踩了：斜视角下测出 0.836×，误判成减速失效）。
     *
     * 本节结束时已退出相机视角，`applyOrbitPivot` 不再每帧改写相机，
     * 所以下面设置的机位能稳定保持。
     */
    const dampSetup = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const vm = ${VIEWPORT}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const object = store.getters.objects[0]
      store.dispatch('editScene', (scene) => ({
        ...scene,
        objects: scene.objects.map((o) => o.id === object.id
          ? { ...o, position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }
          : o),
        camera: { ...scene.camera, targetObjectId: null, position: { x: 0, y: 1, z: 10 }, target: { x: 0, y: 1, z: 0 } }
      }))
      store.commit('setSelection', [object.id])
      store.commit('setTransformMode', 'translate')
      await step(800)
      vm.applyCameraState(store.getters.camera)
      await step(600)
      const rect = document.querySelector('canvas').getBoundingClientRect()
      const dist = Math.hypot(
        vm.camera.position.x - 0,
        vm.camera.position.y - 1,
        vm.camera.position.z - 0
      )
      return {
        objectId: object.id,
        canvasH: Math.round(rect.height),
        fov: vm.camera.fov,
        dist: +dist.toFixed(4),
        worldPerPx: (2 * Math.tan((vm.camera.fov * Math.PI) / 360) * dist) / rect.height
      }
    })()`)
    console.log('减速测量基准:', JSON.stringify(dampSetup))

    const dampCenter = await cdp.evaluate(`(() => {
      const probe = window.__XBH_DIAGNOSE__
      const store = ${STORE}
      const object = store.getters.objects.find((o) => o.id === ${JSON.stringify(dampSetup.objectId ?? '')})
      const p = probe.project({ x: object.position.x, y: object.position.y, z: object.position.z })
      const rect = document.querySelector('canvas').getBoundingClientRect()
      return { x: Math.round(rect.left + p.x), y: Math.round(rect.top + p.y) }
    })()`)

    let dampHandle = null
    scanDamp: for (let radius = 6; radius <= 150; radius += 5) {
      for (let angle = 0; angle < 360; angle += 10) {
        const rad = (angle * Math.PI) / 180
        const px = Math.round(dampCenter.x + Math.cos(rad) * radius)
        const py = Math.round(dampCenter.y + Math.sin(rad) * radius)
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none', buttons: 0 })
        await sleep(28)
        const axis = await cdp.evaluate(`(() => ${VIEWPORT}.transformControls?.axis ?? null)()`)
        if (axis === 'X') { dampHandle = { x: px, y: py, axis }; break scanDamp }
      }
    }
    check('找到 X 轴手柄（减速测量需要确定的轴向）', Boolean(dampHandle), `轴=${dampHandle?.axis}`)

    if (dampHandle) {
      const dampPosBefore = await cdp.evaluate(`(() => {
        const root = ${VIEWPORT}.rootMap.get(${JSON.stringify(dampSetup.objectId ?? '')})
        return { x: root.position.x, y: root.position.y, z: root.position.z }
      })()`)
      const POINTER_PX = 60
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: dampHandle.x, y: dampHandle.y, button: 'left', buttons: 1, clickCount: 1
      })
      await sleep(90)
      for (let step = 1; step <= 10; step += 1) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved', x: dampHandle.x + (POINTER_PX * step) / 10, y: dampHandle.y, button: 'left', buttons: 1
        })
        await sleep(45)
      }
      await sleep(140)
      const dampPosDuring = await cdp.evaluate(`(() => {
        const root = ${VIEWPORT}.rootMap.get(${JSON.stringify(dampSetup.objectId ?? '')})
        return { x: root.position.x, y: root.position.y, z: root.position.z }
      })()`)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: dampHandle.x + POINTER_PX, y: dampHandle.y, button: 'left', buttons: 0, clickCount: 1
      })
      await sleep(500)
      const dampPosAfter = await cdp.evaluate(`(() => {
        const root = ${VIEWPORT}.rootMap.get(${JSON.stringify(dampSetup.objectId ?? '')})
        return { x: root.position.x, y: root.position.y, z: root.position.z }
      })()`)

      const movedDuring = distance(dampPosDuring, dampPosBefore)
      const expectedNoDamping = dampSetup.worldPerPx * POINTER_PX
      const dampingRatio = movedDuring / expectedNoDamping
      check(
        'gizmo 拖拽已减速到约 0.5×（不再 1:1）',
        dampingRatio > 0.42 && dampingRatio < 0.58,
        `鼠标 ${POINTER_PX}px → 实际 ${movedDuring.toFixed(4)} 世界单位；1:1 应为 ${expectedNoDamping.toFixed(4)}；比值=${dampingRatio.toFixed(3)}×`
      )
      check(
        '松手提交的位置与拖拽中一致（减速不会回弹）',
        distance(dampPosAfter, dampPosDuring) < 0.01,
        `提交差=${distance(dampPosAfter, dampPosDuring).toFixed(5)}`
      )
      check(
        '拖拽一次只产生一次可撤销修改（位置已写入 store）',
        Math.abs(
          (await cdp.evaluate(`(() => ${STORE}.getters.objects.find((o) => o.id === ${JSON.stringify(dampSetup.objectId ?? '')}).position.x)()`)) -
            dampPosAfter.x
        ) < 0.001
      )
    }

    // ===================== 十九、画幅与预演比例 =====================
    /*
     * 两个曾经的真实缺陷：
     *
     * 1. **预演画面被横向拉伸**。预演会隐藏工具栏与侧栏，视口容器从 1244
     *    变宽到 1600；但 `resize()` 只挂在 `window.resize` 上，没有布局监听，
     *    而 canvas 的 CSS 是 `width:100%`、绘制缓冲由 `setSize(w,h,false)`
     *    决定（不改样式）。于是缓冲停在 1244、CSS 盒子 1600，浏览器横向
     *    拉伸 —— 实测 1.2862×，用户看到的就是"画面扁扁的"。
     *    现在用 ResizeObserver 盯容器 + 进出预演时显式补一次。
     *
     * 2. **换画幅时焦距乱变**。`fovDegrees` 是垂直视场角，只改画幅不动它，
     *    同一颗镜头换画幅就变成别的焦段（25.64mm 的镜头选 21:9 会变 19.54mm）。
     *    现在换画幅会在 `Editor.updateCamera` 里按"长边定视野"重算。
     */
    const sizeProbe = `(() => {
      const vm = ${VIEWPORT}
      const canvas = document.querySelector('canvas')
      const size = vm.renderer.getSize(new (vm.camera.position.constructor)())
      return {
        cssW: canvas.clientWidth,
        cssH: canvas.clientHeight,
        bufferW: size.x,
        bufferH: size.y,
        stretched: canvas.clientWidth !== size.x || canvas.clientHeight !== size.y
      }
    })()`

    await cdp.evaluate(`(async () => {
      const store = ${STORE}
      store.dispatch('editScene', (scene) => ({
        ...scene,
        camera: { ...scene.camera, aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 }
      }))
      await new Promise((r) => setTimeout(r, 500))
      return true
    })()`)
    const editCanvasSize = await cdp.evaluate(sizeProbe)
    check('编辑模式下 canvas 缓冲与 CSS 尺寸一致', editCanvasSize.stretched === false, JSON.stringify(editCanvasSize))

    await cdp.evaluate(`(() => { ${STORE}.commit('setPreviewMode', true); return true })()`)
    await sleep(1600)
    const previewCanvasSize = await cdp.evaluate(sizeProbe)
    check(
      '预演模式下 canvas 不再被拉伸（缓冲跟随容器）',
      previewCanvasSize.stretched === false,
      `CSS ${previewCanvasSize.cssW}×${previewCanvasSize.cssH} 缓冲 ${previewCanvasSize.bufferW}×${previewCanvasSize.bufferH}`
    )
    check(
      '预演时容器确实变宽了（修复不是靠尺寸没变侥幸通过）',
      previewCanvasSize.cssW > editCanvasSize.cssW,
      `${editCanvasSize.cssW} → ${previewCanvasSize.cssW}`
    )

    // 预演画面本身像素等比：世界 1 单位横竖各占的像素数必须相等
    const previewSquare = await cdp.evaluate(`(() => {
      const vm = ${VIEWPORT}
      const cam = vm.previewCamera
      const rect = vm.previewRect
      if (!cam || !rect) return null
      const V = vm.camera.position.constructor
      const ndc = (x, y, z) => { const p = new V(x, y, z); p.project(cam); return { x: p.x, y: p.y } }
      const px = (n) => ({ x: rect.left + (n.x * 0.5 + 0.5) * rect.width, y: rect.bottom + (n.y * 0.5 + 0.5) * rect.height })
      const state = vm.cameraState
      const o = { x: state.target.x, y: state.target.y, z: state.target.z }
      const c = px(ndc(o.x, o.y, o.z))
      const ax = px(ndc(o.x + 1, o.y, o.z))
      const ay = px(ndc(o.x, o.y + 1, o.z))
      const perX = Math.hypot(ax.x - c.x, ax.y - c.y)
      const perY = Math.hypot(ay.x - c.x, ay.y - c.y)
      return {
        squareness: +(perX / perY).toFixed(4),
        rectRatio: +(rect.width / rect.height).toFixed(4),
        expectedRatio: +(state.aspectWidth / state.aspectHeight).toFixed(4)
      }
    })()`)
    if (previewSquare) {
      check('预演视口比例等于工程画幅', Math.abs(previewSquare.rectRatio - previewSquare.expectedRatio) < 0.01, JSON.stringify(previewSquare))
    }
    await cdp.evaluate(`(() => { ${STORE}.commit('setPreviewMode', false); return true })()`)
    await sleep(1200)
    const restoredSize = await cdp.evaluate(sizeProbe)
    check('退出预演后 canvas 尺寸仍一致', restoredSize.stretched === false, JSON.stringify(restoredSize))

    // ---- 换画幅保持镜头 ----
    const aspectRows = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 } }))
      await step(500)
      const rows = []
      for (const [w, h, label] of [[16, 9, '16:9'], [21, 9, '21:9'], [9, 16, '9:16'], [239, 100, '2.39:1'], [1, 1, '1:1']]) {
        editor.updateCamera({ aspectWidth: w, aspectHeight: h })
        await step(420)
        const cam = store.getters.camera
        const aspect = cam.aspectWidth / cam.aspectHeight
        const focal = ((35 / Math.max(aspect, 1)) / 2) / Math.tan((cam.fovDegrees * Math.PI) / 360)
        const longFov = (2 * Math.atan((35 / 2) / focal) * 180) / Math.PI
        rows.push({ label, fov: +cam.fovDegrees.toFixed(2), focal: +focal.toFixed(3), longFov: +longFov.toFixed(3) })
      }
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 } }))
      await step(400)
      return rows
    })()`)
    const focalValues = aspectRows.map((row) => row.focal)
    const longFovValues = aspectRows.map((row) => row.longFov)
    check(
      '换画幅时焦距保持不变（同一颗镜头）',
      Math.max(...focalValues) - Math.min(...focalValues) < 0.05,
      `极差=${(Math.max(...focalValues) - Math.min(...focalValues)).toFixed(3)}mm；${aspectRows.map((r) => `${r.label}=${r.focal}`).join(', ')}`
    )
    check(
      '换画幅时长边视野保持不变（长边定视野模型）',
      Math.max(...longFovValues) - Math.min(...longFovValues) < 0.05,
      `极差=${(Math.max(...longFovValues) - Math.min(...longFovValues)).toFixed(3)}°`
    )
    check(
      '宽画幅让垂直视场角变小（画面更宽而不是被拉扁）',
      aspectRows.find((r) => r.label === '21:9').fov < 42,
      String(aspectRows.find((r) => r.label === '21:9').fov)
    )
    check(
      '竖画幅让垂直视场角变大',
      aspectRows.find((r) => r.label === '9:16').fov > 42,
      String(aspectRows.find((r) => r.label === '9:16').fov)
    )

    // ---- 画幅预设按钮 ----
    const aspectPresetUi = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      store.commit('setInspectorTarget', 'camera')
      await new Promise((r) => setTimeout(r, 900))
      const section = [...document.querySelectorAll('.panel__section')].find(
        (el) => el.querySelector('.section-title')?.textContent.trim() === '画幅'
      )
      if (!section) return { ok: false }
      const buttons = [...section.querySelectorAll('button')]
      const labels = buttons.map((b) => b.textContent.trim())
      const wide = buttons.find((b) => b.textContent.trim() === '21:9')
      if (wide) wide.click()
      await new Promise((r) => setTimeout(r, 700))
      const cam = store.getters.camera
      const result = { aspect: cam.aspectWidth + ':' + cam.aspectHeight, fov: +cam.fovDegrees.toFixed(2) }
      store.dispatch('editScene', (scene) => ({ ...scene, camera: { ...scene.camera, aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 } }))
      await new Promise((r) => setTimeout(r, 400))
      return { ok: true, labels, result }
    })()`)
    check('画幅预设提供 21:9', aspectPresetUi.ok && aspectPresetUi.labels.includes('21:9'), JSON.stringify(aspectPresetUi.labels))
    check('画幅预设提供 16:9 与 9:16', aspectPresetUi.ok && aspectPresetUi.labels.includes('16:9') && aspectPresetUi.labels.includes('9:16'), JSON.stringify(aspectPresetUi.labels))
    check(
      '点 21:9 预设后画幅与视场角一起变',
      aspectPresetUi.ok && aspectPresetUi.result.aspect === '21:9' && aspectPresetUi.result.fov < 40,
      JSON.stringify(aspectPresetUi.result)
    )

    // ---- 镜头轨随画幅同步换算 ----
    const shotRemap = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const cam = (x) => ({ position: { x, y: 2, z: 5 }, target: { x: 0, y: 1, z: 0 }, fovDegrees: 42 })
      store.dispatch('editScene', (scene) => ({
        ...scene,
        camera: { ...scene.camera, aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 },
        timeline: { ...scene.timeline, cameraShots: [
          { id: 'a', name: 'a', timeSeconds: 0, transition: 'cut', camera: cam(0) },
          { id: 'b', name: 'b', timeSeconds: 3, transition: 'smooth', camera: cam(5) }
        ] }
      }))
      await step(600)
      const before = store.getters.timeline.cameraShots.map((s) => +s.camera.fovDegrees.toFixed(2))
      editor.updateCamera({ aspectWidth: 21, aspectHeight: 9 })
      await step(700)
      const after = store.getters.timeline.cameraShots.map((s) => +s.camera.fovDegrees.toFixed(2))
      const aspect = store.getters.timeline.cameraShots.map((s) => s.camera.aspectWidth + ':' + s.camera.aspectHeight)
      store.dispatch('editScene', (scene) => ({
        ...scene,
        timeline: { ...scene.timeline, cameraShots: [] },
        camera: { ...scene.camera, aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 }
      }))
      await step(400)
      return { before, after, aspect }
    })()`)
    check(
      '换画幅时镜头轨视场角同步换算（编辑与成片一致）',
      shotRemap.before.every((v) => Math.abs(v - 42) < 0.01) && shotRemap.after.every((v) => v < 40),
      `before=${JSON.stringify(shotRemap.before)} after=${JSON.stringify(shotRemap.after)}`
    )
    check('镜头轨也记录了新画幅', shotRemap.aspect.every((a) => a === '21:9'), JSON.stringify(shotRemap.aspect))

    // ===================== 二十、快捷键设置 =====================
    /*
     * 可配置快捷键的回归护栏。重点在**按住类动作**（相机飞行）：
     * 改成注册表驱动最容易出的问题是"按住不放的键在 keyup 时清不掉"，
     * 相机会一直往前飞。
     */
    check('从菜单打开快捷键设置', (await clickMenu(cdp, '帮助', '键盘快捷键')) === 'ok')
    const shortcutPanel = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.dialog')
      if (!dialog) return { open: false }
      const rows = [...dialog.querySelectorAll('.shortcut-row')]
      return {
        open: true,
        rowCount: rows.length,
        labels: rows.map((r) => r.querySelector('.shortcut-row__label')?.textContent.trim()),
        keys: rows.map((r) => r.querySelector('.shortcut-key')?.textContent.trim()),
        groups: [...dialog.querySelectorAll('.section-title')].map((el) => el.textContent.trim()),
        presets: [...dialog.querySelectorAll('.panel__section .btn-grid .btn')].map((b) => b.textContent.trim())
      }
    })()`)
    check('快捷键面板已打开', shortcutPanel.open === true, JSON.stringify(shortcutPanel.open))
    check('列出全部可配置动作', shortcutPanel.rowCount === 15, String(shortcutPanel.rowCount))
    check(
      '面板按"工具 / 相机飞行 / 通用"分组',
      ['工具', '相机飞行', '通用'].every((g) => shortcutPanel.groups.includes(g)),
      JSON.stringify(shortcutPanel.groups)
    )
    check(
      '预设提供 本应用默认 / Maya / Blender',
      ['本应用默认', 'Maya', 'Blender'].every((p) => shortcutPanel.presets.includes(p)),
      JSON.stringify(shortcutPanel.presets)
    )
    check(
      '默认显示 Q/W/E/R',
      ['Q', 'W', 'E', 'R'].every((k) => shortcutPanel.keys.includes(k)),
      JSON.stringify(shortcutPanel.keys.slice(0, 4))
    )

    // ---- 录制改键 ----
    const recorded = await cdp.evaluate(`(async () => {
      const dialog = document.querySelector('.dialog')
      const row = [...dialog.querySelectorAll('.shortcut-row')].find(
        (r) => r.querySelector('.shortcut-row__label')?.textContent.trim() === '移动工具'
      )
      row.querySelector('.shortcut-key').click()
      await new Promise((r) => setTimeout(r, 250))
      return {
        recording: Boolean(dialog.querySelector('.shortcut-row.is-recording')),
        hint: dialog.querySelector('.shortcut-recording')?.textContent.trim() ?? null
      }
    })()`)
    check('点击按键格子进入录制态', recorded.recording === true, JSON.stringify(recorded))
    check('录制态提示按 Esc 可取消', Boolean(recorded.hint) && recorded.hint.includes('Esc'), String(recorded.hint))

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't' })
    await sleep(80)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't' })
    await sleep(250)
    const afterRecord = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.dialog')
      const row = [...dialog.querySelectorAll('.shortcut-row')].find(
        (r) => r.querySelector('.shortcut-row__label')?.textContent.trim() === '移动工具'
      )
      return { key: row.querySelector('.shortcut-key').textContent.trim(), binding: ${STORE}.state.keybindings['tool.translate'] }
    })()`)
    check('录制把移动工具改成了 T', afterRecord.binding === 't' && afterRecord.key === 'T', JSON.stringify(afterRecord))

    // 关闭面板验证改键真的生效、旧键真的失效
    await cdp.evaluate(`(() => { ${STORE}.commit('setShortcutDialogOpen', false); return true })()`)
    await sleep(400)
    await cdp.evaluate(`(() => { ${STORE}.commit('setTransformMode', 'translate'); return true })()`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 't' })
    await sleep(60)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 't' })
    await sleep(200)
    const withT = await cdp.evaluate(`(() => ${STORE}.state.transformMode)()`)
    await cdp.evaluate(`(() => { ${STORE}.commit('setTransformMode', 'rotate'); return true })()`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' })
    await sleep(60)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' })
    await sleep(200)
    const withW = await cdp.evaluate(`(() => ${STORE}.state.transformMode)()`)
    check('新键 T 生效（切到移动）', withT === 'translate', String(withT))
    check('旧键 W 不再切工具（起点 rotate 仍为 rotate）', withW === 'rotate', String(withW))
    await cdp.evaluate(`(() => { ${STORE}.commit('resetKeybindings'); return true })()`)
    await sleep(300)

    // ---- 预设 ----
    const presetBindings = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      const pick = (label) => {
        const dialog = document.querySelector('.dialog')
        const btn = [...dialog.querySelectorAll('.panel__section .btn-grid .btn')].find(
          (b) => b.textContent.trim() === label
        )
        if (btn) btn.click()
      }
      store.commit('setShortcutDialogOpen', true)
      await step(400)
      pick('Maya'); await step(400)
      const maya = { ...store.state.keybindings }
      pick('Blender'); await step(400)
      const blender = { ...store.state.keybindings }
      store.commit('setShortcutDialogOpen', false)
      await step(300)
      return { maya, blender }
    })()`)
    const mayaTools = ['tool.select', 'tool.translate', 'tool.rotate', 'tool.scale'].map((id) => presetBindings.maya[id])
    const blenderTools = ['tool.select', 'tool.translate', 'tool.rotate', 'tool.scale'].map((id) => presetBindings.blender[id])
    check('Maya 预设：Q/W/E/R 是选择/移动/旋转/缩放', JSON.stringify(mayaTools) === JSON.stringify(['q', 'w', 'e', 'r']), JSON.stringify(mayaTools))
    check('Maya 预设：播放是 Alt+V', presetBindings.maya['timeline.play'] === 'alt+v', String(presetBindings.maya['timeline.play']))
    check('Blender 预设：W/G/R/S 是选择/移动/旋转/缩放', JSON.stringify(blenderTools) === JSON.stringify(['w', 'g', 'r', 's']), JSON.stringify(blenderTools))
    check('Blender 预设：播放是空格', presetBindings.blender['timeline.play'] === 'space', String(presetBindings.blender['timeline.play']))
    check(
      '相机飞行键三套预设一致（Maya 与 Blender 的飞行也是 WASD）',
      ['nav.forward', 'nav.backward', 'nav.left', 'nav.right', 'nav.up', 'nav.down', 'nav.boost'].every(
        (id) => presetBindings.maya[id] === presetBindings.blender[id]
      ),
      JSON.stringify(['nav.forward', 'nav.backward', 'nav.up', 'nav.down'].map((id) => presetBindings.blender[id]))
    )

    // Blender 预设下真的用 G 移动
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'g' })
    await sleep(60)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'g' })
    await sleep(220)
    const blenderG = await cdp.evaluate(`(() => ${STORE}.state.transformMode)()`)
    check('Blender 预设下 G 切到移动', blenderG === 'translate', String(blenderG))
    await cdp.evaluate(`(() => { ${STORE}.commit('applyKeybindingPreset', 'default'); return true })()`)
    await sleep(300)

    // ---- 冲突提示 ----
    const conflictUi = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const step = (ms) => new Promise((r) => setTimeout(r, ms))
      store.commit('setShortcutDialogOpen', true)
      await step(400)
      const cleanCount = document.querySelectorAll('.dialog .field-hint--warn').length
      // 把"缩放工具"也绑到 W：与"移动工具"同 scope，应判冲突
      store.commit('setKeybinding', { actionId: 'tool.scale', binding: 'w' })
      await step(500)
      const warn = document.querySelector('.dialog .field-hint--warn')
      const marked = document.querySelectorAll('.dialog .shortcut-key.is-conflict').length
      store.commit('resetKeybindings')
      await step(400)
      return { cleanCount, text: warn ? warn.textContent.trim() : null, marked }
    })()`)
    check('默认绑定无冲突提示（W 跨 scope 是合法的）', conflictUi.cleanCount === 0, String(conflictUi.cleanCount))
    check('同 scope 撞键会被提示', Boolean(conflictUi.text) && conflictUi.text.includes('冲突'), String(conflictUi.text))
    check('冲突的按键格子被标出', conflictUi.marked >= 2, String(conflictUi.marked))
    await cdp.evaluate(`(() => { ${STORE}.commit('setShortcutDialogOpen', false); return true })()`)
    await sleep(300)

    // ---- 持久化 ----
    const persist = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      store.commit('setKeybinding', { actionId: 'tool.select', binding: 'z' })
      await new Promise((r) => setTimeout(r, 400))
      const raw = window.localStorage.getItem('xiaobaihe-keybindings')
      store.commit('restoreKeybindings', { 'tool.select': 'hyper+z', bogus: 'q' })
      await new Promise((r) => setTimeout(r, 300))
      const sanitized = {
        select: store.state.keybindings['tool.select'],
        hasBogus: 'bogus' in store.state.keybindings,
        count: Object.keys(store.state.keybindings).length
      }
      store.commit('resetKeybindings')
      await new Promise((r) => setTimeout(r, 300))
      return { raw, sanitized }
    })()`)
    check('绑定写入 localStorage', Boolean(persist.raw) && persist.raw.includes('"tool.select":"z"'), String(persist.raw).slice(0, 60))
    check(
      '非法存储被清洗并补齐缺失动作',
      persist.sanitized.select === 'q' && persist.sanitized.hasBogus === false && persist.sanitized.count === 15,
      JSON.stringify(persist.sanitized)
    )

    // ---- 按住类动作：改绑后仍能飞、松手能停 ----
    await clickMenu(cdp, '相机', '进入相机视角')
    await clickMenu(cdp, '相机', '导航：WASD 飞行')
    await sleep(400)
    const flyBefore = await cdp.evaluate(`(() => { const vm = ${VIEWPORT}; return { x: vm.camera.position.x, z: vm.camera.position.z } })()`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' })
    await sleep(800)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' })
    await sleep(250)
    const flyAfter = await cdp.evaluate(`(() => { const vm = ${VIEWPORT}; return { x: vm.camera.position.x, z: vm.camera.position.z } })()`)
    check(
      '默认 W 仍能飞行（改绑机制没破坏原有行为）',
      Math.hypot(flyAfter.x - flyBefore.x, flyAfter.z - flyBefore.z) > 0.2,
      `位移=${Math.hypot(flyAfter.x - flyBefore.x, flyAfter.z - flyBefore.z).toFixed(3)}`
    )

    await cdp.evaluate(`(() => { ${STORE}.commit('setKeybinding', { actionId: 'nav.forward', binding: 'i' }); return true })()`)
    await sleep(300)
    const rebindBefore = await cdp.evaluate(`(() => { const vm = ${VIEWPORT}; return { x: vm.camera.position.x, z: vm.camera.position.z } })()`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w' })
    await sleep(700)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w' })
    await sleep(250)
    const afterOldKey = await cdp.evaluate(`(() => { const vm = ${VIEWPORT}; return { x: vm.camera.position.x, z: vm.camera.position.z } })()`)
    check(
      '改绑后旧键 W 不再飞行',
      Math.hypot(afterOldKey.x - rebindBefore.x, afterOldKey.z - rebindBefore.z) < 0.05,
      `位移=${Math.hypot(afterOldKey.x - rebindBefore.x, afterOldKey.z - rebindBefore.z).toFixed(4)}`
    )

    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'i' })
    await sleep(800)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'i' })
    await sleep(250)
    const afterNewKey = await cdp.evaluate(`(() => { const vm = ${VIEWPORT}; return { x: vm.camera.position.x, z: vm.camera.position.z } })()`)
    check(
      '改绑后的新键 I 能飞行',
      Math.hypot(afterNewKey.x - rebindBefore.x, afterNewKey.z - rebindBefore.z) > 0.2,
      `位移=${Math.hypot(afterNewKey.x - rebindBefore.x, afterNewKey.z - rebindBefore.z).toFixed(3)}`
    )
    // 按住类动作最容易出的问题：松手还在飞
    await sleep(700)
    const settled = await cdp.evaluate(`(() => { const vm = ${VIEWPORT}; return { x: vm.camera.position.x, z: vm.camera.position.z } })()`)
    check(
      '松开新键后相机停下（不会一直飞）',
      Math.hypot(settled.x - afterNewKey.x, settled.z - afterNewKey.z) < 0.05,
      `松手后位移=${Math.hypot(settled.x - afterNewKey.x, settled.z - afterNewKey.z).toFixed(4)}`
    )

    await cdp.evaluate(`(() => { ${STORE}.commit('resetKeybindings'); return true })()`)
    await sleep(300)
    await clickMenu(cdp, '相机', '退出相机视角')
    await sleep(300)

    // ---- Esc 不参与配置 ----
    const escBinding = await cdp.evaluate(`(() => {
      const values = Object.values(${STORE}.state.keybindings)
      return { hasEscape: values.includes('escape'), count: values.length }
    })()`)
    check('Esc 不在可配置绑定里（它是全局取消键）', escBinding.hasEscape === false, JSON.stringify(escBinding))

    // ===================== 二十一、全景图背景 =====================
    /*
     * 全景图当天空盒：任何机位都像"站在那张图里"。
     *
     * 关键不变量：
     * - 工程里**只存文件名引用**（几 MB 的图塞进 JSON 会让每次保存都重传）；
     * - `mapping` 必须是等距圆柱（303），否则会被当平面贴图铺在背景上；
     * - `colorSpace` 必须是 sRGB，否则整张图偏暗发灰；
     * - 换了背景必须进指纹（否则关窗口就丢）；
     * - 存盘重开后要还在（`openProject` 曾把 background 漏掉）。
     */
    const panoPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

    const panoApplied = await cdp.evaluate(`(async () => {
      const editor = document.querySelector('.editor').__vue__
      const bytes = Uint8Array.from(atob(${JSON.stringify(panoPng)}), (c) => c.charCodeAt(0))
      const file = new File([bytes], '全景测试.png', { type: 'image/png' })
      await editor.uploadPanorama(file)
      /*
       * 必须「轮询等纹理真的挂上」，不能固定 sleep：
       * 纹理要经过 HTTP 取图 + 解码，实测抖到 1.2s 左右，
       * 写死 1200ms 会偶发读到还没挂上的状态（曾经因此假失败）。
       */
      const vm0 = ${VIEWPORT}
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const bg = vm0.scene.background
        if (bg && bg.isTexture && bg.image && bg.image.width > 0) break
        await new Promise((r) => setTimeout(r, 100))
      }
      const store = ${STORE}
      const vm = ${VIEWPORT}
      const bg = vm.scene.background
      return {
        fileName: store.state.history.present.background.panoramaFileName,
        sourceName: store.state.history.present.background.panoramaSourceName,
        dirty: store.getters.isDirty,
        isTexture: Boolean(bg && bg.isTexture),
        isEquirect: Boolean(bg && bg.mapping === 303),
        colorSpace: bg ? bg.colorSpace : null,
        environmentSet: Boolean(vm.scene.environment)
      }
    })()`)
    check(
      '上传全景图后工程里只记文件名（不是 base64）',
      /\.png$/i.test(panoApplied.fileName || '') && !String(panoApplied.fileName).startsWith('data:'),
      String(panoApplied.fileName)
    )
    check('保留了原始文件名用于显示', panoApplied.sourceName === '全景测试.png', String(panoApplied.sourceName))
    check('应用背景被判成"有未保存修改"', panoApplied.dirty === true, String(panoApplied.dirty))
    check(
      'scene.background 是等距圆柱纹理（不是平面贴图）',
      panoApplied.isTexture && panoApplied.isEquirect,
      JSON.stringify(panoApplied)
    )
    check('色彩空间声明为 sRGB', panoApplied.colorSpace === 'srgb', String(panoApplied.colorSpace))
    check('默认不参与环境光照', panoApplied.environmentSet === false, String(panoApplied.environmentSet))

    const panoParams = await cdp.evaluate(`(async () => {
      const editor = document.querySelector('.editor').__vue__
      const vm = ${VIEWPORT}
      editor.updateBackground({ rotateDegrees: 90, intensity: 1.6, affectsLighting: true })
      await new Promise((r) => setTimeout(r, 800))
      return {
        rotateY: +(vm.scene.backgroundRotation.y * 180 / Math.PI).toFixed(2),
        intensity: vm.scene.backgroundIntensity,
        envIsBackground: vm.scene.environment === vm.scene.background
      }
    })()`)
    check('水平旋转生效', Math.abs(panoParams.rotateY - 90) < 1, String(panoParams.rotateY))
    check('背景亮度生效', Math.abs(panoParams.intensity - 1.6) < 0.01, String(panoParams.intensity))
    check('开启后全景图同时作为环境光照', panoParams.envIsBackground === true, JSON.stringify(panoParams))

    const panoDrop = await cdp.evaluate(`(async () => {
      const root = document.querySelector('.viewport')
      const bytes = Uint8Array.from(atob(${JSON.stringify(panoPng)}), (c) => c.charCodeAt(0))
      const file = new File([bytes], '拖进来的全景.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
      root.dispatchEvent(over)
      // Vue 的 DOM 更新是异步的，等两帧再读 class
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const highlighted = root.classList.contains('is-panorama-drop')
      root.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
      await new Promise((r) => setTimeout(r, 1400))
      return {
        overPrevented: over.defaultPrevented,
        highlighted,
        stillHighlighted: root.classList.contains('is-panorama-drop'),
        sourceName: ${STORE}.state.history.present.background.panoramaSourceName
      }
    })()`)
    check('拖到视口上有高亮提示', panoDrop.highlighted === true, String(panoDrop.highlighted))
    check('拖拽被接管（阻止浏览器"打开图片"）', panoDrop.overPrevented === true, String(panoDrop.overPrevented))
    check('松手后提示消失', panoDrop.stillHighlighted === false, String(panoDrop.stillHighlighted))
    check('拖进来的图被应用为背景', panoDrop.sourceName === '拖进来的全景.png', String(panoDrop.sourceName))

    const panoPersist = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const saved = await store.dispatch('saveProject', {})
      const projectId = saved.projectId || store.state.projectId
      const doc = await fetch('/api/projects/' + projectId, { credentials: 'include' }).then((r) => r.json())
      const background = doc.document ? doc.document.scene.background : doc.scene.background
      await store.dispatch('openProject', projectId)
      await new Promise((r) => setTimeout(r, 1600))
      const vm = ${VIEWPORT}
      return {
        projectId,
        savedFileName: background ? background.panoramaFileName : null,
        reopenedFileName: store.state.history.present.background.panoramaFileName,
        reopenedHasBackground: Boolean(vm.scene.background),
        reopenedIsEquirect: Boolean(vm.scene.background && vm.scene.background.mapping === 303)
      }
    })()`)
    check(
      '存盘文档里带上了背景（只有文件名，无图片数据）',
      /\.png$/i.test(panoPersist.savedFileName || '') && !String(panoPersist.savedFileName).startsWith('data:'),
      String(panoPersist.savedFileName)
    )
    check(
      '重新打开工程后背景配置还在',
      /\.png$/i.test(panoPersist.reopenedFileName || ''),
      String(panoPersist.reopenedFileName)
    )
    check(
      '重新打开后天空盒重新加载出来了',
      panoPersist.reopenedHasBackground === true && panoPersist.reopenedIsEquirect === true,
      JSON.stringify({ bg: panoPersist.reopenedHasBackground, equirect: panoPersist.reopenedIsEquirect })
    )

    const panoRemoved = await cdp.evaluate(`(async () => {
      const editor = document.querySelector('.editor').__vue__
      const vm = ${VIEWPORT}
      editor.removePanorama()
      await new Promise((r) => setTimeout(r, 900))
      return {
        fileName: ${STORE}.state.history.present.background.panoramaFileName,
        hasBackground: Boolean(vm.scene.background),
        hasEnvironment: Boolean(vm.scene.environment)
      }
    })()`)
    check('移除后工程里文件名清空', panoRemoved.fileName === '', JSON.stringify(panoRemoved.fileName))
    check(
      '移除后天空盒与环境光照都清空',
      panoRemoved.hasBackground === false && panoRemoved.hasEnvironment === false,
      JSON.stringify(panoRemoved)
    )

    // ===================== 二十二、人台比例 =====================
    /*
     * 人台曾经有三处比例问题，且都只在"看画面"时才暴露：
     *
     * 1. 根节点按 `size` 三分量缩放，而 `size` 存的是 `{x:1, y:身高, z:1}`
     *    → 人物被竖直拉伸 1.75 倍（又细又长）；
     * 2. 控制骨架实际包围盒是 0.9883 高、脚底 -0.5475，而外观按 1.0 / -0.5
     *    归一化 → 关节手柄比画出来的身体低 13% 身高（≈24cm），脚底陷地 8cm；
     * 3. 骨架比例按"教科书 7.5 头身"，而随附 GLB 是 6 头身 → 肩/头又偏高 5%。
     *
     * 现在骨架比例按 GLB 的**实测**骨骼位置定，这里做端到端校验。
     */
    const mannequin = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      editor.addMannequin()
      /*
       * 必须等外观 GLB 真的挂上再量，不能只 sleep：
       * GLB 有 7.3MB，没加载完时包围盒只有控制骨架（宽/高 ≈ 0.29），
       * 会让"身材不是细长条"这条断言假失败。
       */
      const vmWait = ${VIEWPORT}
      const deadline = Date.now() + 20000
      let root0 = null
      while (Date.now() < deadline) {
        const object0 = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
        root0 = object0 ? vmWait.rootMap.get(object0.id) : null
        if (root0 && root0.userData.mannequinVisual) break
        await new Promise((r) => setTimeout(r, 200))
      }
      await new Promise((r) => setTimeout(r, 400))
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      const vm = ${VIEWPORT}
      const root = vm.rootMap.get(object.id)
      const visual = root.userData.mannequinVisual
      root.updateMatrixWorld(true)

      // 包围盒（自己算，避免依赖 THREE 模块作用域）
      const min = { x: Infinity, y: Infinity, z: Infinity }
      const max = { x: -Infinity, y: -Infinity, z: -Infinity }
      const stack = [root]
      while (stack.length) {
        const node = stack.pop()
        for (const c of node.children) stack.push(c)
        if (!node.isMesh || !node.geometry) continue
        node.geometry.computeBoundingBox()
        const bb = node.geometry.boundingBox
        if (!bb) continue
        const m = node.matrixWorld.elements
        for (const xs of [bb.min.x, bb.max.x])
          for (const ys of [bb.min.y, bb.max.y])
            for (const zs of [bb.min.z, bb.max.z]) {
              const wx = m[0]*xs + m[4]*ys + m[8]*zs + m[12]
              const wy = m[1]*xs + m[5]*ys + m[9]*zs + m[13]
              const wz = m[2]*xs + m[6]*ys + m[10]*zs + m[14]
              min.x = Math.min(min.x, wx); max.x = Math.max(max.x, wx)
              min.y = Math.min(min.y, wy); max.y = Math.max(max.y, wy)
              min.z = Math.min(min.z, wz); max.z = Math.max(max.z, wz)
            }
      }
      const height = max.y - min.y
      const scratch = root.position.clone()
      const at = (id) => {
        root.userData.mannequinJoints.get(id).getWorldPosition(scratch)
        return +(((scratch.y - min.y) / height).toFixed(3))
      }
      const boneAt = (name) => {
        const bone = visual?.bones?.get(name)
        if (!bone) return null
        bone.getWorldPosition(scratch)
        return +(((scratch.y - min.y) / height).toFixed(3))
      }
      return {
        size: { ...object.size },
        scale: { x: root.scale.x, y: root.scale.y, z: root.scale.z },
        footY: +min.y.toFixed(4),
        headY: +max.y.toFixed(4),
        height: +height.toFixed(4),
        width: +(max.x - min.x).toFixed(3),
        depth: +(max.z - min.z).toFixed(3),
        visualLoaded: Boolean(visual),
        rig: {
          knee: at('leftKnee'),
          hip: at('leftHip'),
          spine: at('spine'),
          shoulder: at('leftShoulder'),
          elbow: at('leftElbow'),
          head: at('head')
        },
        bones: {
          calf: boneAt('calf_l'),
          thigh: boneAt('thigh_l'),
          spine: boneAt('spine_01'),
          upperarm: boneAt('upperarm_l'),
          lowerarm: boneAt('lowerarm_l'),
          head: boneAt('Head')
        }
      }
    })()`)

    check(
      '人台根节点是等比缩放（以前竖直拉伸 1.75 倍）',
      Math.abs(mannequin.scale.x - mannequin.scale.y) < 1e-6 &&
        Math.abs(mannequin.scale.z - mannequin.scale.y) < 1e-6,
      JSON.stringify(mannequin.scale)
    )
    check(
      'size 三个分量相等（否则会被拉伸）',
      Math.abs(mannequin.size.x - mannequin.size.y) < 1e-6 &&
        Math.abs(mannequin.size.z - mannequin.size.y) < 1e-6,
      JSON.stringify(mannequin.size)
    )
    check('脚底正好落在世界 y=0（不陷地也不悬空）', Math.abs(mannequin.footY) < 0.002, String(mannequin.footY))
    check(
      '头顶高度等于设定身高（1.75）',
      Math.abs(mannequin.headY - mannequin.size.y) < 0.002,
      `${mannequin.headY} vs ${mannequin.size.y}`
    )
    check(
      '身材不是细长条：宽度/高度在合理范围',
      /*
       * 这条必须在外观挂上之后量，否则包围盒只有控制骨架（宽/高≈0.29）会假失败。
       * 摆好姿势的人体约 0.55（臂在体侧），T-pose 约 1.06（臂展开），
       * 所以 0.5~1.2 这个带宽同时容纳两种状态，但排除"竖直拉伸"。
       */
      mannequin.visualLoaded === true &&
        mannequin.width / mannequin.height > 0.5 &&
        mannequin.width / mannequin.height < 1.2,
      `visual=${mannequin.visualLoaded} w=${mannequin.width} h=${mannequin.height} ratio=${(mannequin.width / mannequin.height).toFixed(2)}`
    )
    check(
      '关节高度落在人体标准位置（髋≈0.49 肩≈0.77 膝≈0.28）',
      Math.abs(mannequin.rig.hip - 0.49) < 0.02 &&
        Math.abs(mannequin.rig.shoulder - 0.769) < 0.02 &&
        Math.abs(mannequin.rig.knee - 0.284) < 0.02,
      JSON.stringify(mannequin.rig)
    )

    // 最关键的一条：控制手柄必须和**画出来的人体**对齐，否则拖关节会拖错部位。
    if (mannequin.visualLoaded) {
      const pairs = [
        ['膝', mannequin.rig.knee, mannequin.bones.calf],
        ['髋', mannequin.rig.hip, mannequin.bones.thigh],
        ['脊柱', mannequin.rig.spine, mannequin.bones.spine],
        ['肩', mannequin.rig.shoulder, mannequin.bones.upperarm],
        ['肘', mannequin.rig.elbow, mannequin.bones.lowerarm],
        ['头', mannequin.rig.head, mannequin.bones.head]
      ]
      const worst = pairs.reduce(
        (acc, [label, rigY, boneY]) => {
          if (boneY === null) return acc
          const diff = Math.abs(rigY - boneY)
          return diff > acc.diff ? { label, diff, rigY, boneY } : acc
        },
        { label: '', diff: 0 }
      )
      check(
        '关节手柄与外观骨骼对齐（偏差 <2% 身高）',
        worst.diff < 0.02,
        `${worst.label}: 控制 ${worst.rigY} vs 外观 ${worst.boneY}，偏差 ${(worst.diff * 100).toFixed(1)}%`
      )
    }

    // 改身高也只能等比缩放
    const resized = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      const feetBefore = object.position.y - object.size.y / 2
      editor.updateMannequinHeight({ id: object.id, heightMeters: 1.9 })
      await new Promise((r) => setTimeout(r, 1200))
      const after = store.state.history.present.objects.find((o) => o.id === object.id)
      const vm = ${VIEWPORT}
      const root = vm.rootMap.get(object.id)
      return {
        size: { ...after.size },
        scale: { x: root.scale.x, y: root.scale.y, z: root.scale.z },
        feetBefore: +feetBefore.toFixed(4),
        feetAfter: +(after.position.y - after.size.y / 2).toFixed(4)
      }
    })()`)
    check(
      '改身高后仍是等比缩放',
      Math.abs(resized.scale.x - resized.scale.y) < 1e-6 && Math.abs(resized.scale.z - resized.scale.y) < 1e-6,
      JSON.stringify(resized.scale)
    )
    check(
      '改身高时脚底高度不变',
      Math.abs(resized.feetAfter - resized.feetBefore) < 0.002,
      `${resized.feetBefore} → ${resized.feetAfter}`
    )

    // ===================== 二十三、导入模型持久化 =====================
    /*
     * 以前导入的模型只活在内存 Map 里：重新打开工程就只剩一个占位方块。
     * 现在工程里只存**文件引用**（主文件 + 全部依赖资源），几何体靠
     * "按引用下载 → 重新 importStaticModel"恢复。这里用一个最小 glTF
     * （一个三角形 + 外部 .bin）走完整条真实路径：
     *
     *   editor.handleModelFiles → 上传 exports → 存盘 → **刷新页面**
     *   → 重新打开工程 → 断言三角面数真的 > 0
     *
     * 必须刷新页面：`importedModels` / `importedLoads` 都是组件内存状态，
     * 不刷新的话"重新打开工程"会命中本次导入的缓存，恢复逻辑根本不会执行，
     * 测试会假通过。
     */
    const miniPositions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
    const miniIndices = new Uint16Array([0, 1, 2])
    const miniBin = Buffer.concat([
      Buffer.from(miniPositions.buffer, miniPositions.byteOffset, miniPositions.byteLength),
      Buffer.from(miniIndices.buffer, miniIndices.byteOffset, miniIndices.byteLength)
    ])
    const miniGltf = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'triangle', mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      buffers: [{ uri: 'mini-mesh.bin', byteLength: miniBin.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
        { buffer: 0, byteOffset: 36, byteLength: 6, target: 34963 }
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          min: [0, 0, 0],
          max: [1, 1, 0]
        },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }
      ]
    }
    const miniGltfText = JSON.stringify(miniGltf)
    const miniBinBase64 = miniBin.toString('base64')

    /*
     * 页面内统计一棵 three.js 子树的面数。
     *
     * 场景探针只给出"有哪些物体"，不提供面数；而"恢复了没有"这件事
     * 只能用真实几何体证明——占位方块的 children 也是 1。
     */
    const TRIANGLE_COUNT = `((root) => {
      let total = 0
      root.traverse((child) => {
        if (!child.isMesh || !child.geometry) return
        const geometry = child.geometry
        const count = geometry.index
          ? geometry.index.count
          : (geometry.getAttribute('position') || { count: 0 }).count
        total += Math.floor((count || 0) / 3)
      })
      return total
    })`

    const importPath = await cdp.evaluate(`(async () => {
      const editor = document.querySelector('.editor').__vue__
      const store = ${STORE}
      const bin = Uint8Array.from(atob(${JSON.stringify(miniBinBase64)}), (c) => c.charCodeAt(0))
      const files = [
        new File([${JSON.stringify(miniGltfText)}], 'mini.gltf', { type: 'model/gltf+json' }),
        new File([bin], 'mini-mesh.bin', { type: 'application/octet-stream' })
      ]
      await editor.handleModelFiles({ target: { files, value: '' } })
      await new Promise((r) => setTimeout(r, 3000))
      const object = store.state.history.present.objects.filter((item) => item.kind === 'imported').pop()
      const vm = ${VIEWPORT}
      const root = object ? vm.rootMap.get(object.id) : null
      const asset = object ? object.importedAsset : null
      const mainFileName = asset && asset.files ? asset.files.main.fileName : null
      const mainResponse = mainFileName
        ? await fetch('/api/exports/' + encodeURIComponent(mainFileName), { credentials: 'include' })
        : null
      return {
        id: object ? object.id : null,
        format: asset ? asset.format : null,
        reportTriangles: asset && asset.report ? asset.report.triangleCount : 0,
        mainFileName,
        resourceNames: asset && asset.files ? asset.files.resources.map((item) => item.name) : [],
        resourceFileNames: asset && asset.files ? asset.files.resources.map((item) => item.fileName) : [],
        hasInlineData: Boolean(asset && (asset.primaryData || asset.resources)),
        mainRetrievable: Boolean(mainResponse && mainResponse.ok),
        triangles: root ? (${TRIANGLE_COUNT})(root) : 0,
        children: root ? root.children.length : 0,
        // 占位方块本身有 12 个三角面，所以"面数 > 0"证明不了模型加载出来了。
        placeholderOnly: Boolean(
          root &&
            root.children.length === 1 &&
            root.children[0].geometry &&
            root.children[0].geometry.type === 'BoxGeometry'
        ),
        dirty: store.getters.isDirty
      }
    })()`)
    check(
      '导入后工程里记下了主文件引用',
      /\.gltf$/i.test(importPath.mainFileName || ''),
      String(importPath.mainFileName)
    )
    check(
      '依赖 .bin 也记了引用（name 保原始名 / fileName 用服务端名）',
      importPath.resourceNames.includes('mini-mesh.bin') &&
        importPath.resourceFileNames.length === 1 &&
        /\.bin$/i.test(importPath.resourceFileNames[0] || ''),
      JSON.stringify({ names: importPath.resourceNames, files: importPath.resourceFileNames })
    )
    check('工程里不存模型 base64（只存文件名引用）', importPath.hasInlineData === false)
    check('主文件能从 /api/exports 取回（同源、带 cookie）', importPath.mainRetrievable === true)
    check(
      '导入后立刻看到真实几何体（占位方块已被替换）',
      importPath.triangles > 0 &&
        importPath.triangles === importPath.reportTriangles &&
        importPath.placeholderOnly === false,
      `triangles=${importPath.triangles} report=${importPath.reportTriangles} placeholderOnly=${importPath.placeholderOnly}`
    )
    check('导入被判成"有未保存修改"', importPath.dirty === true, String(importPath.dirty))

    const importSaved = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      await store.dispatch('saveProject', {})
      const projectId = store.state.projectId
      const payload = await fetch('/api/projects/' + encodeURIComponent(projectId), {
        credentials: 'include'
      }).then((r) => r.json())
      const documentData = payload.document || payload
      const stored = documentData.scene.objects.filter((item) => item.kind === 'imported').pop()
      const asset = stored ? stored.importedAsset : null
      return {
        projectId,
        schemaVersion: documentData.schemaVersion,
        mainFileName: asset && asset.files ? asset.files.main.fileName : null,
        resourceCount: asset && asset.files ? asset.files.resources.length : -1,
        hasInlineData: Boolean(asset && (asset.primaryData || asset.resources))
      }
    })()`)
    check('存盘文档的 schema 版本为 19', importSaved.schemaVersion === 19, String(importSaved.schemaVersion))
    check(
      '存盘后模型文件引用仍在（主文件 + 依赖）',
      /\.gltf$/i.test(importSaved.mainFileName || '') && importSaved.resourceCount === 1,
      JSON.stringify(importSaved)
    )
    check('存盘文档里没有模型 base64', importSaved.hasInlineData === false)

    /*
     * 刷新页面：把所有内存缓存（`importedModels` / `importedLoads` /
     * Editor 的 `importedModels`）全部清掉，模拟"关掉再打开"。
     */
    await cdp.send('Page.navigate', { url: `${BASE_URL}/editor` })
    await waitFor(cdp, 'Boolean(document.querySelector(".editor"))', { label: '编辑器（刷新后）' })
    await sleep(2200)
    const recoveryAfterReload = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.dialog')
      if (!dialog) return 'none'
      const discard = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '放弃')
      if (discard) { discard.click(); return 'discarded' }
      return 'other'
    })()`)
    console.log(`   [环境] 刷新后恢复对话框: ${recoveryAfterReload}`)
    await sleep(700)

    const importRestored = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const projectId = ${JSON.stringify(importSaved.projectId)}
      // 产品里"重新打开工程"就是这条 action；此时内存里已经没有任何模型缓存。
      await store.dispatch('openProject', projectId)
      const vm = ${VIEWPORT}
      const cachedBefore = vm.importedModels.size
      const deadline = Date.now() + 20000
      let object = null
      let root = null
      let triangles = 0
      let reportTriangles = 0
      let placeholderOnly = true
      while (Date.now() < deadline) {
        object = store.state.history.present.objects.filter((item) => item.kind === 'imported').pop()
        root = object && vm.rootMap ? vm.rootMap.get(object.id) : null
        triangles = root ? (${TRIANGLE_COUNT})(root) : 0
        reportTriangles =
          object && object.importedAsset && object.importedAsset.report
            ? object.importedAsset.report.triangleCount
            : 0
        placeholderOnly = Boolean(
          root &&
            root.children.length === 1 &&
            root.children[0].geometry &&
            root.children[0].geometry.type === 'BoxGeometry'
        )
        // 占位方块也有 12 个面，所以必须等到"面数等于报告值且不再是占位方块"。
        if (reportTriangles > 0 && triangles === reportTriangles && !placeholderOnly) break
        await new Promise((r) => setTimeout(r, 300))
      }
      const asset = object ? object.importedAsset : null
      const requests = performance.getEntriesByType('resource').map((entry) => entry.name)
      const mainFileName = ${JSON.stringify(importSaved.mainFileName)}
      return {
        found: Boolean(object),
        id: object ? object.id : null,
        triangles,
        children: root ? root.children.length : 0,
        reportTriangles,
        placeholderOnly,
        filesRestored: Boolean(asset && asset.files),
        cachedBefore,
        downloadedMain: requests.some(
          (name) => name.indexOf('/api/exports/') >= 0 && name.indexOf(mainFileName) >= 0
        ),
        warnings: window.__XBH_DIAGNOSE__.entries()
          .filter((entry) => entry.source === 'imported-model')
          .map((entry) => entry.message)
      }
    })()`)
    check('刷新后模型缓存确实是空的（否则下面测不出恢复）', importRestored.cachedBefore === 0, String(importRestored.cachedBefore))
    check('重新打开工程后导入物体还在', importRestored.found === true)
    check(
      '模型几何体真的恢复了（占位方块已被替换）',
      importRestored.triangles > 0 && importRestored.placeholderOnly === false,
      `triangles=${importRestored.triangles} placeholderOnly=${importRestored.placeholderOnly}`
    )
    check(
      '恢复的是真实网格：面数等于导入时记录的面数',
      importRestored.triangles === importRestored.reportTriangles && importRestored.children > 0,
      JSON.stringify({
        triangles: importRestored.triangles,
        report: importRestored.reportTriangles,
        children: importRestored.children
      })
    )
    check(
      '恢复时确实按引用下载了主文件（不是靠内存缓存）',
      importRestored.downloadedMain === true,
      String(importRestored.downloadedMain)
    )
    check(
      '恢复过程没有记录警告（没有 404 / 解析失败）',
      importRestored.warnings.length === 0,
      importRestored.warnings.join(' | ')
    )

    /*
     * 向后兼容：v17 及更早的工程里 `importedAsset` 只有 format / sourceName / report，
     * 没有文件引用。这种工程必须能照常打开——占位方块留着，但不许报错。
     */
    const legacyImported = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const vm = ${VIEWPORT}
      const scene = store.state.history.present
      const imported = scene.objects.filter((item) => item.kind === 'imported').pop()
      if (!imported) return { skipped: true }
      const legacy = JSON.parse(JSON.stringify(imported))
      legacy.id = 'legacy-imported'
      delete legacy.importedAsset.files
      store.commit('resetScene', {
        objects: [legacy],
        camera: scene.camera,
        lighting: scene.lighting,
        timeline: scene.timeline,
        background: scene.background
      })
      await new Promise((r) => setTimeout(r, 1500))
      const root = vm.rootMap.get('legacy-imported')
      return {
        skipped: false,
        hasRoot: Boolean(root),
        children: root ? root.children.length : 0,
        triangles: root ? (${TRIANGLE_COUNT})(root) : 0,
        placeholderOnly: Boolean(
          root &&
            root.children.length === 1 &&
            root.children[0].geometry &&
            root.children[0].geometry.type === 'BoxGeometry'
        ),
        hasFiles: Boolean(legacy.importedAsset.files),
        warnings: window.__XBH_DIAGNOSE__.entries()
          .filter((entry) => entry.source === 'imported-model')
          .map((entry) => entry.message)
      }
    })()`)
    check(
      '老工程（没有文件引用）照常打开、只显示占位方块',
      legacyImported.skipped === false &&
        legacyImported.hasRoot === true &&
        legacyImported.placeholderOnly === true &&
        legacyImported.hasFiles === false,
      JSON.stringify(legacyImported)
    )

    // ===================== 二十四、姿势参数面板 =====================
    /*
     * Live2D / VTube 那种"一条参数一根滑块"的关节参数面板。
     *
     * 光看 store 里的数字变化不算通过——这类功能最容易出的问题是
     * **"数据变了但画面没动"**，所以这里必须量到：
     * - 控制骨架关节的实际旋转（three 的 joint.rotation）；
     * - 外观 GLB 骨骼的实际朝向（手动覆盖是否真的盖过了动作预设）。
     *
     * 注意：上一节结束时工程里是"老工程 + 导入物体"，没有人台，
     * 所以这里先新建一个并确保它被选中（面板只在选中人台时渲染）。
     */
      const posePanel = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      editor.addMannequin()
      /*
       * 等外观 GLB 挂上再做（下面要量 GLB 骨骼四元数，没挂上就是 null）。
       * 固定 sleep 会偶发太早——7.3MB 的模型加载时间有抖动。
       */
      const vmWait = ${VIEWPORT}
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const candidate = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
        const candidateRoot = candidate ? vmWait.rootMap.get(candidate.id) : null
        if (candidateRoot && candidateRoot.userData.mannequinVisual) break
        await new Promise((r) => setTimeout(r, 200))
      }
      await new Promise((r) => setTimeout(r, 400))

      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      if (!object) return { error: '没有新建出人台' }
      const vm = ${VIEWPORT}
      const root = vm.rootMap.get(object.id)
      const joints = root.userData.mannequinJoints
      const visual = root.userData.mannequinVisual

      const deg = (rad) => +((rad * 180) / Math.PI).toFixed(2)
      const rigRotation = (id) => ({
        x: deg(joints.get(id).rotation.x),
        y: deg(joints.get(id).rotation.y),
        z: deg(joints.get(id).rotation.z)
      })
      // 外观骨骼的世界朝向——用来确认"手动覆盖真的生效了"（骨架变了不算）
      const boneQuat = (name) => {
        const bone = visual?.bones?.get(name)
        if (!bone) return null
        bone.updateWorldMatrix(true, false)
        const q = bone.matrixWorld.decompose
          ? (() => {
              const p = root.position.clone()
              const s = root.scale.clone()
              const out = bone.quaternion.clone()
              bone.matrixWorld.decompose(p, out, s)
              return out
            })()
          : bone.quaternion.clone()
        return [q.x, q.y, q.z, q.w].map((v) => +v.toFixed(5))
      }

      const panel = document.querySelector('.pose-panel')
      const sliders = panel ? [...panel.querySelectorAll('.pose-axis__range')] : []
      const disabled = panel ? [...panel.querySelectorAll('.pose-axis__range:disabled')] : []

      const before = {
        rigHead: rigRotation('head'),
        manualJoints: [
          ...(store.state.history.present.objects.find((o) => o.id === object.id).mannequin.manualJoints ?? [])
        ],
        boneHead: boneQuat('Head')
      }

      // 走界面真实路径：找到"头部"那一行的 Y 轴滑块，派发 input 事件
      const headPanel = panel
        ? [...panel.querySelectorAll('.pose-joint')].find((j) =>
            j.querySelector('.pose-joint__label')?.textContent.includes('头部')
          )
        : null
      const headYSlider = headPanel
        ? [...headPanel.querySelectorAll('.pose-axis')]
            .find((a) => a.querySelector('.pose-axis__name').textContent.trim() === 'Y')
            ?.querySelector('input')
        : null
      if (headYSlider) {
        headYSlider.value = '35'
        headYSlider.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await new Promise((r) => setTimeout(r, 1000))

      const afterHead = store.state.history.present.objects.find((o) => o.id === object.id).mannequin
      const mid = {
        rigHead: rigRotation('head'),
        poseHead: { ...afterHead.pose.head },
        manualJoints: [...(afterHead.manualJoints ?? [])],
        boneHead: boneQuat('Head'),
        dirty: store.getters.isDirty
      }

      // 肘是单向关节（0~145）：传入负值必须被夹住
      editor.updateJointAngle({ id: object.id, jointId: 'leftElbow', axis: 'x', value: -50 })
      await new Promise((r) => setTimeout(r, 700))
      const clamped = store.state.history.present.objects.find((o) => o.id === object.id).mannequin.pose
        .leftElbow

      // 只改一个轴，另外两轴不能被清零
      editor.updateJointAngle({ id: object.id, jointId: 'leftElbow', axis: 'y', value: 10 })
      await new Promise((r) => setTimeout(r, 700))
      const twoAxes = store.state.history.present.objects.find((o) => o.id === object.id).mannequin.pose
        .leftElbow

      editor.resetMannequinPose({ id: object.id })
      await new Promise((r) => setTimeout(r, 1000))
      const afterReset = store.state.history.present.objects.find((o) => o.id === object.id).mannequin

      return {
        panelRendered: Boolean(panel),
        sliderCount: sliders.length,
        disabledCount: disabled.length,
        jointCount: panel ? panel.querySelectorAll('.pose-joint').length : 0,
        groupCount: panel ? panel.querySelectorAll('.pose-group').length : 0,
        hadSlider: Boolean(headYSlider),
        before,
        mid,
        clamped,
        twoAxes,
        afterReset: {
          poseHead: { ...afterReset.pose.head },
          manualJoints: [...(afterReset.manualJoints ?? [])],
          rigHead: rigRotation('head')
        }
      }
    })()`)

    if (posePanel.error) throw new Error(posePanel.error)

    check('姿势面板已渲染', posePanel.panelRendered === true, String(posePanel.panelRendered))
    check(
      '每个关节三根滑块（10 关节 = 30 根）',
      posePanel.sliderCount === 30 && posePanel.jointCount === 10,
      `sliders=${posePanel.sliderCount} joints=${posePanel.jointCount}`
    )
    check('关节按身体部位分组', posePanel.groupCount >= 2, String(posePanel.groupCount))
    check(
      '限位上下界相同的轴被禁用（膝盖 Y/Z 是 [0,0]，拖不动就别给可拖的滑块）',
      posePanel.disabledCount > 0,
      String(posePanel.disabledCount)
    )
    check('找到了头部 Y 轴滑块（走界面真实路径而非直接调方法）', posePanel.hadSlider === true, String(posePanel.hadSlider))
    check(
      '拖滑块后工程里的角度变了',
      Math.abs(posePanel.mid.poseHead.y - 35) < 0.01,
      JSON.stringify(posePanel.mid.poseHead)
    )
    check(
      '画面真的跟着动：控制骨架头部旋转到位',
      Math.abs(posePanel.mid.rigHead.y - 35) < 1,
      `前 ${JSON.stringify(posePanel.before.rigHead)} → 后 ${JSON.stringify(posePanel.mid.rigHead)}`
    )
    check(
      '该关节被记进 manualJoints（否则会被动作预设盖住）',
      posePanel.mid.manualJoints.includes('head'),
      JSON.stringify(posePanel.mid.manualJoints)
    )
    check(
      '外观 GLB 的头部骨骼朝向真的被手动覆盖改变了',
      posePanel.mid.boneHead !== null &&
        JSON.stringify(posePanel.before.boneHead) !== JSON.stringify(posePanel.mid.boneHead),
      `前 ${JSON.stringify(posePanel.before.boneHead)} → 后 ${JSON.stringify(posePanel.mid.boneHead)}`
    )
    check('改姿势被判成"有未保存修改"', posePanel.mid.dirty === true, String(posePanel.mid.dirty))
    check(
      '越界被限位夹住（肘 -50 → 0）',
      Math.abs(posePanel.clamped.x) < 0.01,
      JSON.stringify(posePanel.clamped)
    )
    check(
      '改一个轴不会把另外两轴清零',
      Math.abs(posePanel.twoAxes.x) < 0.01 && Math.abs(posePanel.twoAxes.y - 10) < 0.01,
      JSON.stringify(posePanel.twoAxes)
    )
    check(
      '重置全部：姿势回预设、手动覆盖清空、骨架复位',
      Math.abs(posePanel.afterReset.poseHead.y) < 0.01 &&
        posePanel.afterReset.manualJoints.length === 0 &&
        Math.abs(posePanel.afterReset.rigHead.y) < 0.01,
      JSON.stringify(posePanel.afterReset)
    )

    // ===================== 二十五、姿势库 =====================
    /*
     * 保存 / 命名 / 切换自定义姿势（schema 19）。
     *
     * 走**界面真实路径**：内联输入框 + 按钮，不用 window.prompt——
     * prompt 是浏览器原生模态，脚本驱动不了，用户也没法边看画面边想名字。
     *
     * 覆盖链条：保存 → 出现在列表 → 应用（presetId 必须置 null，否则外观层
     * 拿动作预设盖住它）→ 存盘 → **刷新页面** → 重开工程后库还在 → 更新 / 删除。
     * 必须刷新：`poseLibrary` 虽然存在工程里，但刷新才能证明它是"存盘数据"
     * 而不是内存里的残留。
     */
    const poseLibrary = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__

      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      if (!object) return { error: '没有可用的人台' }
      editor.handleSelection([object.id])
      await sleep(700)

      const panel = document.querySelector('.pose-panel')
      if (!panel) return { error: '姿势面板没有渲染' }
      const input = panel.querySelector('.pose-library__input')
      const saveButton = panel.querySelector('.pose-library__save-btn')

      // 摆一个可辨认的姿势：头 Y=30、左前臂 X=40（都走滑块的真实事件）
      const setJoint = (label, axisLabel, value) => {
        const row = [...panel.querySelectorAll('.pose-joint')].find((j) =>
          j.querySelector('.pose-joint__label')?.textContent.includes(label)
        )
        const slider = row
          ? [...row.querySelectorAll('.pose-axis')]
              .find((a) => a.querySelector('.pose-axis__name').textContent.trim() === axisLabel)
              ?.querySelector('input')
          : null
        if (!slider) return false
        slider.value = String(value)
        slider.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      }
      const usedHead = setJoint('头部', 'Y', 30)
      await sleep(500)
      const usedElbow = setJoint('左前臂', 'X', 40)
      await sleep(800)

      const libraryBefore = (store.state.history.present.poseLibrary ?? []).length
      const dirtyBefore = store.getters.isDirty
      const hadEmptyHint = Boolean(panel.querySelector('.pose-library__empty'))

      input.value = '抱臂姿势'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(250)
      saveButton.click()
      await sleep(800)

      const scene = store.state.history.present
      const entries = scene.poseLibrary ?? []
      const savedEntry = entries[entries.length - 1]
      const savedObject = scene.objects.find((o) => o.id === object.id)
      const rows = [...panel.querySelectorAll('.pose-library__entry')]
      return {
        usedHead,
        usedElbow,
        libraryBefore,
        dirtyBefore,
        hadEmptyHint,
        hasInput: Boolean(input),
        hasSaveButton: Boolean(saveButton),
        count: entries.length,
        name: savedEntry?.name,
        entryId: savedEntry?.id,
        headY: savedEntry?.pose?.head?.y,
        elbowX: savedEntry?.pose?.leftElbow?.x,
        jointCount: savedEntry ? Object.keys(savedEntry.pose).length : 0,
        createdAtValid: Boolean(savedEntry && !Number.isNaN(new Date(savedEntry.createdAt).getTime())),
        inputCleared: panel.querySelector('.pose-library__input').value === '',
        rowCount: rows.length,
        rowNames: rows.map((r) => r.querySelector('.pose-library__entry-name').textContent.trim()),
        emptyHintGone: !panel.querySelector('.pose-library__empty'),
        dirtyAfter: store.getters.isDirty,
        objectHeadY: savedObject?.mannequin?.pose?.head?.y
      }
    })()`)

    if (poseLibrary.error) throw new Error(poseLibrary.error)

    check('姿势库的保存入口是内联输入框 + 按钮（不是 window.prompt）', poseLibrary.hasInput === true && poseLibrary.hasSaveButton === true)
    check('保存前库是空的并显示空态提示', poseLibrary.libraryBefore === 0 && poseLibrary.hadEmptyHint === true, `before=${poseLibrary.libraryBefore}`)
    check('走界面滑块真的改了关节角度（头 Y=30 / 左肘 X=40）', poseLibrary.usedHead === true && poseLibrary.usedElbow === true)
    check(
      '保存后库里出现一条命名条目，姿势是完整关节表',
      poseLibrary.count === 1 &&
        poseLibrary.name === '抱臂姿势' &&
        poseLibrary.jointCount === 10 &&
        poseLibrary.headY === 30 &&
        poseLibrary.elbowX === 40,
      JSON.stringify({ count: poseLibrary.count, name: poseLibrary.name, joints: poseLibrary.jointCount, head: poseLibrary.headY, elbow: poseLibrary.elbowX })
    )
    check('条目带 id 与可解析的 createdAt', Boolean(poseLibrary.entryId) && poseLibrary.createdAtValid === true)
    check(
      '列表里出现该条目、空态提示消失',
      poseLibrary.rowCount === 1 && poseLibrary.rowNames[0] === '抱臂姿势' && poseLibrary.emptyHintGone === true,
      JSON.stringify(poseLibrary.rowNames)
    )
    check('保存后输入框被清空（下一次保存不会误用旧名字）', poseLibrary.inputCleared === true)
    check('保存姿势被判成"有未保存修改"', poseLibrary.dirtyBefore === true && poseLibrary.dirtyAfter === true)

    /*
     * 应用：先把姿势改坏，再点「应用」，必须回到保存时那一套；
     * 同时校验 presetId 被置 null、manualJoints 填满 10 个关节，
     * 以及**控制骨架真的跟着转**（数据对了画面没动是这类功能的经典坑）。
     */
    const poseLibraryApply = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const vm = ${VIEWPORT}
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      const root = vm.rootMap.get(object.id)
      const joints = root.userData.mannequinJoints
      const deg = (rad) => +((rad * 180) / Math.PI).toFixed(2)

      const entryBefore = JSON.parse(JSON.stringify(store.state.history.present.poseLibrary[0]))
      // 先把头扭到另一个方向，证明"应用"确实把它改回来了
      editor.updateJointAngle({ id: object.id, jointId: 'head', axis: 'y', value: -25 })
      await sleep(700)
      const brokenHeadY = store.state.history.present.objects.find((o) => o.id === object.id).mannequin.pose.head.y
      const entryAfterEdit = store.state.history.present.poseLibrary[0]

      const panel = document.querySelector('.pose-panel')
      panel.querySelector('.pose-library__apply').click()
      await sleep(900)

      const applied = store.state.history.present.objects.find((o) => o.id === object.id).mannequin
      return {
        brokenHeadY,
        entryUnchangedByEditing: entryAfterEdit.pose.head.y === entryBefore.pose.head.y,
        presetId: applied.presetId,
        manualCount: (applied.manualJoints ?? []).length,
        headY: applied.pose.head.y,
        elbowX: applied.pose.leftElbow.x,
        rigHeadY: deg(joints.get('head').rotation.y),
        // 面板上的「手动」标记必须整排亮起（manualJoints 填满的证据）
        manualBadges: [...panel.querySelectorAll('.pose-joint__overridden.is-on')].length,
        presetSelectShowsCustom: (() => {
          const select = document.querySelector('.pose-panel')?.parentElement?.querySelector('select')
          return select ? select.value : null
        })()
      }
    })()`)

    check(
      '应用前先改坏姿势（头 Y=-25），确认后面是真的被改回来',
      Math.abs(poseLibraryApply.brokenHeadY + 25) < 0.01,
      String(poseLibraryApply.brokenHeadY)
    )
    check(
      '库条目是快照：拖滑块不会改坏库里存的姿势',
      poseLibraryApply.entryUnchangedByEditing === true
    )
    check(
      '应用库姿势：姿势回到保存时那一套',
      Math.abs(poseLibraryApply.headY - 30) < 0.01 && Math.abs(poseLibraryApply.elbowX - 40) < 0.01,
      JSON.stringify({ head: poseLibraryApply.headY, elbow: poseLibraryApply.elbowX })
    )
    check(
      '应用库姿势后 presetId 置 null（否则外观层会用动作预设盖住它）',
      poseLibraryApply.presetId === null,
      String(poseLibraryApply.presetId)
    )
    check(
      '应用库姿势后 manualJoints 填满全部 10 个关节（面板标记才准确）',
      poseLibraryApply.manualCount === 10 && poseLibraryApply.manualBadges === 10,
      `manual=${poseLibraryApply.manualCount} badges=${poseLibraryApply.manualBadges}`
    )
    check(
      '画面真的跟着动：控制骨架头部旋转到位',
      Math.abs(poseLibraryApply.rigHeadY - 30) < 1,
      String(poseLibraryApply.rigHeadY)
    )

    // 存盘：姿势库必须真的进工程文件（schema 19）
    const poseLibrarySaved = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      await store.dispatch('saveProject', {})
      const projectId = store.state.projectId
      const payload = await fetch('/api/projects/' + encodeURIComponent(projectId), {
        credentials: 'include'
      }).then((r) => r.json())
      const documentData = payload.document || payload
      const library = documentData.scene.poseLibrary ?? []
      return {
        projectId,
        schemaVersion: documentData.schemaVersion,
        count: library.length,
        name: library[0]?.name,
        headY: library[0]?.pose?.head?.y,
        jointCount: library[0] ? Object.keys(library[0].pose).length : 0,
        dirty: store.getters.isDirty
      }
    })()`)
    check('存盘文档 schema 版本为 19（姿势库）', poseLibrarySaved.schemaVersion === 19, String(poseLibrarySaved.schemaVersion))
    check(
      '姿势库随工程存盘（名字 + 完整关节表）',
      poseLibrarySaved.count === 1 &&
        poseLibrarySaved.name === '抱臂姿势' &&
        poseLibrarySaved.jointCount === 10 &&
        Math.abs(poseLibrarySaved.headY - 30) < 0.01,
      JSON.stringify(poseLibrarySaved)
    )
    check('存盘后不再是"有未保存修改"', poseLibrarySaved.dirty === false, String(poseLibrarySaved.dirty))

    // 刷新页面：清掉所有内存状态，证明库是从工程文件读回来的
    await cdp.send('Page.navigate', { url: `${BASE_URL}/editor` })
    await waitFor(cdp, 'Boolean(document.querySelector(".editor"))', { label: '编辑器（刷新后·姿势库）' })
    await sleep(2200)
    const recoveryAfterReloadPose = await cdp.evaluate(`(() => {
      const dialog = document.querySelector('.dialog')
      if (!dialog) return 'none'
      const discard = [...dialog.querySelectorAll('button')].find((b) => b.textContent.trim() === '放弃')
      if (discard) { discard.click(); return 'discarded' }
      return 'other'
    })()`)
    console.log(`   [环境] 刷新后恢复对话框: ${recoveryAfterReloadPose}`)
    await sleep(700)

    const poseLibraryReloaded = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      await store.dispatch('openProject', ${JSON.stringify(poseLibrarySaved.projectId)})
      await sleep(1500)
      const scene = store.state.history.present
      const library = scene.poseLibrary ?? []
      const object = scene.objects.filter((o) => o.kind === 'mannequin').pop()
      if (object) editor.handleSelection([object.id])
      await sleep(800)
      const panel = document.querySelector('.pose-panel')
      const rows = panel ? [...panel.querySelectorAll('.pose-library__entry')] : []
      return {
        count: library.length,
        name: library[0]?.name,
        headY: library[0]?.pose?.head?.y,
        jointCount: library[0] ? Object.keys(library[0].pose).length : 0,
        rowCount: rows.length,
        rowNames: rows.map((r) => r.querySelector('.pose-library__entry-name').textContent.trim()),
        selected: Boolean(object)
      }
    })()`)
    check(
      '刷新页面 + 重开工程后姿势库还在（来自工程文件，不是内存残留）',
      poseLibraryReloaded.count === 1 &&
        poseLibraryReloaded.name === '抱臂姿势' &&
        poseLibraryReloaded.jointCount === 10 &&
        Math.abs(poseLibraryReloaded.headY - 30) < 0.01,
      JSON.stringify(poseLibraryReloaded)
    )
    check(
      '重开工程后列表里也能看到它',
      poseLibraryReloaded.selected === true &&
        poseLibraryReloaded.rowCount === 1 &&
        poseLibraryReloaded.rowNames[0] === '抱臂姿势',
      JSON.stringify({ selected: poseLibraryReloaded.selected, rows: poseLibraryReloaded.rowNames })
    )

    /*
     * 更新 / 删除 / 命名边界：空名给默认名、超长截断、重名允许（按 id 区分）。
     * 这些"确定行为"必须固定下来，否则以后改净化规则会静默改变用户数据。
     */
    const poseLibraryMaintenance = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      editor.handleSelection([object.id])
      await sleep(600)

      const inputNow = () => document.querySelector('.pose-library__input')
      const rowsNow = () => [...document.querySelectorAll('.pose-library__entry')]
      const typeName = async (name) => {
        const input = inputNow()
        input.value = name
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(200)
      }
      const clickSave = async () => {
        document.querySelector('.pose-library__save-btn').click()
        await sleep(700)
      }

      const entryId = store.state.history.present.poseLibrary[0].id
      const nameBefore = store.state.history.present.poseLibrary[0].name

      // 「更新为当前」：改姿势后覆盖这一条（id 与名字不变）
      editor.updateJointAngle({ id: object.id, jointId: 'head', axis: 'y', value: 15 })
      await sleep(700)
      rowsNow()[0].querySelector('.pose-library__update').click()
      await sleep(800)
      const updated = store.state.history.present.poseLibrary[0]

      // 空名 → 「姿势 N」
      await typeName('')
      await clickSave()
      const namesAfterEmpty = store.state.history.present.poseLibrary.map((e) => e.name)

      // 超长名 → 截断到 24
      await typeName('超'.repeat(50))
      await clickSave()
      const afterLong = store.state.history.present.poseLibrary
      const longEntry = afterLong[afterLong.length - 1]

      // 重名允许：再存一条同名
      await typeName(longEntry.name)
      await clickSave()
      const afterDuplicate = store.state.history.present.poseLibrary
      const duplicateIds = afterDuplicate.map((e) => e.id)

      // 删除第一条
      rowsNow()[0].querySelector('.pose-library__delete').click()
      await sleep(800)
      const afterDelete = store.state.history.present.poseLibrary

      return {
        entryId,
        nameBefore,
        updatedIdSame: updated.id === entryId,
        updatedNameSame: updated.name === nameBefore,
        updatedHeadY: updated.pose.head.y,
        namesAfterEmpty,
        longName: longEntry.name,
        longNameLength: longEntry.name.length,
        duplicateCount: afterDuplicate.length,
        duplicateUniqueIds: new Set(duplicateIds).size === duplicateIds.length,
        duplicateNames: afterDuplicate.map((e) => e.name),
        afterDeleteCount: afterDelete.length,
        deletedGone: !afterDelete.some((e) => e.id === entryId),
        rowCountAfterDelete: rowsNow().length,
        dirtyAfterAll: store.getters.isDirty
      }
    })()`)

    check(
      '「更新为当前」覆盖同一条（id / 名字不变，姿势变新）',
      poseLibraryMaintenance.updatedIdSame === true &&
        poseLibraryMaintenance.updatedNameSame === true &&
        Math.abs(poseLibraryMaintenance.updatedHeadY - 15) < 0.01,
      JSON.stringify({
        id: poseLibraryMaintenance.updatedIdSame,
        name: poseLibraryMaintenance.updatedNameSame,
        head: poseLibraryMaintenance.updatedHeadY
      })
    )
    check(
      '空名保存自动编号为「姿势 N」',
      poseLibraryMaintenance.namesAfterEmpty.includes('姿势 1'),
      JSON.stringify(poseLibraryMaintenance.namesAfterEmpty)
    )
    check(
      '超长名截断到 24 个字符',
      poseLibraryMaintenance.longNameLength === 24,
      `${poseLibraryMaintenance.longNameLength} / ${poseLibraryMaintenance.longName}`
    )
    check(
      '重名允许且各自独立（按 id 区分，不会互相覆盖）',
      poseLibraryMaintenance.duplicateCount === 4 &&
        poseLibraryMaintenance.duplicateUniqueIds === true &&
        poseLibraryMaintenance.duplicateNames.filter((n) => n === poseLibraryMaintenance.longName).length === 2,
      JSON.stringify(poseLibraryMaintenance.duplicateNames)
    )
    check(
      '删除生效：条目从工程与列表里一起消失',
      poseLibraryMaintenance.deletedGone === true &&
        poseLibraryMaintenance.afterDeleteCount === 3 &&
        poseLibraryMaintenance.rowCountAfterDelete === 3,
      JSON.stringify({
        gone: poseLibraryMaintenance.deletedGone,
        store: poseLibraryMaintenance.afterDeleteCount,
        rows: poseLibraryMaintenance.rowCountAfterDelete
      })
    )
    check('改姿势库被判成"有未保存修改"', poseLibraryMaintenance.dirtyAfterAll === true)

    // ===================== 二十六、镜像 / 对称 =====================
    /*
     * 一键左右对称。
     *
     * **只断言"数字变了"不算通过**：镜像最容易错的地方是符号（y/z 取反）、
     * 以及忘了左右骨骼局部系本身是镜像的。所以这里直接量左右关节的
     * 世界坐标（换算到人台根节点局部空间），必须满足
     *
     *     left.x ≈ -right.x   且   left.y ≈ right.y  且   left.z ≈ right.z
     *
     * 容差 1e-3（人台骨架是"全身高 = 1"的单位模型，乘上 1.75 身高后
     * 约等于 1.75mm）：浮点三角函数误差在 1e-15 量级，1e-3 已经足够严。
     *
     * 注意躯干：`spine` 绕 Y/Z 扭转时整具身体**本来就不该**是世界坐标镜像的
     * （中轴关节被刻意排除在镜像之外）。所以量几何之前先把 spine 的 Y/Z 归零，
     * 而"不动 head/spine"单独用数值断言。
     */
    const mirror = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const vm = ${VIEWPORT}
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      editor.handleSelection([object.id])
      await sleep(600)
      editor.resetMannequinPose({ id: object.id })
      await sleep(600)

      // 摆一个"左右明显不同"的姿势：左侧四肢都带 Y/Z 分量（这样符号错了立刻暴露）
      const set = async (jointId, value) => {
        for (const axis of ['x', 'y', 'z']) {
          editor.updateJointAngle({ id: object.id, jointId, axis, value: value[axis] })
          await sleep(120)
        }
      }
      await set('leftShoulder', { x: 30, y: 20, z: -35 })
      await set('leftElbow', { x: 50, y: 10, z: 5 })
      await set('leftHip', { x: -20, y: 15, z: -10 })
      await set('leftKnee', { x: 40, y: 0, z: 0 })
      // 躯干与头也被扭过：镜像不许动它们
      await set('spine', { x: 12, y: 8, z: -4 })
      await set('head', { x: 5, y: 25, z: 3 })
      await sleep(700)

      const poseBefore = JSON.parse(JSON.stringify(store.state.history.present.objects.find((o) => o.id === object.id).mannequin.pose))
      const presetIdBefore = store.state.history.present.objects.find((o) => o.id === object.id).mannequin.presetId
      const panel = document.querySelector('.pose-panel')
      const leftButton = panel ? panel.querySelector('.pose-mirror__left') : null
      if (!leftButton) return { error: '找不到「左 → 右」按钮' }
      leftButton.click()
      await sleep(900)

      const mannequinAfter = store.state.history.present.objects.find((o) => o.id === object.id).mannequin
      const poseAfter = mannequinAfter.pose

      /*
       * 量几何前把 spine 的 Y/Z 归零：绕 X 的旋转是自镜像的，
       * 这样整具身体在世界坐标里才真的是镜像（见上面的注释）。
       */
      editor.updateJointAngle({ id: object.id, jointId: 'spine', axis: 'y', value: 0 })
      await sleep(250)
      editor.updateJointAngle({ id: object.id, jointId: 'spine', axis: 'z', value: 0 })
      await sleep(900)

      const root = vm.rootMap.get(object.id)
      root.updateMatrixWorld(true)
      const joints = root.userData.mannequinJoints
      const handles = root.userData.mannequinHandles
      const local = (node) => {
        const p = node.getWorldPosition(root.position.clone())
        return root.worldToLocal(p)
      }
      const pairs = [
        ['leftShoulder', 'rightShoulder'],
        ['leftElbow', 'rightElbow'],
        ['leftHip', 'rightHip'],
        ['leftKnee', 'rightKnee']
      ]
      const measurements = []
      let worst = { label: '', diff: 0 }
      for (const [leftId, rightId] of pairs) {
        for (const [kind, map] of [
          ['枢轴', joints],
          ['手柄', handles]
        ]) {
          const leftNode = map.get(leftId)
          const rightNode = map.get(rightId)
          if (!leftNode || !rightNode) continue
          const l = local(leftNode)
          const r = local(rightNode)
          const diff = Math.max(Math.abs(l.x + r.x), Math.abs(l.y - r.y), Math.abs(l.z - r.z))
          measurements.push({
            label: leftId + '/' + kind,
            left: [+l.x.toFixed(5), +l.y.toFixed(5), +l.z.toFixed(5)],
            right: [+r.x.toFixed(5), +r.y.toFixed(5), +r.z.toFixed(5)],
            diff: +diff.toExponential(2)
          })
          if (diff > worst.diff) worst = { label: leftId + '/' + kind, diff }
        }
      }

      return {
        poseBefore,
        presetIdBefore,
        mirrorButtonPresent: Boolean(leftButton),
        poseAfter,
        spineAfter: { ...poseAfter.spine },
        headAfter: { ...poseAfter.head },
        manualJoints: [...(mannequinAfter.manualJoints ?? [])],
        presetId: mannequinAfter.presetId,
        measurements,
        worstDiff: worst.diff,
        worstLabel: worst.label,
        measuredCount: measurements.length
      }
    })()`)

    if (mirror.error) throw new Error(mirror.error)

    check('姿势面板里有「左 → 右」镜像按钮', mirror.mirrorButtonPresent === true)
    check(
      '镜像后右侧四肢 = 左侧的镜像（x 不变、y/z 取反）',
      Math.abs(mirror.poseAfter.rightShoulder.x - 30) < 0.01 &&
        Math.abs(mirror.poseAfter.rightShoulder.y + 20) < 0.01 &&
        Math.abs(mirror.poseAfter.rightShoulder.z - 35) < 0.01 &&
        Math.abs(mirror.poseAfter.rightElbow.x - 50) < 0.01 &&
        Math.abs(mirror.poseAfter.rightElbow.y + 10) < 0.01 &&
        Math.abs(mirror.poseAfter.rightElbow.z + 5) < 0.01 &&
        Math.abs(mirror.poseAfter.rightHip.x + 20) < 0.01 &&
        Math.abs(mirror.poseAfter.rightHip.y + 15) < 0.01 &&
        Math.abs(mirror.poseAfter.rightHip.z - 10) < 0.01 &&
        Math.abs(mirror.poseAfter.rightKnee.x - 40) < 0.01,
      JSON.stringify({
        shoulder: mirror.poseAfter.rightShoulder,
        elbow: mirror.poseAfter.rightElbow,
        hip: mirror.poseAfter.rightHip,
        knee: mirror.poseAfter.rightKnee
      })
    )
    check(
      '左侧（源）保持原样，不被改写',
      JSON.stringify(mirror.poseAfter.leftShoulder) === JSON.stringify(mirror.poseBefore.leftShoulder) &&
        JSON.stringify(mirror.poseAfter.leftElbow) === JSON.stringify(mirror.poseBefore.leftElbow) &&
        JSON.stringify(mirror.poseAfter.leftHip) === JSON.stringify(mirror.poseBefore.leftHip),
      JSON.stringify(mirror.poseAfter.leftShoulder)
    )
    check(
      '中轴关节（头 / 躯干）不被镜像动到',
      JSON.stringify(mirror.spineAfter) === JSON.stringify(mirror.poseBefore.spine) &&
        JSON.stringify(mirror.headAfter) === JSON.stringify(mirror.poseBefore.head),
      JSON.stringify({ spine: mirror.spineAfter, head: mirror.headAfter })
    )
    check(
      '量到左右关节世界坐标真的成镜像（x 反号、y/z 相等）',
      mirror.measuredCount === 8 && mirror.worstDiff < 1e-3,
      `最差 ${mirror.worstLabel} = ${mirror.worstDiff.toExponential(2)}；` +
        JSON.stringify(mirror.measurements.slice(0, 2))
    )
    check(
      '镜像的关节被记进 manualJoints（否则有预设时外观不跟随）',
      ['leftShoulder', 'rightShoulder', 'leftElbow', 'rightElbow', 'leftHip', 'rightHip', 'leftKnee', 'rightKnee'].every(
        (id) => mirror.manualJoints.includes(id)
      ),
      JSON.stringify(mirror.manualJoints)
    )
    check(
      '镜像不改变动作预设（presetId 原样保留）',
      mirror.presetId === mirror.presetIdBefore,
      `${mirror.presetIdBefore} → ${mirror.presetId}`
    )

    // 「右 → 左」方向：把右侧改成另一组值，镜像后左侧必须跟着变成它的镜像
    const mirrorReverse = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      const set = async (jointId, value) => {
        for (const axis of ['x', 'y', 'z']) {
          editor.updateJointAngle({ id: object.id, jointId, axis, value: value[axis] })
          await sleep(120)
        }
      }
      await set('rightShoulder', { x: -10, y: 40, z: 25 })
      await sleep(600)
      const panel = document.querySelector('.pose-panel')
      const button = panel ? panel.querySelector('.pose-mirror__right') : null
      if (!button) return { error: '找不到「右 → 左」按钮' }
      button.click()
      await sleep(900)
      const pose = store.state.history.present.objects.find((o) => o.id === object.id).mannequin.pose
      return { leftShoulder: { ...pose.leftShoulder }, rightShoulder: { ...pose.rightShoulder } }
    })()`)
    if (mirrorReverse.error) throw new Error(mirrorReverse.error)
    check(
      '「右 → 左」同样正确（左侧 = 右侧的镜像）',
      Math.abs(mirrorReverse.leftShoulder.x + 10) < 0.01 &&
        Math.abs(mirrorReverse.leftShoulder.y + 40) < 0.01 &&
        Math.abs(mirrorReverse.leftShoulder.z + 25) < 0.01 &&
        JSON.stringify(mirrorReverse.rightShoulder) === JSON.stringify({ x: -10, y: 40, z: 25 }),
      JSON.stringify(mirrorReverse)
    )

    // ===================== 二十七、关节关键帧通道 =====================
    /*
     * 按关节打帧（"只动画左臂"）。
     *
     * 这一类功能最容易假通过：store 里的关键帧数据看起来对，画面却不对。
     * 所以这里一律**量控制骨架关节的真实旋转**：
     *
     * 1. 打两个不同姿势的关键帧 → 拖到中间时刻 → 骨架旋转必须是两者的插值；
     * 2. 只给一个关节打帧 → 其它关节**不被影响**（保持工程姿势），且不出现 NaN；
     * 3. 同一帧再点一次是覆盖，不是插出两条同刻帧（同刻帧会让插值除以 0）。
     *
     * 时刻说明：打帧会对齐到 24fps 帧格，所以用 0 / 2 秒这两个正好落在帧上的
     * 时刻，避免"期望 1.0 秒实际是 1.0417 秒"这种自己给自己制造的偏差。
     */
    const poseKeyframes = await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const vm = ${VIEWPORT}
      const object = store.state.history.present.objects.filter((o) => o.kind === 'mannequin').pop()
      editor.handleSelection([object.id])
      await sleep(600)

      const deg = (rad) => +((rad * 180) / Math.PI).toFixed(2)
      const rigRotation = (jointId) => {
        const root = vm.rootMap.get(object.id)
        const joint = root.userData.mannequinJoints.get(jointId)
        return { x: deg(joint.rotation.x), y: deg(joint.rotation.y), z: deg(joint.rotation.z) }
      }
      const finite = (value) => Object.values(value).every(Number.isFinite)
      const panel = () => document.querySelector('.pose-panel')
      const setJoint = async (jointId, value) => {
        for (const axis of ['x', 'y', 'z']) {
          editor.updateJointAngle({ id: object.id, jointId, axis, value: value[axis] })
          await sleep(100)
        }
      }
      const keyAll = async () => {
        panel().querySelector('.pose-keyframe-all').click()
        await sleep(800)
      }
      const keyJoint = async (label) => {
        const row = [...panel().querySelectorAll('.pose-joint')].find((j) =>
          j.querySelector('.pose-joint__label')?.textContent.includes(label)
        )
        if (!row) return false
        row.querySelector('.pose-joint__key').click()
        await sleep(800)
        return true
      }

      // 清掉旧关键帧，从确定状态开始
      store.commit('setTimelineTime', 0)
      editor.clearObjectKeyframes(object.id)
      await sleep(700)
      editor.resetMannequinPose({ id: object.id })
      await sleep(700)

      // --- 第一段：全部关节通道，两帧之间应插值 ---
      await setJoint('leftShoulder', { x: 0, y: 0, z: 0 })
      await setJoint('spine', { x: 0, y: 0, z: 0 })
      await sleep(500)
      await keyAll()
      const afterFirst = store.state.history.present.timeline.objectKeyframes.filter(
        (k) => k.objectId === object.id
      )
      const firstPoseJoints = afterFirst[0] ? Object.keys(afterFirst[0].transform.mannequinPose).length : 0

      // 第二帧：把左肩抬到 90°、躯干扭到 30°（都在限位内：肩 X ±120、躯干 X ±35）
      store.commit('setTimelineTime', 2)
      await sleep(500)
      await setJoint('leftShoulder', { x: 90, y: 0, z: 0 })
      await setJoint('spine', { x: 30, y: 0, z: 0 })
      await sleep(500)
      await keyAll()
      const afterSecond = store.state.history.present.timeline.objectKeyframes.filter(
        (k) => k.objectId === object.id
      )
      const secondFramePose = afterSecond[1]
        ? {
            leftShoulder: { ...afterSecond[1].transform.mannequinPose.leftShoulder },
            spine: { ...afterSecond[1].transform.mannequinPose.spine }
          }
        : null

      // 拖到 1 秒（两帧正中）：骨架旋转必须是两者的插值
      store.commit('setTimelineTime', 1)
      await sleep(900)
      const atMiddle = {
        leftShoulder: rigRotation('leftShoulder'),
        spine: rigRotation('spine')
      }
      // 手动拖过的物体在播放头处会被"编辑覆盖"挡住，这里断言覆盖列表已清空
      const overridesAtMiddle = [...store.state.timelineEditOverrides]

      // --- 第二段：通道粒度，只给左前臂打帧 ---
      store.commit('setTimelineTime', 0)
      await sleep(400)
      editor.clearObjectKeyframes(object.id)
      await sleep(700)
      editor.resetMannequinPose({ id: object.id })
      await sleep(600)
      await setJoint('leftElbow', { x: 0, y: 0, z: 0 })
      await setJoint('leftShoulder', { x: 0, y: 0, z: 0 })
      await sleep(500)
      const keyedElbow = await keyJoint('左前臂')
      const singleChannel = store.state.history.present.timeline.objectKeyframes.filter(
        (k) => k.objectId === object.id
      )

      // 把左前臂抬到 100°，同一帧再打一次（必须覆盖而不是新增）
      await setJoint('leftElbow', { x: 100, y: 0, z: 0 })
      await sleep(500)
      await keyJoint('左前臂')
      const afterSecondKey = store.state.history.present.timeline.objectKeyframes.filter(
        (k) => k.objectId === object.id
      )
      const sameTimeCount = afterSecondKey.filter((k) => Math.abs(k.timeSeconds - 0) < 1e-6).length

      // 再给另一个关节（右上臂）打帧：必须合并进同一帧，左前臂的值不能被清掉
      await keyJoint('右上臂')
      const afterHeadKey = store.state.history.present.timeline.objectKeyframes.filter(
        (k) => k.objectId === object.id
      )
      const frameAtZero = afterHeadKey.find((k) => Math.abs(k.timeSeconds - 0) < 1e-6)
      const mergedJoints = frameAtZero ? Object.keys(frameAtZero.transform.mannequinPose).sort() : []

      // 把工程姿势里的左前臂改成 30°、头扭到 40°（这两个都**不**再打帧）：
      // 预览时左前臂必须被关键帧里的 100° 覆盖，头则保持工程姿势 40°
      editor.updateJointAngle({ id: object.id, jointId: 'leftElbow', axis: 'x', value: 30 })
      await sleep(400)
      editor.updateJointAngle({ id: object.id, jointId: 'head', axis: 'y', value: 40 })
      await sleep(700)
      const storePoseBeforePreview = JSON.parse(
        JSON.stringify(store.state.history.present.objects.find((o) => o.id === object.id).mannequin.pose)
      )
      store.commit('setTimelineTime', 1.5)
      await sleep(900)
      const headAtMiddle = rigRotation('head')
      const elbowAtMiddle = rigRotation('leftElbow')

      return {
        objectId: object.id,
        firstPoseJoints,
        frameCount: afterSecond.length,
        frameTimes: afterSecond.map((k) => k.timeSeconds),
        frameJointCounts: afterSecond.map((k) => Object.keys(k.transform.mannequinPose).length),
        secondFramePose,
        atMiddle,
        overridesAtMiddle,
        keyedElbow,
        singleChannelCount: singleChannel.length,
        singleChannelJoints: singleChannel[0] ? Object.keys(singleChannel[0].transform.mannequinPose) : [],
        sameTimeCount,
        mergedJoints,
        storePoseBeforePreview,
        headAtMiddle,
        elbowAtMiddle,
        headFinite: finite(headAtMiddle),
        elbowFinite: finite(elbowAtMiddle),
        frameAtZeroTime: frameAtZero ? frameAtZero.timeSeconds : null
      }
    })()`)

    if (poseKeyframes.error) throw new Error(poseKeyframes.error)

    check(
      '「为全部关节打帧」写入完整姿势的关键帧（10 个关节）',
      poseKeyframes.firstPoseJoints === 10,
      String(poseKeyframes.firstPoseJoints)
    )
    check(
      '两个不同姿势各打一帧（同一物体共 2 帧）',
      poseKeyframes.frameCount === 2 &&
        Math.abs(poseKeyframes.frameTimes[0]) < 1e-6 &&
        Math.abs(poseKeyframes.frameTimes[1] - 2) < 1e-6,
      JSON.stringify(poseKeyframes.frameTimes)
    )
    check(
      '中间时刻量到骨架旋转是两者的插值（左肩 X 0→90、躯干 X 0→30，smoothstep(0.5)=0.5）',
      Math.abs(poseKeyframes.atMiddle.leftShoulder.x - 45) < 1.5 &&
        Math.abs(poseKeyframes.atMiddle.spine.x - 15) < 1.5,
      JSON.stringify({ atMiddle: poseKeyframes.atMiddle, secondFrame: poseKeyframes.secondFramePose })
    )
    check(
      '拖到中间时刻后手动编辑覆盖已清空（否则看到的还是编辑态姿势）',
      poseKeyframes.overridesAtMiddle.length === 0,
      JSON.stringify(poseKeyframes.overridesAtMiddle)
    )
    check('逐关节打帧按钮存在并可点', poseKeyframes.keyedElbow === true)
    check(
      '只给左前臂打帧：关键帧里只有这一个关节',
      poseKeyframes.singleChannelCount === 1 &&
        JSON.stringify(poseKeyframes.singleChannelJoints) === JSON.stringify(['leftElbow']),
      JSON.stringify(poseKeyframes.singleChannelJoints)
    )
    check(
      '同一时刻再打一次是覆盖（不是两条同刻帧）',
      poseKeyframes.sameTimeCount === 1,
      String(poseKeyframes.sameTimeCount)
    )
    check(
      '再给右上臂打帧：合并进同一帧，左前臂的值不被清掉',
      JSON.stringify(poseKeyframes.mergedJoints) === JSON.stringify(['leftElbow', 'rightShoulder']),
      JSON.stringify(poseKeyframes.mergedJoints)
    )
    check(
      '未被任何关键帧覆盖的关节保持工程姿势（头 40°）且不出现 NaN',
      Math.abs(poseKeyframes.headAtMiddle.y - 40) < 1.5 && poseKeyframes.headFinite === true,
      JSON.stringify({ head: poseKeyframes.headAtMiddle, finite: poseKeyframes.headFinite })
    )
    check(
      '左前臂自己的通道在 0→1.5 秒之间保持 100°（只有一帧 → 取最近的已有值），并覆盖工程姿势里的 30°',
      Math.abs(poseKeyframes.elbowAtMiddle.x - 100) < 1.5 &&
        Math.abs(poseKeyframes.storePoseBeforePreview.leftElbow.x - 30) < 0.01 &&
        poseKeyframes.elbowFinite === true,
      JSON.stringify({
        elbow: poseKeyframes.elbowAtMiddle,
        storePose: poseKeyframes.storePoseBeforePreview.leftElbow,
        finite: poseKeyframes.elbowFinite
      })
    )

    // ===================== 二十八、拖拽建墙/地面的实时预览 =====================
    /*
     * 以前拖拽全程画面毫无反应，松手才"啪"地出现物体，
     * 用户完全无法判断正在拖多宽。这里量的是「拖拽中画面确实在变」：
     * - 幽灵预览的 scale 随拖拽尺寸变化（不是只到最后才出现）；
     * - HUD 上的尺寸文本同步变化；
     * - 预览看到多大，松手建出来就是多大（共用同一个 transform）。
     */
    const quickBuild = await cdp.evaluate(`(async () => {
      const store = ${STORE}
      const editor = document.querySelector('.editor').__vue__
      const vm = ${VIEWPORT}
      const ghost = () => {
        const group = vm.quickBuildGroup
        const child = group ? group.children.find((item) => item.visible) : null
        return child || null
      }
      const label = () => {
        const pill = document.querySelector('.hud-pill--measure')
        return pill ? pill.textContent.trim() : null
      }

      editor.beginQuickBuild('floor')
      await new Promise((r) => setTimeout(r, 400))
      const beforeStart = { visible: Boolean(ghost()), label: label() }

      // 按下（还没移动）
      editor.handleQuickBuildStart({ x: 0, y: 0, z: 0 })
      await new Promise((r) => setTimeout(r, 300))
      const atStart = { visible: Boolean(ghost()), label: label() }

      // 拖到 3.2 × 1.8
      editor.handleQuickBuildMove({ x: 3.2, y: 0, z: 1.8 })
      await new Promise((r) => setTimeout(r, 300))
      const g1 = ghost()
      const mid = {
        visible: Boolean(g1),
        scale: g1 ? { x: +g1.scale.x.toFixed(3), y: +g1.scale.y.toFixed(3), z: +g1.scale.z.toFixed(3) } : null,
        position: g1 ? { x: +g1.position.x.toFixed(3), y: +g1.position.y.toFixed(3), z: +g1.position.z.toFixed(3) } : null,
        label: label()
      }

      // 继续拖到 6.4 × 3.6 —— 预览必须跟着变大
      editor.handleQuickBuildMove({ x: 6.4, y: 0, z: 3.6 })
      await new Promise((r) => setTimeout(r, 300))
      const g2 = ghost()
      const bigger = {
        visible: Boolean(g2),
        scale: g2 ? { x: +g2.scale.x.toFixed(3), y: +g2.scale.y.toFixed(3), z: +g2.scale.z.toFixed(3) } : null,
        label: label()
      }

      // 松手：建出来的尺寸必须等于预览看到的
      editor.handleQuickBuildEnd({ x: 6.4, y: 0, z: 3.6 })
      await new Promise((r) => setTimeout(r, 600))
      const created = store.state.history.present.objects.filter((o) => o.kind === 'floor').pop()
      const afterEnd = {
        ghostVisible: Boolean(ghost()),
        label: label(),
        size: created ? { x: +created.size.x.toFixed(3), y: +created.size.y.toFixed(3), z: +created.size.z.toFixed(3) } : null,
        position: created ? { x: +created.position.x.toFixed(3), z: +created.position.z.toFixed(3) } : null
      }

      // ---- 墙：有旋转、高度固定 2.8 ----
      editor.beginQuickBuild('wall')
      await new Promise((r) => setTimeout(r, 300))
      editor.handleQuickBuildStart({ x: 0, y: 0, z: 0 })
      editor.handleQuickBuildMove({ x: 4, y: 0, z: 0 })
      await new Promise((r) => setTimeout(r, 300))
      const wallGhost = ghost()
      const wall = {
        visible: Boolean(wallGhost),
        scale: wallGhost ? { x: +wallGhost.scale.x.toFixed(3), y: +wallGhost.scale.y.toFixed(3), z: +wallGhost.scale.z.toFixed(3) } : null,
        rotationY: wallGhost ? +(wallGhost.rotation.y * 180 / Math.PI).toFixed(2) : null,
        label: label()
      }

      // 拖到斜向（45度）：预览必须跟着转，而不是只变长
      editor.handleQuickBuildMove({ x: 3, y: 0, z: 3 })
      await new Promise((r) => setTimeout(r, 300))
      const wallGhost2 = ghost()
      const wallDiagonal = {
        visible: Boolean(wallGhost2),
        rotationY: wallGhost2 ? +(wallGhost2.rotation.y * 180 / Math.PI).toFixed(2) : null,
        length: wallGhost2 ? +wallGhost2.scale.x.toFixed(3) : null,
        label: label()
      }
      editor.handleQuickBuildEnd({ x: 3, y: 0, z: 3 })
      await new Promise((r) => setTimeout(r, 600))
      const createdWall = store.state.history.present.objects.filter((o) => o.kind === 'wall').pop()
      const wallCreated = createdWall
        ? { rotationY: +(createdWall.rotation.y).toFixed(2), length: +createdWall.size.x.toFixed(3) }
        : null

      return { beforeStart, atStart, mid, bigger, afterEnd, wall, wallDiagonal, wallCreated }
    })()`)

    check('拖拽开始前没有幽灵预览', quickBuild.beforeStart.visible === false, JSON.stringify(quickBuild.beforeStart))
    check(
      '刚按下（尺寸为 0）时不画幽灵体，但 HUD 不报错',
      quickBuild.atStart.visible === false,
      JSON.stringify(quickBuild.atStart)
    )
    check(
      '拖动中出现幽灵预览（不是松手才出现）',
      quickBuild.mid.visible === true,
      JSON.stringify(quickBuild.mid)
    )
    check(
      '幽灵预览尺寸 = 拖拽尺寸（3.2 × 1.8）',
      quickBuild.mid.scale !== null &&
        Math.abs(quickBuild.mid.scale.x - 3.2) < 0.01 &&
        Math.abs(quickBuild.mid.scale.z - 1.8) < 0.01,
      JSON.stringify(quickBuild.mid.scale)
    )
    check(
      'HUD 实时显示尺寸文本',
      quickBuild.mid.label === '3.20 × 1.80 m',
      String(quickBuild.mid.label)
    )
    check(
      '继续拖大时预览跟着变大（实时反馈）',
      quickBuild.bigger.scale !== null &&
        quickBuild.bigger.scale.x > quickBuild.mid.scale.x + 1 &&
        quickBuild.bigger.scale.z > quickBuild.mid.scale.z + 1,
      JSON.stringify({ mid: quickBuild.mid.scale, bigger: quickBuild.bigger.scale })
    )
    check(
      'HUD 文本跟着变',
      quickBuild.bigger.label === '6.40 × 3.60 m',
      String(quickBuild.bigger.label)
    )
    check(
      '松手后幽灵预览消失（不残留）',
      quickBuild.afterEnd.ghostVisible === false,
      JSON.stringify(quickBuild.afterEnd)
    )
    check(
      '建出来的尺寸与预览看到的一致',
      quickBuild.afterEnd.size !== null &&
        Math.abs(quickBuild.afterEnd.size.x - quickBuild.bigger.scale.x) < 0.01 &&
        Math.abs(quickBuild.afterEnd.size.z - quickBuild.bigger.scale.z) < 0.01,
      JSON.stringify({ preview: quickBuild.bigger.scale, created: quickBuild.afterEnd.size })
    )

    check(
      '墙的幽灵预览：高度固定 2.8、长度跟拖拽',
      quickBuild.wall.visible === true &&
        Math.abs(quickBuild.wall.scale.y - 2.8) < 0.01 &&
        Math.abs(quickBuild.wall.scale.x - 4) < 0.01,
      JSON.stringify(quickBuild.wall)
    )
    check(
      '墙的幽灵预览带正确旋转（沿世界 X 走）',
      Math.abs(quickBuild.wall.rotationY) < 0.01,
      String(quickBuild.wall.rotationY)
    )
    check(
      '拖成斜墙时预览跟着转（45°），不是只变长',
      /*
       * 只要幅度对：符号由 `rotation.y = -atan2(dz, dx)` 的约定决定
       * （局部 +X 要对上拖拽方向），写死正号会把正确实现判成失败。
       */
      Math.abs(Math.abs(quickBuild.wallDiagonal.rotationY) - 45) < 1 &&
        Math.abs(quickBuild.wallDiagonal.length - Math.hypot(3, 3)) < 0.02,
      JSON.stringify(quickBuild.wallDiagonal)
    )
    check(
      '斜墙建成后的旋转与预览完全一致（预览即所得）',
      quickBuild.wallCreated !== null &&
        Math.abs(quickBuild.wallCreated.rotationY - quickBuild.wallDiagonal.rotationY) < 0.01 &&
        Math.abs(quickBuild.wallCreated.length - quickBuild.wallDiagonal.length) < 0.01,
      JSON.stringify({ preview: quickBuild.wallDiagonal, created: quickBuild.wallCreated })
    )
    check(
      '墙的 HUD 只显示长度（高度是固定的）',
      /^长度 4\.24 m$/.test(String(quickBuild.wallDiagonal.label)),
      String(quickBuild.wallDiagonal.label)
    )

    check('无未捕获运行时异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '))
  } finally {
    cdp?.close()
    try {
      child.kill()
    } catch {
      /* ignore */
    }
  }

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    console.log('FAILED:')
    for (const item of failed) console.log(`  - ${item.label} ${item.detail}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exitCode = 1
})
