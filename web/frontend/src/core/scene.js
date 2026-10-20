/**
 * 场景对象工厂、质量检查与场景摘要。
 * 移植自 `scene.ts`、`quality.ts`、`scene-summary.ts`。
 */

import {
  BASIC_KIND_NAMES,
  BASIC_KIND_SIZES,
  DEFAULT_CAMERA,
  DEFAULT_LIGHTING,
  DEFAULT_TIMELINE,
  LIGHT_PRESETS,
  PATH_KIND,
  createId
} from './project-document'
import { PATH_COLOR } from './nav-path'
import { createMannequinData } from './mannequin'
import { validateCustomMesh } from './geometry'
import { describeLighting } from './lighting-description'

export function createSceneObject(kind, existing) {
  const count = existing.filter((object) => object.kind === kind).length
  return {
    id: createId(),
    kind,
    name: `${BASIC_KIND_NAMES[kind]} ${String(count + 1).padStart(2, '0')}`,
    position: { x: 0, y: BASIC_KIND_SIZES[kind].y / 2, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { ...BASIC_KIND_SIZES[kind] },
    color: '#c9cdd0',
    visible: true,
    locked: false
  }
}

export function createMannequinSceneObject(existing, heightMeters = 1.75) {
  const count = existing.filter((object) => object.kind === 'mannequin').length
  return {
    id: createId(),
    kind: 'mannequin',
    name: `人台 ${String(count + 1).padStart(2, '0')}`,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: heightMeters, z: 1 },
    color: '#e8e6e1',
    visible: true,
    locked: false,
    mannequin: createMannequinData(heightMeters)
  }
}

export function createCustomSceneObject(existing, mesh) {
  const count = existing.filter((object) => object.kind === 'custom').length
  return {
    id: createId(),
    kind: 'custom',
    name: `自定义形状 ${String(count + 1).padStart(2, '0')}`,
    position: { x: 0, y: 0.5, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    color: '#c9cdd0',
    visible: true,
    locked: false,
    customMesh: mesh
  }
}

/**
 * 新建一条空白导航线。
 *
 * 节点先留空：真正的节点由"绘制"或"手动添加"写入。
 * 空路径在视口里不可见也不可选中（没有几何体），
 * 因此创建后立刻由父组件选中并进入绘制模式。
 */
export function createPathSceneObject(existing) {
  const count = existing.filter((object) => object.kind === 'path').length
  return {
    id: createId(),
    kind: 'path',
    name: `导航线 ${String(count + 1).padStart(2, '0')}`,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    color: PATH_COLOR,
    visible: true,
    locked: false,
    pathNodes: []
  }
}

export function createImportedSceneObject(existing, asset, name) {
  return {
    id: createId(),
    kind: 'imported',
    name: name || asset.sourceName,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    color: '#c9cdd0',
    visible: true,
    locked: false,
    importedAsset: asset,
    useImportedLights: false,
    previewQuality: 'original',
    exportQuality: 'original'
  }
}

export function createSceneLight(kind, existingLights) {
  const preset = LIGHT_PRESETS[kind]
  const count = existingLights.filter((light) => light.kind === kind).length
  return {
    id: createId(),
    kind,
    name: `${preset.name} ${String(count + 1).padStart(2, '0')}`,
    position: { ...preset.position },
    target: { ...preset.target },
    color: preset.color,
    intensity: preset.intensity,
    size: preset.size,
    angleDegrees: preset.angleDegrees,
    visible: true,
    locked: false
  }
}

export function cloneSceneObject(object) {
  return {
    ...JSON.parse(JSON.stringify(object)),
    id: createId(),
    name: `${object.name} 副本`
  }
}

/**
 * 新场景的初始内容。
 *
 * 刻意放一个方块：完全空的场景配深色主题，用户会以为软件坏了
 * （"打开就是一片黑"），有一个参照物才能立刻确认渲染正常、
 * 也能马上试一下拖拽和变换。
 *
 * 这里**不放地面物体**：地面基线由视口里的参考网格负责
 * （见 SceneViewport.createGrid）。如果再加一块 24×24 的地板，
 * 它的顶面会盖住网格线，反而把基线遮没了。
 */
export function createInitialScene() {
  const box = {
    ...createSceneObject('box', []),
    name: '方块 01',
    position: { x: 0, y: 1.1, z: 0 }
  }
  return {
    objects: [box],
    camera: JSON.parse(JSON.stringify(DEFAULT_CAMERA)),
    lighting: JSON.parse(JSON.stringify(DEFAULT_LIGHTING)),
    timeline: JSON.parse(JSON.stringify(DEFAULT_TIMELINE))
  }
}

// ----------------------------------------------------------------------
// 质量检查
// ----------------------------------------------------------------------

function primitiveTriangles(object) {
  // 导航线只是引导线，不产生可导出的面片。
  if (object.kind === PATH_KIND) return 0
  if (object.kind === 'box') return 12
  if (object.kind === 'cylinder') return 128
  if (object.kind === 'sphere') return 1216
  if (object.kind === 'mannequin') return 12566
  if (object.kind === 'custom') {
    if (object.customMesh) {
      return object.customMesh.faces.reduce((sum, face) => sum + Math.max(face.length - 2, 0), 0)
    }
    return 0
  }
  return object.importedAsset?.report?.triangleCount ?? 0
}

/**
 * 导出前检查场景。
 * 刻意把"问题"和"提示"分开：错误阻止导出，警告只提醒用户确认。
 */
export function inspectSceneQuality(objects) {
  const issues = []
  let triangleCount = 0

  if (objects.length === 0) {
    issues.push({ severity: 'error', message: '场景中还没有可导出的模型。' })
  }

  for (const object of objects) {
    triangleCount += primitiveTriangles(object)
    if (Math.min(object.size.x, object.size.y, object.size.z) < 0.02) {
      issues.push({
        severity: 'warning',
        objectId: object.id,
        message: `${object.name} 有一个方向过薄，导出轮廓时可能不清楚。`
      })
    }
    if (object.kind === 'custom' && object.customMesh) {
      for (const message of validateCustomMesh(object.customMesh)) {
        issues.push({ severity: 'error', objectId: object.id, message: `${object.name}：${message}` })
      }
    }
    if (object.kind === 'imported' && object.importedAsset?.report?.issues) {
      for (const issue of object.importedAsset.report.issues) {
        if (issue.severity === 'info') continue
        issues.push({ severity: issue.severity, objectId: object.id, message: issue.message })
      }
    }
  }

  if (triangleCount > 1_000_000) {
    issues.push({ severity: 'warning', message: '场景超过 100 万三角面，编辑和导出可能变慢。' })
  }
  const status = issues.some((issue) => issue.severity === 'error')
    ? 'error'
    : issues.length > 0
      ? 'warning'
      : 'good'
  return { objectCount: objects.length, triangleCount, issueCount: issues.length, issues, status }
}

// ----------------------------------------------------------------------
// 场景摘要（发送给 AI）
// ----------------------------------------------------------------------

const KIND_LABELS = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面',
  custom: '自定义形状',
  imported: '导入模型',
  mannequin: '人台',
  path: '导航线'
}

