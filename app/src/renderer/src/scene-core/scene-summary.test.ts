import { describe, expect, it } from 'vitest'
import { createInitialScene, createSceneObject } from './scene'
import { summarizeScene, summarizeSceneObject } from './scene-summary'

describe('scene-summary', () => {
  it('描述空场景时说明没有物体', () => {
    const summary = summarizeScene(createInitialScene())
    expect(summary).toContain('没有任何物体')
    expect(summary).toContain('相机')
  })

  it('描述基础物体时包含名称、id、位置与尺寸', () => {
    const scene = createInitialScene()
    const box = createSceneObject('box', [])
    scene.objects = [box]
    const summary = summarizeScene(scene)
    expect(summary).toContain('方块')
    expect(summary).toContain(`id=${box.id}`)
    expect(summary).toContain('位置')
    expect(summary).toContain('尺寸')
    expect(summary).toContain('物体共 1 个')
  })

  it('描述人台时带出动作与身高', () => {
    const scene = createInitialScene()
    const mannequin = createSceneObject('box', [])
    scene.objects = [
      {
        ...mannequin,
        kind: 'mannequin',
        name: '人台 01',
        mannequin: {
          heightMeters: 1.75,
          pose: {
            head: { x: 0, y: 0, z: 0 },
            spine: { x: 0, y: 0, z: 0 },
            leftShoulder: { x: 0, y: 0, z: 0 },
            rightShoulder: { x: 0, y: 0, z: 0 },
            leftElbow: { x: 0, y: 0, z: 0 },
            rightElbow: { x: 0, y: 0, z: 0 },
            leftHip: { x: 0, y: 0, z: 0 },
            rightHip: { x: 0, y: 0, z: 0 },
            leftKnee: { x: 0, y: 0, z: 0 },
            rightKnee: { x: 0, y: 0, z: 0 }
          },
          presetId: 'sit'
        }
      }
    ]
    const text = summarizeSceneObject(scene.objects[0])
    expect(text).toContain('人台')
    expect(text).toContain('坐下')
    expect(text).toContain('身高 1.75 米')
  })

  it('标注隐藏与锁定状态', () => {
    const object = { ...createSceneObject('box', []), visible: false, locked: true }
    const text = summarizeSceneObject(object)
    expect(text).toContain('已隐藏')
    expect(text).toContain('已锁定')
  })

  it('物体很多时截断并给出提示', () => {
    const scene = createInitialScene()
    scene.objects = Array.from({ length: 45 }, () => createSceneObject('sphere', []))
    const summary = summarizeScene(scene)
    expect(summary).toContain('其余 5 个物体未一一列出')
  })

  it('摘要包含光照信息，让 AI 知道光从哪来', () => {
    const scene = createInitialScene()
    const summary = summarizeScene(scene)
    expect(summary).toContain('光照')
    expect(summary).toContain('固定半球环境光')
  })

  it('有时间轴内容时补充说明', () => {
    const scene = createInitialScene()
    scene.timeline.durationSeconds = 8
    scene.timeline.cameraShots = [
      {
        id: 'shot-1',
        name: '镜头 01',
        timeSeconds: 0,
        transition: 'cut',
        camera: scene.camera
      }
    ]
    const summary = summarizeScene(scene)
    expect(summary).toContain('8 秒')
    expect(summary).toContain('镜头关键帧 1 个')
  })
})
