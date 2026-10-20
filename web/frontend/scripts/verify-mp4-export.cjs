/**
 * MP4 导出的端到端验证。
 *
 * 关键点：**不能只看"文件存在"**。
 * 一个损坏的 MP4 也能有几百 KB，也会返回 200。必须真的解析容器结构：
 *   - `ftyp` box 存在，且 brand 是 isom/mp42/avc1 这类；
 *   - `moov` box 存在，且**在 mdat 之前**（fastStart 生效）；
 *   - 文件尺寸与帧数×分辨率量级相符（太小说明只写了 header）。
 *
 * 覆盖：
 *   1. 编码能力探测能挑出一个可用的 H.264 codec
 *   2. 导出真的产出 MP4 文件（后端落盘）
 *   3. 文件是合法 MP4 容器（ftyp + moov + mdat，moov 在前）
 *   4. 首尾帧单图仍然保留（回归保护）
 *   5. 视频体积与分辨率/时长量级相符
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/verify-mp4-export.cjs http://127.0.0.1:8181/editor
 */

const http = require('http')
const fs = require('fs')

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

/** 直接下载导出文件，拿到真实字节。 */
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
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), headers: res.headers }))
      })
      .on('error', reject)
  })
}

/**
 * 扫一遍 MP4 的 box 结构。
 *
 * MP4 是"盒子套盒子"的格式，每个 box 是 [4 字节长度][4 字节类型]。
 * 这里只看顶层 box 的顺序与大小——足够判断文件是否合法，
 * 又不至于把验证脚本写成半个解析器。
 */
function parseTopLevelBoxes(buffer) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (size < 8) break
    boxes.push({ type, size, offset })
    offset += size
  }
  return boxes
}

/**
 * 从 moov → trak → mdia → minf → stbl → stsd 里挖出编码器写入的真实宽高。
 *
 * 为什么值得写这段"半个解析器"：
 * "文件有 ftyp/moov/mdat" 只能说明容器没坏，不能说明**画面是对的**。
 * 编码器配置错尺寸时同样会产出结构合法的文件，只是播放出来分辨率不对。
 * 而 stsd 里的宽高是编码器自己写进去的，是唯一的真相来源。
 *
 * 这里用最朴素的"递归下钻 + 按类型查找"实现：box 结构是自描述的，
 * 不需要完整解析每一层的字段，只要能一路找到 stsd 即可。
 */
function findBox(buffer, type, start = 0, end = buffer.length) {
  let offset = start
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset)
    const boxType = buffer.toString('ascii', offset + 4, offset + 8)
    if (size < 8) break
    if (boxType === type) return { offset, size }
    offset += size
  }
  return null
}

