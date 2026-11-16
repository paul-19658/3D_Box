import { describe, expect, it } from 'vitest'

import {
  DEFAULT_BACKGROUND,
  DEFAULT_CAMERA,
  DEFAULT_LIGHTING,
  DEFAULT_TIMELINE,
  PROJECT_SCHEMA_VERSION,
  createId,
  createProjectDocument,
  migrateProjectDocument,
  normalizeBackground,
  sceneFingerprint
} from '@/core/project-document'
import { createSceneObject, createSceneLight, inspectSceneQuality } from '@/core/scene'

const sampleScene = () => ({
  objects: [createSceneObject('box', [])],
  camera: JSON.parse(JSON.stringify(DEFAULT_CAMERA)),
  lighting: JSON.parse(JSON.stringify(DEFAULT_LIGHTING)),
  timeline: JSON.parse(JSON.stringify(DEFAULT_TIMELINE)),
  background: JSON.parse(JSON.stringify(DEFAULT_BACKGROUND))
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

/**
 * 全景图背景（schema 16）。
 *
 * 关键约束：
 * - 老工程（v15 及更早）没有 `background` 字段，迁移后必须是"没有背景"，不能报错；
 * - 只存**文件名引用**，不存图本身（几 MB 的图塞进 JSON 会让每次保存都重传）；
 * - 旋转归一到 [0,360)、亮度截到 0~4，避免三端判断分叉；
 * - 改了背景必须进指纹，否则"换了背景"不会被判成有未保存修改。
 */
describe('全景图背景', () => {
  it('默认没有背景', () => {
    expect(DEFAULT_BACKGROUND.panoramaFileName).toBe('')
    expect(DEFAULT_BACKGROUND.rotateDegrees).toBe(0)
    expect(DEFAULT_BACKGROUND.intensity).toBe(1)
    expect(DEFAULT_BACKGROUND.affectsLighting).toBe(false)
  })

  it('老工程缺字段时迁移成"没有背景"，不报错', () => {
    const migrated = migrateProjectDocument({
      name: '旧工程',
      schemaVersion: 15,
      scene: { objects: [], camera: DEFAULT_CAMERA, lighting: DEFAULT_LIGHTING, timeline: DEFAULT_TIMELINE }
    })
    expect(migrated.scene.background).toEqual(DEFAULT_BACKGROUND)
  })

  it('迁移时保留合法的背景配置', () => {
    const migrated = migrateProjectDocument({
      name: '带背景',
      scene: {
        objects: [],
        camera: DEFAULT_CAMERA,
        background: {
          panoramaFileName: 'pano-1.jpg',
          panoramaSourceName: '外景.jpg',
          rotateDegrees: 90,
          intensity: 1.5,
          affectsLighting: true
        }
      }
    })
    expect(migrated.scene.background).toEqual({
      panoramaFileName: 'pano-1.jpg',
      panoramaSourceName: '外景.jpg',
      rotateDegrees: 90,
      intensity: 1.5,
      affectsLighting: true
    })
  })

  it('旋转归一到 [0,360)，亮度截到 0~4', () => {
    expect(normalizeBackground({ rotateDegrees: -90 }).rotateDegrees).toBe(270)
    expect(normalizeBackground({ rotateDegrees: 450 }).rotateDegrees).toBe(90)
    expect(normalizeBackground({ rotateDegrees: 720 }).rotateDegrees).toBe(0)
    expect(normalizeBackground({ intensity: 9 }).intensity).toBe(4)
    expect(normalizeBackground({ intensity: -3 }).intensity).toBe(0)
  })

  it('非法值回落到默认，不产出 NaN', () => {
    const normalized = normalizeBackground({
      panoramaFileName: 42,
      rotateDegrees: 'abc',
      intensity: null,
      affectsLighting: 'yes'
    })
    expect(normalized.panoramaFileName).toBe('')
    expect(Number.isNaN(normalized.rotateDegrees)).toBe(false)
    expect(normalized.rotateDegrees).toBe(0)
    expect(normalized.intensity).toBe(1)
    expect(normalized.affectsLighting).toBe(false)
  })

  it('非对象输入也能走通', () => {
    expect(normalizeBackground(null)).toEqual(DEFAULT_BACKGROUND)
    expect(normalizeBackground('nope')).toEqual(DEFAULT_BACKGROUND)
  })

  it('换背景会让指纹变化（否则不会被判成有未保存修改）', () => {
    const scene = sampleScene()
    const before = sceneFingerprint(
      scene.objects,
      scene.camera,
      scene.lighting,
      scene.timeline,
      scene.background
    )
    const after = sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline, {
      ...DEFAULT_BACKGROUND,
      panoramaFileName: 'pano-1.jpg'
    })
    expect(before).not.toBe(after)
  })

  it('背景没变时指纹不变', () => {
    const scene = sampleScene()
    const a = sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline, scene.background)
    const b = sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline, {
      ...scene.background
    })
    expect(a).toBe(b)
  })

  it('createProjectDocument 会带上背景并做净化', () => {
    const scene = sampleScene()
    const document = createProjectDocument({
      name: '带背景',
      ...scene,
      background: { ...DEFAULT_BACKGROUND, panoramaFileName: 'p.jpg', rotateDegrees: -45 }
    })
    expect(document.scene.background.panoramaFileName).toBe('p.jpg')
    expect(document.scene.background.rotateDegrees).toBe(315)
  })
})

