/**
 * 把 AI 命令应用到场景。移植自
 * `app/src/renderer/src/scene-core/apply-ai-scene-commands.ts`。
 *
 * 设计要点：
 * - 纯函数：输入场景 + 命令，返回新场景，不修改原对象，便于撤销；
 * - 按名称或 id 定位物体，模型常用名称而不是我们生成的 id；
 * - 移动动画会自动生成物体关键帧与（可选的）相机跟拍镜头。
 */

import { BASIC_KIND_NAMES, BASIC_KIND_SIZES, MANNEQUIN_PRESET_IDS, createId } from './project-document'
import { MANNEQUIN_PRESETS, createMannequinData, createNeutralMannequinPose } from './mannequin'

function cloneObject(object) {
  return JSON.parse(JSON.stringify(object))
}

/**
 * 按 id / 名称定位物体。
 * 可选 kind：人台姿势等场景下，若该类型只剩一个物体则兜底选中（复核常写错 id）。
 */
function findObject(objects, id, name, kind) {
  const pool = kind ? objects.filter((object) => object.kind === kind) : objects
  if (id) {
    const byId = pool.find((object) => object.id === id) ?? objects.find((object) => object.id === id)
    if (byId) return byId
  }
  if (name) {
    const exact = pool.find((object) => object.name === name)
    if (exact) return exact
    const normalized = name.replace(/\s+/g, '').toLowerCase()
    const loose = pool.find(
      (object) => object.name.replace(/\s+/g, '').toLowerCase() === normalized
    )
    if (loose) return loose
    const partial = pool.find((object) => object.name.includes(name))
    if (partial) return partial
  }
  if (kind && pool.length === 1) return pool[0]
  return null
}

function mergeVector(base, update) {
  if (!update) return { ...base }
  return {
    x: update.x ?? base.x,
    y: update.y ?? base.y,
    z: update.z ?? base.z
  }
}

/** 模型默认朝 -Z；按水平位移计算朝向角（度）。 */
function facingDegrees(from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.hypot(dx, dz) < 1e-4) return 0
  return (Math.atan2(dx, -dz) * 180) / Math.PI
}

function normalizeFollow(value) {
  if (value === false || value === undefined) return null
  const source = value === true ? {} : value
  const mode = source.mode || 'side'
  return {
    mode,
    sideOffset: source.sideOffset ?? 4,
    backOffset: source.backOffset ?? 1.5,
    radius: source.radius ?? (mode === 'orbit' ? 5 : 4),
    orbitDegrees: source.orbitDegrees ?? 360,
    orbitDirection: source.orbitDirection ?? 'ccw',
    startAngleDegrees: source.startAngleDegrees ?? 0,
    height: source.height ?? 2.2,
    lookAtHeight: source.lookAtHeight ?? 1.2
  }
}

function samplePathAt(points, progress) {
  const clamped = Math.min(Math.max(progress, 0), 1)
  if (points.length === 1) {
    return { position: { ...points[0] }, direction: { x: 0, z: -1 } }
  }
  const segmentCount = points.length - 1
  const scaled = clamped * segmentCount
  const index = Math.min(Math.floor(scaled), segmentCount - 1)
  const local = scaled - index
  const from = points[index]
  const to = points[index + 1]
  const position = {
    x: from.x + (to.x - from.x) * local,
    y: from.y + (to.y - from.y) * local,
    z: from.z + (to.z - from.z) * local
  }
  let dx = to.x - from.x
  let dz = to.z - from.z
  const len = Math.hypot(dx, dz)
  if (len < 1e-4) {
    dx = 0
    dz = -1
  } else {
    dx /= len
    dz /= len
  }
  return { position, direction: { x: dx, z: dz } }
}

function cameraPoseForFollow(follow, subject, direction, progress) {
  const target = {
    x: subject.x,
    y: follow.lookAtHeight,
    z: subject.z
  }

  if (follow.mode === 'orbit') {
    const sign = follow.orbitDirection === 'cw' ? -1 : 1
    const angleDeg = follow.startAngleDegrees + progress * follow.orbitDegrees * sign
    const angle = (angleDeg * Math.PI) / 180
    return {
      position: {
        x: subject.x + Math.cos(angle) * follow.radius,
        y: follow.height,
        z: subject.z + Math.sin(angle) * follow.radius
      },
      target
    }
  }

  const dx = direction.x
  const dz = direction.z
  const sideX = dz
  const sideZ = -dx

  if (follow.mode === 'chase') {
    return {
      position: {
        x: subject.x - dx * follow.radius,
        y: follow.height,
        z: subject.z - dz * follow.radius
      },
      target
    }
  }
  if (follow.mode === 'front') {
    return {
      position: {
        x: subject.x + dx * follow.radius,
        y: follow.height,
        z: subject.z + dz * follow.radius
      },
      target
    }
  }

  return {
    position: {
      x: subject.x + sideX * follow.sideOffset - dx * follow.backOffset,
      y: follow.height,
      z: subject.z + sideZ * follow.sideOffset - dz * follow.backOffset
    },
    target
  }
}