function round(value) {
  return Math.round(value * 100) / 100
}

function formatVector(value) {
  return `${round(value.x)}, ${round(value.y)}, ${round(value.z)}`
}

/**
 * 单个物体的文字摘要（发送给 AI）。
 *
 * `allObjects` 可选：给了才能把"绑定到哪条导航线"翻译成路径名，
 * 否则只能写出一个 id，AI 读不懂。
 */
export function summarizeSceneObject(object, allObjects = []) {
  const label = KIND_LABELS[object.kind] || object.kind
  const parts = [
    `${label}「${object.name}」`,
    `id=${object.id}`,
    `位置(${formatVector(object.position)})`,
    `尺寸(${formatVector(object.size)})`
  ]
  if (object.kind !== 'mannequin') parts.push(`旋转(${formatVector(object.rotation)})`)
  if (!object.visible) parts.push('已隐藏')
  if (object.locked) parts.push('已锁定')
  if (object.kind === 'mannequin' && object.mannequin) {
    if (object.mannequin.presetId) parts.push(`动作：${object.mannequin.presetId}`)
    parts.push(`身高 ${round(object.mannequin.heightMeters)} 米`)
  }
  if (object.kind === PATH_KIND) {
    parts.push(`导航线节点 ${object.pathNodes?.length ?? 0} 个`)
  }
  if (object.pathBinding) {
    const path = allObjects.find((item) => item.id === object.pathBinding.pathId)
    parts.push(`沿导航线「${path ? path.name : object.pathBinding.pathId}」运动`)
  }
  return `- ${parts.join('，')}`
}

export function summarizeScene(scene) {
  const objects = scene.objects
  const visibleCount = objects.filter((object) => object.visible).length
  const lines = []
  lines.push(
    `物体共 ${objects.length} 个（可见 ${visibleCount} 个），相机视场角 ${round(
      scene.camera.fovDegrees
    )} 度，画幅 ${scene.camera.aspectWidth}:${scene.camera.aspectHeight}。`
  )
  lines.push(`相机位置(${formatVector(scene.camera.position)})，看向(${formatVector(scene.camera.target)})。`)
  lines.push(describeLighting(scene.lighting.lights).summaryLine)
  if (objects.length === 0) {
    lines.push('当前场景没有任何物体。')
  } else {
    for (const object of objects.slice(0, 40)) lines.push(summarizeSceneObject(object, objects))
    if (objects.length > 40) lines.push(`- 其余 ${objects.length - 40} 个物体未一一列出。`)
  }
  if (scene.timeline.cameraShots.length > 0 || scene.timeline.objectKeyframes.length > 0) {
    lines.push(
      `时间轴：总长 ${round(scene.timeline.durationSeconds)} 秒，镜头关键帧 ${
        scene.timeline.cameraShots.length
      } 个，物体关键帧 ${scene.timeline.objectKeyframes.length} 个。`
    )
  }
  return lines.join('\n')
}
