import * as THREE from 'three'
import type {
  AiAnimateMoveCameraFollow,
  AiAnimateMoveCommand,
  AiSceneCommand
} from '../../../shared/ai-scene-commands'
import type {
  CameraShotNode,
  ObjectKeyframeNode,
  SceneObjectData,
  Vector3Value
} from '../../../shared/project-document'
import { DEFAULT_TIMELINE } from '../../../shared/project-document'
import { calculateFrameCamera } from '../camera/framing'
import { cloneMannequinPose, MANNEQUIN_PRESETS } from '../mannequin/mannequin'
import { sortedCameraShots } from '../timeline/camera-timeline'
import { sortedObjectKeyframes } from '../timeline/object-timeline'
import { objectWorldBounds } from './geometry'
import { placeNewObject } from './layout'
import { createMannequinSceneObject, createSceneObject, type SceneState } from './scene'

export interface ApplyAiSceneCommandsResult {
  scene: SceneState
  appliedCount: number
  warnings: string[]
  selectedIds: string[]
  framedCamera: boolean
  /** 是否写入了物体位移 / 跟拍时间轴，便于 UI 自动播放 */
  hasTimelineAnimation: boolean
}

function mergeVector(base: Vector3Value, patch?: Partial<Vector3Value>): Vector3Value {
  if (!patch) return { ...base }
  return {
    x: patch.x ?? base.x,
    y: patch.y ?? base.y,
    z: patch.z ?? base.z
  }
}

function findObject(
  objects: SceneObjectData[],
  id?: string,
  name?: string,
  kind?: SceneObjectData['kind']
): SceneObjectData | undefined {
  const pool = kind ? objects.filter((object) => object.kind === kind) : objects
  if (id) {
    const byId = pool.find((object) => object.id === id) ?? objects.find((object) => object.id === id)
    if (byId) return byId
  }
  if (name) {
    const exact = pool.find((object) => object.name === name)
    if (exact) return exact
    const partial = pool.find((object) => object.name.includes(name))
    if (partial) return partial
  }
  // 模型复核时常写错 id：若该类型只剩一个物体则兜底选中
  if (kind && pool.length === 1) return pool[0]
  return undefined
}

function applyPresetToMannequin(
  object: SceneObjectData,
  presetId: NonNullable<SceneObjectData['mannequin']>['presetId']
): SceneObjectData {
  if (!object.mannequin || !presetId) return object
  const preset = MANNEQUIN_PRESETS.find((item) => item.id === presetId)
  if (!preset) return object
  return {
    ...object,
    mannequin: {
      ...object.mannequin,
      pose: cloneMannequinPose(preset.pose),
      presetId,
      manualJoints: []
    }
  }
}

function frameSceneCamera(scene: SceneState): SceneState {
  const visible = scene.objects.filter((object) => object.visible)
  if (visible.length === 0) return scene
  const box = visible.reduce(
    (bounds, object) => bounds.union(objectWorldBounds(object)),
    objectWorldBounds(visible[0]).clone()
  )
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())
  const radius = Math.max(size.x, size.y, size.z, 0.5) * 0.6
  const aspect =
    scene.camera.aspectHeight === 0 ? 16 / 9 : scene.camera.aspectWidth / scene.camera.aspectHeight
  const camera = calculateFrameCamera({
    center: { x: center.x, y: center.y, z: center.z },
    radius,
    currentCamera: scene.camera,
    verticalFovDegrees: scene.camera.fovDegrees,
    aspect
  })
  return { ...scene, camera }
}

function createId(): string {
  return globalThis.crypto.randomUUID()
}

function resolvePathPoints(
  object: SceneObjectData,
  path: Array<Partial<Vector3Value>>
): Vector3Value[] {
  return path.map((point) => ({
    x: point.x ?? object.position.x,
    y: point.y ?? object.position.y,
    z: point.z ?? object.position.z
  }))
}

/** 模型默认朝 -Z；按水平位移计算朝向角（度）。 */
function facingDegrees(from: Vector3Value, to: Vector3Value): number {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.hypot(dx, dz) < 1e-4) return 0
  return (Math.atan2(dx, -dz) * 180) / Math.PI
}

interface NormalizedFollow {
  mode: 'side' | 'chase' | 'front' | 'orbit'
  sideOffset: number
  backOffset: number
  radius: number
  orbitDegrees: number
  orbitDirection: 'cw' | 'ccw'
  startAngleDegrees: number
  height: number
  lookAtHeight: number
}

