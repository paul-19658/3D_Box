import { describe, expect, it } from 'vitest'
import {
  extractAiSceneCommands,
  isAiVerificationAccepted,
  parseAiSceneCommands,
  resolveAiSceneCommandsFromReply,
  stripAiSceneCommandBlock
} from './ai-scene-commands'

const sittingCircleJson = `[
  {"type":"clear_scene"},
  {"type":"add_object","kind":"box","name":"圆桌","size":{"x":2.2,"y":0.08,"z":2.2},"position":{"x":0,"y":0.04,"z":0},"color":"#d8d4cc"},
  {"type":"add_mannequin","name":"人台 01","presetId":"sit","position":{"x":0,"z":1.5},"rotation":{"y":180}},
  {"type":"add_mannequin","name":"人台 02","presetId":"sit","position":{"x":1.43,"z":0.46},"rotation":{"y":252}},
  {"type":"add_mannequin","name":"人台 03","presetId":"sit","position":{"x":0.88,"z":-1.21},"rotation":{"y":324}},
  {"type":"add_mannequin","name":"人台 04","presetId":"sit","position":{"x":-0.88,"z":-1.21},"rotation":{"y":36}},
  {"type":"add_mannequin","name":"人台 05","presetId":"sit","position":{"x":-1.43,"z":0.46},"rotation":{"y":108}},
  {"type":"set_camera","position":{"x":4.5,"y":3.2,"z":5.5},"target":{"x":0,"y":1,"z":0},"fovDegrees":42}
]`

describe('ai-scene-commands', () => {
  it('从 json 代码块提取命令', () => {
    const content = `搭一个围坐讨论场景。\n\`\`\`json\n${sittingCircleJson}\n\`\`\``
    const raw = extractAiSceneCommands(content)
    const commands = parseAiSceneCommands(raw)
    expect(commands).toHaveLength(8)
    expect(commands[0]).toEqual({ type: 'clear_scene' })
    expect(commands[1]).toMatchObject({ type: 'add_object', kind: 'box', name: '圆桌' })
    expect(commands.filter((command) => command.type === 'add_mannequin')).toHaveLength(5)
    expect(commands.at(-1)).toMatchObject({ type: 'set_camera', fovDegrees: 42 })
  })

  it('去掉代码块后留下说明文字', () => {
    const content = `先清空再搭五个人。\n\`\`\`json\n[{"type":"clear_scene"}]\n\`\`\``
    expect(stripAiSceneCommandBlock(content)).toBe('先清空再搭五个人。')
  })

  it('跳过非法项并支持 commands 包装对象', () => {
    const commands = parseAiSceneCommands({
      commands: [
        { type: 'clear_scene' },
        { type: 'add_object', kind: 'spaceship' },
        { type: 'add_object', kind: 'box', color: 'red', size: { x: -2, y: 1 } },
        { type: 'update_object' },
        { type: 'set_mannequin_pose', name: '人台 01', presetId: 'sit' }
      ]
    })
    expect(commands).toHaveLength(3)
    expect(commands[1]).toMatchObject({
      type: 'add_object',
      kind: 'box',
      size: { x: 2, y: 1 }
    })
    expect(commands[1]).not.toHaveProperty('color', 'red')
    expect(commands[2]).toMatchObject({ type: 'set_mannequin_pose', presetId: 'sit' })
  })

  it('resolve 能同时给出 prose 与命令', () => {
    const resolved = resolveAiSceneCommandsFromReply(
      `生成五人围坐场景。\n\`\`\`json\n${sittingCircleJson}\n\`\`\``
    )
    expect(resolved.rawFound).toBe(true)
    expect(resolved.prose).toContain('围坐')
    expect(resolved.commands).toHaveLength(8)
  })

  it('没有 JSON 时 rawFound 为 false', () => {
    const resolved = resolveAiSceneCommandsFromReply('建议你先放一张桌子，再加人台。')
    expect(resolved.rawFound).toBe(false)
    expect(resolved.commands).toHaveLength(0)
  })

  it('识别复核通过的 ok 回复', () => {
    expect(isAiVerificationAccepted('ok')).toBe(true)
    expect(isAiVerificationAccepted('OK。')).toBe(true)
    expect(isAiVerificationAccepted('通过')).toBe(true)
    expect(isAiVerificationAccepted('没问题')).toBe(true)
    expect(isAiVerificationAccepted('构图偏了，请把相机拉远')).toBe(false)
  })

  it('解析 animate_move 跟拍命令', () => {
    const commands = parseAiSceneCommands([
      {
        type: 'animate_move',
        name: '跑者',
        path: [
          { x: -4, z: 0 },
          { x: 8, z: 0 }
        ],
        durationSeconds: 5,
        cameraFollow: true
      }
    ])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      type: 'animate_move',
      name: '跑者',
      durationSeconds: 5,
      faceAlongPath: true,
      cameraFollow: true
    })
  })

  it('解析 orbit 环绕跟拍参数', () => {
    const commands = parseAiSceneCommands([
      {
        type: 'animate_move',
        name: '主角',
        path: [
          { x: 0, z: 0 },
          { x: 6, z: 0 }
        ],
        cameraFollow: {
          mode: 'orbit',
          orbitDegrees: 360,
          radius: 5,
          orbitDirection: 'cw'
        }
      }
    ])
    expect(commands[0]).toMatchObject({
      type: 'animate_move',
      cameraFollow: {
        mode: 'orbit',
        orbitDegrees: 360,
        radius: 5,
        orbitDirection: 'cw'
      }
    })
  })

  it('修复 fovDegrees: fifty 等非法 JSON 并仍能解析命令', () => {
    const broken = `将搭建摆荡场景。
\`\`\`json
[
  {"type":"clear_scene"},
  {"type":"add_mannequin","name":"蜘蛛侠","presetId":"raise-hand","position":{"x":0,"y":5,"z":-10}},
  {"type":"animate_move","name":"蜘蛛侠","path":[{"x":0,"z":-10},{"x":3.5,"z":10}],"durationSeconds":8,"cameraFollow":true},
  {"type":"set_camera","position":{"x":-10,"y":6,"z":-5},"target":{"x":0,"y":5,"z":0},"fovDegrees": fifty}
]
\`\`\``
    const resolved = resolveAiSceneCommandsFromReply(broken)
    expect(resolved.rawFound).toBe(true)
    expect(resolved.commands.length).toBeGreaterThanOrEqual(3)
    expect(resolved.commands.some((command) => command.type === 'clear_scene')).toBe(true)
    expect(resolved.commands.some((command) => command.type === 'animate_move')).toBe(true)
    const camera = resolved.commands.find((command) => command.type === 'set_camera')
    expect(camera).toMatchObject({ type: 'set_camera', fovDegrees: 50 })
  })

  it('单条坏对象时仍可捞出其余命令', () => {
    const mixed = `[
      {"type":"clear_scene"},
      {"type":"add_object","kind":"box","name":"楼","broken":
      {"type":"add_mannequin","name":"蜘蛛侠","presetId":"raise-hand"}
    ]`
    const raw = extractAiSceneCommands(mixed)
    const commands = parseAiSceneCommands(raw)
    expect(commands.some((command) => command.type === 'clear_scene')).toBe(true)
    expect(commands.some((command) => command.type === 'add_mannequin')).toBe(true)
  })
})
