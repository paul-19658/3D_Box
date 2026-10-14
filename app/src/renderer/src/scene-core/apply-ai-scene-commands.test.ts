import { describe, expect, it } from 'vitest'
import { parseAiSceneCommands } from '../../../shared/ai-scene-commands'
import { applyAiSceneCommands } from './apply-ai-scene-commands'
import { createInitialScene, createSceneObject } from './scene'

const sittingCommands = parseAiSceneCommands([
  { type: 'clear_scene' },
  {
    type: 'add_object',
    kind: 'box',
    name: '圆桌',
    size: { x: 2.2, y: 0.08, z: 2.2 },
    position: { x: 0, y: 0.04, z: 0 },
    color: '#d8d4cc'
  },
  {
    type: 'add_mannequin',
    name: '人台 01',
    presetId: 'sit',
    position: { x: 0, z: 1.5 },
    rotation: { y: 180 }
  },
  {
    type: 'add_mannequin',
    name: '人台 02',
    presetId: 'sit',
    position: { x: 1.43, z: 0.46 },
    rotation: { y: 252 }
  },
  {
    type: 'add_mannequin',
    name: '人台 03',
    presetId: 'sit',
    position: { x: 0.88, z: -1.21 },
    rotation: { y: 324 }
  },
  {
    type: 'add_mannequin',
    name: '人台 04',
    presetId: 'sit',
    position: { x: -0.88, z: -1.21 },
    rotation: { y: 36 }
  },
  {
    type: 'add_mannequin',
    name: '人台 05',
    presetId: 'sit',
    position: { x: -1.43, z: 0.46 },
    rotation: { y: 108 }
  },
  {
    type: 'set_camera',
    position: { x: 4.5, y: 3.2, z: 5.5 },
    target: { x: 0, y: 1, z: 0 },
    fovDegrees: 42
  }
])

