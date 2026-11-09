/**
 * 相机轨迹插值：时间参数化的向心 Catmull-Rom 样条（纯逻辑，零依赖）。
 *
 * ## 为什么换掉原来的逐段线性 + smoothstep
 *
 * 原实现有两个实测缺陷（见 docs 与验证脚本）：
 * 1. **每个中间关键帧速度归零** —— smoothstep 让每段两端缓动到 0，
 *    所以相机飞到一个镜头就"停一下"再走，多镜头推移会一顿一顿；
 * 2. **位置是分段直线** —— 逐分量线性插值，永远拍不出弧线运镜。
 *
 * ## 采用方案：三次 Hermite + Catmull-Rom 切线（时间参数化）
 *
 * 这是相机轨道运动的标准做法（与 three.js `CatmullRomCurve3`、
 * Unreal Camera Rig Rail、Unity Cinemachine 同一族数学）：曲线**穿过每个
 * 关键帧**，且一阶导连续（速度连续、不会在关键帧停顿）。
 *
 * 关键设计：**用真实时间做节点间距**。
 * `CatmullRomCurve3` 用的是弧长/几何参数，适合"沿轨道匀速跑"；
 * 而相机轨迹要求"第 3 秒必须到第 3 个机位"，因此必须按时间参数化。
 * 时间做节点间距后，节点处的导数就是真实速度，天然速度连续。
 *
 * 切线用标准的**非均匀 Catmull-Rom** 公式（相邻割线斜率的加权平均）：
 *
 * ```
 * m_i = ( (P_i - P_{i-1})/Δt_prev · Δt_next + (P_{i+1} - P_i)/Δt_next · Δt_prev )
 *       / (Δt_prev + Δt_next)
 * ```
 *
 * 端点用单侧割线（natural 端条件）。于是只有两个关键帧时，
 * 两端切线都等于该割线，Hermite 精确退化为**匀速直线运动**——
 * 这正是"两个关键帧之间平滑运动"最需要的性质。
 *
 * ## 过冲（overshoot）防护
 *
 * Catmull-Rom 在折角很急时会产生过冲/打圈。业界常用的抑制手段是把切线
 * 幅值限制在相邻弦长的若干倍以内（本模块取 2 倍）。这不是改变曲线类型，
 * 只在病态输入下把切线拉回来，保证画面不会突然甩出去。
 */

/** 切线幅值相对相邻弦长的上限倍数，用于抑制急折角处的过冲。 */
const TANGENT_CHORD_LIMIT = 2

/** 分段三次 Hermite 基函数。s ∈ [0,1]。 */
function hermite(p0, p1, m0, m1, s, dt) {
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  // m 是"对时间"的导数，乘上段时长换算到 s 参数域。
  return h00 * p0 + h10 * dt * m0 + h01 * p1 + h11 * dt * m1
}

/**
 * 计算每个节点的切线（对时间的导数，单位：米/秒）。
 *
 * @param {Array<{time:number, value:number}>} knots 已按时间升序、时间唯一
 * @returns {number[]}
 */
function tangentsFor(knots) {
  const count = knots.length
  const tangents = new Array(count).fill(0)
  if (count < 2) return tangents

  for (let index = 0; index < count; index += 1) {
    if (index === 0) {
      // 端点：单侧割线，保证只有两帧时退化为匀速直线。
      tangents[index] = (knots[1].value - knots[0].value) / (knots[1].time - knots[0].time)
    } else if (index === count - 1) {
      const last = count - 1
      tangents[index] = (knots[last].value - knots[last - 1].value) / (knots[last].time - knots[last - 1].time)
    } else {
      const dtPrev = knots[index].time - knots[index - 1].time
      const dtNext = knots[index + 1].time - knots[index].time
      const slopePrev = (knots[index].value - knots[index - 1].value) / dtPrev
      const slopeNext = (knots[index + 1].value - knots[index].value) / dtNext
      const total = dtPrev + dtNext
      tangents[index] = total > 0 ? (slopePrev * dtNext + slopeNext * dtPrev) / total : slopeNext
    }
  }

  /*
   * 过冲抑制：把切线幅值限制在相邻割线速度的若干倍内。
   * 只在病态折角（切线远大于实际位移速度）时才生效，正常运镜不受影响。
   */
  for (let index = 1; index < count - 1; index += 1) {
    const dtPrev = knots[index].time - knots[index - 1].time
    const dtNext = knots[index + 1].time - knots[index].time
    const chordPrev = Math.abs((knots[index].value - knots[index - 1].value) / dtPrev)
    const chordNext = Math.abs((knots[index + 1].value - knots[index].value) / dtNext)
    const limit = TANGENT_CHORD_LIMIT * Math.max(chordPrev, chordNext)
    if (limit > 0 && Math.abs(tangents[index]) > limit) {
      tangents[index] = Math.sign(tangents[index]) * limit
    }
  }

  return tangents
}

