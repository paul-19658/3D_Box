/**
 * 三项修复的端到端验证。
 *
 *   1. 导出的视频**真的有动画**（不是一张静态图 + 轻微运镜）
 *   2. 时间轴标尺与物体轨道的 0 点对齐（同一 x 起点）
 *   3. 拖拽造物时镜头不跟着转（OrbitControls 被隔离）
 *
 * 三条判定都刻意避开"看起来对":
 *
 * 第 1 条：不看 MP4（解不了 H.264），而是让流程只导出**首尾帧**，
 *   然后比对两张 PNG 的字节。PNG 编码确定，同像素必同字节；
 *   "只有相机在动、物体不动"这个 bug 恰好会让两张图完全相同。
 *   全流程走 UI，不读 Vue 实例内部——生产构建里 `#app.__vue__` 不存在。
 *
 * 第 2 条：不量"标尺有没有画出来"，而是量标尺与每条轨道的
 *   `getBoundingClientRect()` 左右边界是否**同一像素**。
 *
 * 第 3 条：全部用 CDP `Input.dispatchMouseEvent` 派发**真实**输入。
 *   合成 `new PointerEvent()` 驱动不了 OrbitControls（它内部要真实
 *   pointer capture，合成事件会直接抛错中断处理），于是"镜头没转"
 *   既可能是"隔离生效"也可能是"事件被打断"——同一个观测值对应两种
 *   完全不同的状态，断言就没有信息量。
 *   真实输入下还加了一条**反向对照**：切回选择工具后同样的拖拽必须
 *   能转镜头。否则"controls 永久锁死"也能让正向断言全绿。
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/verify-export-fixes.cjs http://127.0.0.1:8181/editor
 */

const http = require('http')

const target = process.argv[2] || 'http://127.0.0.1:8000/editor'
const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 9222
const API_BASE = process.env.API_BASE || target.replace(/\/editor.*$/, '')

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

