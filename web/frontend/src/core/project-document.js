/**
 * 工程文档的数据结构与默认值。
 *
 * 本文件是 `app/src/shared/project-document.ts` 的等价实现。
 * 后端 `web/backend/app/models/project.py` 必须有相同字段与校验规则。
 * 修改任意一端都必须同步另外两端，并在 docs/AI_DEV_GUIDE.md 登记。
 */

/**
 * schema 13：新增 `kind: 'path'` 的导航线对象。
 *
 * 只增不改：v12 及更早的工程里没有 path 对象，迁移时原样保留即可，
 * 因此不需要写"版本升级改写"逻辑，只需要在类型白名单里放开 path。
 */
export const PROJECT_SCHEMA_VERSION = 13
export const PROJECT_EXTENSION = 'block3d'

/** 场景里可作为"物体"存在的类型。导航线也是物体，因此也在这里。 */
export const OBJECT_KINDS = [
  'box',
  'cylinder',
  'sphere',
  'wall',
  'floor',
  'custom',
  'imported',
  'mannequin',
  'path'
]

/** 导航线节点的坐标系：相对路径对象自身位置的局部坐标。 */
export const PATH_KIND = 'path'

export const MANNEQUIN_JOINT_IDS = [
  'head',
  'spine',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee'
]

export const MANNEQUIN_PRESET_IDS = ['stand', 'sit', 'raise-hand', 'walk', 'run']

/**
 * 默认摄影机。
 *
 * 刻意与视口的编辑相机（`SceneViewport.init` 里的 7.5 / 5.5 / 8.5）错开：
 * 如果两者位置完全相同，摄影机模型正好落在观察者眼睛上，
 * 既看不见也点不中，"选择摄影机"功能会像是坏的。
 *
 * 放在左前方而不是紧贴编辑相机，是因为太近时机身会占满画面下半部分，
 * 看起来像遮挡物而不是"场景里的一台相机"。
 */
export const DEFAULT_CAMERA = {
  position: { x: -5.6, y: 3.4, z: 6.4 },
  target: { x: 0, y: 1, z: 0 },
  fovDegrees: 42,
  aspectWidth: 16,
  aspectHeight: 9
}

export const DEFAULT_LIGHTING = {
  lights: [
    {
      id: 'light-main',
      name: '柔和主光',
      kind: 'area',
      position: { x: 6, y: 10, z: 5 },
      target: { x: 0, y: 1, z: 0 },
      color: '#fffaf1',
      intensity: 2.8,
      size: 4,
      angleDegrees: 45,
      visible: true,
      locked: false
    }
  ]
}

export const DEFAULT_TIMELINE = {
  durationSeconds: 5,
  cameraShots: [],
  objectKeyframes: []
}

/** 与固定场景光保持单一来源：视口渲染与光照描述都引用这里。 */
export const FIXED_HEMISPHERE_LIGHT = {
  skyColor: '#ffffff',
  groundColor: '#a9b0b1',
  intensity: 1.15
}

export const FIXED_FILL_LIGHT = {
  color: '#e5f4f1',
  intensity: 0.42,
  position: { x: -5, y: 4, z: -3 },
  target: { x: 0, y: 0, z: 0 }
}

/** 基础体的默认尺寸，单位米。 */
export const BASIC_KIND_SIZES = {
  box: { x: 2.2, y: 2.2, z: 2.2 },
  cylinder: { x: 1.8, y: 2.4, z: 1.8 },
  sphere: { x: 2, y: 2, z: 2 },
  wall: { x: 4, y: 2.8, z: 0.18 },
  floor: { x: 4, y: 0.12, z: 4 }
}

export const BASIC_KIND_NAMES = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面'
}

export const LIGHT_KIND_LABELS = {
  point: '点光源',
  spot: '聚光灯',
  area: '面光',
  sun: '日光'
}

