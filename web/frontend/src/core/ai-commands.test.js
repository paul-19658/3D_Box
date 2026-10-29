import { describe, expect, it } from 'vitest'

import { applyAiSceneCommands } from '@/core/apply-ai-scene-commands'
import { describeCommand, extractCommandsFromReply, isVerificationPass } from '@/core/ai-commands'
import { AI_DEFAULT_SYSTEM_PROMPT, AI_SCENE_COMMAND_SCHEMA_HINT } from '@/core/ai-defaults'

const emptyScene = () => ({
  objects: [],
  camera: {
    position: { x: 7.5, y: 5.5, z: 8.5 },
    target: { x: 0, y: 1, z: 0 },
    fovDegrees: 42,
    aspectWidth: 16,
    aspectHeight: 9
  },
  lighting: { lights: [] },
  timeline: { durationSeconds: 5, cameraShots: [], objectKeyframes: [] }
})

const boxObject = () => ({
  id: 'obj-1',
  kind: 'box',
  name: '方块 01',
  position: { x: 0, y: 1, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  size: { x: 2, y: 2, z: 2 },
  color: '#c9cdd0',
  visible: true,
  locked: false
})

describe('AI 回复解析', () => {
  it('从代码块里取命令数组', () => {
    const reply = '好的，我来搭建：\n```json\n[{"type":"clear_scene"}]\n```'
    expect(extractCommandsFromReply(reply)).toEqual([{ type: 'clear_scene' }])
  })

  it('优先使用靠后的 JSON 块，因为模型常先解释再给命令', () => {
    const reply = [
      '```json',
      '[{"type":"clear_scene"}]',
      '```',
      '修正后：',
      '```json',
      '[{"type":"add_object","kind":"box"}]',
      '```'
    ].join('\n')
    expect(extractCommandsFromReply(reply)[0].type).toBe('add_object')
  })

  it('丢弃非法 kind 的命令，而不是硬塞进场景', () => {
    const reply = '[{"type":"add_object","kind":"dragon"}]'
    expect(extractCommandsFromReply(reply)).toEqual([])
  })

  it('丢弃缺少 id 与 name 的 update_object', () => {
    const reply = '[{"type":"update_object","position":{"x":1}}]'
    expect(extractCommandsFromReply(reply)).toEqual([])
  })

  it('把越界数值夹紧到允许范围', () => {
    const reply = '[{"type":"set_camera","fovDegrees":9999}]'
    expect(extractCommandsFromReply(reply)[0].fovDegrees).toBe(120)
  })

  it('animate_move 少于两个路径点时被丢弃', () => {
    const reply = '[{"type":"animate_move","name":"人台","path":[{"x":0,"z":0}]}]'
    expect(extractCommandsFromReply(reply)).toEqual([])
  })

  it('解析 animate_camera 路径与别名 dolly', () => {
    const reply = JSON.stringify([
      {
        type: 'dolly',
        path: [
          { position: { x: 2, y: 1.9, z: 23 }, target: { x: 1, y: 4, z: 0 }, fovDegrees: 48 },
          { position: { x: 1.9, y: 2.2, z: 18 }, target: { x: 1, y: 4, z: 0 } }
        ],
        durationSeconds: 5
      }
    ])
    const commands = extractCommandsFromReply(reply)
    expect(commands).toHaveLength(1)
    expect(commands[0].type).toBe('animate_camera')
    expect(commands[0].durationSeconds).toBe(5)
    expect(commands[0].path).toHaveLength(2)
    expect(commands[0].path[0].position).toEqual({ x: 2, y: 1.9, z: 23 })
    expect(commands[0].path[0].fovDegrees).toBe(48)
    expect(commands[0].path[1].fovDegrees).toBeUndefined()
  })

  it('animate_camera 少于两个有效路径点时被丢弃', () => {
    const reply = JSON.stringify([
      {
        type: 'animate_camera',
        path: [{ position: { x: 0, y: 1, z: 10 } }],
        durationSeconds: 3
      }
    ])
    expect(extractCommandsFromReply(reply)).toEqual([])
  })

  it('解析 faceAlongPath 与 cameraFollow 布尔/对象形态', () => {
    const reply = JSON.stringify([
      {
        type: 'animate_move',
        name: '跑者',
        path: [
          { x: 0, z: 0 },
          { x: 4, z: 0 }
        ],
        faceAlongPath: false,
        cameraFollow: true
      }
    ])
    const command = extractCommandsFromReply(reply)[0]
    expect(command.faceAlongPath).toBe(false)
    expect(command.cameraFollow).toEqual({ mode: 'side' })
  })

  it('parseCameraFollow 支持 orbit 方向与角度', () => {
    const reply = JSON.stringify([
      {
        type: 'animate_move',
        name: '跑者',
        path: [
          { x: 0, z: 0 },
          { x: 4, z: 0 }
        ],
        cameraFollow: { mode: 'orbit', orbitDegrees: 720, orbitDirection: 'cw', radius: 6 }
      }
    ])
    const follow = extractCommandsFromReply(reply)[0].cameraFollow
    expect(follow.mode).toBe('orbit')
    expect(follow.orbitDegrees).toBe(720)
    expect(follow.orbitDirection).toBe('cw')
    expect(follow.radius).toBe(6)
  })

  it('非 JSON 回复返回空数组而不是抛错', () => {
    expect(extractCommandsFromReply('我不太确定你的意思。')).toEqual([])
  })

  it('复核通过接受 ok / okay / 通过 / 没问题 等', () => {
    expect(isVerificationPass('OK。')).toBe(true)
    expect(isVerificationPass('okay')).toBe(true)
    expect(isVerificationPass('通过')).toBe(true)
    expect(isVerificationPass('没问题')).toBe(true)
    expect(isVerificationPass('合格')).toBe(true)
    expect(isVerificationPass('看起来还行')).toBe(false)
  })

  it('命令摘要带出人类可读的名称', () => {
    expect(describeCommand({ type: 'add_object', kind: 'wall', name: '背景墙' })).toContain('背景墙')
  })

  it('默认系统提示为 agent 版并内嵌命令 schema', () => {
    expect(AI_DEFAULT_SYSTEM_PROMPT).toContain('list_assets')
    expect(AI_DEFAULT_SYSTEM_PROMPT).toContain('apply_scene_commands')
    expect(AI_DEFAULT_SYSTEM_PROMPT).toContain('animate_move')
    expect(AI_DEFAULT_SYSTEM_PROMPT).toContain('animate_camera')
    expect(AI_DEFAULT_SYSTEM_PROMPT).toContain(AI_SCENE_COMMAND_SCHEMA_HINT.slice(0, 40))
    expect(AI_SCENE_COMMAND_SCHEMA_HINT).toContain('clear_scene')
    expect(AI_SCENE_COMMAND_SCHEMA_HINT).toContain('cameraFollow')
    expect(AI_SCENE_COMMAND_SCHEMA_HINT).toContain('remove_object')
    expect(AI_SCENE_COMMAND_SCHEMA_HINT).toContain('animate_camera')
  })

  it('animate_camera 命令摘要可读', () => {
    expect(describeCommand({ type: 'animate_camera', durationSeconds: 5 })).toContain('镜头路径动画')
    expect(describeCommand({ type: 'animate_camera', durationSeconds: 5 })).toContain('5')
  })
})

describe('命令应用', () => {
  it('clear_scene 清空物体与关键帧', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    scene.timeline.objectKeyframes = [
      { id: 'k', objectId: 'obj-1', timeSeconds: 0, interpolation: 'smooth', transform: {} }
    ]
    const result = applyAiSceneCommands(scene, [{ type: 'clear_scene' }])
    expect(result.scene.objects).toEqual([])
    expect(result.scene.timeline.objectKeyframes).toEqual([])
    expect(result.applied).toBe(1)
  })

  it('add_object 按名称建物体并贴地', () => {
    const result = applyAiSceneCommands(emptyScene(), [
      { type: 'add_object', kind: 'wall', name: '背景墙', size: { x: 6, y: 3, z: 0.2 } }
    ])
    expect(result.scene.objects).toHaveLength(1)
    expect(result.scene.objects[0].name).toBe('背景墙')
    expect(result.scene.objects[0].position.y).toBeCloseTo(1.5, 6)
  })

  it('update_object 能用 id 定位并只改给出的字段', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    const result = applyAiSceneCommands(scene, [{ type: 'update_object', id: 'obj-1', position: { x: 9 } }])
    const updated = result.scene.objects[0]
    expect(updated.position).toEqual({ x: 9, y: 1, z: 0 })
    expect(updated.size).toEqual({ x: 2, y: 2, z: 2 })
  })

  it('找不到目标时跳过并记录原因，不静默失败', () => {
    const result = applyAiSceneCommands(emptyScene(), [
      { type: 'update_object', name: '不存在的物体', position: { x: 1 } }
    ])
    expect(result.applied).toBe(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('不存在的物体')
  })

  it('remove_object 按名称删除并清掉其关键帧', () => {
    const scene = {
      ...emptyScene(),
      objects: [
        boxObject(),
        { ...boxObject(), id: 'obj-2', name: '跳舞女孩_补齐' }
      ]
    }
    scene.timeline.objectKeyframes = [
      { id: 'k1', objectId: 'obj-1', timeSeconds: 0, interpolation: 'smooth', transform: {} },
      { id: 'k2', objectId: 'obj-2', timeSeconds: 0, interpolation: 'smooth', transform: {} }
    ]
    const result = applyAiSceneCommands(scene, [
      { type: 'remove_object', name: '跳舞女孩_补齐' }
    ])
    expect(result.applied).toBe(1)
    expect(result.scene.objects).toHaveLength(1)
    expect(result.scene.objects[0].name).toBe('方块 01')
    expect(result.scene.timeline.objectKeyframes.every((k) => k.objectId !== 'obj-2')).toBe(true)
  })

  it('解析 remove_object 命令', () => {
    const reply = '[{"type":"remove_object","name":"跳舞女孩_补齐"}]'
    expect(extractCommandsFromReply(reply)).toEqual([
      { type: 'remove_object', id: undefined, name: '跳舞女孩_补齐' }
    ])
  })

  it('add_mannequin 带上预设姿势', () => {
    const result = applyAiSceneCommands(emptyScene(), [
      { type: 'add_mannequin', name: '主角', presetId: 'sit' }
    ])
    expect(result.scene.objects[0].mannequin.presetId).toBe('sit')
  })

  it('set_mannequin_pose 只作用于人台；唯一人台时 id 写错也可兜底', () => {
    const scene = {
      ...emptyScene(),
      objects: [
        {
          ...boxObject(),
          id: 'man-1',
          kind: 'mannequin',
          name: '主角',
          mannequin: { presetId: 'stand', pose: {}, heightMeters: 1.75, manualJoints: [] }
        }
      ]
    }
    const wrongId = applyAiSceneCommands(scene, [
      { type: 'set_mannequin_pose', id: 'wrong-id', presetId: 'run' }
    ])
    expect(wrongId.applied).toBe(1)
    expect(wrongId.scene.objects[0].mannequin.presetId).toBe('run')

    const boxOnly = applyAiSceneCommands(
      { ...emptyScene(), objects: [boxObject()] },
      [{ type: 'set_mannequin_pose', id: 'obj-1', presetId: 'run' }]
    )
    expect(boxOnly.applied).toBe(0)
    expect(boxOnly.skipped).toHaveLength(1)
  })

  it('set_camera 只覆盖给出的字段', () => {
    const result = applyAiSceneCommands(emptyScene(), [{ type: 'set_camera', target: { x: 0, y: 2, z: 0 } }])
    expect(result.scene.camera.target).toEqual({ x: 0, y: 2, z: 0 })
    expect(result.scene.camera.fovDegrees).toBe(42)
  })

  it('无 set_camera 且无动画时自动取景', () => {
    const result = applyAiSceneCommands(emptyScene(), [
      { type: 'add_object', kind: 'box', name: '箱子', position: { x: 3, z: 3 } }
    ])
    expect(result.scene.camera.position.x).not.toBe(7.5)
    expect(result.scene.camera.fovDegrees).toBe(42)
  })

  it('animate_move 生成关键帧、移到路径起点，并加粗跟拍采样', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    const result = applyAiSceneCommands(scene, [
      {
        type: 'animate_move',
        name: '方块 01',
        path: [
          { x: 2, y: 1, z: 0 },
          { x: 6, y: 1, z: 0 }
        ],
        durationSeconds: 6,
        faceAlongPath: true,
        cameraFollow: { mode: 'orbit', orbitDegrees: 360 }
      }
    ])
    expect(result.scene.objects[0].position).toEqual({ x: 2, y: 1, z: 0 })
    expect(result.scene.timeline.objectKeyframes.length).toBeGreaterThanOrEqual(2)
    expect(result.scene.timeline.cameraShots.length).toBeGreaterThanOrEqual(9)
    expect(result.scene.timeline.durationSeconds).toBeGreaterThanOrEqual(6)
    expect(result.hasTimelineAnimation).toBe(true)
  })

  it('faceAlongPath:false 保持原朝向', () => {
    const scene = {
      ...emptyScene(),
      objects: [{ ...boxObject(), rotation: { x: 0, y: 45, z: 0 } }]
    }
    const result = applyAiSceneCommands(scene, [
      {
        type: 'animate_move',
        name: '方块 01',
        path: [
          { x: 0, y: 1, z: 0 },
          { x: 4, y: 1, z: 0 }
        ],
        faceAlongPath: false
      }
    ])
    expect(result.scene.objects[0].rotation.y).toBe(45)
    for (const keyframe of result.scene.timeline.objectKeyframes) {
      expect(keyframe.transform.rotation.y).toBe(45)
    }
  })

  it('side 跟拍至少生成 3 个镜头采样', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    const result = applyAiSceneCommands(scene, [
      {
        type: 'animate_move',
        name: '方块 01',
        path: [
          { x: 0, z: 0 },
          { x: 4, z: 0 }
        ],
        durationSeconds: 4,
        cameraFollow: { mode: 'side' }
      }
    ])
    expect(result.scene.timeline.cameraShots.length).toBeGreaterThanOrEqual(3)
  })

  it('animate_camera 生成镜头关键帧并把当前相机设为起点', () => {
    const scene = emptyScene()
    const result = applyAiSceneCommands(scene, [
      {
        type: 'animate_camera',
        path: [
          { position: { x: 2, y: 1.9, z: 23 }, target: { x: 1.1, y: 4.45, z: 0 }, fovDegrees: 48 },
          { position: { x: 1.9, y: 2.2, z: 18 }, target: { x: 1.1, y: 4.45, z: 0 } }
        ],
        durationSeconds: 5
      }
    ])
    expect(result.applied).toBe(1)
    expect(result.hasTimelineAnimation).toBe(true)
    expect(result.scene.timeline.durationSeconds).toBeGreaterThanOrEqual(5)
    expect(result.scene.timeline.cameraShots.length).toBeGreaterThanOrEqual(2)
    expect(result.scene.camera.position.z).toBeCloseTo(23, 5)
    expect(result.scene.camera.fovDegrees).toBeCloseTo(48, 5)
    const lastShot = result.scene.timeline.cameraShots[result.scene.timeline.cameraShots.length - 1]
    expect(lastShot.camera.position.z).toBeCloseTo(18, 5)
  })

  it('多条带跟拍的 animate_move：后者覆盖相机镜头', () => {
    const scene = {
      ...emptyScene(),
      objects: [
        boxObject(),
        { ...boxObject(), id: 'obj-2', name: '方块 02', position: { x: 1, y: 1, z: 1 } }
      ]
    }
    const result = applyAiSceneCommands(scene, [
      {
        type: 'animate_move',
        name: '方块 01',
        path: [
          { x: 0, z: 0 },
          { x: 2, z: 0 }
        ],
        cameraFollow: { mode: 'side' }
      },
      {
        type: 'animate_move',
        name: '方块 02',
        path: [
          { x: 1, z: 1 },
          { x: 3, z: 1 }
        ],
        cameraFollow: { mode: 'chase' }
      }
    ])
    expect(result.scene.timeline.objectKeyframes.some((k) => k.objectId === 'obj-1')).toBe(true)
    expect(result.scene.timeline.objectKeyframes.some((k) => k.objectId === 'obj-2')).toBe(true)
    expect(result.scene.timeline.cameraShots.length).toBeGreaterThanOrEqual(3)
  })

  it('clear_scene 后再 add 按顺序生效', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    const result = applyAiSceneCommands(scene, [
      { type: 'clear_scene' },
      { type: 'add_object', kind: 'sphere', name: '球' }
    ])
    expect(result.scene.objects).toHaveLength(1)
    expect(result.scene.objects[0].name).toBe('球')
    expect(result.applied).toBe(2)
  })

  it('名称包含匹配可能命中部分名；精确优先', () => {
    const scene = {
      ...emptyScene(),
      objects: [
        { ...boxObject(), id: 'a', name: '红箱子' },
        { ...boxObject(), id: 'b', name: '蓝箱子大' }
      ]
    }
    const exact = applyAiSceneCommands(scene, [
      { type: 'update_object', name: '红箱子', position: { x: 5 } }
    ])
    expect(exact.scene.objects.find((o) => o.id === 'a').position.x).toBe(5)
  })

  it('原场景对象不被就地修改', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    applyAiSceneCommands(scene, [{ type: 'update_object', id: 'obj-1', position: { x: 9 } }])
    expect(scene.objects[0].position.x).toBe(0)
  })
})
