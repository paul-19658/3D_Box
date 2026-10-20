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

  it('smooth 使用 smoothstep，不是线性', () => {
    const shots = [shot('a', 0, 0), shot('b', 2, 10)]
    // t=0.25 时线性应为 2.5；smoothstep 为 0.15625。
    expect(evaluateCameraShots(shots, 0.5, camera(0)).position.x).toBeCloseTo(1.5625, 4)
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
