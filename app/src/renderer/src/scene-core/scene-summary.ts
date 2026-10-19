import type { SceneObjectData } from '../../../shared/project-document'
import type { SceneState } from './scene'
import { MANNEQUIN_PRESETS } from '../mannequin/mannequin'
import { describeLighting } from './lighting-description'

/**
 * 把当前场景整理成一段简短的中文描述，随用户消息一起发送给 AI。
 * 只包含搭建场景所需的关键信息，避免过长。
 */

const KIND_LABELS: Record<SceneObjectData['kind'], string> = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面',
  custom: '自定义形状',
  imported: '导入模型',
  mannequin: '人台'
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function formatVector(value: { x: number; y: number; z: number }): string {
  return `${round(value.x)}, ${round(value.y)}, ${round(value.z)}`
}

function presetLabel(presetId: string | undefined): string | null {
  if (!presetId) return null
  return MANNEQUIN_PRESETS.find((preset) => preset.id === presetId)?.label ?? presetId
}

export function summarizeSceneObject(object: SceneObjectData): string {
  const label = KIND_LABELS[object.kind]
  const parts = [
    `${label}「${object.name}」`,
    `id=${object.id}`,
    `位置(${formatVector(object.position)})`,
    `尺寸(${formatVector(object.size)})`
  ]
  if (object.kind !== 'mannequin') {
    parts.push(`旋转(${formatVector(object.rotation)})`)
  }
  if (!object.visible) parts.push('已隐藏')
  if (object.locked) parts.push('已锁定')
  if (object.kind === 'mannequin') {
    const pose = presetLabel(object.mannequin?.presetId)
    if (pose) parts.push(`动作：${pose}`)
    if (object.mannequin) parts.push(`身高 ${round(object.mannequin.heightMeters)} 米`)
  }
  return `- ${parts.join('，')}`
}

export function summarizeScene(scene: SceneState): string {
  const objects = scene.objects
  const visibleCount = objects.filter((object) => object.visible).length
  const lines: string[] = []
  lines.push(
    `物体共 ${objects.length} 个（可见 ${visibleCount} 个），相机视场角 ${round(scene.camera.fovDegrees)} 度，画幅 ${scene.camera.aspectWidth}:${scene.camera.aspectHeight}。`
  )
  lines.push(
    `相机位置(${formatVector(scene.camera.position)})，看向(${formatVector(scene.camera.target)})。`
  )
  lines.push(describeLighting(scene.lighting.lights).summaryLine)
  if (objects.length === 0) {
    lines.push('当前场景没有任何物体。')
  } else {
    for (const object of objects.slice(0, 40)) {
      lines.push(summarizeSceneObject(object))
    }
    if (objects.length > 40) lines.push(`- 其余 ${objects.length - 40} 个物体未一一列出。`)
  }
  if (scene.timeline.cameraShots.length > 0 || scene.timeline.objectKeyframes.length > 0) {
    lines.push(
      `时间轴：总长 ${round(scene.timeline.durationSeconds)} 秒，镜头关键帧 ${scene.timeline.cameraShots.length} 个，物体关键帧 ${scene.timeline.objectKeyframes.length} 个。`
    )
  }
  return lines.join('\n')
}
