/**
 * 自动关键帧纯逻辑测试。
 *
 * 重点守四件事：
 * 1. 只对"可动画字段"打帧——改颜色/改名/显隐绝不能产生关键帧；
 * 2. 同一时刻重复打帧必须覆盖而非追加（实测追加会让数据静默劣化）；
 * 3. 播放中 / 只读工程不打帧；
 * 4. 一次变更只产生一个场景对象（保证"拖一次 = 撤销一次"）。
 */
import { describe, expect, it } from 'vitest'
import {
  applyAutoKey,
  buildCameraState,
  buildObjectTransform,
  cameraChanged,
  collectAutoKeyTargets,
  objectTransformChanged,
  shouldAutoKey,
  upsertCameraShot,
  upsertObjectKeyframe
} from './auto-key'

function vec(x = 0, y = 0, z = 0) {
  return { x, y, z }
}

function makeObject(overrides = {}) {
  return {
    id: 'obj-1',
    kind: 'box',
    name: '方块 01',
    position: vec(0, 0, 0),
    rotation: vec(0, 0, 0),
    size: vec(1, 1, 1),
    color: '#c9cdd0',
    visible: true,
    locked: false,
    ...overrides
  }
}

function makeCamera(overrides = {}) {
  return {
    position: vec(0, 0, 5),
    target: vec(0, 0, 0),
    fovDegrees: 42,
    aspectWidth: 16,
    aspectHeight: 9,
    ...overrides
  }
}

function makeScene(overrides = {}) {
  return {
    objects: [makeObject()],
    camera: makeCamera(),
    lighting: { lights: [] },
    timeline: { durationSeconds: 5, cameraShots: [], objectKeyframes: [] },
    ...overrides
  }
}

let idCounter = 0
const createId = () => `id-${(idCounter += 1)}`

function autoKeyOptions(overrides = {}) {
  return { enabled: true, playing: false, readOnly: false, timeSeconds: 1, createId, ...overrides }
}

describe('buildObjectTransform', () => {
  it('只取位姿与人台字段，颜色/名称不进关键帧', () => {
    const transform = buildObjectTransform(
      makeObject({ color: '#ff0000', name: '改了名' })
    )
    expect(Object.keys(transform).sort()).toEqual(['position', 'rotation', 'size'])
  })

  it('人台物体带上姿势、预设与手动关节（漏了手动关节预览会跳回预设）', () => {
    const transform = buildObjectTransform(
      makeObject({
        kind: 'mannequin',
        mannequin: {
          presetId: 'walk',
          pose: { head: vec(1, 2, 3) },
          manualJoints: ['head', 'spine']
        }
      })
    )
    expect(transform.mannequinPresetId).toBe('walk')
    expect(transform.mannequinPose.head).toEqual(vec(1, 2, 3))
    expect(transform.mannequinManualJoints).toEqual(['head', 'spine'])
  })

  it('深拷贝：改原对象不会污染已生成的关键帧数据', () => {
    const object = makeObject()
    const transform = buildObjectTransform(object)
    object.position.x = 999
    expect(transform.position.x).toBe(0)
  })

  it('空输入返回 null，不抛错', () => {
    expect(buildObjectTransform(null)).toBeNull()
  })
})

describe('buildCameraState', () => {
  it('带上画幅（求值层需要它做输出画幅覆盖）', () => {
    const state = buildCameraState(makeCamera())
    expect(state.aspectWidth).toBe(16)
    expect(state.aspectHeight).toBe(9)
  })

  it('空输入返回 null', () => {
    expect(buildCameraState(null)).toBeNull()
  })
})

describe('objectTransformChanged', () => {
  it('位置变化算改变', () => {
    expect(objectTransformChanged(makeObject(), makeObject({ position: vec(1, 0, 0) }))).toBe(true)
  })

  it('旋转 / 缩放变化都算改变', () => {
    expect(objectTransformChanged(makeObject(), makeObject({ rotation: vec(0, 90, 0) }))).toBe(true)
    expect(objectTransformChanged(makeObject(), makeObject({ size: vec(2, 1, 1) }))).toBe(true)
  })

  it('只改颜色 / 名称 / 显隐 / 锁定不算改变（这些不该打帧）', () => {
    const base = makeObject()
    expect(objectTransformChanged(base, makeObject({ color: '#ff0000' }))).toBe(false)
    expect(objectTransformChanged(base, makeObject({ name: '新名字' }))).toBe(false)
    expect(objectTransformChanged(base, makeObject({ visible: false }))).toBe(false)
    expect(objectTransformChanged(base, makeObject({ locked: true }))).toBe(false)
  })

  it('人台姿势变化算改变', () => {
    const prev = makeObject({ mannequin: { presetId: 'stand', pose: { head: vec(0, 0, 0) } } })
    const next = makeObject({ mannequin: { presetId: 'stand', pose: { head: vec(5, 0, 0) } } })
    expect(objectTransformChanged(prev, next)).toBe(true)
  })

  it('人台预设变化算改变（即使姿势恰好相同）', () => {
    const pose = { head: vec(0, 0, 0) }
    const prev = makeObject({ mannequin: { presetId: 'stand', pose } })
    const next = makeObject({ mannequin: { presetId: 'walk', pose } })
    expect(objectTransformChanged(prev, next)).toBe(true)
  })

  it('手动关节列表变化算改变', () => {
    const prev = makeObject({ mannequin: { presetId: 'stand', manualJoints: [] } })
    const next = makeObject({ mannequin: { presetId: 'stand', manualJoints: ['head'] } })
    expect(objectTransformChanged(prev, next)).toBe(true)
  })

  it('浮点抖动在容差内不算改变，避免拖拽抖动灌满撤销栈', () => {
    const prev = makeObject()
    const next = makeObject({ position: vec(1e-9, 0, 0) })
    expect(objectTransformChanged(prev, next)).toBe(false)
  })

  it('任一侧缺失按"没变"处理，不误报', () => {
    expect(objectTransformChanged(null, makeObject())).toBe(false)
    expect(objectTransformChanged(makeObject(), null)).toBe(false)
  })
})

