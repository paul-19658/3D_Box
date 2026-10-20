/**
 * 读取页面内 diagnostics 收集到的日志。
 *
 * 和 diagnose.cjs 的分工：
 * - diagnose.cjs 用 CDP 监听"从现在开始"的 console；
 * - 本脚本读取页面**已经记录下来**的历史条目（由 core/diagnostics.js 采集），
 *   包括页面加载之前就发生的错误，以及 Vue 的 errorHandler 回调。
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/dump-diagnostics.cjs [level]
 *   level 省略时输出全部；传 error 只看错误。
 */

const http = require('http')

const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 9222
const level = process.argv[2] || ''

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
  const targets = await getJSON('/json/list')
  const page = targets.find((item) => item.type === 'page')
  if (!page) throw new Error('没有找到 page 目标')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 1
  const pending = new Map()
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
    }
  })

  await new Promise((resolve) => socket.addEventListener('open', resolve))
  await send('Runtime.enable')

  const expression = `(() => {
    const api = window.__XBH_DIAGNOSE__
    if (!api) return JSON.stringify({ missing: true })
    const wanted = ${JSON.stringify(level)}
    const entries = api.entries().filter((e) => !wanted || e.level === wanted)
    return JSON.stringify({ total: api.entries().length, entries })
  })()`

  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  const raw = result.result && result.result.value
  if (!raw) throw new Error('读取诊断数据失败')

  const parsed = JSON.parse(raw)
  if (parsed.missing) {
    console.log('页面里没有 __XBH_DIAGNOSE__，诊断模块未安装')
  } else {
    console.log(`共 ${parsed.total} 条，筛选后 ${parsed.entries.length} 条`)
    for (const entry of parsed.entries) {
      console.log(`[+${entry.t}ms] [${entry.level}] [${entry.source}] ${entry.message}`)
    }
  }

  socket.close()
}

main().catch((error) => {
  console.error('dump-diagnostics failed:', error.message)
  process.exit(1)
})
