/**
 * 无头浏览器诊断脚本。
 *
 * 目的：拿到"页面到底报了什么错"以及 canvas / 容器的真实尺寸，
 * 而不是靠截图猜。用 CDP（Chrome DevTools Protocol）直连，
 * 把 console、未捕获异常、失败的请求全部收集回来。
 *
 * 用法（需先启动后端）：
 *   node scripts/diagnose.cjs http://127.0.0.1:8061/editor
 */

const http = require('http')

const target = process.argv[2] || 'http://127.0.0.1:8000/editor'
// 端口可通过环境变量覆盖：并行诊断时容易撞默认端口。
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

const formatArgs = (args) =>
  args
    .map((arg) => {
      if (arg.value !== undefined) return String(arg.value)
      if (arg.description) return arg.description
      return arg.type
    })
    .join(' ')

async function main() {
  // 等 Edge 的调试端口就绪。
  let targets = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      targets = await getJSON('/json/list')
      if (targets && targets.length > 0) break
    } catch {
      // 还没起来，继续等。
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!targets || targets.length === 0) throw new Error('调试端口未就绪')

  const page = targets.find((item) => item.type === 'page') || targets[0]
  const socket = new WebSocket(page.webSocketDebuggerUrl)

  let nextId = 1
  const pending = new Map()
  const logs = []
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
    if (message.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${message.params.type}] ${formatArgs(message.params.args)}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      const text =
        (details.exception && details.exception.description) ||
        details.text ||
        'unknown exception'
      errors.push(text.split('\n').slice(0, 6).join('\n'))
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry
      if (entry.level === 'error') errors.push(`[${entry.source}] ${entry.text}`)
    }
  })

  await new Promise((resolve) => socket.addEventListener('open', resolve))

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Page.navigate', { url: target })

  // 给渲染循环足够时间跑起来。
  await new Promise((resolve) => setTimeout(resolve, 6000))

  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const stage = document.querySelector('.editor-stage')
      const viewport = document.querySelector('.viewport')
      const canvas = document.querySelector('.viewport-canvas')
      const rail = document.querySelector('.tool-rail')
      const buttons = [...document.querySelectorAll('.rail-btn')]
      const rect = (el) => el ? {
        w: Math.round(el.getBoundingClientRect().width),
        h: Math.round(el.getBoundingClientRect().height)
      } : null
      return JSON.stringify({
        stage: rect(stage),
        viewport: rect(viewport),
        canvasCss: rect(canvas),
        canvasBacking: canvas ? { w: canvas.width, h: canvas.height } : null,
        rail: rect(rail),
        railButtonCount: buttons.length,
        railButtonRects: buttons.slice(0, 4).map((b) => rect(b)),
        railSvgRects: buttons.slice(0, 4).map((b) => {
          const svg = b.querySelector('svg')
          return svg ? rect(svg) : null
        }),
        bodyOverflow: getComputedStyle(document.body).overflow,
        viewportCssHeight: viewport ? getComputedStyle(viewport).height : null,
        canvasCssHeight: canvas ? getComputedStyle(canvas).height : null
      })
    })()`,
    returnByValue: true
  })

  console.log('=== PROBE ===')
  console.log(probe.result && probe.result.value)
  console.log('=== CONSOLE ===')
  console.log(logs.length ? logs.join('\n') : '(none)')
  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  // 截图走 CDP 而不是命令行 --screenshot：
  // 命令行模式在软件渲染（swiftshader）下容易卡住，CDP 由页面自己触发合成更稳。
  if (process.env.SHOT_PATH) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot && shot.data) {
      require('fs').writeFileSync(process.env.SHOT_PATH, Buffer.from(shot.data, 'base64'))
      console.log(`=== SHOT === saved ${process.env.SHOT_PATH}`)
    } else {
      console.log('=== SHOT === failed')
    }
  }

  socket.close()
}

main().catch((error) => {
  console.error('diagnose failed:', error.message)
  process.exit(1)
})
