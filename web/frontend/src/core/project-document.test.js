import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CAMERA,
  DEFAULT_LIGHTING,
  DEFAULT_TIMELINE,
  PROJECT_SCHEMA_VERSION,
  createId,
  createProjectDocument,
  migrateProjectDocument,
  sceneFingerprint
} from '@/core/project-document'
import { createSceneObject, createSceneLight, inspectSceneQuality } from '@/core/scene'

const sampleScene = () => ({
  objects: [createSceneObject('box', [])],
  camera: JSON.parse(JSON.stringify(DEFAULT_CAMERA)),
  lighting: JSON.parse(JSON.stringify(DEFAULT_LIGHTING)),
  timeline: JSON.parse(JSON.stringify(DEFAULT_TIMELINE))
})

describe('project-document', () => {
  it('生成当前 schema 版本的文档，并带上名称与时间戳', () => {
    const scene = sampleScene()
    const document = createProjectDocument({ name: ' 测试场景 ', ...scene })
    expect(document.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
    expect(document.name).toBe('测试场景')
    expect(Number.isNaN(new Date(document.savedAt).getTime())).toBe(false)
  })

  it('名称为空时回退到"未命名场景"，避免出现无名工程', () => {
    const scene = sampleScene()
    expect(createProjectDocument({ name: '   ', ...scene }).name).toBe('未命名场景')
  })

  it('createId 返回互不相同的标识', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createId()))
    expect(ids.size).toBe(200)
  })

  it('迁移旧文档时补全相机、光照与时间轴，不丢弃物体', () => {
    const migrated = migrateProjectDocument({
      schemaVersion: 1,
      name: '老工程',
      scene: { objects: [{ id: 'a', kind: 'box', name: 'A' }] }
    })
    expect(migrated.schemaVersion).toBe(PROJECT_SCHEMA_VERSION)
    expect(migrated.name).toBe('老工程')
    expect(migrated.scene.objects).toHaveLength(1)
    expect(migrated.scene.camera).toEqual(DEFAULT_CAMERA)
    expect(migrated.scene.lighting.lights.length).toBeGreaterThan(0)
    expect(migrated.scene.timeline).toEqual(DEFAULT_TIMELINE)
  })

  it('非法光照被整体替换为默认值，而不是留下半损坏数据', () => {
    const migrated = migrateProjectDocument({
      scene: {
        objects: [],
        lighting: { lights: [{ id: 'x', intensity: 999 }] }
      }
    })
    expect(migrated.scene.lighting).toEqual(DEFAULT_LIGHTING)
  })

  it('缺少 id 的物体被过滤掉', () => {
    const migrated = migrateProjectDocument({
      scene: { objects: [{ kind: 'box' }, { id: 'keep', kind: 'box' }] }
    })
    expect(migrated.scene.objects.map((object) => object.id)).toEqual(['keep'])
  })

  it('指纹忽略 savedAt，因此保存后不会一直处于"未保存"状态', () => {
    const scene = sampleScene()
    const first = sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline)
    const second = sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline)
    expect(first).toBe(second)
  })

  it('物体位置变化会让指纹变化，脏标记才会生效', () => {
    const scene = sampleScene()
    const before = sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline)
    const moved = [{ ...scene.objects[0], position: { x: 5, y: 1, z: 0 } }]
    const after = sceneFingerprint(moved, scene.camera, scene.lighting, scene.timeline)
    expect(before).not.toBe(after)
  })
})

describe('scene 工厂与质量检查', () => {
  it('新物体按同类计数命名，并从 y = 高度的一半开始', () => {
    const first = createSceneObject('box', [])
    const second = createSceneObject('box', [first])
    expect(first.name).toBe('方块 01')
    expect(second.name).toBe('方块 02')
    expect(first.position.y).toBeCloseTo(first.size.y / 2, 6)
  })

  it('空场景的质量检查报错，阻止导出', () => {
    const report = inspectSceneQuality([])
    expect(report.status).toBe('error')
    expect(report.issues[0].severity).toBe('error')
  })

  it('过薄的物体会给出警告而不是错误', () => {
    const thin = { ...createSceneObject('wall', []), size: { x: 4, y: 0.01, z: 0.18 } }
    const report = inspectSceneQuality([thin])
    expect(report.status).toBe('warning')
    expect(report.issues.some((issue) => issue.severity === 'warning')).toBe(true)
  })

  it('灯光按类型命名并带上预设位置', () => {
    const light = createSceneLight('sun', [])
    expect(light.name).toBe('日光 01')
    expect(light.kind).toBe('sun')
    expect(light.intensity).toBeGreaterThan(0)
  })
})
