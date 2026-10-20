/**
 * 时间轴求值：相机镜头与物体关键帧。
 * 移植自 `camera-timeline.ts`、`object-timeline.ts`、`frame-state.ts`、`timeline-edit.ts`。
 *
 * 关键行为：
 * - smooth 插值使用 smoothstep（3t²-2t³），而不是线性，让运镜有加减速；
 * - cut 镜头在到达该节点前保持上一镜头，到达瞬间切换；
 * - 旋转插值走最短角路径，避免 350° → 10° 时绕一大圈。
 */

import { applyPathBindings } from './nav-path'

export const TIMELINE_FRAME_RATE = 24
const MINIMUM_MARKER_GAP_SECONDS = 0.05

export function clampTimelineTime(timeSeconds, durationSeconds) {
  if (!Number.isFinite(timeSeconds)) return 0
  return Math.min(Math.max(timeSeconds, 0), Math.max(durationSeconds, 0))
}

/** 为新标记找一个不与已有标记重叠的时间点。 */
export function findAvailableTimelineTime(requestedTime, occupiedTimes, durationSeconds) {
  const duration = Math.max(durationSeconds, 0)
  const candidate = clampTimelineTime(requestedTime, duration)
  const occupied = [...occupiedTimes].sort((a, b) => a - b)
  const tooClose = (value) => occupied.some((time) => Math.abs(time - value) < MINIMUM_MARKER_GAP_SECONDS)
  if (!tooClose(candidate)) return candidate

  for (let step = 1; step <= 40; step += 1) {
    const forward = clampTimelineTime(candidate + step * MINIMUM_MARKER_GAP_SECONDS, duration)
    if (!tooClose(forward)) return forward
    const backward = clampTimelineTime(candidate - step * MINIMUM_MARKER_GAP_SECONDS, duration)
    if (!tooClose(backward)) return backward
  }
  return candidate
}

function interpolate(first, second, amount) {
  return first + (second - first) * amount
}

function smoothstep(amount) {
  return amount * amount * (3 - 2 * amount)
}

function interpolateRotation(first, second, amount) {
  const delta = ((((second - first + 180) % 360) + 360) % 360) - 180
  return first + delta * amount
}

function interpolateVector(first, second, amount, rotation = false) {
  const resolve = rotation ? interpolateRotation : interpolate
  return {
    x: resolve(first.x, second.x, amount),
    y: resolve(first.y, second.y, amount),
    z: resolve(first.z, second.z, amount)
  }
}

function cloneVector(value) {
  return { x: value.x, y: value.y, z: value.z }
}

function cloneCamera(camera) {
  return {
    position: cloneVector(camera.position),
    target: cloneVector(camera.target),
    fovDegrees: camera.fovDegrees,
    aspectWidth: camera.aspectWidth,
    aspectHeight: camera.aspectHeight
  }
}

export function sortedCameraShots(shots) {
  return [...shots].sort((first, second) => first.timeSeconds - second.timeSeconds)
}

export function evaluateCameraShots(shots, timeSeconds, outputAspect) {
  const ordered = sortedCameraShots(shots)
  if (ordered.length === 0) return null
  const withOutputAspect = (camera) => ({
    ...cloneCamera(camera),
    aspectWidth: outputAspect.aspectWidth,
    aspectHeight: outputAspect.aspectHeight
  })
  if (timeSeconds <= ordered[0].timeSeconds) return withOutputAspect(ordered[0].camera)
  const last = ordered[ordered.length - 1]
  if (timeSeconds >= last.timeSeconds) return withOutputAspect(last.camera)

  for (let index = 1; index < ordered.length; index += 1) {
    const next = ordered[index]
    const previous = ordered[index - 1]
    if (timeSeconds > next.timeSeconds) continue
    if (next.transition === 'cut') return withOutputAspect(previous.camera)
    const raw = (timeSeconds - previous.timeSeconds) / (next.timeSeconds - previous.timeSeconds)
    const amount = smoothstep(raw)
    return {
      position: interpolateVector(previous.camera.position, next.camera.position, amount),
      target: interpolateVector(previous.camera.target, next.camera.target, amount),
      fovDegrees: interpolate(previous.camera.fovDegrees, next.camera.fovDegrees, amount),
      aspectWidth: outputAspect.aspectWidth,
      aspectHeight: outputAspect.aspectHeight
    }
  }
  return withOutputAspect(last.camera)
}

function cloneTransform(transform) {
  return {
    position: cloneVector(transform.position),
    rotation: cloneVector(transform.rotation),
    size: cloneVector(transform.size),
    mannequinPose: transform.mannequinPose
      ? Object.fromEntries(
          Object.entries(transform.mannequinPose).map(([id, value]) => [id, cloneVector(value)])
        )
      : undefined,
    mannequinPresetId: transform.mannequinPresetId,
    mannequinManualJoints: transform.mannequinManualJoints ? [...transform.mannequinManualJoints] : undefined,
    mannequinPresetBlend: transform.mannequinPresetBlend ? { ...transform.mannequinPresetBlend } : undefined
  }
}

export function sortedObjectKeyframes(keyframes) {
  return [...keyframes].sort(
    (first, second) => first.timeSeconds - second.timeSeconds || first.objectId.localeCompare(second.objectId)
  )
}