describe('cameraChanged', () => {
  it('机位 / 注视点 / 视场角变化都算改变', () => {
    const base = makeCamera()
    expect(cameraChanged(base, makeCamera({ position: vec(1, 0, 5) }))).toBe(true)
    expect(cameraChanged(base, makeCamera({ target: vec(0, 1, 0) }))).toBe(true)
    expect(cameraChanged(base, makeCamera({ fovDegrees: 60 }))).toBe(true)
  })

  it('只改画幅不算改变——画幅是全局输出设置，不是动画属性', () => {
    const base = makeCamera()
    expect(cameraChanged(base, makeCamera({ aspectWidth: 9, aspectHeight: 16 }))).toBe(false)
  })
})

describe('collectAutoKeyTargets', () => {
  it('收集位姿变化的物体', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [makeObject({ position: vec(2, 0, 0) })] })
    const targets = collectAutoKeyTargets(prev, next)
    expect(targets.objects).toHaveLength(1)
    expect(targets.objects[0].objectId).toBe('obj-1')
  })

  it('新增物体不打帧（Maya 里新建对象不自动产生关键帧）', () => {
    const prev = makeScene({ objects: [] })
    const next = makeScene({ objects: [makeObject()] })
    expect(collectAutoKeyTargets(prev, next).objects).toHaveLength(0)
  })

  it('删除物体不打帧，否则会留下孤儿轨道', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [] })
    expect(collectAutoKeyTargets(prev, next).objects).toHaveLength(0)
  })

  it('锁定的物体即使位姿变了也不打帧（锁定的意义就是防误改）', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [makeObject({ position: vec(9, 0, 0), locked: true })] })
    expect(collectAutoKeyTargets(prev, next).objects).toHaveLength(0)
  })

  it('相机变化被单独收集', () => {
    const prev = makeScene()
    const next = makeScene({ camera: makeCamera({ position: vec(1, 1, 1) }) })
    const targets = collectAutoKeyTargets(prev, next)
    expect(targets.camera).not.toBeNull()
    expect(targets.objects).toHaveLength(0)
  })

  it('无变化时两个目标都为空', () => {
    const prev = makeScene()
    const targets = collectAutoKeyTargets(prev, makeScene())
    expect(targets.objects).toHaveLength(0)
    expect(targets.camera).toBeNull()
  })

  it('空输入不崩', () => {
    expect(collectAutoKeyTargets(null, null)).toEqual({ objects: [], camera: null })
  })
})

describe('upsertObjectKeyframe', () => {
  const transform = buildObjectTransform(makeObject())

  it('同一时刻已存在则覆盖，不追加', () => {
    const first = upsertObjectKeyframe([], {
      id: 'k1',
      objectId: 'obj-1',
      timeSeconds: 1,
      transform
    })
    const second = upsertObjectKeyframe(first, {
      id: 'k2',
      objectId: 'obj-1',
      timeSeconds: 1,
      transform
    })
    expect(second).toHaveLength(1)
  })

  it('覆盖时沿用原 id，保证时间轴上的选中态不丢', () => {
    const first = upsertObjectKeyframe([], {
      id: 'k1',
      objectId: 'obj-1',
      timeSeconds: 1,
      transform
    })
    const second = upsertObjectKeyframe(first, {
      id: 'k2',
      objectId: 'obj-1',
      timeSeconds: 1,
      transform
    })
    expect(second[0].id).toBe('k1')
  })

  it('不同时刻正常追加并按时间排序', () => {
    let list = upsertObjectKeyframe([], { id: 'k1', objectId: 'obj-1', timeSeconds: 3, transform })
    list = upsertObjectKeyframe(list, { id: 'k2', objectId: 'obj-1', timeSeconds: 1, transform })
    expect(list.map((item) => item.timeSeconds)).toEqual([1, 3])
  })

  it('不同物体的同刻关键帧互不干扰', () => {
    let list = upsertObjectKeyframe([], { id: 'k1', objectId: 'obj-1', timeSeconds: 1, transform })
    list = upsertObjectKeyframe(list, { id: 'k2', objectId: 'obj-2', timeSeconds: 1, transform })
    expect(list).toHaveLength(2)
  })

  it('反复覆盖不会累积垃圾帧（模拟连续拖拽）', () => {
    let list = []
    for (let i = 0; i < 50; i += 1) {
      list = upsertObjectKeyframe(list, { id: `k${i}`, objectId: 'obj-1', timeSeconds: 1, transform })
    }
    expect(list).toHaveLength(1)
  })
})