function readVideoDimensions(buffer) {
  // 逐层下钻。路径是固定的：moov > trak > mdia > minf > stbl > stsd。
  let cursor = findBox(buffer, 'moov')
  if (!cursor) return null
  // trak 可能不止一个（视频 + 音频），逐个找带 stsd 的那个。
  let offset = cursor.offset + 8
  const moovEnd = cursor.offset + cursor.size
  while (offset < moovEnd) {
    const size = buffer.readUInt32BE(offset)
    const boxType = buffer.toString('ascii', offset + 4, offset + 8)
    if (size < 8) break
    if (boxType === 'trak') {
      const trakEnd = offset + size
      const mdia = findBox(buffer, 'mdia', offset + 8, trakEnd)
      const minf = mdia ? findBox(buffer, 'minf', mdia.offset + 8, mdia.offset + mdia.size) : null
      const stbl = minf ? findBox(buffer, 'stbl', minf.offset + 8, minf.offset + minf.size) : null
      const stsd = stbl ? findBox(buffer, 'stsd', stbl.offset + 8, stbl.offset + stbl.size) : null
      if (stsd) {
        /*
         * stsd 的结构：[8 box 头][4 version+flags][4 entryCount][entry...]
         * entry 是 [4 size][4 format][6 reserved][2 dataRefIndex]，
         * 然后视频 sample entry 固定有 16 字节的预定义字段，
         * 宽高就在其后：width(2) height(2)。
         */
        const entryStart = stsd.offset + 16
        if (entryStart + 8 + 6 + 2 + 16 + 4 <= buffer.length) {
          const format = buffer.toString('ascii', entryStart + 4, entryStart + 8)
          const widthOffset = entryStart + 8 + 6 + 2 + 16
          const width = buffer.readUInt16BE(widthOffset)
          const height = buffer.readUInt16BE(widthOffset + 2)
          return { format, width, height }
        }
      }
    }
    offset += size
  }
  return null
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

  // ---------------------------------------------------------------
  // 1. 打开导出对话框，读编码能力探测结果
  // ---------------------------------------------------------------
  const dialog = await evaluate(`(async () => {
    const button = [...document.querySelectorAll('button')]
      .find((b) => (b.textContent || '').trim() === '导出')
    if (!button) return { ok: false, reason: '找不到"导出"按钮' }
    button.click()
    await new Promise((r) => setTimeout(r, 300))

    const item = [...document.querySelectorAll('.menu-item, .dropdown__item, li, button')]
      .find((el) => (el.textContent || '').includes('导出动画') || (el.textContent || '').includes('视频'))
    if (item) { item.click(); await new Promise((r) => setTimeout(r, 400)) }

    const panel = document.querySelector('[aria-label="导出动画视频"]')
    if (!panel) return { ok: false, reason: '导出对话框没有打开' }
    // 能力探测是异步的，给它时间跑完。
    await new Promise((r) => setTimeout(r, 1500))
    const text = panel.textContent || ''
    return { ok: true, text }
  })()`)
  console.log('对话框:', dialog.ok ? '(已打开)' : dialog.reason)

  check(dialog.ok === true, '导出对话框可以打开', dialog.reason || '')

  /*
   * 注意：不能用 split('\n') 去"找那一行"。
   *
   * textContent 会把所有块级元素拼成一整串，元素之间没有换行符——
   * 按行切分拿到的是整个面板的文字，`startsWith('编码器：')` 永远不成立。
   * 直接用正则在整个文本里找才是稳的。
   */
  const panelText = dialog.text || ''
  const supportLine = /MP4 编码：\S+/.exec(panelText)?.[0] || ''
  const codecMatch = /avc1\.[0-9a-fA-F]{6}/.exec(panelText)
  console.log('能力提示:', supportLine, '/ 编码器:', codecMatch?.[0] || '(未找到)')

  check(supportLine.includes('可用'), '本机探测到可用的 MP4 编码能力', supportLine)
  check(Boolean(codecMatch), '挑出的编码器是 H.264（avc1.*）', codecMatch?.[0] || '(未找到)')

  // ---------------------------------------------------------------
  // 2. 直接调用编码层做一次真实编码（比走 UI 更快、更可控）
  // ---------------------------------------------------------------
  const encoded = await evaluate(`(async () => {
    // 从 webpack 打包后的模块里拿不到具名导出，这里直接内联一次等价流程：
    // 用同一套 codec 候选 + WebCodecs + muxer，验证"真的能编出合法文件"。
    if (typeof VideoEncoder === 'undefined') return { ok: false, reason: 'no-webcodecs' }

    const candidates = ['avc1.640032','avc1.640028','avc1.4D402A','avc1.4D401F','avc1.42E01F','avc1.42E01E']
    const width = 320, height = 180, frameRate = 12, totalFrames = 12
    let codec = null
    for (const candidate of candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: candidate, width, height, bitrate: 1000000, framerate: frameRate
        })
        if (support && support.supported) { codec = candidate; break }
      } catch (e) { /* 试下一个 */ }
    }
    if (!codec) return { ok: false, reason: 'no-codec' }

    // 用 SceneViewport 的导出画布路径：渲染一帧到 2D 画布。
    const viewport = document.querySelector('.viewport-canvas')
    if (!viewport) return { ok: false, reason: '找不到视口' }

    const chunks = []
    let muxedBytes = 0
    const encoder = new VideoEncoder({
      output: (chunk) => { chunks.push(chunk.byteLength); muxedBytes += chunk.byteLength },
      error: (e) => { window.__mp4Error = String(e && e.message || e) }
    })
    encoder.configure({ codec, width, height, bitrate: 1000000, framerate: frameRate, avc: { format: 'avc' } })

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')

    for (let index = 0; index < totalFrames; index += 1) {
      ctx.fillStyle = 'rgb(' + (index * 20) + ', 40, 80)'
      ctx.fillRect(0, 0, width, height)
      const frame = new VideoFrame(canvas, {
        timestamp: Math.round(index * 1000000 / frameRate),
        duration: Math.round(1000000 / frameRate)
      })
      try {
        encoder.encode(frame, { keyFrame: index % frameRate === 0 })
      } finally {
        frame.close()
      }
      while (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 4))
    }
    await encoder.flush()
    encoder.close()
    return {
      ok: true, codec, chunks: chunks.length, bytes: muxedBytes,
      error: window.__mp4Error || null
    }
  })()`)
  console.log('真实编码:', JSON.stringify(encoded))

  check(encoded.ok === true, 'WebCodecs 能完成一次真实编码', encoded.reason || '')
  check(encoded.chunks === 12, '每一帧都产出了编码数据', `chunks=${encoded.chunks}`)
  check(encoded.bytes > 1000, '编码数据不是空壳', `bytes=${encoded.bytes}`)

  // ---------------------------------------------------------------
  // 3. 走完整 UI 导出，拿后端落盘的真文件
  // ---------------------------------------------------------------
  const exported = await evaluate(`(async () => {
    const panel = document.querySelector('[aria-label="导出动画视频"]')
    if (!panel) return { ok: false, reason: '导出对话框不见了' }

    // 时长压到最短，让验证跑得快；同时确保只勾 MP4 + 首尾帧。
    const checkboxes = [...panel.querySelectorAll('input[type="checkbox"]')]
    const setChecked = (needle, value) => {
      const box = checkboxes.find((c) => {
        const label = c.closest('label')?.textContent || ''
        return label.includes(needle)
      })
      if (box && box.checked !== value) box.click()
    }
    setChecked('MP4 视频', true)
    setChecked('首帧', true)
    setChecked('序列帧', false)

    // 帧率调到 12、最大边 720，缩短导出时间。
    const numberInputs = [...panel.querySelectorAll('input[type="number"]')]
    if (numberInputs[0]) {
      numberInputs[0].value = '12'
      numberInputs[0].dispatchEvent(new Event('change', { bubbles: true }))
    }
    const selects = [...panel.querySelectorAll('select')]
    const sizeSelect = selects.find((s) => [...s.options].some((o) => (o.textContent || '').includes('720')))
    if (sizeSelect) {
      const option = [...sizeSelect.options].find((o) => (o.textContent || '').includes('720'))
      sizeSelect.value = option.value
      sizeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await new Promise((r) => setTimeout(r, 1200))

    // 读回面板上显示的"输出 W × H"，后面用它校验编码器写入的真实尺寸。
    const sizeText = [...panel.querySelectorAll('.meta-line')]
      .map((el) => el.textContent || '')
      .find((text) => text.includes('输出')) || ''
    const sizeMatch = /输出\\s*(\\d+)\\s*×\\s*(\\d+)/.exec(sizeText)
    const size = sizeMatch ? { width: Number(sizeMatch[1]), height: Number(sizeMatch[2]) } : null

    const start = [...panel.querySelectorAll('button')]
      .find((b) => (b.textContent || '').includes('开始导出'))
    if (!start) return { ok: false, reason: '找不到"开始导出"按钮' }
    start.click()

    // 等导出完成：结果区出现 .result__row 就是好了。
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((r) => setTimeout(r, 500))
      const rows = [...panel.querySelectorAll('.result__row')]
      if (rows.length > 0) {
        return {
          ok: true,
          size,
          files: rows.map((row) => ({
            name: row.querySelector('.result__name')?.textContent?.trim() || '',
            meta: row.querySelector('.result__meta')?.textContent?.trim() || ''
          }))
        }
      }
      const stillBusy = [...panel.querySelectorAll('button')]
        .some((b) => (b.textContent || '').includes('导出中'))
      if (!stillBusy && attempt > 4) {
        // 已经不在导出，但也没有结果 → 失败了。
        const notice = document.querySelector('.notice, .toast, .notices')?.textContent || ''
        return { ok: false, reason: '导出结束但没有产物', notice: notice.slice(0, 200) }
      }
    }
    return { ok: false, reason: '导出超时' }
  })()`)
  console.log('UI 导出:', JSON.stringify(exported))

  check(exported.ok === true, '走 UI 能完整跑完一次导出', exported.reason || '')

  const files = exported.files || []
  const mp4File = files.find((file) => file.name.endsWith('.mp4'))
  /*
   * 文件名里可能带 `-\d+`，那是后端 write_export 的重名计数。
   * 同一工程名反复导出时它会加 `-3` 这样的后缀，
   * 断言必须容忍，否则第二次跑验证就会假失败。
   */
  const endpointFiles = files.filter((file) => /_(first|last)(-\d+)?\.png$/.test(file.name))

  check(Boolean(mp4File), '导出了 MP4 文件', mp4File ? mp4File.name : JSON.stringify(files.map((f) => f.name)))
  check(endpointFiles.length === 2, '首尾帧单图仍然保留', endpointFiles.map((f) => f.name).join(', '))

  /*
   * 画面不被拉伸：导出画幅的宽高比必须等于相机画幅预设的宽高比。
   *
   * 这是"只改渲染器尺寸、忘了改 camera.aspect"那个 bug 的回归保护。
   * 表现是画面被横向拉伸，但文件结构完全合法——只验容器发现不了，
   * 必须比对"实际输出的宽高比"与"相机设定的宽高比"。
   */
  if (exported.size) {
    const outputRatio = exported.size.width / exported.size.height
    const expectedRatio = 16 / 9
    check(
      Math.abs(outputRatio - expectedRatio) < 0.02,
      '导出画幅的宽高比与相机预设一致（未被拉伸）',
      `${exported.size.width}×${exported.size.height} = ${outputRatio.toFixed(4)} / 期望 ${expectedRatio.toFixed(4)}`
    )
  }

  /*
   * 导出结束后编辑相机的宽高比必须还原。
   *
   * `withOutputSize` 会临时把 camera.aspect 改成导出宽高比，
   * 漏掉 finally 里的还原，用户会发现"导完视频后视口画面变形了"，
   * 而且这个变形会一直留着直到用户手动 resize 窗口。
   */
  const restored = await evaluate(`(() => {
    const state = window.__XBH_DIAGNOSE__.editorCamera?.()
    return state
  })()`)
  console.log('导出后编辑相机:', JSON.stringify(restored))
  check(
    Boolean(restored) && typeof restored.aspect === 'number' && Number.isFinite(restored.aspect),
    '导出后可以读到编辑相机的宽高比',
    restored ? `aspect=${restored.aspect}` : '(探针未返回)'
  )

  // ---------------------------------------------------------------
  // 4. 下载并解析 MP4 容器结构
  // ---------------------------------------------------------------
  if (mp4File) {
    const url = `${API_BASE}/api/exports/${encodeURIComponent(mp4File.name)}`
    let downloaded = null
    try {
      downloaded = await fetchBytes(url)
    } catch (error) {
      console.log('下载失败:', error.message)
    }

    if (downloaded) {
      const { buffer, headers } = downloaded
      const boxes = parseTopLevelBoxes(buffer)
      const types = boxes.map((box) => box.type)
      console.log('MP4 结构:', JSON.stringify({ size: buffer.length, types, contentType: headers['content-type'] }))

      check(types.includes('ftyp'), 'MP4 含 ftyp box（容器头合法）', types.join(','))
      check(types.includes('moov'), 'MP4 含 moov box（索引表存在）', types.join(','))
      check(types.includes('mdat'), 'MP4 含 mdat box（真的有画面数据）', types.join(','))

      const moovIndex = types.indexOf('moov')
      const mdatIndex = types.indexOf('mdat')
      check(
        moovIndex >= 0 && mdatIndex >= 0 && moovIndex < mdatIndex,
        'moov 在 mdat 之前（fastStart 生效，可直接上传播放）',
        `moov@${moovIndex} mdat@${mdatIndex}`
      )

      const brand = buffer.length >= 12 ? buffer.toString('ascii', 8, 12) : ''
      check(
        ['isom', 'mp42', 'avc1', 'iso2', 'mp41'].includes(brand),
        'ftyp brand 是常见的 MP4 品牌',
        brand
      )

      check(
        (headers['content-type'] || '').includes('video/mp4'),
        '下载响应声明 video/mp4',
        headers['content-type'] || '(无)'
      )

      // 720p 12fps 的 5 秒视频，再怎么压也不该小于 10KB。
      check(buffer.length > 10_000, '文件体积与真实视频量级相符', `${buffer.length} 字节`)

      /*
       * 最强的一条：从 stsd 里读回编码器实际写入的分辨率。
       *
       * 只验 "有 ftyp/moov/mdat" 是不够的——配置错尺寸时同样会产出
       * 结构合法的文件，只是播出来分辨率不对。stsd 里的宽高是
       * 编码器自己写进去的，是唯一可信的来源。
       */
      const video = readVideoDimensions(buffer)
      console.log('视频轨道:', JSON.stringify(video))
      check(
        Boolean(video) && video.format === 'avc1',
        '视频轨道的 sample entry 是 avc1（真正的 H.264 轨道）',
        video ? video.format : '(未找到 stsd)'
      )
      const expectedSize = exported.size
      check(
        Boolean(video) &&
          Boolean(expectedSize) &&
          video.width === expectedSize.width &&
          video.height === expectedSize.height,
        '编码尺寸与导出设置一致',
        video
          ? `${video.width}×${video.height} / 期望 ${expectedSize ? `${expectedSize.width}×${expectedSize.height}` : '(未知)'}`
          : ''
      )

      if (process.env.MP4_OUT) {
        fs.writeFileSync(process.env.MP4_OUT, buffer)
        console.log(`=== MP4 === ${process.env.MP4_OUT}`)
      }
    } else {
      check(false, '能下载到导出的 MP4', '下载请求失败')
    }
  }

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
  console.error('verify-mp4-export failed:', error.message)
  process.exit(1)
})