describe('apply-ai-scene-commands', () => {
  it('清空旧物体并搭建五人围坐场景', () => {
    const scene = createInitialScene()
    scene.objects = [createSceneObject('sphere', [])]
    const result = applyAiSceneCommands(scene, sittingCommands)

    expect(result.appliedCount).toBe(8)
    expect(result.warnings).toHaveLength(0)
    expect(result.scene.objects).toHaveLength(6)
    expect(result.scene.objects[0]).toMatchObject({
      kind: 'box',
      name: '圆桌',
      color: '#d8d4cc',
      size: { x: 2.2, y: 0.08, z: 2.2 },
      position: { x: 0, y: 0.04, z: 0 }
    })

    const mannequins = result.scene.objects.filter((object) => object.kind === 'mannequin')
    expect(mannequins).toHaveLength(5)
    for (const mannequin of mannequins) {
      expect(mannequin.mannequin?.presetId).toBe('sit')
      expect(mannequin.mannequin?.pose.leftHip.x).toBeLessThan(-50)
    }
    expect(mannequins[0].position).toMatchObject({ x: 0, z: 1.5 })
    expect(mannequins[0].rotation.y).toBe(180)
    expect(result.scene.camera.position).toEqual({ x: 4.5, y: 3.2, z: 5.5 })
    expect(result.framedCamera).toBe(false)
    expect(result.selectedIds).toHaveLength(6)
  })

  it('未指定相机时自动框选', () => {
    const result = applyAiSceneCommands(createInitialScene(), [
      { type: 'add_object', kind: 'box', position: { x: 2, z: -1 } }
    ])
    expect(result.appliedCount).toBe(1)
    expect(result.framedCamera).toBe(true)
    expect(result.scene.objects[0].position.y).toBeCloseTo(result.scene.objects[0].size.y / 2)
  })

  it('按名称更新物体并设置人台姿势', () => {
    const scene = createInitialScene()
    const box = { ...createSceneObject('box', []), name: '桌子' }
    scene.objects = [box]
    const withMannequin = applyAiSceneCommands(scene, [
      { type: 'add_mannequin', name: '主持人', presetId: 'stand' }
    ])
    const result = applyAiSceneCommands(withMannequin.scene, [
      { type: 'update_object', name: '桌子', position: { x: 1, y: 1.1, z: 0 }, color: '#aabbcc' },
      { type: 'set_mannequin_pose', name: '主持人', presetId: 'raise-hand' }
    ])
    expect(result.appliedCount).toBe(2)
    expect(result.scene.objects[0]).toMatchObject({
      name: '桌子',
      color: '#aabbcc',
      position: { x: 1, y: 1.1, z: 0 }
    })
    expect(result.scene.objects[1].mannequin?.presetId).toBe('raise-hand')
  })

  it('找不到目标时给出警告且不中断后续命令', () => {
    const result = applyAiSceneCommands(createInitialScene(), [
      { type: 'update_object', name: '不存在', position: { x: 1 } },
      { type: 'add_object', kind: 'cylinder', name: '柱子' }
    ])
    expect(result.appliedCount).toBe(1)
    expect(result.warnings[0]).toContain('不存在')
    expect(result.scene.objects[0].name).toBe('柱子')
  })

  it('人台 id 写错但场景仅一人台时仍能设置姿势', () => {
    const built = applyAiSceneCommands(createInitialScene(), [
      { type: 'add_mannequin', name: '跑者', presetId: 'stand' }
    ])
    const result = applyAiSceneCommands(built.scene, [
      {
        type: 'set_mannequin_pose',
        id: 'stale-id-from-wrong-closure',
        presetId: 'run'
      }
    ])
    expect(result.appliedCount).toBe(1)
    expect(result.warnings).toHaveLength(0)
    expect(result.scene.objects[0].mannequin?.presetId).toBe('run')
  })

  it('animate_move 写入位移关键帧与侧面跟拍镜头', () => {
    const built = applyAiSceneCommands(createInitialScene(), [
      { type: 'add_mannequin', name: '跑者', presetId: 'run', position: { x: -4, z: 0 } }
    ])
    const result = applyAiSceneCommands(built.scene, [
      {
        type: 'animate_move',
        name: '跑者',
        path: [
          { x: -4, z: 0 },
          { x: 0, z: 0 },
          { x: 8, z: 0 }
        ],
        durationSeconds: 4,
        faceAlongPath: true,
        cameraFollow: true
      }
    ])
    expect(result.appliedCount).toBe(1)
    expect(result.hasTimelineAnimation).toBe(true)
    expect(result.warnings).toHaveLength(0)
    expect(result.scene.timeline.durationSeconds).toBeGreaterThanOrEqual(4)
    expect(result.scene.timeline.objectKeyframes).toHaveLength(3)
    const xs = result.scene.timeline.objectKeyframes.map((keyframe) => keyframe.transform.position.x)
    expect(xs).toEqual([-4, 0, 8])
    expect(result.scene.timeline.cameraShots.length).toBeGreaterThanOrEqual(3)
    expect(result.scene.timeline.cameraShots[0].camera.target.x).toBe(-4)
    expect(result.scene.objects[0].position.x).toBe(-4)
  })

  it('orbit 模式生成 360 环绕跟随镜头', () => {
    const built = applyAiSceneCommands(createInitialScene(), [
      { type: 'add_mannequin', name: '主角', presetId: 'walk', position: { x: 0, z: 0 } }
    ])
    const result = applyAiSceneCommands(built.scene, [
      {
        type: 'animate_move',
        name: '主角',
        path: [
          { x: 0, z: 0 },
          { x: 6, z: 0 }
        ],
        durationSeconds: 6,
        cameraFollow: {
          mode: 'orbit',
          orbitDegrees: 360,
          radius: 5,
          height: 2.4,
          lookAtHeight: 1.2
        }
      }
    ])
    expect(result.hasTimelineAnimation).toBe(true)
    expect(result.scene.timeline.cameraShots.length).toBeGreaterThanOrEqual(9)
    const first = result.scene.timeline.cameraShots[0].camera.position
    const mid = result.scene.timeline.cameraShots[Math.floor(result.scene.timeline.cameraShots.length / 2)]
      .camera.position
    // 环绕过程中机位水平方位应明显变化
    expect(Math.hypot(first.x - mid.x, first.z - mid.z)).toBeGreaterThan(3)
    for (const shot of result.scene.timeline.cameraShots) {
      expect(shot.camera.target.y).toBe(1.2)
    }
  })
})