export const LIGHT_PRESETS = {
  area: {
    name: '柔和面光',
    position: { x: 5, y: 8, z: 4 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff4df',
    intensity: 2.5,
    size: 4,
    angleDegrees: 45
  },
  point: {
    name: '点光源',
    position: { x: 3, y: 5, z: 3 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff1d6',
    intensity: 3.2,
    size: 0.35,
    angleDegrees: 45
  },
  spot: {
    name: '聚光灯',
    position: { x: 4, y: 7, z: 5 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff8ee',
    intensity: 4,
    size: 0.3,
    angleDegrees: 38
  },
  sun: {
    name: '日光',
    position: { x: 6, y: 10, z: 4 },
    target: { x: 0, y: 0, z: 0 },
    color: '#fff5dc',
    intensity: 1.8,
    size: 1,
    angleDegrees: 5
  }
}

/** 相机画幅预设，与用户指南中列出的比例一致。 */
export const ASPECT_PRESETS = [
  { label: '16:9', width: 16, height: 9 },
  { label: '9:16', width: 9, height: 16 },
  { label: '1:1', width: 1, height: 1 },
  { label: '4:3', width: 4, height: 3 }
]

export function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function cloneVector(value) {
  return { x: value.x, y: value.y, z: value.z }
}

export function createProjectDocument({ name, objects, camera, lighting, timeline, appVersion }) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: appVersion || '0.22.0',
    savedAt: new Date().toISOString(),
    name: (name || '').trim() || '未命名场景',
    scene: { objects, camera, lighting, timeline }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVector3(value) {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function isSceneLight(value) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    ['point', 'spot', 'area', 'sun'].includes(value.kind) &&
    isVector3(value.position) &&
    isVector3(value.target) &&
    isFiniteNumber(value.intensity) &&
    value.intensity >= 0 &&
    value.intensity <= 20 &&
    isFiniteNumber(value.size) &&
    value.size > 0 &&
    value.size <= 100 &&
    isFiniteNumber(value.angleDegrees) &&
    typeof value.visible === 'boolean' &&
    typeof value.locked === 'boolean'
  )
}

function isCamera(value) {
  return (
    isRecord(value) &&
    isVector3(value.position) &&
    isVector3(value.target) &&
    isFiniteNumber(value.fovDegrees) &&
    isFiniteNumber(value.aspectWidth) &&
    isFiniteNumber(value.aspectHeight)
  )
}

/** 导航线节点：只需 x / z 有效，y 允许缺省（缺省按 0 处理）。 */
function isPathNode(value) {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.z)
}

function isPathBinding(value) {
  return isRecord(value) && typeof value.pathId === 'string' && value.pathId.length > 0
}

/**
 * 补齐单个物体的可选字段。
 *
 * 关键点：**path 对象的节点必须过一遍净化**。
 * 手改文件、或旧版本写出的坐标里可能混进 NaN，直接进渲染层会让
 * 整条路径消失（NaN 会污染矩阵），而且很难排查。
 */
function normalizeObject(object) {
  const next = { ...object }
  if (next.kind === PATH_KIND) {
    next.pathNodes = Array.isArray(next.pathNodes)
      ? next.pathNodes
          .filter(isPathNode)
          .map((node) => ({ x: node.x, y: isFiniteNumber(node.y) ? node.y : 0, z: node.z }))
      : []
  } else if (next.pathNodes !== undefined) {
    // 非路径对象不该带节点，去掉以免渲染层误判。
    delete next.pathNodes
  }
  if (next.pathBinding !== undefined && !isPathBinding(next.pathBinding)) {
    delete next.pathBinding
  }
  return next
}

/**
 * 把任意历史版本工程迁移到当前 schema。
 *
 * 策略与后端 `migrate_document` 一致：字段缺失或非法时回退默认值，
 * 而不是直接拒绝——用户工程打不开的代价远高于静默补全。
 */
export function migrateProjectDocument(raw) {
  const sceneRaw = (raw && raw.scene) || {}
  const camera = isCamera(sceneRaw.camera) ? sceneRaw.camera : JSON.parse(JSON.stringify(DEFAULT_CAMERA))
  const lighting =
    isRecord(sceneRaw.lighting) &&
    Array.isArray(sceneRaw.lighting.lights) &&
    sceneRaw.lighting.lights.length > 0 &&
    sceneRaw.lighting.lights.every(isSceneLight)
      ? sceneRaw.lighting
      : JSON.parse(JSON.stringify(DEFAULT_LIGHTING))
  const timeline = isRecord(sceneRaw.timeline)
    ? {
        durationSeconds: isFiniteNumber(sceneRaw.timeline.durationSeconds)
          ? sceneRaw.timeline.durationSeconds
          : DEFAULT_TIMELINE.durationSeconds,
        cameraShots: Array.isArray(sceneRaw.timeline.cameraShots) ? sceneRaw.timeline.cameraShots : [],
        objectKeyframes: Array.isArray(sceneRaw.timeline.objectKeyframes)
          ? sceneRaw.timeline.objectKeyframes
          : []
      }
    : JSON.parse(JSON.stringify(DEFAULT_TIMELINE))

  const objects = Array.isArray(sceneRaw.objects)
    ? sceneRaw.objects
        .filter((object) => isRecord(object) && typeof object.id === 'string')
        .filter((object) => OBJECT_KINDS.includes(object.kind))
        .map(normalizeObject)
    : []

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: (raw && raw.appVersion) || '0.22.0',
    savedAt: (raw && raw.savedAt) || new Date().toISOString(),
    name: (raw && raw.name) || '未命名场景',
    scene: { objects, camera, lighting, timeline }
  }
}

