import { describe, expect, it } from 'vitest'

import { applyAiSceneCommands } from '@/core/apply-ai-scene-commands'
import { describeCommand, extractCommandsFromReply, isVerificationPass } from '@/core/ai-commands'

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

  it('非 JSON 回复返回空数组而不是抛错', () => {
    expect(extractCommandsFromReply('我不太确定你的意思。')).toEqual([])
  })

  it('复核通过只认 ok / 通过 / 合格', () => {
    expect(isVerificationPass('OK。')).toBe(true)
    expect(isVerificationPass('通过')).toBe(true)
    expect(isVerificationPass('看起来还行')).toBe(false)
  })

  it('命令摘要带出人类可读的名称', () => {
    expect(describeCommand({ type: 'add_object', kind: 'wall', name: '背景墙' })).toContain('背景墙')
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

  it('add_mannequin 带上预设姿势', () => {
    const result = applyAiSceneCommands(emptyScene(), [
      { type: 'add_mannequin', name: '主角', presetId: 'sit' }
    ])
    expect(result.scene.objects[0].mannequin.presetId).toBe('sit')
  })

  it('set_mannequin_pose 只作用于人台', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    const result = applyAiSceneCommands(scene, [{ type: 'set_mannequin_pose', id: 'obj-1', presetId: 'run' }])
    expect(result.applied).toBe(0)
    expect(result.skipped).toHaveLength(1)
  })

  it('set_camera 只覆盖给出的字段', () => {
    const result = applyAiSceneCommands(emptyScene(), [{ type: 'set_camera', target: { x: 0, y: 2, z: 0 } }])
    expect(result.scene.camera.target).toEqual({ x: 0, y: 2, z: 0 })
    expect(result.scene.camera.fovDegrees).toBe(42)
  })

  it('animate_move 生成关键帧并让时长覆盖整个动画', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    const result = applyAiSceneCommands(scene, [
      {
        type: 'animate_move',
        name: '方块 01',
        path: [
          { x: 0, y: 0, z: 0 },
          { x: 4, y: 0, z: 0 }
        ],
        durationSeconds: 6,
        cameraFollow: { mode: 'orbit' }
      }
    ])
    expect(result.scene.timeline.objectKeyframes.length).toBeGreaterThanOrEqual(2)
    expect(result.scene.timeline.durationSeconds).toBeGreaterThanOrEqual(6)
  })

  it('原场景对象不被就地修改', () => {
    const scene = { ...emptyScene(), objects: [boxObject()] }
    applyAiSceneCommands(scene, [{ type: 'update_object', id: 'obj-1', position: { x: 9 } }])
    expect(scene.objects[0].position.x).toBe(0)
  })
})
