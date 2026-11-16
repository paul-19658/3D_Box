import { describe, expect, it } from 'vitest'

import {
  quickBuildMeasurement,
  quickBuildTransform,
  snapQuickBuildEnd,
  snapQuickBuildStart
} from '@/core/quick-build'

/**
 * 快速建墙 / 打地面的几何与尺寸文本。
 *
 * 重点锁住"拖拽中能看清实时尺寸"这件事依赖的两块逻辑：
 * 1. `quickBuildTransform()` —— 幽灵预览与最终成体**共用同一个函数**，
 *    所以预览看到的多大，松手建出来就必须多大（不能各算一套）。
 * 2. `quickBuildMeasurement()` —— HUD 上的尺寸文本。它曾经是**死代码**
 *    （定义了但从没被调用），所以这里把它返回的格式固定下来。
 */
describe('quick-build 几何', () => {
  const wallDraft = (from, to) => ({
    kind: 'wall',
    start: { x: from[0], y: 0, z: from[1] },
    end: { x: to[0], y: 0, z: to[1] }
  })
  const floorDraft = (from, to) => ({
    kind: 'floor',
    start: { x: from[0], y: 0, z: from[1] },
    end: { x: to[0], y: 0, z: to[1] }
  })

  it('墙：长度取两端距离，高度与厚度固定', () => {
    const transform = quickBuildTransform(wallDraft([0, 0], [4, 0]))
    expect(transform.size.x).toBeCloseTo(4, 6)
    expect(transform.size.y).toBeCloseTo(2.8, 6)
    expect(transform.size.z).toBeCloseTo(0.18, 6)
    // 中点
    expect(transform.position.x).toBeCloseTo(2, 6)
    expect(transform.position.z).toBeCloseTo(0, 6)
  })

  it('墙：斜着拖也按真实距离算长度', () => {
    const transform = quickBuildTransform(wallDraft([0, 0], [3, 4]))
    expect(transform.size.x).toBeCloseTo(5, 6)
  })

  it('地面：宽深取两端差值的绝对值（反向拖也是正的）', () => {
    const forward = quickBuildTransform(floorDraft([0, 0], [3, 2]))
    const backward = quickBuildTransform(floorDraft([3, 2], [0, 0]))
    expect(forward.size.x).toBeCloseTo(3, 6)
    expect(forward.size.z).toBeCloseTo(2, 6)
    expect(backward.size.x).toBeCloseTo(3, 6)
    expect(backward.size.z).toBeCloseTo(2, 6)
    // 中心一致
    expect(forward.position.x).toBeCloseTo(backward.position.x, 6)
    expect(forward.position.z).toBeCloseTo(backward.position.z, 6)
  })

  it('太小的拖拽不出体（避免误点留下碎片物体）', () => {
    expect(quickBuildTransform(wallDraft([0, 0], [0.05, 0]))).toBe(null)
    expect(quickBuildTransform(floorDraft([0, 0], [0.05, 0.05]))).toBe(null)
  })
})

describe('quick-build 尺寸文本', () => {
  it('地面：宽 × 深，带单位与两位小数', () => {
    const label = quickBuildMeasurement({
      kind: 'floor',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 3.2, y: 0, z: 1.8 }
    })
    expect(label).toBe('3.20 × 1.80 m')
  })

  it('墙：只显示长度（高度厚度是固定的，显示出来也没意义）', () => {
    const label = quickBuildMeasurement({
      kind: 'wall',
      start: { x: 0, y: 0, z: 0 },
      end: { x: 3.25, y: 0, z: 0 }
    })
    expect(label).toBe('长度 3.25 m')
  })

  it('缺少 start/end 时返回 null，不抛异常（刚按下还没移动的那一帧）', () => {
    expect(quickBuildTransform({ kind: 'wall', start: { x: 0, y: 0, z: 0 }, end: null })).toBe(null)
    expect(quickBuildTransform({ kind: 'floor', start: null, end: null })).toBe(null)
    expect(quickBuildTransform(null)).toBe(null)
    // HUD 文本同样要能扛住
    expect(quickBuildMeasurement({ kind: 'floor', start: { x: 0, y: 0, z: 0 }, end: null })).toBe(
      '请拖出尺寸'
    )
  })

  it('尺寸还没成形时给引导文案，而不是 "0.00 × 0.00"', () => {
    expect(
      quickBuildMeasurement({ kind: 'wall', start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 } })
    ).toBe('请拖出尺寸')
  })

  it('文本随拖拽单调增长（这正是"能看清实时变化"的最低要求）', () => {
    const widths = [0.5, 1.5, 3, 6].map((width) => {
      const label = quickBuildMeasurement({
        kind: 'floor',
        start: { x: 0, y: 0, z: 0 },
        end: { x: width, y: 0, z: 1 }
      })
      return Number.parseFloat(label)
    })
    for (let index = 1; index < widths.length; index += 1) {
      expect(widths[index]).toBeGreaterThan(widths[index - 1])
    }
  })
})

describe('quick-build 吸附', () => {
  it('起点吸附到 0.1 网格', () => {
    const snapped = snapQuickBuildStart({ x: 1.234, y: 0, z: -0.04 })
    expect(snapped.x).toBeCloseTo(1.2, 6)
    // -0.04 四舍五入到 0（不要出现 -0，否则 `Object.is` 判断会分叉）
    expect(snapped.z).toBe(0)
    expect(Object.is(snapped.z, -0)).toBe(false)
    expect(snapped.y).toBe(0)
  })

  it('墙在 8 度容差内吸附成水平/垂直', () => {
    const start = { x: 0, y: 0, z: 0 }
    // 几乎水平 → z 拉平到起点
    expect(snapQuickBuildEnd('wall', start, { x: 4, y: 0, z: 0.3 }).point.z).toBe(0)
    // 几乎垂直 → x 拉平到起点
    expect(snapQuickBuildEnd('wall', start, { x: 0.3, y: 0, z: 4 }).point.x).toBe(0)
    // 明显斜向 → 不吸附
    expect(snapQuickBuildEnd('wall', start, { x: 3, y: 0, z: 3 }).axisSnapped).toBe(false)
  })

  it('地面不做方向吸附（矩形本来就该自由拖）', () => {
    const result = snapQuickBuildEnd('floor', { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0.3 })
    expect(result.axisSnapped).toBe(false)
    expect(result.point.z).not.toBe(0)
  })
})