function evaluateTrack(keyframes, timeSeconds) {
  if (timeSeconds <= keyframes[0].timeSeconds) return cloneTransform(keyframes[0].transform)
  const last = keyframes[keyframes.length - 1]
  if (timeSeconds >= last.timeSeconds) return cloneTransform(last.transform)

  for (let index = 1; index < keyframes.length; index += 1) {
    const next = keyframes[index]
    const previous = keyframes[index - 1]
    if (timeSeconds > next.timeSeconds) continue
    const raw = (timeSeconds - previous.timeSeconds) / (next.timeSeconds - previous.timeSeconds)
    const amount = next.interpolation === 'smooth' ? smoothstep(raw) : raw
    const previousPose = previous.transform.mannequinPose
    const nextPose = next.transform.mannequinPose
    let mannequinPose
    if (!previousPose && !nextPose) mannequinPose = undefined
    else if (!previousPose) mannequinPose = nextPose
    else if (!nextPose) mannequinPose = previousPose
    else {
      mannequinPose = Object.fromEntries(
        Object.keys(previousPose).map((jointId) => [
          jointId,
          interpolateVector(previousPose[jointId], nextPose[jointId], amount, true)
        ])
      )
    }
    return {
      position: interpolateVector(previous.transform.position, next.transform.position, amount),
      rotation: interpolateVector(previous.transform.rotation, next.transform.rotation, amount, true),
      size: interpolateVector(previous.transform.size, next.transform.size, amount),
      mannequinPose,
      mannequinPresetId:
        amount < 0.5 ? previous.transform.mannequinPresetId : next.transform.mannequinPresetId,
      mannequinManualJoints: [
        ...new Set([
          ...(previous.transform.mannequinManualJoints ?? []),
          ...(next.transform.mannequinManualJoints ?? [])
        ])
      ],
      mannequinPresetBlend:
        previous.transform.mannequinPresetId === next.transform.mannequinPresetId
          ? undefined
          : {
              from: previous.transform.mannequinPresetId,
              to: next.transform.mannequinPresetId,
              amount
            }
    }
  }
  return cloneTransform(last.transform)
}

export function evaluateObjectKeyframes(keyframes, timeSeconds) {
  const tracks = new Map()
  for (const keyframe of sortedObjectKeyframes(keyframes)) {
    tracks.set(keyframe.objectId, [...(tracks.get(keyframe.objectId) ?? []), keyframe])
  }
  return new Map(
    [...tracks.entries()].map(([objectId, track]) => [objectId, evaluateTrack(track, timeSeconds)])
  )
}

/** 把关键帧求值结果叠加到物体列表，用于播放预览。 */
export function applyObjectKeyframePreview(objects, preview) {
  if (!preview) return objects
  return objects.map((object) => {
    const transform = preview.get(object.id)
    if (!transform) return object
    const cloned = cloneTransform(transform)
    return {
      ...object,
      position: cloned.position,
      rotation: cloned.rotation,
      size: cloned.size,
      mannequin:
        object.mannequin && cloned.mannequinPose
          ? {
              ...object.mannequin,
              pose: cloned.mannequinPose,
              presetId: cloned.mannequinPresetId,
              manualJoints: cloned.mannequinManualJoints,
              // 过渡信息要一起带上：两个关键帧预设不同时，
              // 外观层靠它做姿势插值，否则动作切换会"啪"地跳过去。
              presetBlend: cloned.mannequinPresetBlend
            }
          : object.mannequin
    }
  })
}

/**
 * 求某一时刻的完整帧状态：相机 + 所有物体的变换。
 * 图片 / 视频导出逐帧调用本函数，保证预览与导出画面一致。
 */
export function evaluateTimelineAtTime(timeline, baseCamera, timeSeconds) {
  const resolvedTime = clampTimelineTime(timeSeconds, timeline.durationSeconds)
  return {
    timeSeconds: resolvedTime,
    camera: evaluateCameraShots(timeline.cameraShots, resolvedTime, baseCamera) ?? cloneCamera(baseCamera),
    objectTransforms: evaluateObjectKeyframes(timeline.objectKeyframes, resolvedTime)
  }
}

/**
 * 一次算完"关键帧预览 + 导航线绑定"两道叠加。
 *
 * 顺序不能颠倒：先把关键帧求值叠上去（得到该时刻的物体姿态），
 * 再让绑定了导航线的物体覆盖为路径上的位置与朝向。
 * 绑定优先，是有意的设计——用户明确指定"这个物体沿导航线走"，
 * 就不该再被遗留的关键帧拽回原地。
 */
export function applyTimelinePreview(objects, timeline, timeSeconds) {
  if (!Array.isArray(objects) || objects.length === 0) return objects
  const resolvedTime = clampTimelineTime(timeSeconds, timeline?.durationSeconds ?? 0)
  const withKeyframes = applyObjectKeyframePreview(
    objects,
    evaluateObjectKeyframes(timeline?.objectKeyframes ?? [], resolvedTime)
  )
  return applyPathBindings(withKeyframes, resolvedTime, timeline?.durationSeconds ?? 0)
}

export function timeToFrameIndex(timeSeconds, durationSeconds, frameRate = TIMELINE_FRAME_RATE) {
  return Math.round(clampTimelineTime(timeSeconds, durationSeconds) * frameRate)
}

export function frameIndexToTime(frameIndex, durationSeconds, frameRate = TIMELINE_FRAME_RATE) {
  return clampTimelineTime(Math.max(Math.round(frameIndex), 0) / frameRate, durationSeconds)
}
