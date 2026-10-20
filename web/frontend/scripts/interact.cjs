/**
 * 交互冒烟：在真实浏览器里点一遍左侧工具栏与视口，确认事件真的生效。
 *
 * 为什么需要它：无头截图只能证明"画出来了"，证明不了"点得动"。
 * 之前的 bug 正是"按钮尺寸正常但点击无响应"，必须用真实事件链验证。
 *
 * 用法（需先启动后端与带调试端口的 Edge）：
 *   DEBUG_PORT=9224 node scripts/interact.cjs http://127.0.0.1:8091/editor
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
        (result.exceptionDetails.exception &&
          result.exceptionDetails.exception.description) ||
          result.exceptionDetails.text
      )
    }
    return result.result.value
  }

  // 在页面里用真实的鼠标事件点击某个选择器，然后回报结果。
  const clickTest = async (label, selector, verifyExpression) => {
    const script = `(async () => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return { ok: false, reason: 'selector not found: ' + ${JSON.stringify(selector)} }
      const box = el.getBoundingClientRect()
      const x = box.left + box.width / 2
      const y = box.top + box.height / 2
      const fire = (type) => el.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1
      }))
      fire('pointerdown'); fire('mousedown'); fire('pointerup'); fire('mouseup'); fire('click')
      await new Promise((r) => setTimeout(r, 400))
      return { ok: true, value: (${verifyExpression}) }
    })()`
    const result = await evaluate(script)
    console.log(`${result.ok ? 'CLICK' : 'SKIP '} ${label} -> ${JSON.stringify(result)}`)
    return result
  }

  /**
   * 状态探针。
   *
   * 生产构建里 Vue 不会往根元素挂 `__vue__`（devtools 钩子在 production 被裁掉），
   * 所以不能从实例上取 store。改为读"用户能看到的 DOM"：
   * 资产列表的条目数、被激活的按钮、属性面板标题——
   * 这些恰好是用户判断"点了有没有反应"的依据，验证价值更高。
   */
  const storeProbe = `(() => {
    const activeRail = [...document.querySelectorAll('.rail-btn.is-active')]
      .map((b) => b.getAttribute('title'))
    const panelTitle = document.querySelector('.inspector__head span')
    return {
      assetRows: document.querySelectorAll('.asset-panel .list-row').length,
      objectRows: document.querySelectorAll('.asset-panel .asset-panel__body > .list-row').length,
      activeRail,
      inspectorTitle: panelTitle ? panelTitle.textContent.trim() : null,
      selectionBoxCount: document.querySelectorAll('.asset-panel .list-row.is-active').length
    }
  })()`

  console.log('=== BEFORE ===')
  console.log(JSON.stringify(await evaluate(storeProbe)))

  await clickTest('工具栏：方块', '.tool-rail__group:nth-child(2) .rail-btn:nth-child(1)', storeProbe)
  await clickTest('工具栏：球体', '.tool-rail__group:nth-child(2) .rail-btn:nth-child(5)', storeProbe)
  await clickTest('工具栏：人台', '.tool-rail__group:nth-child(2) .rail-btn:nth-child(6)', storeProbe)
  await clickTest('工具栏：涂色', '.tool-rail__group:nth-child(1) .rail-btn:nth-child(5)', storeProbe)
  await clickTest('工具栏：旋转', '.tool-rail__group:nth-child(1) .rail-btn:nth-child(3)', storeProbe)

  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  socket.close()
}

main().catch((error) => {
  console.error('interact failed:', error.message)
  process.exit(1)
})