/**
 * 生成用于比较"是否有未保存修改"的指纹。
 *
 * 刻意不含 savedAt：否则每次保存都会让指纹变化，脏标记永远为真。
 * 用 JSON 字符串而非哈希，是为了让调试时能直接看出差异。
 */
export function sceneFingerprint(objects, camera, lighting, timeline) {
  const round = (value) => Math.round(value * 1_000_000) / 1_000_000
  return JSON.stringify({
    objects: objects.map((object) => ({
      id: object.id,
      kind: object.kind,
      name: object.name,
      description: object.description ?? '',
      position: [round(object.position.x), round(object.position.y), round(object.position.z)],
      rotation: [round(object.rotation.x), round(object.rotation.y), round(object.rotation.z)],
      size: [round(object.size.x), round(object.size.y), round(object.size.z)],
      color: object.color,
      colorOverride: object.colorOverride ?? '',
      faceColors: object.faceColors ?? null,
      displayMode: object.displayMode ?? 'solid',
      visible: object.visible,
      locked: object.locked,
      groupId: object.groupId ?? '',
      mannequin: object.mannequin
        ? {
            heightMeters: round(object.mannequin.heightMeters),
            presetId: object.mannequin.presetId ?? '',
            pose: object.mannequin.pose
          }
        : null,
      customMesh: object.customMesh ?? null,
      cuts: object.cuts ?? null,
      // 导航线：节点位置与绑定关系都是"会改变画面"的数据，必须进指纹，
      // 否则拖动节点后 Ctrl+S 不会认为工程变脏，改名/存盘都被跳过。
      pathNodes: object.pathNodes
        ? object.pathNodes.map((node) => [round(node.x), round(node.y), round(node.z)])
        : null,
      pathBinding: object.pathBinding
        ? {
            pathId: object.pathBinding.pathId,
            followRotation: object.pathBinding.followRotation !== false,
            offsetSeconds: round(object.pathBinding.offsetSeconds ?? 0),
            heightOffset: round(object.pathBinding.heightOffset ?? 0)
          }
        : null
    })),
    camera: {
      position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
      target: [round(camera.target.x), round(camera.target.y), round(camera.target.z)],
      fovDegrees: round(camera.fovDegrees),
      aspectWidth: camera.aspectWidth,
      aspectHeight: camera.aspectHeight
    },
    lighting,
    timeline
  })
}
