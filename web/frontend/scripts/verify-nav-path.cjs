/**
 * 导航线（路径）端到端验证。
 *
 * 判定依据全部来自场景探针（window.__XBH_DIAGNOSE__.scene()）与真实 DOM 测量，
 * 而不是截图——"线上有几个小圆点"在缩略图上根本数不清。
 *
 * 覆盖：
 *   1. 时间轴面板不再溢出（播放头不再贯穿到面板外）
 *   2. 时间轴可以拖拽调整高度
 *   3. 画出的导航线真的落在场景里（节点数 / 世界坐标）
 *   4. 导航线节点自动出现在时间轴的导航线轨道上
 *   5. 物体能绑定到导航线，并沿路径运动 + 朝向跟随
 *   6. 沿路径拖拽节点会同步移动时间轴标记（线性插值）
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/verify-nav-path.cjs http://127.0.0.1:8181/editor
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
      // 等调试端口。
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

  // 关掉恢复弹窗，保证从干净场景开始。
  await evaluate(`(async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const dialog = document.querySelector('[aria-label="恢复未保存内容"]')
      if (!dialog) { await new Promise((r) => setTimeout(r, 150)); continue }
      const discard = [...dialog.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '放弃')
      if (discard) discard.click()
      await new Promise((r) => setTimeout(r, 600))
      return
    }
  })()`)
  await sleep(300)

  const results = []
  const check = (ok, label, detail) => {
    results.push(ok)
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  }

  // ---------------------------------------------------------------
  // 1. 时间轴布局：播放头不得溢出面板
  // ---------------------------------------------------------------
  const layout = await evaluate(`(() => {
    const timeline = document.querySelector('.timeline')
    const playhead = document.querySelector('.playhead')
    const ruler = document.querySelector('.ruler')
    if (!timeline || !playhead || !ruler) return { ok: false, reason: '找不到时间轴元素' }
    const timelineRect = timeline.getBoundingClientRect()
    const playheadRect = playhead.getBoundingClientRect()
    const rulerRect = ruler.getBoundingClientRect()
    return {
      ok: true,
      // 播放头必须完全落在时间轴面板内（旧版本 bottom:-100px 会伸到面板外）
      playheadInside: playheadRect.bottom <= timelineRect.bottom + 1,
      playheadHeight: Math.round(playheadRect.height),
      rulerHeight: Math.round(rulerRect.height),
      // 轨道必须裁剪，否则标记会盖到侧栏上
      rulerOverflow: getComputedStyle(ruler).overflow,
      trackOverflow: getComputedStyle(document.querySelector('.lane__track')).overflow,
      timelineHeight: Math.round(timelineRect.height)
    }
  })()`)
  console.log('时间轴布局:', JSON.stringify(layout))

  check(layout.ok === true, '时间轴元素齐全', layout.reason || '')
  check(
    layout.ok === true && layout.playheadInside === true,
    '播放头没有溢出时间轴面板（黑条已修复）',
    layout.ok ? `playhead 高 ${layout.playheadHeight}px / ruler 高 ${layout.rulerHeight}px` : ''
  )
  check(
    layout.ok === true && layout.playheadHeight <= layout.rulerHeight + 2,
    '播放头高度被限制在标尺内',
    layout.ok ? `${layout.playheadHeight} <= ${layout.rulerHeight}` : ''
  )
  check(
    layout.ok === true && layout.rulerOverflow === 'hidden' && layout.trackOverflow === 'hidden',
    '轨道与标尺都做了裁剪',
    layout.ok ? `ruler=${layout.rulerOverflow} track=${layout.trackOverflow}` : ''
  )

  // ---------------------------------------------------------------
  // 2. 时间轴可拖拽调整高度
  // ---------------------------------------------------------------
  const resize = await evaluate(`(async () => {
    const resizer = document.querySelector('.timeline__resizer')
    const timeline = document.querySelector('.timeline')
    if (!resizer || !timeline) return { ok: false, reason: '找不到高度抓取带' }
    const before = Math.round(timeline.getBoundingClientRect().height)
    const rect = resizer.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2

    const fire = (el, type, clientY) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire(resizer, 'pointerdown', y)
    // 往上拖 90px = 高度增加 90px
    for (let step = 1; step <= 6; step += 1) {
      fire(window, 'pointermove', y - (90 * step) / 6)
      await new Promise((r) => setTimeout(r, 30))
    }
    fire(window, 'pointerup', y - 90)
    await new Promise((r) => setTimeout(r, 200))

    const after = Math.round(timeline.getBoundingClientRect().height)
    return { ok: true, before, after, delta: after - before }
  })()`)
  console.log('时间轴缩放:', JSON.stringify(resize))

  check(
    resize.ok === true && resize.delta >= 80,
    '拖拽顶边可以加高时间轴',
    resize.ok ? `${resize.before}px → ${resize.after}px` : resize.reason
  )

  // 恢复原高度，避免影响后续断言的可视区域。
  await evaluate(`(async () => {
    const resizer = document.querySelector('.timeline__resizer')
    const rect = resizer.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const fire = (el, type, clientY) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))
    fire(resizer, 'pointerdown', y)
    fire(window, 'pointermove', y + 90)
    fire(window, 'pointerup', y + 90)
    await new Promise((r) => setTimeout(r, 150))
  })()`)

  // ---------------------------------------------------------------
  // 3. 画一条导航线
  // ---------------------------------------------------------------
  const drawn = await evaluate(`(async () => {
    const buttons = [...document.querySelectorAll('.rail-btn')]
    const button = buttons.find((b) => (b.getAttribute('title') || '').includes('导航线'))
    if (!button) return { ok: false, reason: '工具栏里找不到导航线按钮' }
    button.click()
    await new Promise((r) => setTimeout(r, 400))

    const canvas = document.querySelector('.viewport-canvas')
    if (!canvas) return { ok: false, reason: '找不到视口画布' }
    const rect = canvas.getBoundingClientRect()
    // 从画面左侧拖到右侧，横穿地面。
    const startX = rect.left + rect.width * 0.32
    const endX = rect.left + rect.width * 0.68
    const y = rect.top + rect.height * 0.72

    const fire = (el, type, clientX, clientY) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX, clientY,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire(canvas, 'pointerdown', startX, y)
    await new Promise((r) => setTimeout(r, 60))
    const steps = 14
    for (let step = 1; step <= steps; step += 1) {
      fire(canvas, 'pointermove', startX + ((endX - startX) * step) / steps, y)
      await new Promise((r) => setTimeout(r, 45))
    }
    fire(canvas, 'pointerup', endX, y)
    await new Promise((r) => setTimeout(r, 500))

    const snapshot = window.__XBH_DIAGNOSE__.scene()
    const path = (snapshot.paths || []).find((item) => !item.draft)
    return { ok: true, path: path || null, pathCount: (snapshot.paths || []).length }
  })()`)
  console.log('绘制结果:', JSON.stringify(drawn))

  check(drawn.ok === true, '可以在工具栏选中导航线绘制', drawn.reason || '')
  check(
    Boolean(drawn.path) && drawn.path.nodeCount >= 2,
    '按住左键画出了一条带节点的导航线',
    drawn.path ? `节点数=${drawn.path.nodeCount}` : '没有生成路径'
  )
  check(
    Boolean(drawn.path) && drawn.path.nodes.every((node) => Number.isFinite(node.position.x)),
    '导航线节点世界坐标有效',
    drawn.path ? JSON.stringify(drawn.path.nodes[0]?.position) : ''
  )

  // ---------------------------------------------------------------
  // 4. 导航线出现在时间轴轨道上
  // ---------------------------------------------------------------
  const track = await evaluate(`(() => {
    const labels = [...document.querySelectorAll('.lane__label')].map((el) => el.textContent.trim())
    const markers = [...document.querySelectorAll('.path-marker')].map((el) => {
      const rect = el.getBoundingClientRect()
      return { left: Math.round(rect.left) }
    })
    return { labels, markerCount: markers.length, markers }
  })()`)
  console.log('时间轴轨道:', JSON.stringify(track))

  check(
    track.labels.some((label) => label.includes('导航线')),
    '时间轴里出现了导航线轨道',
    `轨道标签：${track.labels.join(' / ')}`
  )
  check(
    track.markerCount >= 2,
    '导航线节点在时间轴上有对应标记',
    `标记数=${track.markerCount}`
  )
  check(
    track.markers.length >= 2 &&
      track.markers[track.markers.length - 1].left > track.markers[0].left,
    '标记按时间顺序从左到右排布',
    JSON.stringify(track.markers)
  )

  // ---------------------------------------------------------------
  // 5. 绑定物体到导航线，验证沿路径运动 + 朝向
  // ---------------------------------------------------------------
  const binding = await evaluate(`(async () => {
    // 选中方块
    const rows = [...document.querySelectorAll('.asset-panel .list-row')]
    const boxRow = rows.find((r) => (r.querySelector('.list-row__name')?.value || '').includes('方块'))
    if (!boxRow) return { ok: false, reason: '资产列表里找不到方块' }
    boxRow.click()
    await new Promise((r) => setTimeout(r, 400))

    const select = [...document.querySelectorAll('.panel__section select')]
      .find((s) => [...s.options].some((o) => (o.textContent || '').includes('导航线')))
    if (!select) return { ok: false, reason: '属性面板里找不到绑定下拉框' }
    const option = [...select.options].find((o) => (o.textContent || '').includes('导航线'))
    select.value = option.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 500))

    const snapshot = window.__XBH_DIAGNOSE__.scene()
    const box = snapshot.objects.find((o) => o.kind === 'box')
    return { ok: true, binding: box?.pathBinding ?? null, position: box?.position ?? null }
  })()`)
  console.log('绑定结果:', JSON.stringify(binding))

  check(
    binding.ok === true && typeof binding.binding === 'string' && binding.binding.length > 0,
    '方块可以绑定到导航线',
    binding.ok ? `pathBinding=${binding.binding}` : binding.reason
  )

  // 拖播放头，验证物体沿路径移动且朝向变化
  const motion = await evaluate(`(async () => {
    const ruler = document.querySelector('.ruler')
    const rect = ruler.getBoundingClientRect()
    const fire = (el, type, ratio) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX: rect.left + rect.width * ratio, clientY: rect.top + rect.height / 2,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))
    /*
     * 期望朝向独立算一遍，不复用被测代码。
     *
     * 在探针数据里找"方块所在的那一段路径"，再用 atan2(dx, dz)
     * 算期望偏航角，和视口里的实际值比对。
     * 不能用"拖动前后朝向不同"来判定：这条路径是直的，朝向本来就不该变。
     */
    const expectedYaw = (box, nodes) => {
      let best = null
      for (let i = 1; i < nodes.length; i += 1) {
        const a = nodes[i - 1].position
        const b = nodes[i].position
        const dx = b.x - a.x
        const dz = b.z - a.z
        const lengthSq = dx * dx + dz * dz
        let t = 0
        if (lengthSq > 1e-9) t = ((box.x - a.x) * dx + (box.z - a.z) * dz) / lengthSq
        t = Math.min(Math.max(t, 0), 1)
        const distance = Math.hypot(box.x - (a.x + dx * t), box.z - (a.z + dz * t))
        if (!best || distance < best.distance) {
          const length = Math.hypot(dx, dz) || 1
          best = { distance, yaw: (Math.atan2(dx / length, dz / length) * 180) / Math.PI }
        }
      }
      return best ? best.yaw : null
    }

    const read = () => {
      const snapshot = window.__XBH_DIAGNOSE__.scene()
      const box = snapshot.objects.find((o) => o.kind === 'box')
      const path = (snapshot.paths || []).find((item) => !item.draft)
      const yaw = box && path ? expectedYaw(box.position, path.nodes) : null
      return {
        position: box?.position,
        rotation: box?.rotation,
        expectedYaw: yaw === null ? null : Math.round(yaw * 100) / 100
      }
    }

    fire(ruler, 'pointerdown', 0.02)
    await new Promise((r) => setTimeout(r, 250))
    const early = read()

    fire(window, 'pointermove', 0.9)
    fire(window, 'pointerup', 0.9)
    await new Promise((r) => setTimeout(r, 350))
    const late = read()

    return { ok: true, early, late }
  })()`)
  console.log('沿路径运动:', JSON.stringify(motion))

  const moved =
    motion.ok === true &&
    motion.early?.position &&
    motion.late?.position &&
    Math.hypot(
      motion.late.position.x - motion.early.position.x,
      motion.late.position.z - motion.early.position.z
    ) > 0.2
  check(moved, '拖动播放头时方块沿导航线移动', motion.ok ? JSON.stringify(motion.late?.position) : '')
  const yawDelta = (entry) => {
    if (!entry || !Number.isFinite(entry.rotation?.y) || entry.expectedYaw === null) return Infinity
    // 按最短角路径比较，允许 0.5 度误差。
    return Math.abs(((entry.rotation.y - entry.expectedYaw + 180) % 360) - 180)
  }
  check(
    yawDelta(motion.late) < 0.5,
    '方块朝向跟随导航线方向（与独立算出的期望偏航角一致）',
    motion.ok ? `实际 ${motion.late?.rotation?.y}° / 期望 ${motion.late?.expectedYaw}°` : ''
  )

  // ---------------------------------------------------------------
  // 6. 沿路径拖拽节点 → 时间轴标记跟着移动
  // ---------------------------------------------------------------
  const drag = await evaluate(`(async () => {
    const snapshotBefore = window.__XBH_DIAGNOSE__.scene()
    const path = (snapshotBefore.paths || []).find((item) => !item.draft)
    if (!path || path.nodes.length < 2) return { ok: false, reason: '没有可拖拽的节点' }

    // 选中间那个节点，拖动它会让两段长度比例变化 → 后续标记时刻跟着变。
    const index = Math.floor(path.nodes.length / 2)
    const node = path.nodes[index]
    if (!node.screen || !node.screen.inFront) return { ok: false, reason: '节点不在画面前方' }

    const markerBefore = [...document.querySelectorAll('.path-marker')]
      .map((el) => Math.round(el.getBoundingClientRect().left))

    const canvas = document.querySelector('.viewport-canvas')
    const rect = canvas.getBoundingClientRect()
    const fromX = rect.left + node.screen.x
    const fromY = rect.top + node.screen.y

    const fire = (el, type, clientX, clientY) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX, clientY,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire(canvas, 'pointerdown', fromX, fromY)
    await new Promise((r) => setTimeout(r, 80))
    // 沿着路径方向往右推 60px（路径大致横穿画面）
    for (let step = 1; step <= 8; step += 1) {
      fire(canvas, 'pointermove', fromX + (60 * step) / 8, fromY)
      await new Promise((r) => setTimeout(r, 40))
    }
    fire(canvas, 'pointerup', fromX + 60, fromY)
    await new Promise((r) => setTimeout(r, 450))

    const snapshotAfter = window.__XBH_DIAGNOSE__.scene()
    const pathAfter = (snapshotAfter.paths || []).find((item) => !item.draft)
    const markerAfter = [...document.querySelectorAll('.path-marker')]
      .map((el) => Math.round(el.getBoundingClientRect().left))

    const before = path.nodes[index].position
    const after = pathAfter?.nodes?.[index]?.position ?? null
    return { ok: true, index, before, after, markerBefore, markerAfter }
  })()`)
  console.log('节点拖拽:', JSON.stringify(drag))

  const nodeMoved =
    drag.ok === true &&
    drag.after &&
    Math.hypot(drag.after.x - drag.before.x, drag.after.z - drag.before.z) > 0.15
  check(nodeMoved, '导航线节点可以沿路径拖拽（线性插值）', drag.ok ? JSON.stringify(drag.after) : drag.reason)
  check(
    drag.ok === true &&
      drag.markerAfter.length === drag.markerBefore.length &&
      drag.markerBefore.some((left, index) => Math.abs(left - (drag.markerAfter[index] ?? left)) > 1),
    '拖拽节点后时间轴标记跟着移动',
    drag.ok ? `${JSON.stringify(drag.markerBefore)} → ${JSON.stringify(drag.markerAfter)}` : ''
  )

  // ---------------------------------------------------------------
  // 7. 手动加节点
  // ---------------------------------------------------------------
  const manual = await evaluate(`(async () => {
    /*
     * 必须先选回导航线。
     *
     * 上一步为了绑定选中了方块，属性面板此刻显示的是方块的表单。
     * 直接找按钮会落空——这不是 UI bug，而是验证脚本漏了切换选中项。
     */
    const rows = [...document.querySelectorAll('.asset-panel .list-row')]
    const pathRow = rows.find((r) => (r.querySelector('.list-row__name')?.value || '').includes('导航线'))
    if (!pathRow) return { ok: false, reason: '资产列表里找不到导航线' }
    pathRow.click()
    await new Promise((r) => setTimeout(r, 400))

    const before = window.__XBH_DIAGNOSE__.scene()
    const pathBefore = (before.paths || []).find((item) => !item.draft)
    const button = [...document.querySelectorAll('.panel__section .btn')]
      .find((b) => (b.textContent || '').includes('在最长段加节点'))
    if (!button) return { ok: false, reason: '找不到"在最长段加节点"按钮' }
    button.click()
    await new Promise((r) => setTimeout(r, 400))
    const after = window.__XBH_DIAGNOSE__.scene()
    const pathAfter = (after.paths || []).find((item) => !item.draft)
    return { ok: true, before: pathBefore?.nodeCount ?? 0, after: pathAfter?.nodeCount ?? 0 }
  })()`)
  console.log('手动加节点:', JSON.stringify(manual))

  check(
    manual.ok === true && manual.after === manual.before + 1,
    '属性面板可以手动添加节点',
    manual.ok ? `${manual.before} → ${manual.after}` : manual.reason
  )

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
  console.error('verify-nav-path failed:', error.message)
  process.exit(1)
})