function cameraFollowShots(follow, path, durationSeconds, baseCamera) {
  if (!follow) return []
  const orbitSteps = Math.ceil(Math.abs(follow.orbitDegrees) / 20)
  const sampleCount =
    follow.mode === 'orbit'
      ? Math.max(path.length, orbitSteps + 1, Math.ceil(durationSeconds * 3) + 1, 9)
      : Math.max(path.length, Math.ceil(durationSeconds * 2) + 1, 3)

  return Array.from({ length: sampleCount }, (_, index) => {
    const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1)
    const sample = samplePathAt(path, progress)
    const pose = cameraPoseForFollow(follow, sample.position, sample.direction, progress)
    return {
      id: createId(),
      name: `跟拍 ${String(index + 1).padStart(2, '0')}`,
      timeSeconds: durationSeconds * progress,
      transition: index === 0 ? 'cut' : 'smooth',
      camera: {
        position: { ...pose.position },
        target: { ...pose.target },
        fovDegrees: baseCamera.fovDegrees,
        aspectWidth: baseCamera.aspectWidth,
        aspectHeight: baseCamera.aspectHeight
      }
    }
  })
}

function lerpNumber(from, to, progress) {
  return from + (to - from) * progress
}

function lerpVector(from, to, progress) {
  return {
    x: lerpNumber(from.x, to.x, progress),
    y: lerpNumber(from.y, to.y, progress),
    z: lerpNumber(from.z, to.z, progress)
  }
}

/**
 * 镜头路径关键帧：在 path 点之间按进度插值 position / target / fov。
 * 缺省字段沿用 baseCamera 或前一点已解析值。
 */
function cameraPathShots(path, durationSeconds, baseCamera) {
  if (!Array.isArray(path) || path.length < 2) return []

  let lastTarget = { ...baseCamera.target }
  let lastFov = baseCamera.fovDegrees
  const resolved = path.map((point) => {
    const position = {
      x: point.position.x ?? baseCamera.position.x,
      y: point.position.y ?? baseCamera.position.y,
      z: point.position.z ?? baseCamera.position.z
    }
    const target = point.target
      ? {
          x: point.target.x ?? lastTarget.x,
          y: point.target.y ?? lastTarget.y,
          z: point.target.z ?? lastTarget.z
        }
      : { ...lastTarget }
    const fovDegrees = point.fovDegrees ?? lastFov
    lastTarget = target
    lastFov = fovDegrees
    return { position, target, fovDegrees }
  })

  const sampleCount = Math.max(resolved.length, Math.ceil(durationSeconds * 2) + 1, 3)
  return Array.from({ length: sampleCount }, (_, index) => {
    const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1)
    const scaled = progress * (resolved.length - 1)
    const fromIndex = Math.min(Math.floor(scaled), resolved.length - 2)
    const local = scaled - fromIndex
    const from = resolved[fromIndex]
    const to = resolved[fromIndex + 1]
    return {
      id: createId(),
      name: `运镜 ${String(index + 1).padStart(2, '0')}`,
      timeSeconds: durationSeconds * progress,
      transition: index === 0 ? 'cut' : 'smooth',
      camera: {
        position: lerpVector(from.position, to.position, local),
        target: lerpVector(from.target, to.target, local),
        fovDegrees: lerpNumber(from.fovDegrees, to.fovDegrees, local),
        aspectWidth: baseCamera.aspectWidth,
        aspectHeight: baseCamera.aspectHeight
      }
    }
  })
}

function resolvePathPoints(object, path) {
  return path.map((point) => ({
    x: point.x ?? object.position.x,
    y: point.y ?? object.position.y,
    z: point.z ?? object.position.z
  }))
}

