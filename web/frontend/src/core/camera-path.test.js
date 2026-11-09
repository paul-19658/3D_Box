/**
 * 相机轨迹插值测试。
 *
 * 守四件事：
 * 1. 曲线**精确穿过**每个关键帧（第 3 秒必须到第 3 个机位）；
 * 2. 速度在中间关键帧**连续**（不再停顿）——这是换掉旧算法的主因；
 * 3. 只有两个关键帧时退化为**匀速直线**（最常用的单人推移运镜）；
 * 4. 病态输入（同刻重复、急折角、非法坐标）不会产生 NaN 或甩出画面。
 */
import { describe, expect, it } from 'vitest'
import {
  evaluatePositionTrack,
  evaluateScalarTrack,
  normalizeKnots,
  sampleSpeeds
} from './camera-path'

const knotsOf = (points) => points.map(([time, x, y, z]) => ({ time, position: { x, y, z } }))

describe('evaluatePositionTrack：穿过关键帧', () => {
  const knots = knotsOf([
    [0, 0, 2, 10],
    [2, 5, 2, 10],
    [4, 10, 2, 10]
  ])

  it('在每个关键帧时刻精确落在该机位', () => {
    expect(evaluatePositionTrack(knots, 0)).toEqual({ x: 0, y: 2, z: 10 })
    const mid = evaluatePositionTrack(knots, 2)
    expect(mid.x).toBeCloseTo(5, 9)
    expect(mid.y).toBeCloseTo(2, 9)
    expect(mid.z).toBeCloseTo(10, 9)
    const last = evaluatePositionTrack(knots, 4)
    expect(last.x).toBeCloseTo(10, 9)
  })

  it('超出范围时夹紧到首尾关键帧', () => {
    expect(evaluatePositionTrack(knots, -5).x).toBe(0)
    expect(evaluatePositionTrack(knots, 99).x).toBe(10)
  })

  it('共线且等间距时速度恒定（没有缓动停顿）', () => {
    const speeds = sampleSpeeds(knots, 4, 24).map((entry) => entry.speed)
    const min = Math.min(...speeds)
    const max = Math.max(...speeds)
    expect(min).toBeCloseTo(2.5, 6)
    expect(max).toBeCloseTo(2.5, 6)
  })
})

describe('速度连续性（核心回归护栏）', () => {
  /**
   * 这是换掉旧算法的直接原因：旧实现用 smoothstep，每个中间关键帧
   * 速度都归零，相机在那里"停一下"再走。新实现必须速度连续。
   */
  it('中间关键帧处速度不为零，且与两侧接近', () => {
    const knots = knotsOf([
      [0, 0, 2, 10],
      [2, 5, 2, 10],
      [4, 10, 2, 10]
    ])
    const speeds = sampleSpeeds(knots, 4, 24)
    const atKey = speeds.find((entry) => Math.abs(entry.time - 2) < 1e-9)
    expect(atKey).toBeTruthy()
    expect(atKey.speed).toBeGreaterThan(2)

    const neighbours = speeds.filter((entry) => Math.abs(entry.time - 2) <= 2 / 24 + 1e-9)
    for (const entry of neighbours) {
      expect(entry.speed).toBeGreaterThan(2)
    }
  })

  it('非共线（弧线）运动速度也连续：相邻采样的速度变化很小', () => {
    // 一条明显的弧：x 前进、z 先远离再回来
    const knots = knotsOf([
      [0, 0, 2, 0],
      [2, 5, 2, 3],
      [4, 10, 2, 0]
    ])
    const speeds = sampleSpeeds(knots, 4, 24).map((entry) => entry.speed)
    for (let index = 1; index < speeds.length; index += 1) {
      const jump = Math.abs(speeds[index] - speeds[index - 1])
      // 24fps 下相邻两帧的速度跳变应当很小（旧算法在关键帧处会跳到 0）
      expect(jump).toBeLessThan(0.6)
    }
  })

  it('弧线轨迹确实离开了两端的连直线（说明有曲率，不是分段直线）', () => {
    const knots = knotsOf([
      [0, 0, 2, 0],
      [2, 5, 2, 3],
      [4, 10, 2, 0]
    ])
    // 首尾连线的中点 (5,2,0)；轨迹在 t=2 处是控制点 (5,2,3)，明显偏离
    const midpointOfChord = { x: 5, y: 2, z: 0 }
    const actual = evaluatePositionTrack(knots, 2)
    expect(Math.abs(actual.z - midpointOfChord.z)).toBeGreaterThan(1)
  })
})

