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

function findObject(objects, id, name) {
  if (id) {
    const byId = objects.find((object) => object.id === id)
    if (byId) return byId
  }
  if (name) {
    // 先精确匹配，再忽略大小写与空格匹配，最后按包含关系匹配。
    const exact = objects.find((object) => object.name === name)
    if (exact) return exact
    const normalized = name.replace(/\s+/g, '').toLowerCase()
    const loose = objects.find((object) => object.name.replace(/\s+/g, '').toLowerCase() === normalized)
    if (loose) return loose
    return objects.find((object) => object.name.includes(name)) ?? null
  }
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

/** 让物体朝向路径前进方向（-Z 为模型正面，与 three.js 约定一致）。 */
function facingDegrees(from, to) {
  const deltaX = to.x - from.x
  const deltaZ = to.z - from.z
  if (Math.hypot(deltaX, deltaZ) < 1e-6) return null
  return (Math.atan2(deltaX, deltaZ) * 180) / Math.PI + 180
}

function cameraFollowShots(follow, path, durationSeconds, baseCamera, objectName) {
  if (!follow) return []
  const mode = follow.mode || 'side'
  const start = path[0]
  const end = path[path.length - 1]
  const center = { x: (start.x + end.x) / 2, z: (start.z + end.z) / 2 }
  const spanX = end.x - start.x
  const spanZ = end.z - start.z
  const span = Math.max(Math.hypot(spanX, spanZ), 1)
  const height = follow.height ?? 2.2
  const lookAtHeight = follow.lookAtHeight ?? 1.2

  const describe = (position) => ({
    position: { x: position.x, y: height, z: position.z },
    target: { x: position.lookAtX ?? center.x, y: lookAtHeight, z: position.lookAtZ ?? center.z },
    fovDegrees: baseCamera.fovDegrees,
    aspectWidth: baseCamera.aspectWidth,
    aspectHeight: baseCamera.aspectHeight
  })

  if (mode === 'orbit') {
    const radius = follow.radius ?? 5
    const total = follow.orbitDegrees ?? 360
    const direction = follow.orbitDirection === 'cw' ? -1 : 1
    const startAngle = follow.startAngleDegrees ?? 0
    const steps = Math.max(2, Math.min(8, Math.round(Math.abs(total) / 90) + 1))
    return Array.from({ length: steps }, (_, index) => {
      const amount = index / (steps - 1)
      const angle = ((startAngle + direction * total * amount) * Math.PI) / 180
      return {
        id: createId(),
        name: `跟拍镜头 ${index + 1}`,
        timeSeconds: durationSeconds * amount,
        transition: index === 0 ? 'cut' : 'smooth',
        camera: describe({
          x: center.x + Math.sin(angle) * radius,
          z: center.z + Math.cos(angle) * radius
        })
      }
    })
  }

  const sideOffset = follow.sideOffset ?? 4
  const backOffset = follow.backOffset ?? 1.5
  const radius = follow.radius ?? 5
  const normalX = span / 1 > 0 ? -spanZ / span : 1
  const normalZ = span / 1 > 0 ? spanX / span : 0

  const offsets = {
    side: { x: normalX * sideOffset, z: normalZ * sideOffset },
    chase: { x: (-spanX / span) * backOffset, z: (-spanZ / span) * backOffset },
    front: { x: (spanX / span) * radius, z: (spanZ / span) * radius }
  }
  const offset = offsets[mode] ?? offsets.side
  const at = (timeAmount) => ({
    x: start.x + spanX * timeAmount + offset.x,
    z: start.z + spanZ * timeAmount + offset.z,
    lookAtX: start.x + spanX * timeAmount,
    lookAtZ: start.z + spanZ * timeAmount
  })

  return [
    {
      id: createId(),
      name: `${objectName || '物体'}跟拍开始`,
      timeSeconds: 0,
      transition: 'cut',
      camera: describe(at(0))
    },
    {
      id: createId(),
      name: `${objectName || '物体'}跟拍结束`,
      timeSeconds: durationSeconds,
      transition: 'smooth',
      camera: describe(at(1))
    }
  ]
}

function keyframesForMove(object, path, durationSeconds) {
  const points = path.map((point) => ({
    x: point.x ?? object.position.x,
    y: point.y ?? object.position.y,
    z: point.z ?? object.position.z
  }))
  return points.map((point, index) => {
    const previous = index > 0 ? points[index - 1] : null
    const next = index < points.length - 1 ? points[index + 1] : null
    const heading = next ? facingDegrees(point, next) : previous ? facingDegrees(previous, point) : null
    return {
      id: createId(),
      objectId: object.id,
      timeSeconds: (durationSeconds * index) / (points.length - 1),
      interpolation: 'linear',
      transform: {
        position: { ...point },
        rotation: {
          x: object.rotation.x,
          y: heading === null ? object.rotation.y : heading,
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

/**
 * 应用命令数组。
 *
 * 返回 `{ scene, applied, skipped }`：
 * - `applied` 是成功应用的命令数，用于提示用户；
 * - `skipped` 记录被跳过的原因，便于排查模型输出问题。
 */
export function applyAiSceneCommands(scene, commands) {
  let objects = scene.objects.map(cloneObject)
  let camera = cloneObject(scene.camera)
  // 光照与灯光列表在命令集里没有对应的修改类型，因此整个流程中保持不变。
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

    if (command.type === 'set_mannequin_pose') {
      const target = findObject(objects, command.id, command.name)
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
      const keyframes = keyframesForMove(target, command.path, duration)
      timeline = {
        durationSeconds: Math.max(timeline.durationSeconds, duration),
        cameraShots: command.cameraFollow
          ? cameraFollowShots(command.cameraFollow, command.path, duration, camera, target.name)
          : timeline.cameraShots,
        objectKeyframes: [
          ...timeline.objectKeyframes.filter((keyframe) => keyframe.objectId !== target.id),
          ...keyframes
        ]
      }
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
    skipped
  }
}