function keyframesForMove(object, path, durationSeconds, faceAlongPath) {
  const points = resolvePathPoints(object, path)
  return points.map((point, index) => {
    const next = index < points.length - 1 ? points[index + 1] : null
    const previous = index > 0 ? points[index - 1] : null
    const facingFrom = next ? point : previous || point
    const facingTo = next || point
    const rotationY = faceAlongPath ? facingDegrees(facingFrom, facingTo) : object.rotation.y
    return {
      id: createId(),
      objectId: object.id,
      timeSeconds: (durationSeconds * index) / (points.length - 1),
      interpolation: 'smooth',
      transform: {
        position: { ...point },
        rotation: {
          x: object.rotation.x,
          y: rotationY,
          z: object.rotation.z
        },
        size: { ...object.size },
        mannequinPose: object.mannequin ? cloneObject(object.mannequin.pose) : undefined,
        mannequinPresetId: object.mannequin?.presetId,
        mannequinManualJoints: object.mannequin?.manualJoints ? [...object.mannequin.manualJoints] : undefined
      }
    }
  })
}

function sortedByTime(items) {
  return [...items].sort((a, b) => a.timeSeconds - b.timeSeconds)
}

/**
 * 应用命令数组。
 *
 * 返回 `{ scene, applied, skipped, hasTimelineAnimation }`：
 * - `applied` 是成功应用的命令数，用于提示用户；
 * - `skipped` 记录被跳过的原因，便于排查模型输出问题。
 */
