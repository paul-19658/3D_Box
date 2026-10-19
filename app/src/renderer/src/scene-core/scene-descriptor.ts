import type {
  CameraState,
  PrimitiveKind,
  SceneLightData,
  SceneObjectData,
  TimelineState,
  Vector3Value
} from '../../../shared/project-document'
import { MANNEQUIN_PRESETS } from '../mannequin/mannequin'
import type { SceneState } from './scene'
import {
  describeLighting,
  FIXED_FILL_LIGHT,
  FIXED_HEMISPHERE_LIGHT,
  type LightDescription
} from './lighting-description'

/**
 * 场景说明：把带描述的物体整理成带索引的清单，供导出 JSON 与 AI 参考。
 *
 * 索引规则：只给“有描述且可见”的物体编号，编号从 1 开始，按物体在场景中的顺序分配。
 * 画面叠加层里显示的数字与这里导出的索引完全一致，方便 AI 把画面上的编号和描述对应起来。
 */

export const SCENE_DESCRIPTOR_SCHEMA_VERSION = 2 as const

export const KIND_LABELS: Record<PrimitiveKind, string> = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面',
  custom: '自定义形状',
  imported: '导入模型',
  mannequin: '人台'
}

export interface ObjectIndexEntry {
  index: number
  objectId: string
}

export interface SceneDescriptionEntry {
  index: number
  id: string
  name: string
  kind: PrimitiveKind
  kindLabel: string
  description: string
  position: Vector3Value
  rotation: Vector3Value
  size: Vector3Value
  color: string
  mannequinPreset: string | null
}

export interface FixedLightingEntry {
  kind: 'hemisphere' | 'directional-fill'
  description: string
  producesShadow: false
  color: string
  intensity: number
  position?: Vector3Value
}

export interface SceneLightingEntry {
  lights: LightDescription[]
  visibleCount: number
  shadowCasterNames: string[]
  /** 固定环境光（半球光 + 方向补光），始终存在，不产生阴影。 */
  fixed: FixedLightingEntry[]
  /** 供生成式模型直接使用的一段光照说明。 */
  summary: string
}