function normalizeFollow(
  value: boolean | AiAnimateMoveCameraFollow | undefined
): NormalizedFollow | null {
  if (value === false || value === undefined) return null
  const source = value === true ? {} : value
  const mode = source.mode ?? 'side'
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

function samplePathAt(
  points: Vector3Value[],
  progress: number
): { position: Vector3Value; direction: { x: number; z: number } } {
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

function cameraPoseForFollow(
  follow: NormalizedFollow,
  subject: Vector3Value,
  direction: { x: number; z: number },
  progress: number
): { position: Vector3Value; target: Vector3Value } {
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

function applyAnimateMove(
  scene: SceneState,
  command: AiAnimateMoveCommand,
  warnings: string[]
): { scene: SceneState; ok: boolean } {
  const target = findObject(scene.objects, command.id, command.name)
  if (!target) {
    warnings.push(`找不到要移动的物体：${command.id ?? command.name ?? '未指定'}`)
    return { scene, ok: false }
  }
  const points = resolvePathPoints(target, command.path)
  if (points.length < 2) {
    warnings.push('animate_move 至少需要 2 个路径点。')
    return { scene, ok: false }
  }
  const durationSeconds = command.durationSeconds ?? 4
  const faceAlongPath = command.faceAlongPath !== false
  const follow = normalizeFollow(command.cameraFollow)

  const segmentCount = points.length - 1
  const objectKeyframes: ObjectKeyframeNode[] = []

  for (let index = 0; index < points.length; index += 1) {
    const timeSeconds = (durationSeconds * index) / segmentCount
    const position = points[index]
    const nextPoint = points[Math.min(index + 1, points.length - 1)]
    const prevPoint = points[Math.max(index - 1, 0)]
    const facingFrom = index < points.length - 1 ? position : prevPoint
    const facingTo = index < points.length - 1 ? nextPoint : position
    const rotationY = faceAlongPath
      ? facingDegrees(facingFrom, facingTo)
      : target.rotation.y
    const rotation = { ...target.rotation, y: rotationY }

    objectKeyframes.push({
      id: createId(),
      objectId: target.id,
      timeSeconds,
      interpolation: 'smooth',
      transform: {
        position: { ...position },
        rotation,
        size: { ...target.size },
        mannequinPose: target.mannequin
          ? cloneMannequinPose(target.mannequin.pose)
          : undefined,
        mannequinPresetId: target.mannequin?.presetId,
        mannequinManualJoints: target.mannequin?.manualJoints
          ? [...target.mannequin.manualJoints]
          : undefined
      }
    })
  }

  const cameraShots: CameraShotNode[] = []
  if (follow) {
    const orbitSteps = Math.ceil(Math.abs(follow.orbitDegrees) / 20)
    const sampleCount =
      follow.mode === 'orbit'
        ? Math.max(points.length, orbitSteps + 1, Math.ceil(durationSeconds * 3) + 1, 9)
        : Math.max(points.length, 3)
    for (let index = 0; index < sampleCount; index += 1) {
      const progress = sampleCount === 1 ? 0 : index / (sampleCount - 1)
      const timeSeconds = durationSeconds * progress
      const sample = samplePathAt(points, progress)
      const pose = cameraPoseForFollow(follow, sample.position, sample.direction, progress)
      cameraShots.push({
        id: createId(),
        name: `跟拍 ${String(index + 1).padStart(2, '0')}`,
        timeSeconds,
        transition: index === 0 ? 'cut' : 'smooth',
        camera: {
          position: pose.position,
          target: pose.target,
          fovDegrees: scene.camera.fovDegrees,
          aspectWidth: scene.camera.aspectWidth,
          aspectHeight: scene.camera.aspectHeight
        }
      })
    }
  }

  const start = points[0]
  const startFacing = faceAlongPath ? facingDegrees(points[0], points[1]) : target.rotation.y
  const objects = scene.objects.map((object) =>
    object.id === target.id
      ? {
          ...object,
          position: { ...start },
          rotation: { ...object.rotation, y: startFacing }
        }
      : object
  )

  const keptObjectKeyframes = scene.timeline.objectKeyframes.filter(
    (keyframe) => keyframe.objectId !== target.id
  )
  const nextTimeline = {
    durationSeconds: Math.max(scene.timeline.durationSeconds, durationSeconds, 1),
    objectKeyframes: sortedObjectKeyframes([...keptObjectKeyframes, ...objectKeyframes]),
    cameraShots: follow
      ? sortedCameraShots(cameraShots)
      : sortedCameraShots(scene.timeline.cameraShots)
  }

  let nextScene: SceneState = {
    ...scene,
    objects,
    timeline: nextTimeline
  }
  if (follow && cameraShots[0]) {
    nextScene = { ...nextScene, camera: structuredClone(cameraShots[0].camera) }
  }
  return { scene: nextScene, ok: true }
}

/**
 * 将 AI 场景命令应用到场景。纯函数，不触碰 React / IPC。
 */
export function applyAiSceneCommands(
  scene: SceneState,
  commands: AiSceneCommand[]
): ApplyAiSceneCommandsResult {
  let next: SceneState = {
    objects: scene.objects.map((object) => structuredClone(object)),
    camera: structuredClone(scene.camera),
    lighting: structuredClone(scene.lighting),
    timeline: structuredClone(scene.timeline)
  }
  const warnings: string[] = []
  let appliedCount = 0
  const addedIds: string[] = []
  let cameraExplicitlySet = false
  let hasTimelineAnimation = false

  for (const command of commands) {
    switch (command.type) {
      case 'clear_scene': {
        next = {
          ...next,
          objects: [],
          timeline: structuredClone(DEFAULT_TIMELINE)
        }
        addedIds.length = 0
        hasTimelineAnimation = false
        appliedCount += 1
        break
      }
      case 'add_object': {
        let object = createSceneObject(command.kind, next.objects)
        if (command.name) object = { ...object, name: command.name }
        if (command.description) object = { ...object, description: command.description }
        if (command.color) object = { ...object, color: command.color }
        if (command.size) object = { ...object, size: mergeVector(object.size, command.size) }
        if (command.rotation) {
          object = { ...object, rotation: mergeVector(object.rotation, command.rotation) }
        }
        if (command.position) {
          const position = mergeVector(object.position, command.position)
          if (command.position.y === undefined) {
            position.y = object.size.y / 2
          }
          object = { ...object, position }
        } else {
          object = placeNewObject(object, next.objects)
        }
        next = { ...next, objects: [...next.objects, object] }
        addedIds.push(object.id)
        appliedCount += 1
        break
      }
      case 'add_mannequin': {
        let object = createMannequinSceneObject(next.objects)
        if (!object.mannequin) {
          warnings.push('无法创建人台。')
          break
        }
        let mannequin = { ...object.mannequin }
        if (command.heightMeters !== undefined) {
          mannequin = { ...mannequin, heightMeters: command.heightMeters }
          object = {
            ...object,
            size: {
              x: command.heightMeters,
              y: command.heightMeters,
              z: command.heightMeters
            }
          }
        }
        object = { ...object, mannequin }
        if (command.name) object = { ...object, name: command.name }
        if (command.description) object = { ...object, description: command.description }
        if (command.presetId) {
          object = applyPresetToMannequin(object, command.presetId)
        }
        if (command.rotation) {
          object = { ...object, rotation: mergeVector(object.rotation, command.rotation) }
        }
        if (command.position) {
          const height = object.mannequin?.heightMeters ?? 1.75
          const position = mergeVector(object.position, command.position)
          if (command.position.y === undefined) position.y = height / 2
          object = { ...object, position }
        } else {
          object = placeNewObject(object, next.objects)
        }
        next = { ...next, objects: [...next.objects, object] }
        addedIds.push(object.id)
        appliedCount += 1
        break
      }
      case 'update_object': {
        const target = findObject(next.objects, command.id, command.name)
        if (!target) {
          warnings.push(`找不到要更新的物体：${command.id ?? command.name ?? '未指定'}`)
          break
        }
        next = {
          ...next,
          objects: next.objects.map((object) => {
            if (object.id !== target.id) return object
            let updated = { ...object }
            if (command.name) updated = { ...updated, name: command.name }
            if (command.description !== undefined) {
              updated = { ...updated, description: command.description }
            }
            if (command.color) updated = { ...updated, color: command.color }
            if (command.size && object.kind !== 'mannequin') {
              updated = { ...updated, size: mergeVector(object.size, command.size) }
            }
            if (command.rotation) {
              updated = { ...updated, rotation: mergeVector(object.rotation, command.rotation) }
            }
            if (command.position) {
              updated = { ...updated, position: mergeVector(object.position, command.position) }
            }
            return updated
          })
        }
        appliedCount += 1
        break
      }
      case 'set_mannequin_pose': {
        const target = findObject(next.objects, command.id, command.name, 'mannequin')
        if (!target || target.kind !== 'mannequin') {
          warnings.push(`找不到人台：${command.id ?? command.name ?? '未指定'}`)
          break
        }
        next = {
          ...next,
          objects: next.objects.map((object) =>
            object.id === target.id ? applyPresetToMannequin(object, command.presetId) : object
          )
        }
        appliedCount += 1
        break
      }
      case 'set_camera': {
        next = {
          ...next,
          camera: {
            ...next.camera,
            position: mergeVector(next.camera.position, command.position),
            target: mergeVector(next.camera.target, command.target),
            fovDegrees: command.fovDegrees ?? next.camera.fovDegrees
          }
        }
        cameraExplicitlySet = true
        appliedCount += 1
        break
      }
      case 'animate_move': {
        const moved = applyAnimateMove(next, command, warnings)
        next = moved.scene
        if (moved.ok) {
          appliedCount += 1
          hasTimelineAnimation = true
          if (command.cameraFollow !== false && command.cameraFollow !== undefined) {
            cameraExplicitlySet = true
          }
        }
        break
      }
      default:
        break
    }
  }

  let framedCamera = false
  if (!cameraExplicitlySet && !hasTimelineAnimation && appliedCount > 0 && next.objects.length > 0) {
    next = frameSceneCamera(next)
    framedCamera = true
  }

  return {
    scene: next,
    appliedCount,
    warnings,
    selectedIds:
      addedIds.length > 0 ? addedIds : next.objects.map((object) => object.id).slice(0, 1),
    framedCamera,
    hasTimelineAnimation
  }
}