export function applyAiSceneCommands(scene, commands) {
  let objects = scene.objects.map(cloneObject)
  let camera = cloneObject(scene.camera)
  const lighting = cloneObject(scene.lighting)
  let timeline = cloneObject(scene.timeline)
  let applied = 0
  const skipped = []

  const cameraExplicitlySet = commands.some((command) => command.type === 'set_camera')
  let hasTimelineAnimation = false

  for (const command of commands) {
    if (command.type === 'clear_scene') {
      objects = []
      timeline = {
        durationSeconds: timeline.durationSeconds,
        cameraShots: [],
        objectKeyframes: []
      }
      applied += 1
      continue
    }

    if (command.type === 'add_object') {
      const kind = command.kind
      const count = objects.filter((object) => object.kind === kind).length
      const size = mergeVector({ ...BASIC_KIND_SIZES[kind] }, command.size)
      objects.push({
        id: createId(),
        kind,
        name: command.name || `${BASIC_KIND_NAMES[kind]} ${String(count + 1).padStart(2, '0')}`,
        description: command.description,
        position: mergeVector({ x: 0, y: size.y / 2, z: 0 }, command.position),
        rotation: mergeVector({ x: 0, y: 0, z: 0 }, command.rotation),
        size,
        color: command.color || '#c9cdd0',
        visible: true,
        locked: false
      })
      applied += 1
      continue
    }

    if (command.type === 'add_mannequin') {
      const height = command.heightMeters ?? 1.75
      const preset = MANNEQUIN_PRESET_IDS.includes(command.presetId) ? command.presetId : 'stand'
      const presetPose =
        MANNEQUIN_PRESETS.find((item) => item.id === preset)?.pose ?? createNeutralMannequinPose()
      const count = objects.filter((object) => object.kind === 'mannequin').length
      objects.push({
        id: createId(),
        kind: 'mannequin',
        name: command.name || `人台 ${String(count + 1).padStart(2, '0')}`,
        description: command.description,
        position: mergeVector({ x: 0, y: 0, z: 0 }, command.position),
        rotation: mergeVector({ x: 0, y: 0, z: 0 }, command.rotation),
        size: { x: 1, y: height, z: 1 },
        color: '#e8e6e1',
        visible: true,
        locked: false,
        mannequin: { ...createMannequinData(height), presetId: preset, pose: cloneObject(presetPose) }
      })
      applied += 1
      continue
    }

    if (command.type === 'update_object') {
      const target = findObject(objects, command.id, command.name)
      if (!target) {
        skipped.push(`找不到物体：${command.name || command.id}`)
        continue
      }
      objects = objects.map((object) =>
        object.id === target.id
          ? {
              ...object,
              name: command.name && command.name !== object.name ? command.name : object.name,
              description: command.description ?? object.description,
              position: mergeVector(object.position, command.position),
              rotation: mergeVector(object.rotation, command.rotation),
              size: mergeVector(object.size, command.size),
              color: command.color ?? object.color
            }
          : object
      )
      applied += 1
      continue
    }

    if (command.type === 'remove_object') {
      const target = findObject(objects, command.id, command.name)
      if (!target) {
        skipped.push(`找不到要删除的物体：${command.name || command.id}`)
        continue
      }
      const removedId = target.id
      objects = objects
        .filter((object) => object.id !== removedId)
        .map((object) => {
          // 其他物体若绑在被删导航线上，清掉绑定，避免悬空引用。
          if (object.pathBinding?.pathId === removedId) {
            const next = { ...object }
            delete next.pathBinding
            return next
          }
          return object
        })
      timeline = {
        ...timeline,
        objectKeyframes: timeline.objectKeyframes.filter(
          (keyframe) => keyframe.objectId !== removedId
        )
      }
      applied += 1
      continue
    }

    if (command.type === 'set_mannequin_pose') {
      const target = findObject(objects, command.id, command.name, 'mannequin')
      if (!target || target.kind !== 'mannequin') {
        skipped.push(`找不到人台：${command.name || command.id}`)
        continue
      }
      const preset = MANNEQUIN_PRESETS.find((item) => item.id === command.presetId) ?? MANNEQUIN_PRESETS[0]
      objects = objects.map((object) =>
        object.id === target.id && object.mannequin
          ? {
              ...object,
              mannequin: {
                ...object.mannequin,
                presetId: preset.id,
                pose: cloneObject(preset.pose),
                manualJoints: []
              }
            }
          : object
      )
      applied += 1
      continue
    }

    if (command.type === 'set_camera') {
      camera = {
        ...camera,
        position: mergeVector(camera.position, command.position),
        target: mergeVector(camera.target, command.target),
        fovDegrees: command.fovDegrees ?? camera.fovDegrees
      }
      applied += 1
      continue
    }

    if (command.type === 'animate_move') {
      const target = findObject(objects, command.id, command.name)
      if (!target) {
        skipped.push(`找不到要移动的物体：${command.name || command.id}`)
        continue
      }
      const duration = command.durationSeconds ?? 4
      const faceAlongPath = command.faceAlongPath !== false
      const points = resolvePathPoints(target, command.path)
      if (points.length < 2) {
        skipped.push('animate_move 至少需要 2 个路径点')
        continue
      }
      const follow = normalizeFollow(command.cameraFollow)
      const keyframes = keyframesForMove(target, command.path, duration, faceAlongPath)
      const followShots = cameraFollowShots(follow, points, duration, camera)

      const start = points[0]
      const startFacing = faceAlongPath ? facingDegrees(points[0], points[1]) : target.rotation.y
      objects = objects.map((object) =>
        object.id === target.id
          ? {
              ...object,
              position: { ...start },
              rotation: { ...object.rotation, y: startFacing }
            }
          : object
      )

      timeline = {
        durationSeconds: Math.max(timeline.durationSeconds, duration),
        cameraShots: follow
          ? sortedByTime(followShots)
          : sortedByTime(timeline.cameraShots),
        objectKeyframes: sortedByTime([
          ...timeline.objectKeyframes.filter((keyframe) => keyframe.objectId !== target.id),
          ...keyframes
        ])
      }
      if (follow && followShots[0]) {
        camera = cloneObject(followShots[0].camera)
      }
      hasTimelineAnimation = true
      applied += 1
      continue
    }

    if (command.type === 'animate_camera') {
      const duration = command.durationSeconds ?? 4
      const path = Array.isArray(command.path) ? command.path : []
      if (path.length < 2) {
        skipped.push('animate_camera 至少需要 2 个路径点')
        continue
      }
      const shots = cameraPathShots(path, duration, camera)
      if (shots.length < 2) {
        skipped.push('animate_camera 无法生成镜头关键帧')
        continue
      }
      timeline = {
        durationSeconds: Math.max(timeline.durationSeconds, duration),
        cameraShots: sortedByTime(shots),
        objectKeyframes: timeline.objectKeyframes
      }
      camera = cloneObject(shots[0].camera)
      hasTimelineAnimation = true
      applied += 1
    }
  }

  // 首次搭建并且模型没显式给相机时，自动取一个能看全场景的机位，
  // 否则用户看到的可能是一堵贴脸的墙。
  if (!cameraExplicitlySet && !hasTimelineAnimation && applied > 0 && objects.length > 0) {
    const maxExtent = objects.reduce((extent, object) => {
      const reach =
        Math.max(Math.abs(object.position.x), Math.abs(object.position.z)) +
        Math.max(object.size.x, object.size.z) / 2
      return Math.max(extent, reach)
    }, 1)
    const distance = Math.max(maxExtent * 1.9, 6)
    camera = {
      ...camera,
      position: { x: distance * 0.67, y: distance * 0.55, z: distance * 0.88 },
      target: { x: 0, y: 0.9, z: 0 },
      fovDegrees: 42
    }
  }

  return {
    scene: { objects, camera, lighting, timeline },
    applied,
    skipped,
    hasTimelineAnimation
  }
}