/**
 * 人台比例修正（schema 17）。
 *
 * 老工程存的人台 `size` 是 `{ x: 1, y: 身高, z: 1 }`，而视口按三个分量缩放
 * 根节点 → 人物被竖直拉伸（又细又长）。迁移时必须统一成三个分量都等于身高。
 */
describe('人台 size 迁移', () => {
  const mannequin = (size, mannequinData) => ({
    id: 'm1',
    kind: 'mannequin',
    name: '人台 01',
    position: { x: 0, y: 0.875, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size,
    color: '#e8e6e1',
    visible: true,
    locked: false,
    mannequin: mannequinData
  })

  const migrate = (object) =>
    migrateProjectDocument({
      name: '旧工程',
      schemaVersion: 16,
      scene: {
        objects: [object],
        camera: DEFAULT_CAMERA,
        lighting: DEFAULT_LIGHTING,
        timeline: DEFAULT_TIMELINE,
        background: DEFAULT_BACKGROUND
      }
    }).scene.objects[0]

  it('把老工程的 { x: 1, y: 身高, z: 1 } 统一为三个分量都等于身高', () => {
    const migrated = migrate(mannequin({ x: 1, y: 1.75, z: 1 }, { heightMeters: 1.75 }))
    expect(migrated.size).toEqual({ x: 1.75, y: 1.75, z: 1.75 })
  })

  it('以 mannequin.heightMeters 为准（size.y 与它不一致时）', () => {
    const migrated = migrate(mannequin({ x: 1, y: 1.6, z: 1 }, { heightMeters: 1.82 }))
    expect(migrated.size).toEqual({ x: 1.82, y: 1.82, z: 1.82 })
  })

  it('缺少 heightMeters 时退回 size.y', () => {
    const migrated = migrate(mannequin({ x: 1, y: 1.7, z: 1 }, null))
    expect(migrated.size).toEqual({ x: 1.7, y: 1.7, z: 1.7 })
  })

  it('不碰其它类型的 size（方块该是扁的就是扁的）', () => {
    const migrated = migrate({
      id: 'b1',
      kind: 'box',
      name: '方块',
      position: { x: 0, y: 1, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 1 },
      color: '#ffffff',
      visible: true,
      locked: false
    })
    expect(migrated.size).toEqual({ x: 2, y: 2, z: 1 })
  })
})

/**
 * 导入模型的文件引用（schema 18）。
 *
 * 关键约束：
 * - 工程里只存**文件引用**（主文件 + 依赖资源），不存 base64——
 *   否则每次保存都要重传几十 MB；
 * - `name`（模型内部引用的原始名）与 `fileName`（服务端去重后的存储名）
 *   必须都留着，缺一个就取不回依赖；
 * - 老工程（v17 及更早）没有 `files`，必须照常打开、不报错，
 *   只是模型恢复不出来（当初也没存文件）。
 */
describe('导入模型的文件引用', () => {
  const imported = (importedAsset) => ({
    id: 'i1',
    kind: 'imported',
    name: '椅子.gltf',
    position: { x: 0, y: 1, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    color: '#c9cdd0',
    visible: true,
    locked: false,
    importedAsset
  })

  const migrate = (object) =>
    migrateProjectDocument({
      name: '导入工程',
      schemaVersion: 18,
      scene: {
        objects: [object],
        camera: DEFAULT_CAMERA,
        lighting: DEFAULT_LIGHTING,
        timeline: DEFAULT_TIMELINE,
        background: DEFAULT_BACKGROUND
      }
    }).scene.objects[0]

  const report = { meshCount: 1, triangleCount: 12, materialCount: 1, textureCount: 0, cameraCount: 0, lightCount: 0, bounds: { x: 1, y: 1, z: 1 }, issues: [] }

  it('三端 schema 版本已经升到 19（姿势库）', () => {
    expect(PROJECT_SCHEMA_VERSION).toBe(19)
  })

  it('迁移后 importedAsset 与其文件引用都保留', () => {
    const migrated = migrate(
      imported({
        format: 'gltf',
        sourceName: '椅子.gltf',
        report,
        files: {
          main: { name: '椅子.gltf', fileName: '椅子.gltf' },
          resources: [
            { name: 'scene.bin', fileName: 'scene-1.bin' },
            { name: 'wood.png', fileName: 'wood.png' }
          ]
        }
      })
    )
    expect(migrated.importedAsset.format).toBe('gltf')
    expect(migrated.importedAsset.sourceName).toBe('椅子.gltf')
    expect(migrated.importedAsset.report.triangleCount).toBe(12)
    expect(migrated.importedAsset.files.main).toEqual({ name: '椅子.gltf', fileName: '椅子.gltf' })
    // `name` 与 `fileName` 可能不同（服务端去重），两个都必须原样留着。
    expect(migrated.importedAsset.files.resources).toEqual([
      { name: 'scene.bin', fileName: 'scene-1.bin' },
      { name: 'wood.png', fileName: 'wood.png' }
    ])
  })

  it('缺文件引用的老工程不炸：importedAsset 保留、files 缺席', () => {
    // v17 及更早的工程只有 format / sourceName / report。
    const migrated = migrateProjectDocument({
      name: 'v17 工程',
      schemaVersion: 17,
      scene: {
        objects: [
          imported({ format: 'obj', sourceName: '老模型.obj', report })
        ],
        camera: DEFAULT_CAMERA,
        lighting: DEFAULT_LIGHTING,
        timeline: DEFAULT_TIMELINE,
        background: DEFAULT_BACKGROUND
      }
    })
    expect(migrated.schemaVersion).toBe(19)
    expect(migrated.scene.objects).toHaveLength(1)
    const asset = migrated.scene.objects[0].importedAsset
    expect(asset.sourceName).toBe('老模型.obj')
    expect(asset.files).toBeUndefined()
  })

  it('主文件引用非法时只丢 files，不丢整个 importedAsset', () => {
    const migrated = migrate(
      imported({
        format: 'glb',
        sourceName: '坏引用.glb',
        report,
        files: { main: { name: '坏引用.glb', fileName: '   ' }, resources: [] }
      })
    )
    // 物体仍然知道"自己是个导入模型、原文件叫什么"，检查器不会退化成未知方块。
    expect(migrated.importedAsset.sourceName).toBe('坏引用.glb')
    expect(migrated.importedAsset.files).toBeUndefined()
  })

  it('过滤掉没有文件名的依赖条目，并给缺失的 name 兜底', () => {
    const migrated = migrate(
      imported({
        format: 'gltf',
        sourceName: 'm.gltf',
        report,
        files: {
          main: { fileName: 'm.gltf' },
          resources: [{ fileName: 'a.bin' }, { name: '丢了文件名.bin' }, null, 'x']
        }
      })
    )
    expect(migrated.importedAsset.files.main).toEqual({ name: 'm.gltf', fileName: 'm.gltf' })
    expect(migrated.importedAsset.files.resources).toEqual([{ name: 'a.bin', fileName: 'a.bin' }])
  })

  it('importedAsset 不是对象时整条去掉，而不是留个 undefined 字段', () => {
    const migrated = migrate(imported('这不是对象'))
    expect('importedAsset' in migrated).toBe(false)
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

/**
 * 姿势库（schema 19）。
 *
 * 关键取舍：库条目是**工程内容**——必须进指纹（否则存了姿势不算脏，
 * 用户关窗口就丢）、必须在迁移时补齐关节（应用时 presetId 置 null，
 * 全部关节都由这份 pose 驱动，缺一个就掉回中立角度）。
 */
describe('姿势库迁移与指纹', () => {
  const libraryScene = (poseLibrary) => ({
    name: '姿势库工程',
    schemaVersion: 18,
    scene: {
      objects: [],
      camera: DEFAULT_CAMERA,
      lighting: DEFAULT_LIGHTING,
      timeline: DEFAULT_TIMELINE,
      background: DEFAULT_BACKGROUND,
      poseLibrary
    }
  })

  it('v18 及更早的工程迁移出空姿势库（行为不变）', () => {
    const migrated = migrateProjectDocument({ name: 'v18', schemaVersion: 18, scene: {} })
    expect(migrated.schemaVersion).toBe(19)
    expect(migrated.scene.poseLibrary).toEqual([])
  })

  it('库条目补齐成完整关节表，数值夹回限位', () => {
    const migrated = migrateProjectDocument(
      libraryScene([
        {
          id: 'p1',
          name: '  抱臂  ',
          pose: { head: { x: 999, y: -8, z: '不是数字' }, '不存在的关节': { x: 1, y: 1, z: 1 } },
          createdAt: '2026-11-11T08:00:00Z'
        }
      ])
    )
    const entry = migrated.scene.poseLibrary[0]
    expect(entry.id).toBe('p1')
    expect(entry.name).toBe('抱臂')
    expect(entry.createdAt).toBe('2026-11-11T08:00:00Z')
    // head.x 限位 45，999 被夹住；z 非数字按 0
    expect(entry.pose.head).toEqual({ x: 45, y: -8, z: 0 })
    // 未知关节丢掉、缺失关节补 0，且正好是 10 个
    expect(Object.keys(entry.pose).sort()).toEqual(
      ['head', 'leftElbow', 'leftHip', 'leftKnee', 'leftShoulder', 'rightElbow', 'rightHip', 'rightKnee', 'rightShoulder', 'spine'].sort()
    )
    expect(entry.pose.leftKnee).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('坏条目（非对象 / 缺 id / 重复 id）被丢掉，不拖累整份工程', () => {
    const migrated = migrateProjectDocument(
      libraryScene([
        '不是对象',
        { name: '缺 id', pose: { head: { x: 1, y: 1, z: 1 } } },
        { id: 'dup', name: '第一条', pose: { head: { x: 1, y: 1, z: 1 } } },
        { id: 'dup', name: '重复', pose: { head: { x: 9, y: 9, z: 9 } } },
        { id: 'no-pose', name: '没有姿势' }
      ])
    )
    expect(migrated.scene.poseLibrary.map((entry) => entry.id)).toEqual(['dup'])
    expect(migrated.scene.poseLibrary[0].name).toBe('第一条')
  })

  it('空名原样留着（不编造默认名），由界面显示占位文案', () => {
    const migrated = migrateProjectDocument(
      libraryScene([{ id: 'p1', name: '   ', pose: { head: { x: 0, y: 0, z: 0 } } }])
    )
    expect(migrated.scene.poseLibrary[0].name).toBe('')
  })

  it('存盘文档带上姿势库', () => {
    const scene = sampleScene()
    const document = createProjectDocument({
      name: '带姿势库',
      ...scene,
      poseLibrary: [{ id: 'p1', name: '抱臂', pose: { head: { x: 1, y: 2, z: 3 } } }]
    })
    expect(document.scene.poseLibrary).toHaveLength(1)
    expect(document.scene.poseLibrary[0].pose.head).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('改姿势库会让指纹变化（否则不算"有未保存修改"）', () => {
    const scene = sampleScene()
    const before = sceneFingerprint(
      scene.objects,
      scene.camera,
      scene.lighting,
      scene.timeline,
      scene.background,
      []
    )
    const after = sceneFingerprint(
      scene.objects,
      scene.camera,
      scene.lighting,
      scene.timeline,
      scene.background,
      [{ id: 'p1', name: '抱臂', pose: { head: { x: 0, y: 0, z: 0 } }, createdAt: '' }]
    )
    expect(before).not.toBe(after)
    // 同样的库 → 同样的指纹
    expect(
      sceneFingerprint(scene.objects, scene.camera, scene.lighting, scene.timeline, scene.background, [
        { id: 'p1', name: '抱臂', pose: { head: { x: 0, y: 0, z: 0 } }, createdAt: '' }
      ])
    ).toBe(after)
  })
})
