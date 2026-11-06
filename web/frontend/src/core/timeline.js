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
import { resolveCameraTarget } from './camera-target'
import { evaluatePositionTrack, normalizeKnots } from './camera-path'

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

/**
 * 求某一时刻的相机状态。
 *
 * ## 位置与看向点：时间参数化的向心 Catmull-Rom 样条
 *
 * 旧实现是"逐段线性插值 + smoothstep 缓动"，实测有两个缺陷：
 * 每个中间关键帧速度归零（相机飞到一个镜头就停一下），
 * 以及位置永远是分段直线（拍不出弧线运镜）。
 * 现在换成三次 Hermite + Catmull-Rom 切线（见 `core/camera-path.js`）：
 * 曲线穿过每个关键帧、速度连续、支持弧线。
 *
 * 为什么位置和看向点**都**走样条：相机朝向由"机位→看向点"决定，
 * 只对位置做样条而看向点线性插值的话，镜头会在弧线中段"斜着看"，
 * 主体忽左忽右漂。两者同步样条，运镜才是平滑的。
 *
 * ## 切变（cut）不参与插值
 *
 * `transition === 'cut'` 表示"到这一格硬切过去"，是剪辑语义，
 * 必须保持瞬时切换——给它做平滑就等于把硬切改成了运镜。
 *
 * ## fov 仍按线性插值
 *
 * 焦距是 fov 的另一种表达（见 `core/focal-length.js`），两者单调对应。
 * 对 fov 线性插值等价于"变焦速度略有不均"，实测 35°→42° 段与
 * "按焦距线性"的差异只有 0.3°，肉眼不可见；而给标量做样条会过冲
 * （出现"变焦到头又弹回来"），反而更糟。所以标量保持线性。
 */
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

  /*
   * 切变必须在样条**之前**处理：找到 time 落在哪一段之后，
   * 如果该段是 cut，就保持前一个镜头，不做任何插值。
   * 注意 `index` 表示"所在段的右端点"，与 ordered 的索引对齐。
   */
  let segmentIndex = ordered.length - 1
  for (let index = 1; index < ordered.length; index += 1) {
    if (timeSeconds <= ordered[index].timeSeconds) {
      segmentIndex = index
      break
    }
  }
  if (ordered[segmentIndex].transition === 'cut') {
    return withOutputAspect(ordered[segmentIndex - 1].camera)
  }

  /*
   * 采样范围要扩到"所在段 + 前后各一个"邻居，样条才能算出真实切线。
   * 端点的单侧割线由 camera-path 内部处理。
   */
  const from = Math.max(0, segmentIndex - 2)
  const to = Math.min(ordered.length - 1, segmentIndex + 1)
  const window = ordered.slice(from, to + 1)

  /** `normalizeKnots` 产出 `{ time, value }`；这里转成轨迹求值要的 `{ time, position }`。 */
  const toPositionKnots = (items) =>
    normalizeKnots(items, (shot) => shot.timeSeconds, (shot) => shot.camera.position).map((knot) => ({
      time: knot.time,
      position: knot.value
    }))

  const positionKnots = toPositionKnots(window)
  const targetKnots = toPositionKnots(
    window.map((shot) => ({ ...shot, camera: { ...shot.camera, position: shot.camera.target } }))
  )

  const position = evaluatePositionTrack(positionKnots, timeSeconds)
  const target = evaluatePositionTrack(targetKnots, timeSeconds)
  if (!position || !target) {
    // 关键帧数据不完整（例如坐标是 NaN）：退回该段起点，画面停住而不是消失。
    return withOutputAspect(ordered[segmentIndex - 1].camera)
  }

  const previous = ordered[segmentIndex - 1]
  const next = ordered[segmentIndex]
  const span = next.timeSeconds - previous.timeSeconds
  const raw = span > 0 ? (timeSeconds - previous.timeSeconds) / span : 0
  return {
    position,
    target,
    fovDegrees: interpolate(previous.camera.fovDegrees, next.camera.fovDegrees, raw),
    aspectWidth: outputAspect.aspectWidth,
    aspectHeight: outputAspect.aspectHeight
  }
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
 *
 * ## 为什么相机要在物体之后解算
 *
 * 相机可以**绑定到某个物体**（`camera.targetObjectId`），这时它的看向点是
 * 那个物体在该时刻的位置。所以顺序必须是：
 *   先算物体（关键帧 + 导航线绑定）→ 再用物体位置解算相机 target。
 * 反过来会让相机盯着物体在 0 时刻的位置，物体一动镜头就跟丢了。
 *
 * `baseObjects` 是**基准**物体列表（store 里的原始数据），不是求值结果——
 * 关键帧与导航线叠加都在本函数内完成，调用方不需要自己先求值。
 * 不传时按空列表处理，此时绑定会优雅退回静态 `target`。
 */
export function evaluateTimelineAtTime(timeline, baseCamera, timeSeconds, baseObjects = []) {
  const resolvedTime = clampTimelineTime(timeSeconds, timeline.durationSeconds)
  const objectTransforms = evaluateObjectKeyframes(timeline.objectKeyframes, resolvedTime)
  const objects = applyPathBindings(
    applyObjectKeyframePreview(baseObjects, objectTransforms),
    resolvedTime,
    timeline.durationSeconds
  )
  const shotsCamera = evaluateCameraShots(timeline.cameraShots, resolvedTime, baseCamera)
  /*
   * 绑定属于**相机本身**，不属于单个镜头。
   *
   * `evaluateCameraShots()` 在有镜头轨时是从 shot 数据重建相机的，
   * 不会带上 `targetObjectId` / `lookAtEnabled`；不在这里补回来，
   * 一旦打了镜头轨绑定就会失效（或者反过来，关掉的开关被重新打开）。
   * 所以这两项一律以基准相机为准。
   */
  const resolved = shotsCamera ?? cloneCamera(baseCamera)
  const camera = resolveCameraTarget(
    {
      ...resolved,
      targetObjectId: baseCamera?.targetObjectId ?? null,
      lookAtEnabled: baseCamera?.lookAtEnabled !== false
    },
    objects
  )
  return {
    timeSeconds: resolvedTime,
    camera,
    objectTransforms
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