describe('upsertCameraShot', () => {
  const camera = buildCameraState(makeCamera())

  it('同一时刻覆盖而非追加', () => {
    const first = upsertCameraShot([], { id: 's1', name: '镜头 01', timeSeconds: 2, camera })
    const second = upsertCameraShot(first, { id: 's2', name: '镜头 02', timeSeconds: 2, camera })
    expect(second).toHaveLength(1)
  })

  it('第一个镜头用 cut，后续用 smooth', () => {
    const first = upsertCameraShot([], { id: 's1', name: '镜头 01', timeSeconds: 0, camera })
    expect(first[0].transition).toBe('cut')
    const second = upsertCameraShot(first, { id: 's2', name: '镜头 02', timeSeconds: 2, camera })
    expect(second[1].transition).toBe('smooth')
  })

  it('覆盖已有镜头时保留用户调过的 transition 与名称', () => {
    const first = upsertCameraShot([], { id: 's1', name: '我的镜头', timeSeconds: 0, camera })
    const edited = [{ ...first[0], transition: 'smooth' }]
    const second = upsertCameraShot(edited, { id: 's2', name: '新名字', timeSeconds: 0, camera })
    expect(second[0].transition).toBe('smooth')
    expect(second[0].name).toBe('我的镜头')
  })
})

describe('shouldAutoKey', () => {
  it('开关关闭时不生效', () => {
    expect(shouldAutoKey({ enabled: false, playing: false, timeSeconds: 1 })).toBe(false)
  })

  it('播放中不生效（安全取舍：避免把帧写到"路过"的时刻上）', () => {
    expect(shouldAutoKey({ enabled: true, playing: true, timeSeconds: 1 })).toBe(false)
  })

  it('只读工程不生效', () => {
    expect(shouldAutoKey({ enabled: true, playing: false, readOnly: true, timeSeconds: 1 })).toBe(false)
  })

  it('时刻非法不生效，避免把帧写到 NaN 上', () => {
    expect(shouldAutoKey({ enabled: true, timeSeconds: NaN })).toBe(false)
    expect(shouldAutoKey({ enabled: true })).toBe(false)
  })

  it('正常情况生效', () => {
    expect(shouldAutoKey({ enabled: true, playing: false, readOnly: false, timeSeconds: 0 })).toBe(true)
  })
})

describe('applyAutoKey', () => {
  it('关掉开关时原样返回，不产生任何关键帧', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [makeObject({ position: vec(5, 0, 0) })] })
    const result = applyAutoKey(prev, next, autoKeyOptions({ enabled: false }))
    expect(result.timeline.objectKeyframes).toHaveLength(0)
    expect(result).toBe(next)
  })

  it('开启后自动打帧，且时间落在播放头时刻', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [makeObject({ position: vec(5, 0, 0) })] })
    const result = applyAutoKey(prev, next, autoKeyOptions({ timeSeconds: 2.5 }))
    expect(result.timeline.objectKeyframes).toHaveLength(1)
    expect(result.timeline.objectKeyframes[0].timeSeconds).toBe(2.5)
    expect(result.timeline.objectKeyframes[0].transform.position.x).toBe(5)
  })

  it('相机变化自动打镜头', () => {
    const prev = makeScene()
    const next = makeScene({ camera: makeCamera({ position: vec(3, 3, 3) }) })
    const result = applyAutoKey(prev, next, autoKeyOptions())
    expect(result.timeline.cameraShots).toHaveLength(1)
  })

  it('返回的是新场景对象，原场景不被改动（不可变更新）', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [makeObject({ position: vec(5, 0, 0) })] })
    const result = applyAutoKey(prev, next, autoKeyOptions())
    expect(result).not.toBe(next)
    expect(next.timeline.objectKeyframes).toHaveLength(0)
    expect(prev.timeline.objectKeyframes).toHaveLength(0)
  })

  it('只改颜色时不打帧（否则改色就产生垃圾帧）', () => {
    const prev = makeScene()
    const next = makeScene({ objects: [makeObject({ color: '#00ff00' })] })
    const result = applyAutoKey(prev, next, autoKeyOptions())
    expect(result.timeline.objectKeyframes).toHaveLength(0)
  })

  it('无变化时原样返回同一个引用，让 editScene 判定为"无改动"', () => {
    const prev = makeScene()
    const next = makeScene()
    const result = applyAutoKey(prev, next, autoKeyOptions())
    expect(result).toBe(next)
  })

  it('场景缺少 timeline 时安全跳过', () => {
    const prev = { objects: [] }
    const next = { objects: [makeObject()] }
    expect(() => applyAutoKey(prev, next, autoKeyOptions())).not.toThrow()
  })
})
