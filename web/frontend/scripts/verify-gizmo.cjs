/**
 * gizmo 真实拖拽验证。
 *
 * 与 verify-interaction.cjs 的区别：这里不只判断"选中还在不在"，
 * 而是要求**坐标真的变了**——这正是用户反馈"拖不动"的判据。
 *
 * 关键点：抓取位置不再靠猜像素偏移。
 * TransformControls 每帧按相机距离缩放控制柄，硬编码"中心偏右 60px"
 * 在任意视角下都会落空。这里改为读场景探针（window.__XBH_DIAGNOSE__）：
 * 探针把控制柄各轴拾取网格的世界坐标投影到屏幕，直接给出精确抓取点。
 *
 * 覆盖两条链路：
 *   1. 选中方块 → 拖 X/Y/Z 轴 → 物体 position 改变
 *   2. 选中摄影机 → 拖轴 → 场景相机 position 改变
 *
 * 用法：
 *   DEBUG_PORT=9230 node scripts/verify-gizmo.cjs http://127.0.0.1:8161/editor
 *   SHOT_PATH=%TEMP%\gizmo.png DEBUG_PORT=9230 node scripts/verify-gizmo.cjs ...
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
      // 端口还没起来，继续等。
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

  /**
   * 关掉"发现未保存的内容"弹窗。
   *
   * 上一轮脚本运行会触发自动保存，于是下一次打开编辑器必然弹恢复对话框。
   * 它是一层遮罩，虽然本脚本直接派发事件给 canvas 不受影响，
   * 但截图会被挡住，看不出真实渲染结果。这里统一选"放弃"，
   * 让每次验证都从干净的初始场景开始。
   */
  const dismissRecovery = await evaluate(`(async () => {
    // 恢复弹窗是异步拉取 /api/recovery 之后才挂载的，可能比 5 秒等待更晚，
    // 所以这里轮询而不是只查一次。
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const dialog = document.querySelector('[aria-label="恢复未保存内容"]')
      if (!dialog) {
        await new Promise((r) => setTimeout(r, 150))
        continue
      }
      const discard = [...dialog.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '放弃')
      if (!discard) return { ok: false, reason: '弹窗里没有"放弃"按钮' }
      discard.click()
      await new Promise((r) => setTimeout(r, 600))
      return { ok: !document.querySelector('[aria-label="恢复未保存内容"]'), clicked: true }
    }
    return { ok: true, clicked: false }
  })()`)
  console.log('恢复弹窗处理:', JSON.stringify(dismissRecovery))
  await sleep(300)

  const results = []
  const check = (ok, label, detail) => {
    results.push(ok)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  }

  // 探针必须存在，否则后面的定位全部无从谈起。
  const probeReady = await evaluate('Boolean(window.__XBH_DIAGNOSE__ && window.__XBH_DIAGNOSE__.scene())')
  check(probeReady, '场景探针可用（window.__XBH_DIAGNOSE__.scene()）')
  if (!probeReady) {
    console.log('=== ERRORS ===')
    console.log(errors.length ? errors.join('\n---\n') : '(none)')
    socket.close()
    process.exit(1)
  }

  /** 点击层级里的某一行（按名称匹配）。 */
  const clickRow = async (match) => {
    await evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.asset-panel .list-row')]
      const row = rows.find((r) => (r.querySelector('.list-row__name')?.value || '').includes(${JSON.stringify(
        match
      )}))
      if (row) row.click()
      await new Promise((r) => setTimeout(r, 500))
    })()`)
    await sleep(250)
  }

  /**
   * 在页面里完成一次真实拖拽：
   * - 先 pointermove 让 TransformControls 完成 hover 命中（axis 不是我们算的，是它算的）
   * - 再 pointerdown 起拖
   * - 沿轴在屏幕投影的方向推进
   * 返回命中信息与是否真正拖动过。
   */
  const dragAxis = async (axis) => {
    return evaluate(`(async () => {
      const canvas = document.querySelector('.viewport-canvas')
      if (!canvas) return { ok: false, reason: 'canvas 不存在' }
      const rect = canvas.getBoundingClientRect()

      const snapshot = window.__XBH_DIAGNOSE__.scene()
      if (!snapshot || !snapshot.gizmo) return { ok: false, reason: '探针没有控制柄信息' }

      const handles = snapshot.gizmo.handles || []
      const handle = ${JSON.stringify(
        axis
      )} === 'auto'
        ? handles.slice().sort((a, b) => b.distance - a.distance)[0]
        : handles.find((h) => h.axis === ${JSON.stringify(axis)})
      if (!handle) return { ok: false, reason: '找不到轴手柄', handles }

      // 屏幕上的推进方向由探针给出（中心 → 手柄的单位向量）。
      // 这样"沿轴推"在任意视角下都成立，不依赖固定像素偏移。
      const dx = handle.dx
      const dy = handle.dy

      // button 的取值必须符合浏览器真实语义：
      // pointermove 期间 button 是 -1（buttons 表示"哪些键被按住"）。
      // TransformControls.pointerMove 里一旦发现 pointer.button !== -1 就直接 return，
      // 如果这里偷懒写 0，拖动会在库内部被静默丢弃。
      const fire = (type, x, y) => {
        const isMove = type === 'pointermove'
        canvas.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            button: isMove ? -1 : 0,
            buttons: type === 'pointerup' ? 0 : 1,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true
          })
        )
      }

      // hover：让 TransformControls 自己判定命中哪一个轴。
      fire('pointermove', handle.x, handle.y)
      await new Promise((r) => setTimeout(r, 80))
      const hoverAxis = window.__XBH_DIAGNOSE__.scene()?.gizmoAxis ?? null

      fire('pointerdown', handle.x, handle.y)
      await new Promise((r) => setTimeout(r, 80))

      const stepX = dx * 8
      const stepY = dy * 8
      for (let step = 1; step <= 18; step += 1) {
        fire('pointermove', handle.x + stepX * step, handle.y + stepY * step)
        await new Promise((r) => setTimeout(r, 20))
      }
      const draggingAxis = window.__XBH_DIAGNOSE__.scene()?.gizmoAxis ?? null
      const draggingFlag = window.__XBH_DIAGNOSE__.scene()?.gizmoDragging ?? false

      fire('pointerup', handle.x + stepX * 18, handle.y + stepY * 18)
      await new Promise((r) => setTimeout(r, 400))

      return {
        ok: true,
        grabX: handle.x,
        grabY: handle.y,
        handleAxis: handle.axis,
        hoverAxis,
        draggingAxis,
        draggingFlag,
        rect: { left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
      }
    })()`)
  }

  // ---------------------------------------------------------------
  // 1. 物体：拖动 gizmo 改变坐标
  // ---------------------------------------------------------------
  await clickRow('方块')
  let snapshot = await evaluate('window.__XBH_DIAGNOSE__.scene()')
  console.log('选中方块:', JSON.stringify(snapshot.selectedIds), 'gizmo 挂载:', snapshot.gizmoAttached)
  check(snapshot.gizmoAttached, '选中方块后控制柄已挂载')
  check(Boolean(snapshot.gizmo && snapshot.gizmo.handles.length > 0), '探针能算出轴手柄屏幕坐标', `handles=${snapshot.gizmo?.handles.length ?? 0}`)

  const beforeObject = snapshot.objects[0]
  const drag1 = await dragAxis('auto')
  console.log('拖拽信息:', JSON.stringify(drag1))
  snapshot = await evaluate('window.__XBH_DIAGNOSE__.scene()')
  const afterObject = snapshot.objects[0]
  console.log('物体位置: 前', JSON.stringify(beforeObject.position), '后', JSON.stringify(afterObject.position))

  const objectMoved = ['x', 'y', 'z'].some(
    (k) => Math.abs(afterObject.position[k] - beforeObject.position[k]) > 0.02
  )
  check(objectMoved, 'gizmo 拖动改变了方块坐标')

  // ---------------------------------------------------------------
  // 2. 摄影机：拖动 gizmo 改变机位
  // ---------------------------------------------------------------
  await clickRow('摄影机')
  snapshot = await evaluate('window.__XBH_DIAGNOSE__.scene()')
  console.log('选中摄影机:', snapshot.cameraSelected, 'gizmo 挂载:', snapshot.gizmoAttached)
  check(snapshot.cameraSelected, '点击层级里的摄影机能选中摄影机')
  check(snapshot.gizmoAttached, '摄影机选中后控制柄已挂载')

  const beforeCamera = snapshot.sceneCamera
  const drag2 = await dragAxis('auto')
  console.log('拖拽信息:', JSON.stringify(drag2))
  snapshot = await evaluate('window.__XBH_DIAGNOSE__.scene()')
  const afterCamera = snapshot.sceneCamera
  console.log('相机位置: 前', JSON.stringify(beforeCamera.position), '后', JSON.stringify(afterCamera.position))

  const cameraMoved = ['x', 'y', 'z'].some(
    (k) => Math.abs(afterCamera.position[k] - beforeCamera.position[k]) > 0.02
  )
  check(cameraMoved, 'gizmo 拖动改变了场景相机机位')

  const targetMoved = ['x', 'y', 'z'].some(
    (k) => Math.abs(afterCamera.target[k] - beforeCamera.target[k]) > 0.02
  )
  check(targetMoved, '摄影机平移后朝向目标同步跟随')

  // ---------------------------------------------------------------
  console.log('')
  const passed = results.filter(Boolean).length
  console.log(`${passed}/${results.length} passed`)
  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  if (process.env.SHOT_PATH) {
    // 截图前重新选中方块：让画面里带上"控制柄挂载在物体上"的样子，
    // 否则最后停在摄影机选中态，控制柄在视野外，截图看不出 gizmo。
    await clickRow('方块')
    await sleep(500)
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
  console.error('verify-gizmo failed:', error.message)
  process.exit(1)
})
