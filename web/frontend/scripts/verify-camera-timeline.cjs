/**
 * 三项交互的端到端验证。
 *
 * 覆盖本轮用户反馈的三个问题：
 *   1. 在画面里点摄影机模型 → 应选中摄影机
 *   2. 点播放 / 拖动播放头 → 编辑视角不动，只有场景相机变化
 *   3. 选中摄影机时 → 出现监视器小窗，且画面与场景相机一致
 *
 * 与 verify-gizmo.cjs 一样，全部通过场景探针读取真实 three.js 状态，
 * 不靠截图或像素猜测。
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/verify-camera-timeline.cjs http://127.0.0.1:8181/editor
 */

const http = require('http')
const fs = require('fs')

const target = process.argv[2] || 'http://127.0.0.1:8000/editor'
const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 9222

const getJSON = (path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: DEBUG_PORT, path }, (res) => {
        let body = ''
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch (error) {
            reject(error)
          }
        })
      })
      .on('error', reject)
  })

async function main() {
  let targets = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      targets = await getJSON('/json/list')
      if (targets && targets.length > 0) break
    } catch {
      // 等待调试端口。
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!targets || targets.length === 0) throw new Error('调试端口未就绪')

  const page = targets.find((item) => item.type === 'page') || targets[0]
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
  const errors = []

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      socket.send(JSON.stringify({ id, method, params }))
    })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      errors.push((details.exception && details.exception.description) || details.text)
    }
  })

  await new Promise((resolve) => socket.addEventListener('open', resolve))
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: target })
  await new Promise((resolve) => setTimeout(resolve, 5000))

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(
        (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
          result.exceptionDetails.text
      )
    }
    return result.result.value
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // 关掉可能出现的恢复弹窗。
  const dismissed = await evaluate(`(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const dialog = document.querySelector('[aria-label="恢复未保存内容"]')
      if (!dialog) { await new Promise((r) => setTimeout(r, 150)); continue }
      const discard = [...dialog.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '放弃')
      if (!discard) return { ok: false }
      discard.click()
      await new Promise((r) => setTimeout(r, 600))
      return { ok: !document.querySelector('[aria-label="恢复未保存内容"]') }
    }
    return { ok: true, skipped: true }
  })()`)
  console.log('恢复弹窗:', JSON.stringify(dismissed))

  const results = []
  const check = (ok, label, detail) => {
    results.push(ok)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  }

  const scene = () => evaluate('window.__XBH_DIAGNOSE__.scene()')

  // ---------------------------------------------------------------
  // 1. 在画面里点摄影机模型 → 应选中摄影机
  // ---------------------------------------------------------------
  // 先取消选中，确保不是"本来就已经选中"造成的假通过。
  await evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 200))
    const panel = document.querySelector('.viewport-canvas')
    const rect = panel.getBoundingClientRect()
    // 点一个角落，这里不会有任何物体，用于清空选中。
    panel.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom - 12,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))
    panel.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom - 12,
      button: 0, buttons: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))
    await new Promise((r) => setTimeout(r, 400))
  })()`)

  let snapshot = await scene()
  check(snapshot.cameraSelected === false, '前置条件：摄影机当前未被选中')

  // 先把编辑视角对准场景，保证摄影机模型确实落在画面内。
  // 用界面上的"对准场景"按钮走真实代码路径，而不是在测试里改相机参数。
  await evaluate(`(async () => {
    const button = [...document.querySelectorAll('.camera-overlay .btn')]
      .find((b) => (b.textContent || '').trim() === '对准场景')
    if (button) button.click()
    await new Promise((r) => setTimeout(r, 600))
  })()`)

  // 场景相机的三维位置投影到屏幕，然后用真实指针事件点它。
  const cameraPick = await evaluate(`(async () => {
    const canvas = document.querySelector('.viewport-canvas')
    const snapshot = window.__XBH_DIAGNOSE__.scene()
    if (!snapshot) return { ok: false, reason: '探针不可用' }

    const rect = canvas.getBoundingClientRect()
    const position = snapshot.sceneCamera.position
    const local = window.__XBH_DIAGNOSE__.project(position)
    if (!local) return { ok: false, reason: '投影失败' }

    const x = rect.left + local.x
    const y = rect.top + local.y

    // 投影点必须真的落在画布内，否则这次"点击"毫无意义：
    // 事件被派发到画布外的坐标上，选中与否都不能说明拾取逻辑对不对。
    const inside =
      local.x >= 0 && local.x <= rect.width && local.y >= 0 && local.y <= rect.height
    if (!inside) {
      return { ok: false, reason: '投影点落在画布外', local: { x: Math.round(local.x), y: Math.round(local.y) }, rect: { w: Math.round(rect.width), h: Math.round(rect.height) } }
    }

    const fire = (type) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire('pointerdown')
    await new Promise((r) => setTimeout(r, 120))
    fire('pointerup')
    await new Promise((r) => setTimeout(r, 450))

    return { ok: true, x: Math.round(x), y: Math.round(y), local: { x: Math.round(local.x), y: Math.round(local.y) } }
  })()`)
  console.log('点击位置:', JSON.stringify(cameraPick))
  check(cameraPick.ok === true, '摄影机模型投影点落在画布内（点击位置有效）', cameraPick.reason || '')

  snapshot = await scene()
  check(snapshot.cameraSelected === true, '在画面里点击摄影机模型即可选中摄影机')

  // ---------------------------------------------------------------
  // 2. 显示器：选中摄影机后出现监视器
  // ---------------------------------------------------------------
  const monitorToggle = await evaluate(`(async () => {
    const buttons = [...document.querySelectorAll('.hud-pill')]
    const button = buttons.find((b) => (b.textContent || '').trim().includes('监视器'))
    if (!button) return { ok: false, reason: '找不到监视器按钮' }
    button.click()
    await new Promise((r) => setTimeout(r, 700))
    const monitor = document.querySelector('.monitor')
    const canvas = document.querySelector('.monitor__canvas')
    if (!monitor || !canvas) return { ok: false, reason: '监视器未出现' }
    const rect = monitor.getBoundingClientRect()
    return {
      ok: true,
      monitor: { w: Math.round(rect.width), h: Math.round(rect.height) },
      canvasCss: { w: Math.round(canvas.getBoundingClientRect().width), h: Math.round(canvas.getBoundingClientRect().height) },
      canvasBacking: { w: canvas.width, h: canvas.height },
      // 监视器里画出来的像素不能全黑，否则说明渲染没跑起来。
      painted: (() => {
        try {
          const probe = document.createElement('canvas')
          probe.width = canvas.width
          probe.height = canvas.height
          const ctx = probe.getContext('2d')
          ctx.drawImage(canvas, 0, 0)
          const data = ctx.getImageData(0, 0, probe.width, probe.height).data
          let nonBlack = 0
          for (let i = 0; i < data.length; i += 4 * 97) {
            if (data[i] + data[i + 1] + data[i + 2] > 24) nonBlack += 1
          }
          return nonBlack
        } catch (error) {
          return -1
        }
      })()
    }
  })()`)
  console.log('监视器:', JSON.stringify(monitorToggle))
  check(monitorToggle.ok === true, '选中摄影机后可打开监视器小窗')
  check(
    monitorToggle.ok && monitorToggle.canvasBacking.w > 100 && monitorToggle.canvasBacking.h > 50,
    '监视器画布有实际绘制尺寸',
    monitorToggle.ok ? `${monitorToggle.canvasBacking.w}×${monitorToggle.canvasBacking.h}` : ''
  )
  check(
    monitorToggle.ok && monitorToggle.painted > 0,
    '监视器画面非全黑（渲染已生效）',
    monitorToggle.ok ? `非黑采样点=${monitorToggle.painted}` : ''
  )

  // ---------------------------------------------------------------
  // 2.5 摄影机模型朝向必须与监视器一致
  // ---------------------------------------------------------------
  // 这是"视锥背对物体、监视器里却有画面"的回归断言：
  // 模型本地 -Z（视锥朝向）必须指向 target，即 facingDot ≈ 1。
  snapshot = await scene()
  const helperInfo = snapshot.cameraHelper
  console.log('摄影机模型朝向:', JSON.stringify(helperInfo))
  check(
    Boolean(helperInfo) && helperInfo.facingDot > 0.99,
    '视锥朝向与监视器一致（模型 -Z 指向 target）',
    helperInfo ? `facingDot=${helperInfo.facingDot}` : '探针无数据'
  )
  check(
    helperInfo && helperInfo.targetDotDistance !== null && helperInfo.targetDotDistance < 0.01,
    '目标点标记落在 target 上（未被旋转错位）',
    helperInfo && helperInfo.targetDotDistance !== null ? `偏差=${helperInfo.targetDotDistance}` : ''
  )

  // ---------------------------------------------------------------
  // 2.6 平移摄影机不能改变朝向
  // ---------------------------------------------------------------
  // 这是"用移动 gizmo 拖摄影机，旋转数值也变了"的回归断言。
  // 平移只应改机位，视线方向（position → target 的单位向量）必须保持不变。
  const panProbe = await evaluate(`(async () => {
    const canvas = document.querySelector('.viewport-canvas')
    const before = window.__XBH_DIAGNOSE__.scene()
    if (!before || !before.gizmo) return { ok: false, reason: '没有控制柄' }

    const handles = before.gizmo.handles || []
    const handle = handles.slice().sort((a, b) => b.distance - a.distance)[0]
    if (!handle) return { ok: false, reason: '找不到轴手柄' }

    const directionBefore = before.cameraHelper.toTarget

    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      button: type === 'pointermove' ? -1 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire('pointermove', handle.x, handle.y)
    await new Promise((r) => setTimeout(r, 80))
    fire('pointerdown', handle.x, handle.y)
    await new Promise((r) => setTimeout(r, 80))
    for (let step = 1; step <= 12; step += 1) {
      fire('pointermove', handle.x + handle.dx * 7 * step, handle.y + handle.dy * 7 * step)
      await new Promise((r) => setTimeout(r, 20))
    }
    fire('pointerup', handle.x + handle.dx * 84, handle.y + handle.dy * 84)
    await new Promise((r) => setTimeout(r, 450))

    const after = window.__XBH_DIAGNOSE__.scene()
    const moved = ['x', 'y', 'z'].some(
      (axis) => Math.abs(after.sceneCamera.position[axis] - before.sceneCamera.position[axis]) > 0.02
    )
    const dot =
      directionBefore.x * after.cameraHelper.toTarget.x +
      directionBefore.y * after.cameraHelper.toTarget.y +
      directionBefore.z * after.cameraHelper.toTarget.z

    return {
      ok: true,
      moved,
      handle: handle.axis,
      directionBefore,
      directionAfter: after.cameraHelper.toTarget,
      directionDot: Math.round(dot * 1000) / 1000,
      positionBefore: before.sceneCamera.position,
      positionAfter: after.sceneCamera.position,
      facingDot: after.cameraHelper.facingDot
    }
  })()`)
  console.log('平移摄影机:', JSON.stringify(panProbe))

  check(panProbe.ok === true && panProbe.moved === true, '拖动 gizmo 能移动摄影机机位')
  check(
    panProbe.ok === true && panProbe.directionDot > 0.99,
    '平移摄影机不会改变朝向（视线方向不变）',
    panProbe.ok ? `dot=${panProbe.directionDot}` : ''
  )
  check(
    panProbe.ok === true && panProbe.facingDot > 0.99,
    '平移后视锥仍朝向 target',
    panProbe.ok ? `facingDot=${panProbe.facingDot}` : ''
  )

  // ---------------------------------------------------------------
  // 3. 时间轴：预览不能移动编辑视角
  // ---------------------------------------------------------------
  // 先记录编辑视角（OrbitControls 所控制的那台相机）的位置。
  const editorCameraBefore = await evaluate('window.__XBH_DIAGNOSE__.editorCamera()')
  console.log('编辑视角（预览前）:', JSON.stringify(editorCameraBefore))

  // 记录一个镜头，让镜头轨非空；再拖到 2 秒。
  const timelineProbe = await evaluate(`(async () => {
    const before = window.__XBH_DIAGNOSE__.editorCamera()

    // 记录镜头
    const record = [...document.querySelectorAll('.timeline__center .btn')]
      .find((b) => (b.textContent || '').trim() === '记录镜头')
    if (record) record.click()
    await new Promise((r) => setTimeout(r, 500))

    // 在标尺上按住并拖动：从 10% 拖到 60%
    const ruler = document.querySelector('.ruler')
    if (!ruler) return { ok: false, reason: '找不到标尺' }
    const rect = ruler.getBoundingClientRect()
    const at = (ratio) => rect.left + rect.width * ratio

    const fire = (el, type, x) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: rect.top + rect.height / 2,
      button: type === 'pointerup' ? 0 : 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire(ruler, 'pointerdown', at(0.1))
    await new Promise((r) => setTimeout(r, 120))
    for (let step = 1; step <= 10; step += 1) {
      fire(window, 'pointermove', at(0.1 + (0.5 * step) / 10))
      await new Promise((r) => setTimeout(r, 40))
    }
    fire(window, 'pointerup', at(0.6))
    await new Promise((r) => setTimeout(r, 500))

    const timeInput = document.querySelector('.time-input')
    const after = window.__XBH_DIAGNOSE__.editorCamera()
    const scene = window.__XBH_DIAGNOSE__.scene()

    return {
      ok: true,
      timeValue: timeInput ? Number(timeInput.value) : null,
      editorCameraBefore: before,
      editorCameraAfter: after,
      sceneCamera: scene.sceneCamera
    }
  })()`)
  console.log('时间轴拖动:', JSON.stringify(timelineProbe))

  check(
    timelineProbe.ok === true && timelineProbe.timeValue > 1,
    '在标尺上按住拖动可以连续改变播放时间',
    timelineProbe.ok ? `time=${timelineProbe.timeValue}` : ''
  )

  const cameraMoved = ['x', 'y', 'z'].some(
    (axis) =>
      Math.abs(timelineProbe.editorCameraAfter[axis] - timelineProbe.editorCameraBefore[axis]) > 0.01
  )
  check(!cameraMoved, '拖动播放头不会移动编辑视角（镜头不再乱飞）', cameraMoved ? '移动了' : '保持原位')

  // ---------------------------------------------------------------
  // 4. 播放：同样不能移动编辑视角
  // ---------------------------------------------------------------
  const playProbe = await evaluate(`(async () => {
    const before = window.__XBH_DIAGNOSE__.editorCamera()
    const play = document.querySelector('.play-btn')
    if (!play) return { ok: false, reason: '找不到播放按钮' }
    play.click()
    await new Promise((r) => setTimeout(r, 900))
    const during = window.__XBH_DIAGNOSE__.editorCamera()
    const sceneDuring = window.__XBH_DIAGNOSE__.scene()
    play.click()
    await new Promise((r) => setTimeout(r, 300))
    const after = window.__XBH_DIAGNOSE__.editorCamera()
    return { ok: true, before, during, after, sceneDuringTime: sceneDuring }
  })()`)
  console.log('播放:', JSON.stringify(playProbe))

  const movedDuringPlay = ['x', 'y', 'z'].some(
    (axis) => Math.abs(playProbe.during[axis] - playProbe.before[axis]) > 0.01
  )
  check(!movedDuringPlay, '点击播放不会移动编辑视角')

  // ---------------------------------------------------------------
  console.log('')
  const passed = results.filter(Boolean).length
  console.log(`${passed}/${results.length} passed`)
  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  if (process.env.SHOT_PATH) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot && shot.data) {
      fs.writeFileSync(process.env.SHOT_PATH, Buffer.from(shot.data, 'base64'))
      console.log(`=== SHOT === ${process.env.SHOT_PATH}`)
    }
  }

  socket.close()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  console.error('verify-camera-timeline failed:', error.message)
  process.exit(1)
})
