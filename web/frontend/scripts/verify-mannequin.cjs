/**
 * 人台外观与动作的端到端验证。
 *
 * 判定依据全部来自场景探针（window.__XBH_DIAGNOSE__.scene()），
 * 而不是截图——"有个人形轮廓"在缩略图上很难分辨是白模胶囊还是蒙皮模型。
 *
 * 覆盖：
 *   1. 添加人台后 GLB 外观能加载出来（网格数 > 0）
 *   2. 切换预设动作会改变实际播放的动画片段
 *   3. 时间轴时间驱动动作进度（拖播放头 → actionTime 跟着变）
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/verify-mannequin.cjs http://127.0.0.1:8181/editor
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

  const mannequinOf = async () => {
    const snapshot = await evaluate('window.__XBH_DIAGNOSE__.scene()')
    const object = (snapshot?.objects ?? []).find((item) => item.kind === 'mannequin')
    return { snapshot, object }
  }

  // ---------------------------------------------------------------
  // 1. 添加人台
  // ---------------------------------------------------------------
  const added = await evaluate(`(async () => {
    const buttons = [...document.querySelectorAll('.rail-btn')]
    const button = buttons.find((b) => {
      const label = (b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent || '')
      return label.includes('人台')
    })
    if (!button) return { ok: false, reason: '工具栏里找不到人台按钮' }
    button.click()
    await new Promise((r) => setTimeout(r, 400))
    return { ok: true }
  })()`)
  check(added.ok === true, '左侧工具栏可以添加人台', added.reason || '')

  // GLB 有 7.3MB，首次加载要给足时间。
  let state = await mannequinOf()
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (state.object?.mannequin?.visualReady) break
    await sleep(500)
    state = await mannequinOf()
  }
  console.log('人台状态:', JSON.stringify(state.object?.mannequin))

  check(Boolean(state.object), '场景里出现了人台对象')
  check(
    state.object?.mannequin?.visualReady === true,
    'GLB 外观已加载（不再是白模占位）',
    state.object?.mannequin ? `visualReady=${state.object.mannequin.visualReady}` : ''
  )
  check(
    (state.object?.mannequin?.meshCount ?? 0) > 0,
    '外观包含实际网格',
    state.object?.mannequin ? `meshCount=${state.object.mannequin.meshCount}` : ''
  )
  check(
    (state.object?.mannequin?.boneCount ?? 0) > 0,
    '外观包含骨骼（蒙皮模型而非静态网格）',
    state.object?.mannequin ? `boneCount=${state.object.mannequin.boneCount}` : ''
  )

  // ---------------------------------------------------------------
  // 2. 切换预设动作
  // ---------------------------------------------------------------
  const switchPreset = async (label) =>
    evaluate(`(async () => {
      const rows = [...document.querySelectorAll('.asset-panel .list-row')]
      const row = rows.find((r) => (r.querySelector('.list-row__name')?.value || '').includes('人台'))
      if (row) row.click()
      await new Promise((r) => setTimeout(r, 400))

      const select = [...document.querySelectorAll('.panel__section select')]
        .find((s) => [...s.options].some((o) => (o.textContent || '').includes(${JSON.stringify(label)})))
      if (!select) return { ok: false, reason: '找不到动作下拉框' }
      const option = [...select.options].find((o) => (o.textContent || '').trim() === ${JSON.stringify(label)})
      if (!option) return { ok: false, reason: '找不到动作选项' }
      select.value = option.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 700))
      return { ok: true, value: select.value }
    })()`)

  const sit = await switchPreset('坐下')
  console.log('切换到坐下:', JSON.stringify(sit))
  check(sit.ok === true, '可以在属性面板切换人台动作', sit.reason || '')

  state = await mannequinOf()
  console.log('坐下状态:', JSON.stringify(state.object?.mannequin))
  check(
    state.object?.mannequin?.presetId === 'sit',
    '预设已切到坐下',
    state.object?.mannequin ? `presetId=${state.object.mannequin.presetId}` : ''
  )
  check(
    state.object?.mannequin?.actionClip === 'Sitting_Idle_Loop',
    '外观实际播放的是坐下动作片段',
    state.object?.mannequin ? `actionClip=${state.object.mannequin.actionClip}` : ''
  )

  await switchPreset('跑步')
  state = await mannequinOf()
  console.log('跑步状态:', JSON.stringify(state.object?.mannequin))
  check(
    state.object?.mannequin?.actionClip === 'Sprint_Loop',
    '切换到跑步后播放片段同步更换',
    state.object?.mannequin ? `actionClip=${state.object.mannequin.actionClip}` : ''
  )

  // ---------------------------------------------------------------
  // 3. 时间轴驱动动作进度
  // ---------------------------------------------------------------
  const timeline = await evaluate(`(async () => {
    const ruler = document.querySelector('.ruler')
    if (!ruler) return { ok: false, reason: '找不到标尺' }
    const rect = ruler.getBoundingClientRect()
    const at = (ratio) => rect.left + rect.width * ratio

    const fire = (el, type, x) => el.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true,
      clientX: x, clientY: rect.top + rect.height / 2,
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }))

    fire(ruler, 'pointerdown', at(0.05))
    await new Promise((r) => setTimeout(r, 200))
    const earlyTime = Number(document.querySelector('.time-input')?.value ?? 0)
    const early = window.__XBH_DIAGNOSE__.scene().objects.find((o) => o.kind === 'mannequin')

    for (let step = 1; step <= 10; step += 1) {
      fire(window, 'pointermove', at(0.05 + (0.55 * step) / 10))
      await new Promise((r) => setTimeout(r, 40))
    }
    fire(window, 'pointerup', at(0.6))
    await new Promise((r) => setTimeout(r, 400))

    const lateTime = Number(document.querySelector('.time-input')?.value ?? 0)
    const late = window.__XBH_DIAGNOSE__.scene().objects.find((o) => o.kind === 'mannequin')
    return {
      ok: true,
      earlyTime,
      lateTime,
      early: early?.mannequin ?? null,
      late: late?.mannequin ?? null
    }
  })()`)
  console.log('时间轴驱动:', JSON.stringify(timeline))

  /*
   * 断言方式：actionTime 必须等于 (时间轴时间 % 片段时长)。
   *
   * 不能直接比较"拖动前后 actionTime 是否不同"：它是循环内时间，
   * 跨过整周期后会绕回开头，两个不同时刻可能取到很近的值。
   * 用取模关系判定，才能既证明它跟着时间轴走，又不依赖具体时长。
   */
  const near = (a, b, tolerance = 0.02) => Math.abs(a - b) < tolerance
  const matchesTimeline = (entry, timeSeconds) => {
    if (!entry?.actionDuration) return false
    const expected = ((timeSeconds % entry.actionDuration) + entry.actionDuration) % entry.actionDuration
    // 取模边界：0 与接近时长的值等价。
    return near(entry.actionTime, expected) || near(Math.abs(entry.actionTime - expected), entry.actionDuration)
  }

  check(
    timeline.ok === true && timeline.lateTime > timeline.earlyTime + 0.5,
    '拖动播放头推进了时间轴',
    timeline.ok ? `${timeline.earlyTime}s → ${timeline.lateTime}s` : timeline.reason
  )
  check(
    timeline.ok === true && matchesTimeline(timeline.early, timeline.earlyTime),
    '人台动作进度与时间轴同步（前半段）',
    timeline.ok ? `actionTime=${timeline.early?.actionTime} / 时长=${timeline.early?.actionDuration}` : ''
  )
  check(
    timeline.ok === true && matchesTimeline(timeline.late, timeline.lateTime),
    '人台动作进度与时间轴同步（后半段）',
    timeline.ok ? `actionTime=${timeline.late?.actionTime} / 时长=${timeline.late?.actionDuration}` : ''
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
  console.error('verify-mannequin failed:', error.message)
  process.exit(1)
})