describe('两个关键帧：匀速直线', () => {
  /**
   * 用户要求的是"两个关键帧之间平滑运动"。只有两个关键帧时没有邻居
   * 可以提供切线，端点用单侧割线后三次 Hermite 会精确退化为匀速直线——
   * 既穿过两端，又不会出现缓动停顿。
   */
  it('退化为匀速直线运动', () => {
    const knots = knotsOf([
      [0, 0, 1, 0],
      [3, 9, 1, 0]
    ])
    const speeds = sampleSpeeds(knots, 3, 24).map((entry) => entry.speed)
    const min = Math.min(...speeds)
    const max = Math.max(...speeds)
    expect(min).toBeCloseTo(3, 6)
    expect(max).toBeCloseTo(3, 6)
  })

  it('中间时刻位置落在连线上', () => {
    const knots = knotsOf([
      [0, 0, 1, 0],
      [4, 8, 3, 0]
    ])
    const half = evaluatePositionTrack(knots, 2)
    expect(half.x).toBeCloseTo(4, 9)
    expect(half.y).toBeCloseTo(2, 9)
  })

  it('两段时长不等时，仍然匀速（时间做节点间距的直接结果）', () => {
    const knots = knotsOf([
      [0, 0, 0, 0],
      [1, 2, 0, 0],
      [5, 10, 0, 0]
    ])
    // 第一段 1 秒走 2 米（2m/s），第二段 4 秒走 8 米（2m/s）——共线等速
    const speeds = sampleSpeeds(knots, 5, 24).map((entry) => entry.speed)
    expect(Math.min(...speeds)).toBeCloseTo(2, 4)
    expect(Math.max(...speeds)).toBeCloseTo(2, 4)
  })
})

describe('过冲抑制', () => {
  it('急折角处不会飞到关键帧包围盒之外太多', () => {
    // 90° 急转弯，普通 Catmull-Rom 容易在拐角外侧甩出去
    const knots = knotsOf([
      [0, 0, 0, 0],
      [1, 10, 0, 0],
      [2, 10, 0, 10]
    ])
    let maxX = -Infinity
    let maxZ = -Infinity
    for (let index = 0; index <= 240; index += 1) {
      const position = evaluatePositionTrack(knots, (index / 240) * 2)
      maxX = Math.max(maxX, position.x)
      maxZ = Math.max(maxZ, position.z)
    }
    // 关键帧 x 最大 10、z 最大 10；过冲必须被压在小范围内
    expect(maxX).toBeLessThan(13)
    expect(maxZ).toBeLessThan(13)
  })
})

describe('evaluateScalarTrack', () => {
  it('单关键帧时返回常数', () => {
    expect(evaluateScalarTrack([{ time: 1, value: 7 }], 0)).toBe(7)
    expect(evaluateScalarTrack([{ time: 1, value: 7 }], 99)).toBe(7)
  })

  it('空输入返回 null，调用方可以据此跳过', () => {
    expect(evaluateScalarTrack([], 0)).toBeNull()
    expect(evaluateScalarTrack(null, 0)).toBeNull()
  })

  it('关键帧时刻精确取值', () => {
    const knots = [
      { time: 0, value: 10 },
      { time: 2, value: 20 },
      { time: 4, value: 15 }
    ]
    expect(evaluateScalarTrack(knots, 0)).toBeCloseTo(10, 9)
    expect(evaluateScalarTrack(knots, 2)).toBeCloseTo(20, 9)
    expect(evaluateScalarTrack(knots, 4)).toBeCloseTo(15, 9)
  })
})

describe('normalizeKnots', () => {
  it('按时间升序排序', () => {
    const items = [
      { t: 3, x: 3 },
      { t: 1, x: 1 }
    ]
    const result = normalizeKnots(items, (item) => item.t, (item) => item.x)
    expect(result.map((entry) => entry.time)).toEqual([1, 3])
  })

  it('同刻重复合并（保留后者），避免除零产生 NaN', () => {
    const items = [
      { t: 1, x: 1 },
      { t: 1, x: 9 }
    ]
    const result = normalizeKnots(items, (item) => item.t, (item) => item.x)
    expect(result).toHaveLength(1)
    expect(result[0].value).toBe(9)
  })

  it('丢弃时间或数值非法（含 NaN）的项', () => {
    const items = [
      { t: NaN, x: 1 },
      { t: 1, x: NaN },
      { t: 2, x: 5 }
    ]
    const result = normalizeKnots(items, (item) => item.t, (item) => item.x)
    expect(result).toHaveLength(1)
    expect(result[0].value).toBe(5)
  })

  it('空输入返回空数组', () => {
    expect(normalizeKnots(null, (i) => i.t, (i) => i.x)).toEqual([])
    expect(normalizeKnots([], (i) => i.t, (i) => i.x)).toEqual([])
  })
})

describe('病态输入下的健壮性', () => {
  it('全部同刻的时刻不会产生 NaN', () => {
    const knots = [
      { time: 1, position: { x: 0, y: 0, z: 0 } },
      { time: 1, position: { x: 5, y: 0, z: 0 } }
    ]
    const result = evaluatePositionTrack(knots, 1)
    expect(Number.isFinite(result.x)).toBe(true)
  })

  it('关键帧很多时也稳定穿过每一个', () => {
    const knots = knotsOf(
      Array.from({ length: 8 }, (_, index) => [index, index * 2, 1 + Math.sin(index), -index])
    )
    for (const knot of knots) {
      const result = evaluatePositionTrack(knots, knot.time)
      expect(result.x).toBeCloseTo(knot.position.x, 6)
      expect(result.y).toBeCloseTo(knot.position.y, 6)
      expect(result.z).toBeCloseTo(knot.position.z, 6)
    }
  })
})
