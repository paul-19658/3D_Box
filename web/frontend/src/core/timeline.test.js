import { describe, expect, it } from 'vitest'

import {
  TIMELINE_FRAME_RATE,
  applyObjectKeyframePreview,
  evaluateCameraShots,
  evaluateObjectKeyframes,
  evaluateTimelineAtTime,
  findAvailableTimelineTime,
  frameIndexToTime,
  timeToFrameIndex
} from '@/core/timeline'

const camera = (x) => ({
  position: { x, y: 5, z: 8 },
  target: { x: 0, y: 1, z: 0 },
  fovDegrees: 42,
  aspectWidth: 16,
  aspectHeight: 9
})

const shot = (id, time, x, transition = 'smooth') => ({
  id,
  name: id,
  timeSeconds: time,
  transition,
  camera: camera(x)
})

const transform = (x) => ({
  position: { x, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  size: { x: 1, y: 1, z: 1 }
})

const keyframe = (id, time, x, interpolation = 'smooth') => ({
  id,
  objectId: 'obj-1',
  timeSeconds: time,
  interpolation,
  transform: transform(x)
})

describe('时间轴求值', () => {
  it('没有镜头时返回 null，调用方回退到编辑相机', () => {
    expect(evaluateCameraShots([], 1, camera(0))).toBeNull()
  })

  it('首尾之外保持端点镜头，不会外插', () => {
    const shots = [shot('a', 1, 1), shot('b', 3, 3)]
    expect(evaluateCameraShots(shots, 0, camera(0)).position.x).toBe(1)
    expect(evaluateCameraShots(shots, 99, camera(0)).position.x).toBe(3)
  })

  it('smooth 过渡在正中间取中点', () => {
    const shots = [shot('a', 0, 0), shot('b', 2, 10)]
    expect(evaluateCameraShots(shots, 1, camera(0)).position.x).toBeCloseTo(5, 6)
  })

  /*
   * 行为变更说明（schema 无关，纯插值算法升级）：
   *
   * 旧实现用 smoothstep 缓动，两个关键帧之间是"慢-快-慢"，所以
   * t=0.5 时位置是 1.5625；代价是**每个中间关键帧速度归零**，
   * 多镜头推移会一顿一顿。
   *
   * 新实现用时间参数化的向心 Catmull-Rom（见 core/camera-path.js）：
   * 只有两个关键帧时，两端切线都等于该割线，三次 Hermite 精确退化为
   * **匀速直线运动**，所以 t=0.5 时位置是 2.5（线性）。
   * 这是刻意的取舍——"不停顿"比"每段缓入缓出"更接近真实运镜。
   */
  it('两个关键帧之间是匀速直线运动（不再是 smoothstep 缓动）', () => {
    const shots = [shot('a', 0, 0), shot('b', 2, 10)]
    expect(evaluateCameraShots(shots, 0.5, camera(0)).position.x).toBeCloseTo(2.5, 6)
    expect(evaluateCameraShots(shots, 1.5, camera(0)).position.x).toBeCloseTo(7.5, 6)
  })

  it('多个关键帧时速度连续：中间镜头处不归零', () => {
    const shots = [shot('a', 0, 0), shot('b', 2, 10), shot('c', 4, 20)]
    const atKey = evaluateCameraShots(shots, 2, camera(0)).position.x
    const before = evaluateCameraShots(shots, 2 - 1 / 24, camera(0)).position.x
    const after = evaluateCameraShots(shots, 2 + 1 / 24, camera(0)).position.x
    expect(atKey).toBeCloseTo(10, 6)
    // 关键帧前后各一帧的位移应当接近（旧算法在这里会骤降）
    expect(Math.abs(after - atKey)).toBeCloseTo(Math.abs(atKey - before), 2)
    expect(Math.abs(after - atKey)).toBeGreaterThan(0.1)
  })

  it('三个关键帧不再共线时，轨迹会离开两端的连直线（有弧线）', () => {
    const arc = (x, z) => ({ ...camera(x), target: { x: 0, y: 1, z: 0 }, position: { x, y: 2, z } })
    const shots = [
      { id: 'a', name: 'a', timeSeconds: 0, transition: 'smooth', camera: arc(0, 0) },
      { id: 'b', name: 'b', timeSeconds: 2, transition: 'smooth', camera: arc(5, 3) },
      { id: 'c', name: 'c', timeSeconds: 4, transition: 'smooth', camera: arc(10, 0) }
    ]
    const atMid = evaluateCameraShots(shots, 2, camera(0)).position
    // 首尾连线中点是 (5,2,0)，实际经过 (5,2,3)
    expect(atMid.z).toBeCloseTo(3, 6)
  })

  it('cut 镜头在到达前保持上一个镜头', () => {
    const shots = [shot('a', 0, 1), shot('b', 2, 9, 'cut')]
    expect(evaluateCameraShots(shots, 1.99, camera(0)).position.x).toBe(1)
  })

  it('输出画幅始终跟随导出的目标画幅', () => {
    const shots = [shot('a', 0, 0)]
    const frame = evaluateCameraShots(shots, 0, { aspectWidth: 9, aspectHeight: 16 })
    expect(frame.aspectWidth).toBe(9)
    expect(frame.aspectHeight).toBe(16)
  })
})

describe('物体关键帧', () => {
  it('单帧轨道在整个时间范围内都返回该帧', () => {
    const tracks = evaluateObjectKeyframes([keyframe('k1', 2, 4)], 0.5)
    expect(tracks.get('obj-1').position.x).toBe(4)
  })

  it('线性插值按比例推进', () => {
    const tracks = evaluateObjectKeyframes(
      [keyframe('k1', 0, 0, 'linear'), keyframe('k2', 2, 10, 'linear')],
      1
    )
    expect(tracks.get('obj-1').position.x).toBeCloseTo(5, 6)
  })

  it('旋转走最短角路径，350° → 10° 不会绕一大圈', () => {
    const first = keyframe('k1', 0, 0)
    const second = keyframe('k2', 2, 0)
    first.transform.rotation.y = 350
    second.transform.rotation.y = 10
    const tracks = evaluateObjectKeyframes([first, second], 1)
    const value = tracks.get('obj-1').rotation.y
    expect(value).toBeGreaterThanOrEqual(350)
    expect(value).toBeLessThanOrEqual(370)
  })

  it('预览叠加不修改原始物体对象', () => {
    const objects = [
      {
        id: 'obj-1',
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        size: { x: 1, y: 1, z: 1 }
      }
    ]
    const tracks = evaluateObjectKeyframes([keyframe('k1', 0, 7)], 0)
    const preview = applyObjectKeyframePreview(objects, tracks)
    expect(preview[0].position.x).toBe(7)
    expect(objects[0].position.x).toBe(0)
  })
})

describe('帧号与时间互换', () => {
  it('时间转帧号按固定 24fps 四舍五入', () => {
    expect(TIMELINE_FRAME_RATE).toBe(24)
    expect(timeToFrameIndex(1, 10)).toBe(24)
  })

  it('帧号转时间会被夹紧在时长范围内', () => {
    expect(frameIndexToTime(24, 10)).toBe(1)
    expect(frameIndexToTime(99999, 2)).toBe(2)
  })
})

describe('findAvailableTimelineTime', () => {
  it('空闲时间点原样返回', () => {
    expect(findAvailableTimelineTime(1, [], 5)).toBe(1)
  })

  it('与已有标记重叠时让开至少 0.05 秒', () => {
    const result = findAvailableTimelineTime(1, [1], 5)
    expect(Math.abs(result - 1)).toBeGreaterThanOrEqual(0.05)
  })

  it('超出时长时夹紧到时长', () => {
    expect(findAvailableTimelineTime(99, [], 5)).toBe(5)
  })
})

describe('evaluateTimelineAtTime', () => {
  it('同时返回相机与所有物体变换', () => {
    const timeline = {
      durationSeconds: 4,
      cameraShots: [shot('a', 0, 1)],
      objectKeyframes: [keyframe('k1', 0, 3)]
    }
    const frame = evaluateTimelineAtTime(timeline, camera(0), 2)
    expect(frame.timeSeconds).toBe(2)
    expect(frame.camera.position.x).toBe(1)
    expect(frame.objectTransforms.get('obj-1').position.x).toBe(3)
  })

  it('时间会被夹紧在 [0, duration] 内', () => {
    const timeline = { durationSeconds: 4, cameraShots: [], objectKeyframes: [] }
    expect(evaluateTimelineAtTime(timeline, camera(0), -5).timeSeconds).toBe(0)
    expect(evaluateTimelineAtTime(timeline, camera(0), 50).timeSeconds).toBe(4)
  })
})

/**
 * 相机 target 绑定物体时的求值。
 *
 * 这是"相机跟随物体"的核心：绑定必须按**该时刻**物体的位置解算，
 * 否则物体一动镜头就跟丢了；而且打了镜头轨之后绑定不能失效
 * （镜头是从 shot 数据重建的，不会自带 targetObjectId）。
 */
describe('evaluateTimelineAtTime：相机绑定物体', () => {
  const boundCamera = (overrides = {}) => ({ ...camera(0), targetObjectId: 'obj-1', ...overrides })

  const boxObject = (x, y = 1.1) => ({
    id: 'obj-1',
    kind: 'box',
    position: { x, y, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 }
  })

  it('看向点等于被绑定物体在该时刻的位置', () => {
    const timeline = { durationSeconds: 4, cameraShots: [], objectKeyframes: [] }
    const frame = evaluateTimelineAtTime(timeline, boundCamera(), 0, [boxObject(7, 1.1)])
    expect(frame.camera.target).toEqual({ x: 7, y: 1.1, z: 0 })
  })

  it('物体有关键帧动画时，不同时刻的看向点跟着变', () => {
    const timeline = {
      durationSeconds: 4,
      cameraShots: [],
      objectKeyframes: [keyframe('k1', 0, 0), keyframe('k2', 4, 8)]
    }
    const objects = [boxObject(0)]
    const at0 = evaluateTimelineAtTime(timeline, boundCamera(), 0, objects)
    const at4 = evaluateTimelineAtTime(timeline, boundCamera(), 4, objects)
    expect(at0.camera.target.x).toBe(0)
    expect(at4.camera.target.x).toBe(8)
  })

  it('打了镜头轨后绑定依然生效（target 以基准相机为准）', () => {
    const timeline = {
      durationSeconds: 4,
      // 镜头记录了机位，但它不含 targetObjectId——绑定必须从基准相机带过来
      cameraShots: [shot('a', 0, 1)],
      objectKeyframes: []
    }
    const frame = evaluateTimelineAtTime(timeline, boundCamera(), 1, [boxObject(5, 2)])
    expect(frame.camera.position.x).toBe(1)
    expect(frame.camera.target).toEqual({ x: 5, y: 2, z: 0 })
  })

  it('未绑定时行为不变（target 用相机自己的）', () => {
    const timeline = { durationSeconds: 4, cameraShots: [], objectKeyframes: [] }
    const frame = evaluateTimelineAtTime(timeline, camera(0), 0, [boxObject(7)])
    expect(frame.camera.target).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('绑定的物体不存在时退回静态 target，不跳到原点', () => {
    const timeline = { durationSeconds: 4, cameraShots: [], objectKeyframes: [] }
    const frame = evaluateTimelineAtTime(timeline, boundCamera(), 0, [boxObject(7)])
    // 换成一个 id 对不上的物体列表
    const other = evaluateTimelineAtTime(timeline, boundCamera(), 0, [{ ...boxObject(7), id: '别的物体' }])
    expect(frame.camera.target).toEqual({ x: 7, y: 1.1, z: 0 })
    expect(other.camera.target).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('人台绑定时对准竖直中心，而不是脚底', () => {
    const timeline = { durationSeconds: 4, cameraShots: [], objectKeyframes: [] }
    const mannequin = {
      id: 'obj-1',
      kind: 'mannequin',
      position: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1.8, z: 1 }
    }
    const frame = evaluateTimelineAtTime(timeline, boundCamera(), 0, [mannequin])
    expect(frame.camera.target.y).toBeCloseTo(0.9, 6)
  })

  it('不传物体列表时安全退回（老调用点不会崩）', () => {
    const timeline = { durationSeconds: 4, cameraShots: [], objectKeyframes: [] }
    const frame = evaluateTimelineAtTime(timeline, boundCamera(), 0)
    expect(frame.camera.target).toEqual({ x: 0, y: 1, z: 0 })
  })
})
