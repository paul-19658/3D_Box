/**
 * 相机 target 绑定的纯逻辑测试。
 *
 * 重点守三件事：
 * 1. 对准点要抹平"position 语义按类型不同"的差异（人台在脚底、基本体在中心）；
 * 2. 绑定失效必须优雅退回静态 target，不能让相机跳到原点；
 * 3. 未绑定时必须原样返回同一个引用——求值链路每帧都会调它，不能无谓造对象。
 */
import { describe, expect, it } from 'vitest'
import {
  isTargetActive,
  isTargetBindingAlive,
  isTargetBound,
  lookAtEnabledPatch,
  objectFocusPoint,
  resolveCameraTarget,
  targetBindingPatch
} from './camera-target'

const camera = (overrides = {}) => ({
  position: { x: 0, y: 2, z: 5 },
  target: { x: 0, y: 1, z: 0 },
  fovDegrees: 42,
  aspectWidth: 16,
  aspectHeight: 9,
  ...overrides
})

const box = (overrides = {}) => ({
  id: 'box-1',
  kind: 'box',
  position: { x: 0, y: 1.1, z: 0 },
  size: { x: 1, y: 1, z: 1 },
  ...overrides
})

const mannequin = (overrides = {}) => ({
  id: 'man-1',
  kind: 'mannequin',
  position: { x: 2, y: 0, z: -1 },
  size: { x: 1, y: 1.8, z: 1 },
  ...overrides
})

