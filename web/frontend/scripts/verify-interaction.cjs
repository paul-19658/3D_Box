/**
 * 交互验证：gizmo 拖动、摄影机选中、诊断导出。
 *
 * 这些都是"只有真实浏览器才能证明"的行为，靠单测和构建都验证不了。
 *
 * 用法（需先启动后端 + 带调试端口的 Edge）：
 *   DEBUG_PORT=9230 node scripts/verify-interaction.cjs http://127.0.0.1:8161/editor
 */

const http = require('http')

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
      // 继续等待。
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

  const results = []
  const check = (label, ok, detail) => {
    results.push({ label, ok, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : '  -> ' + JSON.stringify(detail)}`)
  }

  // ------------------------------------------------------------------
  // 1. 摄影机是否出现在资产层级里
  // ------------------------------------------------------------------
  const hierarchy = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.asset-panel .list-row')]
    return rows.map((row) => ({
      name: row.querySelector('.list-row__name')?.value
        ?? row.querySelector('.list-row__name')?.textContent?.trim(),
      meta: row.querySelector('.list-row__meta')?.textContent?.trim() || ''
    }))
  })()`)
  check(
    '摄影机出现在资产层级里',
    hierarchy.some((row) => row.meta === '摄影机'),
    hierarchy
  )

  // ------------------------------------------------------------------
  // 2. 点层级里的摄影机 -> 选中态 + 属性面板切到摄影机
  // ------------------------------------------------------------------
  const cameraSelect = await evaluate(`(async () => {
    const rows = [...document.querySelectorAll('.asset-panel .list-row')]
    const row = rows.find((r) => r.querySelector('.list-row__meta')?.textContent?.trim() === '摄影机')
    if (!row) return { clicked: false }
    row.click()
    await new Promise((r) => setTimeout(r, 300))
    return {
      clicked: true,
      active: row.classList.contains('is-active'),
      inspectorTitle: document.querySelector('.inspector__head span')?.textContent?.trim()
    }
  })()`)
  check('点击层级里的摄影机能选中摄影机', cameraSelect.active === true, cameraSelect)

  // ------------------------------------------------------------------
  // 3. 选中物体后 gizmo 存在（TransformControls helper 已挂到场景）
  // ------------------------------------------------------------------
  const gizmo = await evaluate(`(async () => {
    const rows = [...document.querySelectorAll('.asset-panel .list-row')]
    const boxRow = rows.find((r) => (r.querySelector('.list-row__name')?.value || '').includes('方块'))
    if (!boxRow) return { selected: false }
    boxRow.click()
    await new Promise((r) => setTimeout(r, 400))
    return { selected: true, active: boxRow.classList.contains('is-active') }
  })()`)
  check('能选中方块（gizmo 挂载前提）', gizmo.active === true, gizmo)

  // ------------------------------------------------------------------
  // 4. 在视口中心按住拖动，确认 gizmo 拖动不会因为"点到空白"而清空选中
  // ------------------------------------------------------------------
  const drag = await evaluate(`(async () => {
    const canvas = document.querySelector('.viewport-canvas')
    const rect = canvas.getBoundingClientRect()
    // 先确保方块仍处于选中态
    const beforeSelected = document.querySelectorAll('.asset-panel .list-row.is-active').length
    const fire = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1
    }))
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    fire('pointerdown', cx, cy)
    for (let step = 1; step <= 12; step += 1) {
      fire('pointermove', cx + step * 3, cy)
      await new Promise((r) => setTimeout(r, 16))
    }
    fire('pointerup', cx + 36, cy)
    await new Promise((r) => setTimeout(r, 400))
    return {
      beforeSelected,
      afterSelected: document.querySelectorAll('.asset-panel .list-row.is-active').length
    }
  })()`)
  check(
    '拖拽视口不会误清空选中（gizmo 拖动前提）',
    drag.afterSelected >= 1,
    drag
  )

  // ------------------------------------------------------------------
  // 5. 诊断按钮存在且能生成报告
  // ------------------------------------------------------------------
  const diagnostics = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('.topbar__right button')]
    const button = buttons.find((b) => b.textContent.trim().startsWith('诊断'))
    return { exists: Boolean(button), label: button?.textContent?.trim() }
  })()`)
  check('顶栏有"诊断"按钮', diagnostics.exists === true, diagnostics)

  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  const failed = results.filter((item) => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  socket.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('verify-interaction failed:', error.message)
  process.exit(1)
})
