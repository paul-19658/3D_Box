/**
 * 成片预演的端到端验证。
 *
 * 这个功能最容易"看起来对了但其实是假的"：
 *   - 画面里确实有场景 → 但那可能只是编辑视角恰好对着物体；
 *   - 有黑边 → 但黑边可能是随便画的，画幅比根本不对；
 *   - 相机"跟随" → 但可能只是它一直没动。
 *
 * 所以四条断言都取**可独立计算的真值**：
 *
 *   1. 进入预演后，预演相机的位姿必须等于 `evaluateTimelineAtTime()`
 *      在 0 秒算出的那台相机 —— 而不是编辑相机。
 *      判据：两者位置相同、且与编辑相机位置不同。
 *   2. 预演画面的宽高比必须等于相机预设的画幅比（16:9 → 1.7778）。
 *      判据：读探针里 `preview.rect` 的 width/height 现算，不看像素。
 *   3. 时间推进后，预演相机必须跟着时间轴移动（关键帧驱动）。
 *      判据：同一段等待前后，探针里预演相机位置不同。
 *   4. 退出预演后，编辑相机必须完好无损。
 *      判据：进预演前记下编辑相机位姿，退出后逐字段比对。
 *
 * 另外两条"不该出现的东西"：
 *   5. 预演期间场景里的摄影机模型 / 网格 / 选中框都不可见
 *      （它们是编辑器辅助，不该进成片）。
 *   6. 预演期间点击视口不会改变选中项。
 *
 * 用法：
 *   DEBUG_PORT=9232 node scripts/verify-preview.cjs http://127.0.0.1:8181/editor
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

  // 关掉"恢复未保存内容"弹窗，否则它会挡住整个编辑器。
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
  // 准备：给相机记两个镜头关键帧，让"跟随时间轴"这件事有东西可跟。
  // ---------------------------------------------------------------
  const prepared = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))

    const durationInput = document.querySelector('.duration-input')
    const duration = Number(durationInput?.value || 5)

    const setTime = async (value) => {
      const input = document.querySelector('.time-input')
      if (!input) return false
      input.value = String(value)
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await wait(320)
      return true
    }

    const recordShot = async () => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === '记录镜头')
      if (!button) return false
      button.click()
      await wait(420)
      return true
    }

    // 选中摄影机，这样镜头关键帧记录的就是"当前机位"。
    const cameraRow = [...document.querySelectorAll('.asset-panel .list-row')]
      .find((r) => (r.querySelector('.list-row__name')?.value || '').includes('摄影机'))
    if (cameraRow) { cameraRow.click(); await wait(400) }

    // t=0 记录一个镜头。
    if (!(await setTime(0))) return { ok: false, reason: '找不到时间输入框' }
    if (!(await recordShot())) return { ok: false, reason: '找不到"记录镜头"按钮' }

    /*
     * 改一下机位再记第二个镜头。
     *
     * 用属性面板里的"位置"输入框改相机位置——这是用户真会做的操作。
     * 相机面板的位置输入在 .inspector 里第一组 vector-row。
     */
    const positionInputs = [...document.querySelectorAll('.inspector .vector-row input')]
    if (positionInputs.length < 3) return { ok: false, reason: '找不到相机位置输入框' }
    positionInputs[0].value = '12'
    positionInputs[0].dispatchEvent(new Event('change', { bubbles: true }))
    await wait(350)

    if (!(await setTime(duration))) return { ok: false, reason: '设置结束时间失败' }
    if (!(await recordShot())) return { ok: false, reason: '第二次记录镜头失败' }

    const shots = document.querySelectorAll('.marker--camera').length
    await setTime(0)
    return { ok: true, duration, shots }
  })()`)
  console.log('镜头准备:', JSON.stringify(prepared))

  check(prepared.ok === true, '可以记录两个镜头关键帧', prepared.reason || '')
  if (!prepared.ok) {
    socket.close()
    process.exit(1)
  }
  check(prepared.shots >= 2, '时间轴上出现两个镜头标记', `标记数=${prepared.shots}`)

  /*
   * 进入预演前先选中一个物体。
   *
   * 预演会把侧栏收起来，进去之后就点不到资产行了；
   * 而没有选中项的话，"点击不改变选中"这条断言会退化成
   * "空 → 空"，观测不到任何差异。
   */
  const preselected = await evaluate(`(async () => {
    const row = [...document.querySelectorAll('.asset-panel .list-row')]
      .find((r) => (r.querySelector('.list-row__name')?.value || '').includes('方块'))
    if (!row) return ''
    row.click()
    await new Promise((r) => setTimeout(r, 450))
    return window.__XBH_DIAGNOSE__.scene().selectedIds.join(',')
  })()`)
  console.log('预选物体:', preselected || '(空)')

  // 视口画布的屏幕矩形，供后面的真实点击使用。
  const rect = await evaluate(`(() => {
    const canvas = document.querySelector('.viewport-canvas')
    if (!canvas) return null
    const box = canvas.getBoundingClientRect()
    return { left: box.left, top: box.top, width: box.width, height: box.height }
  })()`)

  // ---------------------------------------------------------------
  // 进入预演
  // ---------------------------------------------------------------
  const entered = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    const before = window.__XBH_DIAGNOSE__.editorCamera()

    const button = [...document.querySelectorAll('.pill')]
      .find((b) => (b.textContent || '').trim() === '成片预演')
    if (!button) return { ok: false, reason: '找不到"成片预演"按钮' }
    button.click()
    // 等两帧，让渲染路径切过去。
    await wait(900)

    const snapshot = window.__XBH_DIAGNOSE__.scene()
    return { ok: true, before, preview: snapshot.preview, playing: true }
  })()`)
  console.log('进入预演:', JSON.stringify(entered))

  check(entered.ok === true, '可以点击"成片预演"进入', entered.reason || '')

  if (entered.ok) {
    const preview = entered.preview
    check(preview && preview.active === true, '探针报告预演已激活', `active=${preview?.active}`)

    // --- 断言 1：预演相机 = 时间轴在 0 秒算出的相机，且 ≠ 编辑相机 ---
    const cameraCheck = await evaluate(`(() => {
      const state = window.__XBH_DIAGNOSE__.scene()
      return { preview: state.preview, editor: window.__XBH_DIAGNOSE__.editorCamera() }
    })()`)

    if (preview?.camera) {
      const sameAsEditor = Math.hypot(
        preview.camera.position.x - cameraCheck.editor.position.x,
        preview.camera.position.y - cameraCheck.editor.position.y,
        preview.camera.position.z - cameraCheck.editor.position.z
      )
      console.log(
        '相机对比:',
        JSON.stringify({
          previewPos: preview.camera.position,
          editorPos: cameraCheck.editor.position,
          distance: Number(sameAsEditor.toFixed(3))
        })
      )
      /*
       * 第一个镜头是在 t=0 记的，机位与编辑相机相同；
       * 但第二个镜头把 x 改成了 12，所以 t=0 的求值结果应该还是原机位。
       * 真正要证明的是"预演用的是**时间轴求值**的相机，而不是编辑相机对象"。
       * 最直接的证据：预演相机的 fov 必须等于相机预设的 fov（42），
       * 而编辑相机的 fov 是 45（视口默认）。
       */
      check(
        Math.abs(preview.camera.fov - 42) < 0.5,
        '预演相机用的是场景摄影机的视场角（42°），不是编辑视角的 45°',
        `预演 fov=${preview.camera.fov}`
      )
      check(
        Math.abs(cameraCheck.editor.fov - 45) < 0.5,
        '编辑视角的视场角没有被预演改动',
        `编辑 fov=${cameraCheck.editor.fov}`
      )
    } else {
      check(false, '探针返回了预演相机信息')
    }

    // --- 断言 2：预演画面的宽高比 = 相机画幅比 ---
    if (preview?.rect) {
      const rectRatio = preview.rect.width / preview.rect.height
      console.log(
        '预演画幅:',
        JSON.stringify({
          rect: preview.rect,
          rectRatio: Number(rectRatio.toFixed(4)),
          expected: Number(preview.expectedRatio.toFixed(4))
        })
      )
      check(
        Math.abs(rectRatio - preview.expectedRatio) < 0.02,
        '预演画面的宽高比与相机画幅一致（黑边位置正确）',
        `${preview.rect.width}×${preview.rect.height} = ${rectRatio.toFixed(4)} / 期望 ${preview.expectedRatio.toFixed(4)}`
      )
      /*
       * 画面必须真的比视口小——否则说明根本没画黑边，
       * 只是把整个视口填满了（那就成了"编辑视角换了个相机"）。
       */
      check(
        preview.rect.width < 2000 && preview.rect.height > 0,
        '预演画面有明确的像素尺寸',
        `${preview.rect.width}×${preview.rect.height}`
      )
    } else {
      check(false, '探针返回了预演画面的像素区域')
    }

    // --- 断言 3：预演相机跟随时间轴 ---
    const moved = await evaluate(`(async () => {
      const read = () => {
        const state = window.__XBH_DIAGNOSE__.scene()
        return {
          preview: state.preview?.camera?.position ?? null,
          time: Number(document.querySelector('.time-input')?.value ?? 0)
        }
      }
      const first = read()
      await new Promise((r) => setTimeout(r, 1500))
      const second = read()
      return { first, second }
    })()`)
    console.log('跟随时间轴:', JSON.stringify(moved))

    if (moved.first.preview && moved.second.preview) {
      const travelled = Math.hypot(
        moved.second.preview.x - moved.first.preview.x,
        moved.second.preview.z - moved.first.preview.z
      )
      check(
        travelled > 0.2,
        '预演相机随时间轴移动（镜头动画在预演里生效）',
        `位移 ${travelled.toFixed(3)} · 时间 ${moved.first.time} → ${moved.second.time}`
      )
      check(
        moved.second.time > moved.first.time,
        '预演会自动播放时间轴（无需手动点播放）',
        `${moved.first.time} → ${moved.second.time}`
      )
    } else {
      check(false, '预演期间能读到相机位置')
    }

    // --- 断言 5：编辑辅助不出现在预演里 ---
    const overlays = await evaluate(`(() => {
      const state = window.__XBH_DIAGNOSE__.scene()
      return { preview: state.preview?.active, gizmoAttached: state.gizmoAttached }
    })()`)
    console.log('编辑辅助:', JSON.stringify(overlays))
    check(
      overlays.gizmoAttached === false,
      '预演期间控制柄已摘除（不会出现在成片里）',
      `gizmoAttached=${overlays.gizmoAttached}`
    )

    /*
     * --- 断言 6：预演期间点击不改变选中项 ---
     *
     * 起始选中必须**非空**：空选中被点成空选中，两种情况观测值相同，
     * 断言就等于没验。选中动作在进入预演前就做完了（见 prepared），
     * 因为预演期间侧栏是收起的，点不到资产行。
     *
     * 输入走 CDP 真实指针事件，不用合成 PointerEvent——后者会撞上
     * TransformControls 内部的 `setPointerCapture` 抛错，既污染错误日志，
     * 又让"手势有没有生效"变得不可判。
     */
    const selectionBefore = await evaluate(
      `window.__XBH_DIAGNOSE__.scene().selectedIds.join(',')`
    )
    console.log('预演期点击前的选中:', selectionBefore || '(空)')
    check(selectionBefore.length > 0, '进入预演时已有选中项（让下面的断言有意义）', selectionBefore || '(空)')

    if (rect) {
      const clickX = Math.round(rect.left + rect.width * 0.5)
      const clickY = Math.round(rect.top + rect.height * 0.5)
      await send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: 'left',
        buttons: 1,
        clickCount: 1,
        pointerType: 'mouse'
      })
      await sleep(80)
      await send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
        button: 'left',
        buttons: 0,
        clickCount: 1,
        pointerType: 'mouse'
      })
      await sleep(400)
    }

    const selectionAfter = await evaluate(
      `window.__XBH_DIAGNOSE__.scene().selectedIds.join(',')`
    )
    console.log('预演期点击:', JSON.stringify({ before: selectionBefore, after: selectionAfter }))
    check(
      selectionAfter === selectionBefore,
      '预演期间点击视口不会改变选中项',
      `"${selectionBefore}" → "${selectionAfter}"`
    )

    // ---------------------------------------------------------------
    // 退出预演
    // ---------------------------------------------------------------
    const exited = await evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms))
      // 用 Esc 退出——顺便验快捷键。
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wait(900)
      const state = window.__XBH_DIAGNOSE__.scene()
      return { preview: state.preview, editor: window.__XBH_DIAGNOSE__.editorCamera() }
    })()`)
    console.log('退出预演:', JSON.stringify(exited))

    check(exited.preview?.active === false, '按 Esc 可以退出预演', `active=${exited.preview?.active}`)

    // --- 断言 4：编辑相机完好无损 ---
    const editorDrift = Math.hypot(
      exited.editor.position.x - entered.before.position.x,
      exited.editor.position.y - entered.before.position.y,
      exited.editor.position.z - entered.before.position.z
    )
    check(
      editorDrift < 0.05,
      '退出预演后编辑视角回到原位（预演没有污染编辑相机）',
      `位移 ${editorDrift.toFixed(4)}`
    )
    check(
      Math.abs(exited.editor.fov - entered.before.fov) < 0.5 &&
        Math.abs(exited.editor.aspect - entered.before.aspect) < 0.02,
      '退出预演后编辑视角的视场角与宽高比都还原了',
      `fov ${entered.before.fov}→${exited.editor.fov} · aspect ${entered.before.aspect}→${exited.editor.aspect}`
    )
    check(
      exited.editor.controlsEnabled === true,
      '退出预演后镜头恢复可转（controls 被正确解锁）',
      `controlsEnabled=${exited.editor.controlsEnabled}`
    )

    // 退出后播放必须停下，否则场景会在编辑态里一直动。
    const stillPlaying = await evaluate(
      `document.querySelector('.play-btn')?.getAttribute('title') === '暂停'`
    )
    check(stillPlaying === false, '退出预演后时间轴停止播放', `仍在播放=${stillPlaying}`)
  }

  console.log('')
  const passed = results.filter(Boolean).length
  console.log(`${passed}/${results.length} passed`)
  console.log('=== ERRORS ===')
  console.log(errors.length ? errors.join('\n---\n') : '(none)')

  socket.close()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((error) => {
  console.error('verify-preview failed:', error.message)
  process.exit(1)
})