describe('objectFocusPoint', () => {
  it('基本体 position 就是几何中心，直接用它', () => {
    expect(objectFocusPoint(box())).toEqual({ x: 0, y: 1.1, z: 0 })
  })

  it('人台的 position 在脚底，要对准它的竖直中心（否则镜头对着脚看）', () => {
    expect(objectFocusPoint(mannequin())).toEqual({ x: 2, y: 0.9, z: -1 })
  })

  it('导入模型的 position 也在底部，同样抬升半个高度', () => {
    const imported = { id: 'i', kind: 'imported', position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 2, z: 1 } }
    expect(objectFocusPoint(imported)).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('缺 size 的人台按 0 抬升，不产生 NaN', () => {
    const noSize = { id: 'm', kind: 'mannequin', position: { x: 1, y: 0, z: 1 } }
    expect(objectFocusPoint(noSize)).toEqual({ x: 1, y: 0, z: 1 })
  })

  it('坐标非法时按 0 处理，不让 NaN 污染相机', () => {
    const broken = { id: 'b', kind: 'box', position: { x: NaN, y: undefined, z: 3 } }
    expect(objectFocusPoint(broken)).toEqual({ x: 0, y: 0, z: 3 })
  })

  it('空输入返回 null，不抛错', () => {
    expect(objectFocusPoint(null)).toBeNull()
    expect(objectFocusPoint({})).toBeNull()
    expect(objectFocusPoint({ position: null })).toBeNull()
  })
})

describe('isTargetBound', () => {
  it('对象 id 有效才算绑定', () => {
    expect(isTargetBound(camera({ targetObjectId: 'box-1' }))).toBe(true)
    expect(isTargetBound(camera({ targetObjectId: null }))).toBe(false)
    expect(isTargetBound(camera({ targetObjectId: '' }))).toBe(false)
    expect(isTargetBound(camera())).toBe(false)
  })

  it('只表示"有引用"，与开关无关', () => {
    expect(isTargetBound(camera({ targetObjectId: 'box-1', lookAtEnabled: false }))).toBe(true)
  })
})

/**
 * "看向物体"开关：`targetObjectId` 记着绑的是谁，`lookAtEnabled` 决定用不用它。
 * 关掉后相机回到静态 target，但绑定关系保留。
 */
describe('isTargetActive / lookAtEnabled', () => {
  it('绑定了且开关打开（或缺省）才算生效', () => {
    expect(isTargetActive(camera({ targetObjectId: 'box-1' }))).toBe(true)
    expect(isTargetActive(camera({ targetObjectId: 'box-1', lookAtEnabled: true }))).toBe(true)
    expect(isTargetActive(camera({ targetObjectId: 'box-1', lookAtEnabled: false }))).toBe(false)
  })

  it('没绑定时无论开关如何都不生效', () => {
    expect(isTargetActive(camera({ lookAtEnabled: true }))).toBe(false)
    expect(isTargetActive(camera({ targetObjectId: null, lookAtEnabled: true }))).toBe(false)
  })

  it('缺省视为启用（v14 及更早的工程没有这个字段）', () => {
    const legacy = camera({ targetObjectId: 'box-1' })
    expect('lookAtEnabled' in legacy).toBe(false)
    expect(isTargetActive(legacy)).toBe(true)
  })

  it('关闭后 resolveCameraTarget 退回静态 target，但原相机不被改动', () => {
    const off = camera({ targetObjectId: 'box-1', lookAtEnabled: false })
    const resolved = resolveCameraTarget(off, [box({ position: { x: 9, y: 1, z: 9 } })])
    expect(resolved).toBe(off)
    expect(resolved.target).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('关闭只是"暂时不用"，绑定关系仍在', () => {
    const off = camera({ targetObjectId: 'box-1', lookAtEnabled: false })
    expect(isTargetBound(off)).toBe(true)
    // 物体还在 → 绑定是健康的，UI 不该提示"物体已不存在"
    expect(isTargetBindingAlive(off, [box()])).toBe(true)
  })

  it('重新打开后立刻恢复跟随', () => {
    const on = camera({ targetObjectId: 'box-1', lookAtEnabled: true })
    expect(resolveCameraTarget(on, [box({ position: { x: 4, y: 1.1, z: 0 } })]).target).toEqual({
      x: 4,
      y: 1.1,
      z: 0
    })
  })
})

describe('lookAtEnabledPatch', () => {
  it('产出布尔补丁', () => {
    expect(lookAtEnabledPatch(false)).toEqual({ lookAtEnabled: false })
    expect(lookAtEnabledPatch(true)).toEqual({ lookAtEnabled: true })
    expect(lookAtEnabledPatch(undefined)).toEqual({ lookAtEnabled: false })
  })
})

describe('resolveCameraTarget', () => {
  it('未绑定时原样返回同一引用（逐帧调用不能每次都造新对象）', () => {
    const plain = camera()
    expect(resolveCameraTarget(plain, [box()])).toBe(plain)
  })

  it('绑定后 target 变成该物体的对准点', () => {
    const resolved = resolveCameraTarget(camera({ targetObjectId: 'man-1' }), [box(), mannequin()])
    expect(resolved.target).toEqual({ x: 2, y: 0.9, z: -1 })
  })

  it('物体移动后 target 跟着走（这就是"锁定并跟随"）', () => {
    const bound = camera({ targetObjectId: 'box-1' })
    const before = resolveCameraTarget(bound, [box()])
    const after = resolveCameraTarget(bound, [box({ position: { x: 7, y: 1.1, z: 3 } })])
    expect(before.target).toEqual({ x: 0, y: 1.1, z: 0 })
    expect(after.target).toEqual({ x: 7, y: 1.1, z: 3 })
  })

  it('没改动原相机（不可变更新）', () => {
    const bound = camera({ targetObjectId: 'box-1' })
    resolveCameraTarget(bound, [box({ position: { x: 9, y: 1, z: 9 } })])
    expect(bound.target).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('绑定的物体被删掉时退回静态 target，不跳到原点', () => {
    const bound = camera({ targetObjectId: '已删除的物体' })
    const resolved = resolveCameraTarget(bound, [box()])
    expect(resolved).toBe(bound)
    expect(resolved.target).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('物体列表为空/非法时安全退回', () => {
    const bound = camera({ targetObjectId: 'box-1' })
    expect(resolveCameraTarget(bound, [])).toBe(bound)
    expect(resolveCameraTarget(bound, null)).toBe(bound)
  })

  it('位置与朝向是两份数据：position 保持不变，只换 target', () => {
    const bound = camera({ targetObjectId: 'box-1', position: { x: 5, y: 5, z: 5 } })
    const resolved = resolveCameraTarget(bound, [box()])
    expect(resolved.position).toEqual({ x: 5, y: 5, z: 5 })
  })
})

describe('isTargetBindingAlive', () => {
  it('绑定且物体还在 → 真', () => {
    expect(isTargetBindingAlive(camera({ targetObjectId: 'box-1' }), [box()])).toBe(true)
  })

  it('绑定但物体不在了 → 假（UI 要提示用户解除）', () => {
    expect(isTargetBindingAlive(camera({ targetObjectId: 'gone' }), [box()])).toBe(false)
  })

  it('未绑定 → 假', () => {
    expect(isTargetBindingAlive(camera(), [box()])).toBe(false)
  })
})

describe('targetBindingPatch', () => {
  it('设置绑定', () => {
    expect(targetBindingPatch('box-1')).toEqual({ targetObjectId: 'box-1' })
  })

  it('解除绑定用 null，而不是空字符串（schema 里是 nullable）', () => {
    expect(targetBindingPatch(null)).toEqual({ targetObjectId: null })
    expect(targetBindingPatch('')).toEqual({ targetObjectId: null })
  })
})