/**
 * 在一条时间/数值序列上求值。
 *
 * @param {Array<{time:number, value:number}>} knots 升序关键帧
 * @param {number} time 查询时刻
 * @returns {number|null} 无关键帧时返回 null
 */
export function evaluateScalarTrack(knots, time) {
  if (!Array.isArray(knots) || knots.length === 0) return null
  if (knots.length === 1) return knots[0].value
  if (!Number.isFinite(time)) return knots[0].value
  if (time <= knots[0].time) return knots[0].value
  const lastIndex = knots.length - 1
  if (time >= knots[lastIndex].time) return knots[lastIndex].value

  // 找到 time 所在的段。
  let index = 0
  for (let i = 1; i <= lastIndex; i += 1) {
    if (time <= knots[i].time) {
      index = i
      break
    }
  }
  const previous = knots[index - 1]
  const next = knots[index]
  const dt = next.time - previous.time
  if (!(dt > 0)) return next.value
  const s = (time - previous.time) / dt
  const tangents = tangentsFor(knots)
  return hermite(previous.value, next.value, tangents[index - 1], tangents[index], s, dt)
}

/**
 * 三维轨迹求值。
 *
 * @param {Array<{time:number, position:{x,y,z}}>} knots 升序关键帧
 * @param {number} time
 * @returns {{x:number,y:number,z:number}|null}
 */
export function evaluatePositionTrack(knots, time) {
  if (!Array.isArray(knots) || knots.length === 0) return null
  const x = evaluateScalarTrack(knots.map((knot) => ({ time: knot.time, value: knot.position.x })), time)
  const y = evaluateScalarTrack(knots.map((knot) => ({ time: knot.time, value: knot.position.y })), time)
  const z = evaluateScalarTrack(knots.map((knot) => ({ time: knot.time, value: knot.position.z })), time)
  if (x === null || y === null || z === null) return null
  return { x, y, z }
}

/**
 * 校验/整理关键帧序列：按时间升序、丢弃非法项、合并同刻（保留后者）。
 *
 * 同刻重复必须合并：两个同刻关键帧会让 `dt = 0`，切线公式除零，
 * 整条轨迹会变成 NaN 并让相机消失。
 */
export function normalizeKnots(items, readTime, readValue) {
  if (!Array.isArray(items)) return []
  const valid = items
    .filter((item) => item && Number.isFinite(readTime(item)))
    .map((item) => ({ time: readTime(item), value: readValue(item) }))
    .filter((entry) => entry.value !== null && entry.value !== undefined)
    .filter((entry) => {
      if (typeof entry.value === 'number') return Number.isFinite(entry.value)
      return (
        Number.isFinite(entry.value.x) && Number.isFinite(entry.value.y) && Number.isFinite(entry.value.z)
      )
    })
  valid.sort((first, second) => first.time - second.time)
  const deduped = []
  for (const entry of valid) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === entry.time) {
      deduped[deduped.length - 1] = entry
    } else {
      deduped.push(entry)
    }
  }
  return deduped
}

/**
 * 采样整条轨迹的速度（用于验证"不会在关键帧停顿"）。
 *
 * 只在测试与诊断里用；正常渲染不需要。
 */
export function sampleSpeeds(knots, durationSeconds, framesPerSecond = 24) {
  const speeds = []
  const frames = Math.max(1, Math.round(durationSeconds * framesPerSecond))
  let previous = null
  for (let index = 0; index <= frames; index += 1) {
    const time = (index / frames) * durationSeconds
    const position = evaluatePositionTrack(knots, time)
    if (previous && position) {
      speeds.push({
        time,
        speed: Math.hypot(position.x - previous.x, position.y - previous.y, position.z - previous.z) * framesPerSecond
      })
    }
    previous = position
  }
  return speeds
}
