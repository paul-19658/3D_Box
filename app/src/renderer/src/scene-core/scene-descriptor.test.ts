import { describe, expect, it } from 'vitest'
import type { SceneObjectData } from '../../../shared/project-document'
import { createSceneObject, createInitialScene } from './scene'
import {
  assignObjectIndices,
  buildIndexMap,
  buildSceneDescriptor,
  buildSuggestedPrompt,
  serializeSceneDescriptor
} from './scene-descriptor'

function boxWith(description?: string, name = '方块 01'): SceneObjectData {
  const object = createSceneObject('box', [])
  return { ...object, name, description }
}

describe('scene-descriptor', () => {
  it('只给有描述且可见的物体分配索引', () => {
    const described = boxWith('冰箱', '冰箱')
    const noDescription = boxWith(undefined, '无描述')
    const hidden = { ...boxWith('隐藏物体', '隐藏'), visible: false }
    const entries = assignObjectIndices([described, noDescription, hidden])
    expect(entries).toEqual([{ index: 1, objectId: described.id }])
  })

  it('索引从 1 开始且按场景顺序递增', () => {
    const first = boxWith('第一个', 'A')
    const second = boxWith('第二个', 'B')
    const entries = assignObjectIndices([first, second])
    expect(entries.map((entry) => entry.index)).toEqual([1, 2])
    expect(entries.map((entry) => entry.objectId)).toEqual([first.id, second.id])
  })

  it('空白描述不算有效描述', () => {
    expect(assignObjectIndices([boxWith('   ', '空白')])).toEqual([])
  })

  it('buildIndexMap 给出 物体 id → 索引 的映射', () => {
    const first = boxWith('第一个')
    const second = boxWith('第二个')
    const map = buildIndexMap([first, second])
    expect(map.get(first.id)).toBe(1)
    expect(map.get(second.id)).toBe(2)
    expect(map.size).toBe(2)
  })

  it('生成 JSON 文档包含索引、描述与相机信息', () => {
    const scene = createInitialScene()
    const object = boxWith('一个正方形的冰箱', '冰箱')
    scene.objects = [object]
    const document = buildSceneDescriptor({
      projectName: '客厅方案',
      scene,
      generatedAt: '2026-10-10T10:00:00.000Z'
    })
    expect(document.schemaVersion).toBe(2)
    expect(document.generatedAt).toBe('2026-10-10T10:00:00.000Z')
    expect(document.units).toBe('meters')
    expect(document.objects).toHaveLength(1)
    expect(document.objects[0]).toMatchObject({
      index: 1,
      id: object.id,
      kind: 'box',
      kindLabel: '方块',
      description: '一个正方形的冰箱'
    })
    expect(document.camera.aspectRatio).toBe('16:9')
    expect(document.suggestedPrompt).toContain('1.')
  })

  it('没有描述的物体不会出现在文档里', () => {
    const scene = createInitialScene()
    scene.objects = [boxWith(undefined, '无描述'), boxWith('有描述', '有描述')]
    const document = buildSceneDescriptor({ projectName: '测试', scene })
    expect(document.objects).toHaveLength(1)
    expect(document.objects[0].index).toBe(1)
  })

  it('建议提示词在没有任何描述时给出提示', () => {
    const scene = createInitialScene()
    const prompt = buildSuggestedPrompt([], scene.camera, scene.timeline)
    expect(prompt).toContain('还没有填写任何物体描述')
  })

  it('建议提示词包含编号、描述与一致性要求', () => {
    const scene = createInitialScene()
    const object = boxWith('银色双开门冰箱', '冰箱')
    scene.objects = [object]
    const document = buildSceneDescriptor({ projectName: '测试', scene })
    expect(document.suggestedPrompt).toContain('1. 银色双开门冰箱')
    expect(document.suggestedPrompt).toContain('保持所有物体的材质、颜色和形状')
    expect(document.suggestedPrompt).toContain('不要出现任何数字编号')
  })

  it('序列化结果是可解析的 JSON', () => {
    const scene = createInitialScene()
    scene.objects = [boxWith('冰箱')]
    const text = serializeSceneDescriptor(buildSceneDescriptor({ projectName: '测试', scene }))
    expect(text.endsWith('\n')).toBe(true)
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('文档包含光照段落，并标明固定环境光不产生阴影', () => {
    const scene = createInitialScene()
    scene.objects = [boxWith('冰箱')]
    const document = buildSceneDescriptor({ projectName: '测试', scene })
    expect(document.lighting.lights.length).toBeGreaterThan(0)
    expect(document.lighting.fixed.map((entry) => entry.kind)).toEqual([
      'hemisphere',
      'directional-fill'
    ])
    expect(document.lighting.fixed.every((entry) => entry.producesShadow === false)).toBe(true)
    expect(document.lighting.summary).toContain('光照')
  })

  it('默认场景的主光是面光，且不占用阴影名额', () => {
    const scene = createInitialScene()
    scene.objects = [boxWith('冰箱')]
    const document = buildSceneDescriptor({ projectName: '测试', scene })
    const area = document.lighting.lights.find((light) => light.kind === 'area')
    expect(area).toBeDefined()
    expect(area?.castShadow).toBe(false)
    expect(document.lighting.shadowCasterNames).toEqual([])
  })

  it('新增聚光灯后，阴影灯名单随之更新', () => {
    const scene = createInitialScene()
    scene.objects = [boxWith('冰箱')]
    scene.lighting.lights.push({
      id: 'spot-1',
      name: '聚光灯 01',
      kind: 'spot',
      position: { x: 4, y: 7, z: 5 },
      target: { x: 0, y: 1, z: 0 },
      color: '#fff8ee',
      intensity: 4,
      size: 0.3,
      angleDegrees: 38,
      visible: true,
      locked: false
    })
    const document = buildSceneDescriptor({ projectName: '测试', scene })
    expect(document.lighting.shadowCasterNames).toEqual(['聚光灯 01'])
    expect(document.suggestedPrompt).toContain('聚光灯 01')
  })

  it('建议提示词包含光照方向与阴影要求', () => {
    const scene = createInitialScene()
    scene.objects = [boxWith('冰箱')]
    const document = buildSceneDescriptor({ projectName: '测试', scene })
    expect(document.suggestedPrompt).toContain('光照：')
    expect(document.suggestedPrompt).toContain('固定环境光')
    expect(document.suggestedPrompt).toContain('保持上述光照方向、色调与阴影走向')
  })
})
