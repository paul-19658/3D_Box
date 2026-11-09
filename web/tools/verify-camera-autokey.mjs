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