/** 下载导出产物，拿到真实字节（首尾帧比对要用）。 */
function fetchBytes(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`下载失败 ${res.statusCode}`))
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks)))
      })
      .on('error', reject)
  })
}

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

  // ===============================================================
  // 2. 时间轴对齐（先做，因为它不需要造数据）
  // ===============================================================
  const alignment = await evaluate(`(() => {
    const ruler = document.querySelector('.ruler')
    const laneTracks = [...document.querySelectorAll('.lane__track')]
    if (!ruler || laneTracks.length === 0) return { ok: false, reason: '找不到标尺或轨道' }
    const rulerRect = ruler.getBoundingClientRect()
    return {
      ok: true,
      rulerLeft: Math.round(rulerRect.left),
      rulerRight: Math.round(rulerRect.right),
      lanes: laneTracks.map((track) => {
        const rect = track.getBoundingClientRect()
        return { left: Math.round(rect.left), right: Math.round(rect.right) }
      })
    }
  })()`)
  console.log('时间轴对齐:', JSON.stringify(alignment))

  check(alignment.ok === true, '能找到标尺与轨道', alignment.reason || '')

  if (alignment.ok) {
    // 每一条轨道的左右边界都必须与标尺一致（容差 1px 抗亚像素舍入）。
    const mismatched = alignment.lanes.filter(
      (lane) => Math.abs(lane.left - alignment.rulerLeft) > 1 || Math.abs(lane.right - alignment.rulerRight) > 1
    )
    check(
      mismatched.length === 0,
      '标尺与所有物体轨道的横向范围完全对齐（0 点同一 x）',
      mismatched.length === 0
        ? `ruler=${alignment.rulerLeft}..${alignment.rulerRight}`
        : `不一致的轨道：${JSON.stringify(mismatched)}`
    )
  }

  // ===============================================================
  // 3. 拖拽造物时镜头不跟着转
  // ===============================================================
  /*
   * 这里**刻意不用** `new PointerEvent(...)` + dispatchEvent。
   *
   * 合成事件没有真实的 pointer 关联，OrbitControls 内部的
   * `setPointerCapture` 会抛 NotFoundError 并中断它自己的处理，
   * 于是"镜头没转"既可能是"隔离生效"，也可能是"事件处理被打断了"——
   * 两种截然不同的状态给出同一个观测值，这条断言就没有信息量。
   *
   * 改用 CDP 的 `Input.dispatchMouseEvent`：浏览器走完整的原生输入管线，
   * 产生真实的 pointer 序列，与用户手拖完全一致。
   *
   * 这样才敢下两个互相反向的结论：
   *   - 造物拖拽期间镜头不动（隔离生效）；
   *   - 切回选择工具后，同样的拖拽**确实**能转镜头（没被永久锁死）。
   * 缺了第二条，"controls 永久禁用"这种更糟糕的 bug 也能全绿通过。
   */
  const canvasRect = await evaluate(`(() => {
    const canvas = document.querySelector('.viewport-canvas')
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })()`)

  if (canvasRect) {
    const mouse = (type, x, y, buttons) =>
      send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: 'left',
        buttons,
        clickCount: 1,
        pointerType: 'mouse'
      })

    const realDrag = async (fromX, fromY, dx, steps) => {
      await mouse('mousePressed', fromX, fromY, 1)
      await sleep(90)
      for (let step = 1; step <= steps; step += 1) {
        await mouse('mouseMoved', fromX + (dx * step) / steps, fromY, 1)
        await sleep(35)
      }
      return { lastX: fromX + dx, lastY: fromY }
    }

    const clickTool = async (title) => {
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('.rail-btn')]
          .find((b) => (b.getAttribute('title') || '') === ${JSON.stringify(title)})
        if (button) button.click()
      })()`)
      await sleep(450)
    }

    // --- 真实拖拽造物 ---
    await clickTool('墙体')
    const wallsBefore = await evaluate(
      `window.__XBH_DIAGNOSE__.scene().objects.filter((o) => o.kind === 'wall').length`
    )
    const realBefore = await evaluate('window.__XBH_DIAGNOSE__.editorCamera()')

    const dragStart = {
      x: canvasRect.left + canvasRect.width * 0.3,
      y: canvasRect.top + canvasRect.height * 0.65
    }
    const end = await realDrag(dragStart.x, dragStart.y, canvasRect.width * 0.35, 12)
    const realDuring = await evaluate('window.__XBH_DIAGNOSE__.editorCamera()')
    await mouse('mouseReleased', end.lastX, end.lastY, 0)
    await sleep(500)

    const realAfter = await evaluate('window.__XBH_DIAGNOSE__.editorCamera()')
    const wallsAfter = await evaluate(
      `window.__XBH_DIAGNOSE__.scene().objects.filter((o) => o.kind === 'wall').length`
    )

    const realMoved = Math.hypot(
      realAfter.position.x - realBefore.position.x,
      realAfter.position.z - realBefore.position.z
    )
    console.log(
      '真实拖拽:',
      JSON.stringify({ realMoved: Number(realMoved.toFixed(4)), realDuring, wallsBefore, wallsAfter })
    )

    check(realMoved < 0.05, '真实拖拽造物时镜头没有转动', `相机位移 ${realMoved.toFixed(4)}`)
    check(
      realDuring.controlsEnabled === false,
      '真实拖拽期间 controls 处于禁用态',
      `controlsEnabled=${realDuring.controlsEnabled}`
    )
    check(wallsAfter > wallsBefore, '真实拖拽确实生成了墙体', `${wallsBefore} → ${wallsAfter}`)
    check(realAfter.controlsEnabled === true, '真实松开后 controls 已恢复', `controlsEnabled=${realAfter.controlsEnabled}`)

    /*
     * 反向对照：切回"选择"工具，同样的真实拖拽必须能转镜头。
     *
     * 没有这一条，"controls 永久禁用"这种 bug 也能让上面全部通过，
     * 而用户的实际体验是"镜头再也转不动了"。
     */
    await clickTool('选择')
    const rotateBefore = await evaluate('window.__XBH_DIAGNOSE__.editorCamera()')
    const rotateEnd = await realDrag(
      canvasRect.left + canvasRect.width * 0.55,
      canvasRect.top + canvasRect.height * 0.45,
      canvasRect.width * 0.3,
      14
    )
    await mouse('mouseReleased', rotateEnd.lastX, rotateEnd.lastY, 0)
    await sleep(700)

    const rotateAfter = await evaluate('window.__XBH_DIAGNOSE__.editorCamera()')
    const rotateMoved = Math.hypot(
      rotateAfter.position.x - rotateBefore.position.x,
      rotateAfter.position.z - rotateBefore.position.z
    )
    console.log('真实转镜头:', JSON.stringify({ rotateMoved: Number(rotateMoved.toFixed(4)) }))

    check(
      rotateMoved > 0.3,
      '切回选择工具后真实拖拽能转动镜头（controls 没被永久锁死）',
      `相机位移 ${rotateMoved.toFixed(4)}`
    )
  } else {
    check(false, '能找到视口画布用于真实输入测试')
  }

  // ===============================================================
  // 1. 导出的视频真的有动画
  // ===============================================================
  /*
   * 全流程走 UI，不碰 Vue 实例内部。
   *
   * 生产构建里 `#app.__vue__` 根本不存在（devtools 钩子被裁掉），
   * 从实例上拿 store 这条路只在开发构建成立，不能写进验证脚本。
   * 这里改成"像用户那样操作"：点资产行 → 改时间 → 记录关键帧 →
   * 改位置 → 再记录关键帧 → 只导出首尾帧。
   *
   * 判定不用看 MP4（解不了 H.264），而是比对**两张首尾帧 PNG 的字节**。
   * 同一台相机、同一场景、只有物体位置不同 —— 两张图必须不同。
   * 若 `renderFrameAt` 只应用相机而丢掉物体变换（正是这次修的 bug），
   * 两张图会一模一样。
   */
  const animated = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    // --- 选中方块 ---
    const rows = [...document.querySelectorAll('.asset-panel .list-row')]
    const boxRow = rows.find((r) => (r.querySelector('.list-row__name')?.value || '').includes('方块'))
    if (!boxRow) return { ok: false, reason: '找不到方块' }
    boxRow.click()
    await wait(400)

    const durationInput = document.querySelector('.duration-input')
    const duration = Number(durationInput?.value || 5)

    const setTime = async (value) => {
      const input = document.querySelector('.time-input')
      if (!input) return false
      input.value = String(value)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(350)
      return true
    }

    const recordKeyframe = async () => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '记录关键帧')
      if (!button) return false
      button.click()
      await wait(450)
      return true
    }

    const boxX = () => {
      const snapshot = window.__XBH_DIAGNOSE__.scene()
      const item = snapshot.objects.find((o) => o.kind === 'box')
      return item ? item.position.x : null
    }

    // --- 关键帧 1：t=0，保持原位 ---
    if (!(await setTime(0))) return { ok: false, reason: '找不到时间输入框' }
    if (!(await recordKeyframe())) return { ok: false, reason: '找不到"记录关键帧"按钮' }
    const xAtZero = boxX()

    // --- 改位置（属性面板第一组 vector-row 是"位置"） ---
    const positionInput = document.querySelector('.inspector .vector-row input')
    if (!positionInput) return { ok: false, reason: '属性面板里找不到位置输入框' }
    positionInput.value = '-3'
    positionInput.dispatchEvent(new Event('change', { bubbles: true }))
    await wait(350)

    // --- 关键帧 2：t=duration，位置 -3 ---
    if (!(await setTime(duration))) return { ok: false, reason: '设置结束时间失败' }
    if (!(await recordKeyframe())) return { ok: false, reason: '第二次记录关键帧失败' }
    const xAtEnd = boxX()

    // 回到 0 时刻，让"编辑态"与首帧一致。
    await setTime(0)

    return { ok: true, duration, xAtZero, xAtEnd }
  })()`)
  console.log('关键帧构造:', JSON.stringify(animated))

  check(animated.ok === true, '用 UI 能构造出两个关键帧', animated.reason || '')

  if (animated.ok) {
    check(
      animated.xAtZero !== null &&
        animated.xAtEnd !== null &&
        Math.abs(animated.xAtEnd - animated.xAtZero) > 2,
      '时间轴时间变化时物体位置确实不同（动画数据成立）',
      `x: ${animated.xAtZero} → ${animated.xAtEnd}`
    )
  }

  /*
   * 只导首尾帧，然后比对两张 PNG 的字节。
   *
   * 这一步才是真正覆盖 `VideoExportDialog.renderFrameAt` 的地方：
   * 三条产物路径都经过它，首尾帧是最快、最不依赖硬件编码能力的一条。
   */
  const endpointDiff = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    // 打开导出对话框。
    const openButton = [...document.querySelectorAll('button')]
      .find((b) => (b.textContent || '').trim() === '导出')
    if (!openButton) return { ok: false, reason: '找不到"导出"按钮' }
    openButton.click()
    await wait(300)
    const item = [...document.querySelectorAll('.menu-item, .dropdown__item, li, button')]
      .find((el) => (el.textContent || '').includes('导出动画'))
    if (item) { item.click(); await wait(500) }

    const panel = document.querySelector('[aria-label="导出动画视频"]')
    if (!panel) return { ok: false, reason: '导出对话框没有打开' }

    // 只保留首尾帧：不依赖 WebCodecs，也省掉编码时间。
    const checkboxes = [...panel.querySelectorAll('input[type="checkbox"]')]
    const setChecked = (needle, value) => {
      const box = checkboxes.find((c) => (c.closest('label')?.textContent || '').includes(needle))
      if (box && box.checked !== value) box.click()
    }
    setChecked('MP4 视频', false)
    setChecked('序列帧', false)
    setChecked('首帧', true)
    await wait(300)

    const start = [...panel.querySelectorAll('button')]
      .find((b) => (b.textContent || '').includes('开始导出'))
    if (!start) return { ok: false, reason: '找不到"开始导出"按钮' }
    start.click()

    for (let attempt = 0; attempt < 160; attempt += 1) {
      await wait(400)
      const names = [...panel.querySelectorAll('.result__name')]
        .map((el) => (el.textContent || '').trim())
      if (names.length >= 2) return { ok: true, names }
      const stillBusy = [...panel.querySelectorAll('button')]
        .some((b) => (b.textContent || '').includes('导出中'))
      if (!stillBusy && attempt > 6 && names.length === 0) {
        return { ok: false, reason: '导出结束但没有产物' }
      }
    }
    return { ok: false, reason: '导出超时' }
  })()`)
  console.log('首尾帧导出:', JSON.stringify(endpointDiff))

  check(endpointDiff.ok === true, '导出首尾帧成功', endpointDiff.reason || '')

  if (endpointDiff.ok) {
    const names = endpointDiff.names
    const firstPng = names.find((name) => /_first(-\d+)?\.png$/.test(name))
    const lastPng = names.find((name) => /_last(-\d+)?\.png$/.test(name))
    check(Boolean(firstPng && lastPng), '产物里同时有首帧和尾帧', names.join(', '))

    if (firstPng && lastPng) {
      const apiBase = target.replace(/\/editor.*$/, '')
      const [firstBytes, lastBytes] = await Promise.all([
        fetchBytes(`${apiBase}/api/exports/${encodeURIComponent(firstPng)}`),
        fetchBytes(`${apiBase}/api/exports/${encodeURIComponent(lastPng)}`)
      ])
      console.log('首尾帧体积:', firstBytes.length, lastBytes.length)
      check(firstBytes.length > 1000, '首帧 PNG 不是空文件', `${firstBytes.length} 字节`)
      /*
       * PNG 编码是确定性的：同样的像素必然得到同样的字节。
       * 所以"字节不同"就等价于"画面不同"，不需要额外解码。
       */
      check(
        !firstBytes.equals(lastBytes),
        '首尾帧画面不同（导出时物体变换真的被应用了）',
        `${firstPng} ${firstBytes.length}B vs ${lastPng} ${lastBytes.length}B`
      )
    }
  }

  // ===============================================================
  console.log('')
  const passed = results.filter(Boolean).length
  console.log(`${passed}/${results.length} passed`)
  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  socket.close()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  console.error('verify-export-fixes failed:', error.message)
  process.exit(1)
})
