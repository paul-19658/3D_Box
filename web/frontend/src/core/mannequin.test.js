import { describe, expect, it } from 'vitest'

import {
  MANNEQUIN_JOINTS,
  MANNEQUIN_PRESETS,
  applyMannequinPose,
  cloneMannequinPose,
  constrainMannequinJoint,
  createMannequinData,
  createNeutralMannequinPose
} from './mannequin'
import { MANNEQUIN_ASSET_URL, OFFICIAL_POSE_SOURCES, mannequinVisualState } from './mannequin-visual'

/**
 * 人台：预设元数据与外观状态的契约测试。
 *
 * 这类断言的价值在于"改名/改字段时立刻发现"：
 * 预设 id 与动作片段的对应关系一旦错位，人台会摆出莫名其妙的姿势，
 * 但画面上依然"有个人"，很难一眼看出是映射错了。
 */
describe('人台预设与动作资源', () => {
  it('每个预设都标注了动作片段与采样时刻', () => {
    for (const preset of MANNEQUIN_PRESETS) {
      expect(typeof preset.sourceClip).toBe('string')
      expect(preset.sourceClip.length).toBeGreaterThan(0)
      expect(Number.isFinite(preset.sampleTimeSeconds)).toBe(true)
      expect(preset.sampleTimeSeconds).toBeGreaterThanOrEqual(0)
    }
  })

  it('预设的 id 与外观层的采样表一一对应', () => {
    const presetIds = MANNEQUIN_PRESETS.map((preset) => preset.id).sort()
    const sourceIds = Object.keys(OFFICIAL_POSE_SOURCES).sort()
    expect(sourceIds).toEqual(presetIds)

    for (const preset of MANNEQUIN_PRESETS) {
      const source = OFFICIAL_POSE_SOURCES[preset.id]
      expect(source.clip).toBe(preset.sourceClip)
      expect(source.timeSeconds).toBe(preset.sampleTimeSeconds)
    }
  })

  it('外观资源是相对 public 根目录的路径', () => {
    // 不能以 / 开头：应用可能部署在子路径下。
    expect(MANNEQUIN_ASSET_URL.startsWith('/')).toBe(false)
    expect(MANNEQUIN_ASSET_URL.endsWith('.glb')).toBe(true)
  })

  it('五个预设覆盖站立/坐下/伸手/行走/跑步', () => {
    expect(MANNEQUIN_PRESETS.map((preset) => preset.label)).toEqual([
      '站立',
      '坐下',
      '伸手',
      '行走',
      '跑步'
    ])
    // 动作片段不能重复，否则两个预设会长得一模一样。
    const clips = MANNEQUIN_PRESETS.map((preset) => preset.sourceClip)
    expect(new Set(clips).size).toBe(clips.length)
  })
})

describe('mannequinVisualState', () => {
  it('没有数据时返回空状态', () => {
    expect(mannequinVisualState(null)).toEqual({})
    expect(mannequinVisualState(undefined)).toEqual({})
  })

  it('透传预设、手动关节与动作时间', () => {
    const state = mannequinVisualState(
      { presetId: 'walk', manualJoints: ['head'] },
      2.5
    )
    expect(state.presetId).toBe('walk')
    expect(state.manualJoints).toEqual(['head'])
    expect(state.actionTimeSeconds).toBe(2.5)
  })

  it('未传动作时间时不进入播放分支', () => {
    // 关键：undefined 与 0 语义不同。
    // 传 0 会走"播放第 0 秒"，不传则用静态预设姿势。
    const state = mannequinVisualState({ presetId: 'stand' }, undefined)
    expect(state.actionTimeSeconds).toBeUndefined()
  })

  it('手动关节缺失时退化为空数组', () => {
    const state = mannequinVisualState({ presetId: 'sit' }, 0)
    expect(state.manualJoints).toEqual([])
  })

  it('透传预设过渡信息', () => {
    const blend = { from: 'walk', to: 'run', amount: 0.4 }
    const state = mannequinVisualState({ presetId: 'run', presetBlend: blend }, 1)
    expect(state.presetBlend).toEqual(blend)
  })
})

describe('人台数据与关节约束', () => {
  it('新数据默认站立', () => {
    const data = createMannequinData(1.8)
    expect(data.heightMeters).toBe(1.8)
    expect(data.presetId).toBe('stand')
    expect(data.manualJoints).toEqual([])
    expect(data.pose).toEqual(createNeutralMannequinPose())
  })

  it('clone 出的姿势与原姿势互不影响', () => {
    const original = createNeutralMannequinPose()
    const cloned = cloneMannequinPose(original)
    cloned.head.x = 30
    expect(original.head.x).toBe(0)
    // 克隆必须包含全部关节，漏一个会让外观层少摆一根骨头。
    expect(Object.keys(cloned).sort()).toEqual(MANNEQUIN_JOINTS.map((joint) => joint.id).sort())
  })

  it('关节角度被夹紧到定义范围内', () => {
    const neck = constrainMannequinJoint('head', { x: 999, y: -999, z: 0 })
    expect(neck.x).toBe(45)
    expect(neck.y).toBe(-70)
    expect(neck.z).toBe(0)
  })

  it('外观未就绪时应用姿势不报错（只摆控制骨架）', () => {
    // 这是异步加载的真实场景：GLB 还没到，applyMannequinPose 已被调用。
    const root = { userData: {} }
    expect(() => applyMannequinPose(root, createNeutralMannequinPose())).not.toThrow()
    // 状态被记录下来，外观挂上后可以直接复用。
    expect(root.userData.mannequinVisualState).toEqual({})
  })
})
