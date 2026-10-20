/**
 * 排查工具：探测本机浏览器支持哪些 WebCodecs 编解码器。
 *
 * 什么时候用它：
 * 用户报"导出视频说没有可用的 H.264 编码器"时，先跑这个看真实情况。
 * H.264 的 profile 支持是**硬件 / 系统相关**的——实测某台机器上
 * Baseline（42E01E）与 Main（4D401F）都返回 false，只有 High（640028/640032）
 * 可用。所以"我本地能导出"完全不能说明用户那边也能导出。
 *
 * 用法：
 *   $env:DEBUG_PORT='9232'
 *   node scripts/probe-codecs.cjs http://127.0.0.1:8181/editor
 */

const http = require('http')

const target = process.argv[2] || 'http://127.0.0.1:8181/editor'
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
  const targets = await getJSON('/json/list')
  const page = targets.find((item) => item.type === 'page') || targets[0]
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
  await send('Page.navigate', { url: target })
  await new Promise((resolve) => setTimeout(resolve, 4000))

  const result = await send('Runtime.evaluate', {
    expression: `(async () => {
      const report = {
        ua: navigator.userAgent,
        hasVideoEncoder: typeof VideoEncoder !== 'undefined',
        hasVideoFrame: typeof VideoFrame !== 'undefined',
        configs: {}
      }
      if (!report.hasVideoEncoder) return report

      // 与 core/video.js 的 MP4_CODEC_CANDIDATES 保持同一份候选。
      const candidates = {
        'avc1.640032': { width: 1920, height: 1080 },
        'avc1.640028': { width: 1920, height: 1080 },
        'avc1.4D402A': { width: 1280, height: 720 },
        'avc1.4D401F': { width: 1280, height: 720 },
        'avc1.42E01F': { width: 1280, height: 720 },
        'avc1.42E01E': { width: 1280, height: 720 }
      }
      for (const [codec, size] of Object.entries(candidates)) {
        try {
          const support = await VideoEncoder.isConfigSupported({
            codec,
            width: size.width,
            height: size.height,
            bitrate: 8000000,
            framerate: 24
          })
          report.configs[codec] = support.supported === true
        } catch (error) {
          report.configs[codec] = 'error: ' + String((error && error.message) || error)
        }
      }
      return report
    })()`,
    returnByValue: true,
    awaitPromise: true
  })

  const value = result.result.value
  console.log(JSON.stringify(value, null, 2))

  const usable = Object.entries(value.configs || {})
    .filter(([, ok]) => ok === true)
    .map(([codec]) => codec)
  console.log('')
  console.log(usable.length > 0 ? `可用 codec：${usable.join(', ')}` : '没有任何可用的 H.264 codec')

  socket.close()
}

main().catch((error) => {
  console.error('probe failed:', error.message)
  process.exit(1)
})