export interface SceneDescriptorDocument {
  schemaVersion: typeof SCENE_DESCRIPTOR_SCHEMA_VERSION
  generatedAt: string
  projectName: string
  units: 'meters'
  indexMeaning: string
  camera: CameraState & { aspectRatio: string }
  lighting: SceneLightingEntry
  timeline: {
    durationSeconds: number
    cameraShotCount: number
    objectKeyframeCount: number
  }
  objects: SceneDescriptionEntry[]
  suggestedPrompt: string
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function roundVector(value: Vector3Value): Vector3Value {
  return { x: round(value.x), y: round(value.y), z: round(value.z) }
}

function hasDescription(object: SceneObjectData): boolean {
  return (object.description ?? '').trim().length > 0
}

/**
 * 按场景顺序给“有描述且可见”的物体分配从 1 开始的索引。
 */
export function assignObjectIndices(objects: SceneObjectData[]): ObjectIndexEntry[] {
  const entries: ObjectIndexEntry[] = []
  for (const object of objects) {
    if (!object.visible || !hasDescription(object)) continue
    entries.push({ index: entries.length + 1, objectId: object.id })
  }
  return entries
}

/** 返回 物体 id → 索引 的映射，供画面叠加层使用。 */
export function buildIndexMap(objects: SceneObjectData[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const entry of assignObjectIndices(objects)) map.set(entry.objectId, entry.index)
  return map
}

function mannequinPresetLabel(object: SceneObjectData): string | null {
  const presetId = object.mannequin?.presetId
  if (!presetId) return null
  return MANNEQUIN_PRESETS.find((preset) => preset.id === presetId)?.label ?? presetId
}

function aspectRatioLabel(width: number, height: number): string {
  const ratio = width / height
  const candidates = [
    { label: '16:9', ratio: 16 / 9 },
    { label: '9:16', ratio: 9 / 16 },
    { label: '1:1', ratio: 1 },
    { label: '4:3', ratio: 4 / 3 },
    { label: '3:4', ratio: 3 / 4 }
  ]
  return (
    candidates.find((candidate) => Math.abs(candidate.ratio - ratio) <= 0.015)?.label ??
    `${width}:${height}`
  )
}

function cameraDirectionText(camera: CameraState): string {
  const deltaX = camera.target.x - camera.position.x
  const deltaZ = camera.target.z - camera.position.z
  const horizontal = Math.hypot(deltaX, deltaZ)
  if (horizontal < 0.001) return '镜头近乎垂直向下俯视'
  const degrees = (Math.atan2(deltaX, deltaZ) * 180) / Math.PI
  return `镜头朝向约 ${round(degrees)} 度（水平方向，0 度为 +Z，顺时针为正）`
}

/** 把场景灯光整理成可直接序列化的光照条目。 */
export function buildSceneLightingEntry(lights: SceneLightData[]): SceneLightingEntry {
  const described = describeLighting(lights)
  return {
    lights: described.lights,
    visibleCount: described.visibleLights.length,
    shadowCasterNames: described.shadowCasterNames,
    fixed: [
      {
        kind: 'hemisphere',
        description: `半球环境光：天空 ${FIXED_HEMISPHERE_LIGHT.skyColor}，地面反射 ${FIXED_HEMISPHERE_LIGHT.groundColor}`,
        producesShadow: false,
        color: FIXED_HEMISPHERE_LIGHT.skyColor,
        intensity: FIXED_HEMISPHERE_LIGHT.intensity
      },
      {
        kind: 'directional-fill',
        description: '方向补光，从物体左后方补充轮廓亮度',
        producesShadow: false,
        color: FIXED_FILL_LIGHT.color,
        intensity: FIXED_FILL_LIGHT.intensity,
        position: { ...FIXED_FILL_LIGHT.position }
      }
    ],
    summary: described.summaryLine
  }
}

/**
 * 生成建议提示词，可直接复制到生成视频的平台使用。
 *
 * 光照段落会明确说明主光方向、色调与阴影走向，帮助生成式模型还原
 * “光从哪里来、影子往哪里倒”，而不是自行编造一套默认打光。
 */
export function buildSuggestedPrompt(
  entries: SceneDescriptionEntry[],
  camera: CameraState,
  timeline: TimelineState,
  lights: SceneLightData[] = []
): string {
  if (entries.length === 0) {
    return '当前场景还没有填写任何物体描述。请先在物体属性中填写“物体描述”，再生成提示词。'
  }
  const lines: string[] = []
  lines.push('画面中的物体：')
  for (const entry of entries) {
    const details: string[] = [entry.description]
    if (entry.kind === 'mannequin' && entry.mannequinPreset) {
      details.push(`人物动作：${entry.mannequinPreset}`)
    }
    lines.push(
      `${entry.index}. ${details.join('；')}（位置 x=${entry.position.x}, y=${entry.position.y}, z=${entry.position.z}）`
    )
  }
  lines.push('')
  const ratio = aspectRatioLabel(camera.aspectWidth, camera.aspectHeight)
  lines.push(
    `摄影机位置（${round(camera.position.x)}, ${round(camera.position.y)}, ${round(camera.position.z)}），视场角 ${round(camera.fovDegrees)} 度，画幅 ${ratio}。`
  )
  lines.push(cameraDirectionText(camera))
  if (timeline.durationSeconds > 0) {
    lines.push(`镜头时长约 ${round(timeline.durationSeconds)} 秒。`)
  }
  lines.push('')
  lines.push(...describeLighting(lights).promptLines)
  lines.push('')
  lines.push('要求：')
  lines.push('- 保持所有物体的材质、颜色和形状在整个镜头中前后一致。')
  lines.push('- 让物体的运动与参考视频保持一致，不要改变运动轨迹和节奏。')
  lines.push('- 保持上述光照方向、色调与阴影走向在整个镜头中稳定，不要自行添加新的光源。')
  lines.push('- 不要出现任何数字编号、文字标记或参考用的辅助图形。')
  return lines.join('\n')
}

export interface BuildSceneDescriptorInput {
  projectName: string
  scene: SceneState
  generatedAt?: string
}

/**
 * 生成完整的场景说明文档。只有“有描述且可见”的物体会被收录。
 */
export function buildSceneDescriptor(input: BuildSceneDescriptorInput): SceneDescriptorDocument {
  const { scene } = input
  const indexEntries = assignObjectIndices(scene.objects)
  const byId = new Map(scene.objects.map((object) => [object.id, object]))
  const objects: SceneDescriptionEntry[] = []
  for (const entry of indexEntries) {
    const object = byId.get(entry.objectId)
    if (!object) continue
    objects.push({
      index: entry.index,
      id: object.id,
      name: object.name,
      kind: object.kind,
      kindLabel: KIND_LABELS[object.kind],
      description: (object.description ?? '').trim(),
      position: roundVector(object.position),
      rotation: roundVector(object.rotation),
      size: roundVector(object.size),
      color: object.color,
      mannequinPreset: mannequinPresetLabel(object)
    })
  }

  return {
    schemaVersion: SCENE_DESCRIPTOR_SCHEMA_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    projectName: input.projectName,
    units: 'meters',
    indexMeaning: 'objects[].index 对应画面上叠加的数字编号，1 表示第一个带描述的可见物体。',
    camera: {
      ...scene.camera,
      aspectRatio: aspectRatioLabel(scene.camera.aspectWidth, scene.camera.aspectHeight)
    },
    lighting: buildSceneLightingEntry(scene.lighting.lights),
    timeline: {
      durationSeconds: round(scene.timeline.durationSeconds),
      cameraShotCount: scene.timeline.cameraShots.length,
      objectKeyframeCount: scene.timeline.objectKeyframes.length
    },
    objects,
    suggestedPrompt: buildSuggestedPrompt(
      objects,
      scene.camera,
      scene.timeline,
      scene.lighting.lights
    )
  }
}

export function serializeSceneDescriptor(document: SceneDescriptorDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
