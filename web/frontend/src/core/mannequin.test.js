import { describe, expect, it } from 'vitest'

import * as THREE from 'three'

import {
  MANNEQUIN_JOINTS,
  MANNEQUIN_PRESETS,
  MANNEQUIN_PROPORTIONS,
  MANNEQUIN_RIG_BOUNDS,
  POSE_LIBRARY_NAME_MAX_LENGTH,
  applyJointAngle,
  applyLibraryPose,
  applyMannequinPose,
  cloneMannequinPose,
  constrainMannequinJoint,
  createMannequinData,
  createMannequinRig,
  createNeutralMannequinPose,
  createPoseLibraryEntry,
  mannequinJointGroups,
  mirrorJointValue,
  mirrorMannequinPose,
  mirrorTargetJointIds,
  resetMannequinPose,
  sanitizeMannequinPose,
  sanitizePoseLibraryName,
  subsetPose,
  writeMannequinPoseKeyframe
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

/**
 * 人台比例与骨架契约。
 *
 * 这一组断言是为了锁住三件以前各写各、结果对不上的事：
 *
 * 1. **包围盒契约**：脚底 -0.5、头顶 +0.5、总高 1。视口把根节点放在
 *    `position.y = 身高 / 2` 并按 `size` 缩放，靠的就是这条契约。
 * 2. **人体比例**：7.5 头身。以前髋关节只在 0.44 身高处（应为 0.52），
 *    手柄和画出来的人体差了 13% 身高，看起来就是"人物比例不对"。
 * 3. **外观基准一致**：`normalizeVisual()` 用 `MANNEQUIN_RIG_BOUNDS` 归一化，
 *    所以真实骨架必须落在该范围内，否则外观会浮空或陷进地面。
 */
describe('人台比例与骨架契约', () => {
  const buildRig = () => {
    const { root, joints } = createMannequinRig(new THREE.MeshStandardMaterial())
    root.updateMatrixWorld(true)
    return { root, joints }
  }

  /** 关节的世界坐标 → 占全身高的比例（脚底 0、头顶 1）。 */
  const landmarkFraction = (root, joints, jointId, footY, height) => {
    const point = new THREE.Vector3()
    joints.get(jointId).getWorldPosition(point)
    return (point.y - footY) / height
  }

  it('包围盒严格是"脚底 -0.5、头顶 +0.5、总高 1"', () => {
    const { root } = buildRig()
    const box = new THREE.Box3().setFromObject(root)
    const size = box.getSize(new THREE.Vector3())
    expect(box.min.y).toBeCloseTo(MANNEQUIN_RIG_BOUNDS.minY, 3)
    expect(box.max.y).toBeCloseTo(MANNEQUIN_RIG_BOUNDS.maxY, 3)
    expect(size.y).toBeCloseTo(MANNEQUIN_RIG_BOUNDS.height, 3)
  })

  it('契约常量与实际骨架一致（外观归一化依赖它）', () => {
    expect(MANNEQUIN_RIG_BOUNDS.minY).toBe(-0.5)
    expect(MANNEQUIN_RIG_BOUNDS.maxY).toBe(0.5)
    expect(MANNEQUIN_RIG_BOUNDS.height).toBe(1)
    expect(MANNEQUIN_RIG_BOUNDS.maxY - MANNEQUIN_RIG_BOUNDS.minY).toBeCloseTo(
      MANNEQUIN_RIG_BOUNDS.height,
      6
    )
  })

  it('关键关节落在标准人体比例上', () => {
    const { root, joints } = buildRig()
    const box = new THREE.Box3().setFromObject(root)
    const height = box.max.y - box.min.y
    const at = (id) => landmarkFraction(root, joints, id, box.min.y, height)

    // 允许 2% 身高的偏差（胶囊体有半径，关节是枢轴不是表面）
    const expectAt = (id, fraction) => {
      expect(Math.abs(at(id) - fraction)).toBeLessThan(0.02)
    }
    expectAt('spine', MANNEQUIN_PROPORTIONS.waist)
    expectAt('head', MANNEQUIN_PROPORTIONS.headJoint)
    expectAt('leftShoulder', MANNEQUIN_PROPORTIONS.shoulder)
    expectAt('rightShoulder', MANNEQUIN_PROPORTIONS.shoulder)
    expectAt('leftElbow', MANNEQUIN_PROPORTIONS.elbow)
    expectAt('leftHip', MANNEQUIN_PROPORTIONS.hipJoint)
    expectAt('rightHip', MANNEQUIN_PROPORTIONS.hipJoint)
    expectAt('leftKnee', MANNEQUIN_PROPORTIONS.knee)
    expectAt('rightKnee', MANNEQUIN_PROPORTIONS.knee)
  })

  it('髋部落在身高的 45%~55%（人体标准 47%~53%；以前只有 38.5%）', () => {
    const { root, joints } = buildRig()
    const box = new THREE.Box3().setFromObject(root)
    const at = landmarkFraction(root, joints, 'leftHip', box.min.y, box.max.y - box.min.y)
    expect(at).toBeGreaterThan(0.45)
    expect(at).toBeLessThan(0.55)
  })

  it('骨架比例对齐随附 GLB 的实测骨骼位置（手柄才抓得准）', () => {
    // 这些数字是从 quaternius-ual1-standard.glb 的骨骼上量出来的
    // （foot_* / calf_* / thigh_* / spine_01 / upperarm_* / Head / lowerarm_* / hand_*）。
    // 一旦有人改了 GLB 或改了比例表，这条会立刻失败。
    expect(MANNEQUIN_PROPORTIONS.ankle).toBeCloseTo(0.056, 3)
    expect(MANNEQUIN_PROPORTIONS.knee).toBeCloseTo(0.284, 3)
    expect(MANNEQUIN_PROPORTIONS.hipJoint).toBeCloseTo(0.49, 3)
    expect(MANNEQUIN_PROPORTIONS.waist).toBeCloseTo(0.554, 3)
    expect(MANNEQUIN_PROPORTIONS.shoulder).toBeCloseTo(0.769, 3)
    expect(MANNEQUIN_PROPORTIONS.headJoint).toBeCloseTo(0.834, 3)
    expect(MANNEQUIN_PROPORTIONS.elbow).toBeCloseTo(0.637, 3)
    expect(MANNEQUIN_PROPORTIONS.wrist).toBeCloseTo(0.498, 3)
  })

  it('纵向关键点严格自上而下递增（写错顺序会让人体翻折）', () => {
    const P = MANNEQUIN_PROPORTIONS
    const ordered = [P.ankle, P.knee, P.hipJoint, P.waist, P.shoulder, P.headJoint]
    for (let i = 1; i < ordered.length; i += 1) {
      expect(ordered[i]).toBeGreaterThan(ordered[i - 1])
    }
    expect(P.elbow).toBeLessThan(P.shoulder)
    expect(P.elbow).toBeGreaterThan(P.wrist)
  })

  it('左右对称（两肩、两髋、两膝高度一致）', () => {
    const { joints } = buildRig()
    const point = new THREE.Vector3()
    const y = (id) => {
      joints.get(id).getWorldPosition(point)
      return point.y
    }
    expect(y('leftShoulder')).toBeCloseTo(y('rightShoulder'), 6)
    expect(y('leftHip')).toBeCloseTo(y('rightHip'), 6)
    expect(y('leftKnee')).toBeCloseTo(y('rightKnee'), 6)
  })

  it('头高约等于 1/6 全身高（与随附 GLB 的 6 头身一致）', () => {
    const { root, joints } = buildRig()
    const box = new THREE.Box3().setFromObject(root)
    const height = box.max.y - box.min.y
    // 头必须是"头关节下的那块网格"：骨架里躯干胶囊也有 0.27 高，
    // 按"最大但小于 0.3 身高"去找会误抓到躯干。
    const headMesh = joints.get('head').children.find((child) => child instanceof THREE.Mesh)
    expect(headMesh).toBeTruthy()
    headMesh.geometry.computeBoundingBox()
    const world = headMesh.geometry.boundingBox.clone().applyMatrix4(headMesh.matrixWorld)
    const headHeight = world.max.y - world.min.y
    const headsTall = height / headHeight
    // 随附 GLB 是 6 头身的风格化人体（Head 骨骼在 0.834 处），
    // 骨架必须跟它一致，否则手柄会比画出来的身体高一截。
    expect(headsTall).toBeGreaterThan(5.5)
    expect(headsTall).toBeLessThan(6.8)
  })

  it('手垂下来在手腕下方、脚底恰好在 -0.5', () => {
    const { root, joints } = buildRig()
    const box = new THREE.Box3().setFromObject(root)
    const point = new THREE.Vector3()
    joints.get('leftElbow').getWorldPosition(point)
    expect(point.y).toBeGreaterThan(MANNEQUIN_RIG_BOUNDS.minY)
    // 脚底就是包围盒底面，必须精确落在契约上
    expect(box.min.y).toBeCloseTo(MANNEQUIN_RIG_BOUNDS.minY, 3)
  })
})

/**
 * 姿势参数调整（参数面板的合并逻辑）。
 *
 * 这组断言锁住三件事：
 * 1. 限位必须生效（肘/膝是单向关节，越界会让模型反折）；
 * 2. 改一个轴不能把另外两轴清零；
 * 3. 必须把该关节记进 `manualJoints`——有动作预设时，外观只认 manualJoints
 *    里的关节，不记的话"拖了滑块画面却不动"。
 */
describe('姿势参数调整', () => {
  const neutral = () => createMannequinData(1.75)

  it('改一个轴，另外两轴保持原值', () => {
    const data = neutral()
    data.pose.head = { x: 10, y: 20, z: 30 }
    const patch = applyJointAngle(data, 'head', 'y', -15)
    expect(patch.pose.head).toEqual({ x: 10, y: -15, z: 30 })
  })

  it('越界会被限位夹住（肘是单向关节 0~145）', () => {
    const data = neutral()
    expect(applyJointAngle(data, 'leftElbow', 'x', -40).pose.leftElbow.x).toBe(0)
    expect(applyJointAngle(data, 'leftElbow', 'x', 999).pose.leftElbow.x).toBe(145)
  })

  it('把该关节记进 manualJoints（否则会被动作预设盖住）', () => {
    const data = neutral()
    expect(data.manualJoints).toEqual([])
    const patch = applyJointAngle(data, 'leftKnee', 'x', 30)
    expect(patch.manualJoints).toEqual(['leftKnee'])
    // 不重复登记
    const again = applyJointAngle({ ...data, manualJoints: patch.manualJoints }, 'leftKnee', 'x', 60)
    expect(again.manualJoints).toEqual(['leftKnee'])
  })

  it('不改原对象（纯函数，撤销栈才不会被就地改写污染）', () => {
    const data = neutral()
    const before = JSON.parse(JSON.stringify(data))
    applyJointAngle(data, 'spine', 'x', 25)
    expect(data).toEqual(before)
  })

  it('非法输入返回 null，调用方据此跳过写入', () => {
    const data = neutral()
    expect(applyJointAngle(data, 'nope', 'x', 10)).toBe(null)
    expect(applyJointAngle(data, 'head', 'w', 10)).toBe(null)
    expect(applyJointAngle(data, 'head', 'x', Number.NaN)).toBe(null)
    expect(applyJointAngle(data, 'head', 'x', 'abc')).toBe(null)
  })

  it('缺 pose 字段时按中立姿势打底（老工程可能没有某些关节）', () => {
    const patch = applyJointAngle({ presetId: 'stand' }, 'head', 'x', 12)
    expect(patch.pose.head.x).toBe(12)
    expect(patch.pose.spine).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('重置回到预设姿势并清空手动覆盖', () => {
    const data = { ...neutral(), presetId: 'sit', manualJoints: ['head', 'leftKnee'] }
    const reset = resetMannequinPose(data)
    const sit = MANNEQUIN_PRESETS.find((item) => item.id === 'sit')
    expect(reset.manualJoints).toEqual([])
    expect(reset.pose).toEqual(sit.pose)
    // 必须是副本，不能把预设表本身交出去（否则后续拖动会改坏预设）
    expect(reset.pose).not.toBe(sit.pose)
  })

  it('没有预设时重置回到中立姿势', () => {
    const reset = resetMannequinPose({ presetId: null, manualJoints: ['head'] })
    expect(reset.manualJoints).toEqual([])
    expect(reset.pose).toEqual(createNeutralMannequinPose())
  })

  it('关节分组覆盖全部关节且顺序稳定', () => {
    const groups = mannequinJointGroups()
    const ids = groups.flatMap((group) => group.joints.map((joint) => joint.id))
    expect(ids).toEqual(MANNEQUIN_JOINTS.map((joint) => joint.id))
    expect(groups.length).toBeGreaterThan(1)
    for (const group of groups) expect(group.label.length).toBeGreaterThan(0)
  })
})

/**
 * 姿势库（保存 / 命名 / 切回自定义姿势）。
 *
 * 这组断言锁住三件"看起来能用、其实会坏"的事：
 * 1. 库条目必须是**快照**（深拷贝）——共享引用会让用户之后拖滑块改坏库里的姿势；
 * 2. 应用库姿势时 `presetId` 必须置 null——否则外观层拿动作预设盖住它，
 *    表现是"只有一部分关节跟着变"；
 * 3. `manualJoints` 必须填满全部关节——面板的「手动 / 预设」标记读的就是它。
 */
describe('姿势库', () => {
  it('名称净化：裁空白、并空白、去控制字符、超长截断', () => {
    expect(sanitizePoseLibraryName('  抱臂  ')).toBe('抱臂')
    expect(sanitizePoseLibraryName('抱\t臂\n姿势')).toBe('抱 臂 姿势')
    expect(sanitizePoseLibraryName('   ')).toBe('')
    expect(sanitizePoseLibraryName(null)).toBe('')
    expect(sanitizePoseLibraryName('x'.repeat(80))).toHaveLength(POSE_LIBRARY_NAME_MAX_LENGTH)
  })

  it('空名自动编号为「姿势 1」，并跳过已占用的名字', () => {
    expect(createPoseLibraryEntry('', createNeutralMannequinPose()).name).toBe('姿势 1')
    const entry = createPoseLibraryEntry('', createNeutralMannequinPose(), {
      existingNames: ['姿势 1', '姿势 2']
    })
    expect(entry.name).toBe('姿势 3')
  })

  it('条目带 id / name / pose / createdAt', () => {
    const entry = createPoseLibraryEntry('抱臂', createNeutralMannequinPose(), {
      id: 'fixed-id',
      createdAt: '2026-11-11T08:00:00Z'
    })
    expect(entry.id).toBe('fixed-id')
    expect(entry.createdAt).toBe('2026-11-11T08:00:00Z')
    expect(Object.keys(entry.pose).sort()).toEqual(MANNEQUIN_JOINTS.map((joint) => joint.id).sort())
  })

  it('pose 是深拷贝：改原姿势不会改到库条目', () => {
    const source = createNeutralMannequinPose()
    const entry = createPoseLibraryEntry('快照', source)
    source.head.x = 40
    expect(entry.pose.head.x).toBe(0)
    // 反向也一样：改条目不会改回原对象
    const cloned = createPoseLibraryEntry('快照', source)
    cloned.pose.head.x = -20
    expect(source.head.x).toBe(40)
  })

  it('缺关节 / 非法值 / 未知关节都被净化（库条目永远是完整关节表）', () => {
    const pose = sanitizeMannequinPose({
      head: { x: 999, y: -8, z: '不是数字' },
      leftElbow: { x: -50, y: 0, z: 0 },
      未知关节: { x: 1, y: 1, z: 1 }
    })
    expect(Object.keys(pose).sort()).toEqual(MANNEQUIN_JOINTS.map((joint) => joint.id).sort())
    expect(pose.head).toEqual({ x: 45, y: -8, z: 0 })
    // 肘是单向关节：-50 被夹到 0
    expect(pose.leftElbow.x).toBe(0)
    expect(pose['未知关节']).toBeUndefined()
  })

  it('应用库姿势：presetId 置 null + manualJoints 填满全部关节', () => {
    const entry = createPoseLibraryEntry('抱臂', {
      ...createNeutralMannequinPose(),
      leftElbow: { x: 90, y: 0, z: 0 }
    })
    const patch = applyLibraryPose({ presetId: 'walk', manualJoints: ['head'] }, entry)
    expect(patch.presetId).toBe(null)
    expect(patch.manualJoints).toEqual(MANNEQUIN_JOINTS.map((joint) => joint.id))
    expect(patch.pose.leftElbow.x).toBe(90)
    // 返回的也是副本
    patch.pose.leftElbow.x = 0
    expect(entry.pose.leftElbow.x).toBe(90)
  })

  it('条目没有 pose 时返回 null（调用方据此跳过写入）', () => {
    expect(applyLibraryPose({ presetId: 'stand' }, null)).toBe(null)
    expect(applyLibraryPose({ presetId: 'stand' }, { id: 'x' })).toBe(null)
  })
})

/**
 * 镜像 / 对称。
 *
 * 三条要点：
 * 1. 数学是 `(rx, ry, rz) → (rx, -ry, -rz)`（推导见 mannequin.js 的注释）；
 * 2. **只**处理四肢 4 对关节，`head` / `spine` 保持不动；
 * 3. 光断言"数字变了"不算通过——这里用真实骨架量世界坐标，
 *    必须满足 `left.x ≈ -right.x` 且 `left.y ≈ right.y`、`left.z ≈ right.z`。
 */
describe('镜像 / 对称', () => {
  const asymmetric = () => ({
    ...createNeutralMannequinPose(),
    head: { x: 5, y: 25, z: 3 },
    spine: { x: 12, y: 8, z: -4 },
    leftShoulder: { x: 30, y: 20, z: -35 },
    leftElbow: { x: 50, y: 10, z: 5 },
    leftHip: { x: -20, y: 15, z: -10 },
    leftKnee: { x: 40, y: 0, z: 0 }
  })

  it('mirrorJointValue：绕 X 不变，绕 Y / Z 取反', () => {
    expect(mirrorJointValue({ x: 30, y: 20, z: -35 })).toEqual({ x: 30, y: -20, z: 35 })
    expect(mirrorJointValue({ x: -10, y: 0, z: 0 })).toEqual({ x: -10, y: 0, z: 0 })
    // 非法值按 0
    expect(mirrorJointValue(undefined)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('左→右：右臂右腿变成左侧的镜像，左侧原样不动', () => {
    const pose = mirrorMannequinPose(asymmetric(), 'left', 'right')
    expect(pose.rightShoulder).toEqual({ x: 30, y: -20, z: 35 })
    expect(pose.rightElbow).toEqual({ x: 50, y: -10, z: -5 })
    expect(pose.rightHip).toEqual({ x: -20, y: -15, z: 10 })
    expect(pose.rightKnee).toEqual({ x: 40, y: 0, z: 0 })
    // 左侧是源，必须原样
    expect(pose.leftShoulder).toEqual({ x: 30, y: 20, z: -35 })
    expect(pose.leftHip).toEqual({ x: -20, y: 15, z: -10 })
  })

  it('右→左：反过来同样成立', () => {
    const source = { ...createNeutralMannequinPose(), rightShoulder: { x: -15, y: 40, z: 25 } }
    const pose = mirrorMannequinPose(source, 'right', 'left')
    expect(pose.leftShoulder).toEqual({ x: -15, y: -40, z: -25 })
    expect(pose.rightShoulder).toEqual({ x: -15, y: 40, z: 25 })
  })

  it('中轴关节（head / spine）不被镜像动到', () => {
    const pose = mirrorMannequinPose(asymmetric(), 'left', 'right')
    expect(pose.head).toEqual({ x: 5, y: 25, z: 3 })
    expect(pose.spine).toEqual({ x: 12, y: 8, z: -4 })
  })

  it('不改原姿势（纯函数）', () => {
    const source = asymmetric()
    const before = JSON.parse(JSON.stringify(source))
    mirrorMannequinPose(source, 'left', 'right')
    expect(source).toEqual(before)
  })

  it('两侧相同或侧别非法时是无操作（返回净化副本）', () => {
    const source = asymmetric()
    expect(mirrorMannequinPose(source, 'left', 'left').rightShoulder).toEqual(source.rightShoulder)
    expect(mirrorMannequinPose(source, 'up', 'down').rightShoulder).toEqual(source.rightShoulder)
    expect(mirrorMannequinPose(source, 'left', 'right')).not.toBe(source)
  })

  it('镜像后的值仍然落在目标关节的限位内（限位本身是镜像对称的）', () => {
    // 左肩 z 的下限 -175 镜像到右肩 z 的 +175（正好是右肩上限）
    const pose = mirrorMannequinPose(
      { ...createNeutralMannequinPose(), leftShoulder: { x: 0, y: 0, z: -175 } },
      'left',
      'right'
    )
    expect(pose.rightShoulder.z).toBe(175)
    // 左髋 z 的 35（上限）镜像到右髋 z 的 -35（下限）
    const hips = mirrorMannequinPose(
      { ...createNeutralMannequinPose(), leftHip: { x: 0, y: 0, z: 35 } },
      'left',
      'right'
    )
    expect(hips.rightHip.z).toBe(-35)
  })

  it('镜像目标关节 id 返回对侧的 4 个四肢关节', () => {
    expect(mirrorTargetJointIds('left').sort()).toEqual(
      ['rightElbow', 'rightHip', 'rightKnee', 'rightShoulder'].sort()
    )
    expect(mirrorTargetJointIds('right').sort()).toEqual(
      ['leftElbow', 'leftHip', 'leftKnee', 'leftShoulder'].sort()
    )
  })

  /**
   * 几何验证：镜像后左右关节的世界坐标必须真的成镜像。
   *
   * 这条是"镜像数学对不对"的唯一硬证据——只比较数字的话，
   * 把 y/z 的符号写反、或者忘了处理骨骼局部系的镜像，都会静默通过。
   *
   * 注意躯干：`spine` 绕 Y/Z 扭转时整具身体**本来就不该**是世界坐标镜像的
   * （中轴关节被刻意排除在镜像之外）。所以世界坐标的断言必须用一个
   * "躯干只绕 X"的姿势；躯干扭过的情形放到下面那条用躯干局部空间来验。
   */
  const measureMirrorDeviation = (pairs, maps, toLocal) => {
    let worst = { label: '', diff: 0 }
    let compared = 0
    for (const [leftId, rightId] of pairs) {
      for (const [kind, map] of maps) {
        const leftNode = map.get(leftId)
        const rightNode = map.get(rightId)
        if (!leftNode || !rightNode) continue
        compared += 1
        const left = toLocal(leftNode)
        const right = toLocal(rightNode)
        const diff = Math.max(
          Math.abs(left.x + right.x),
          Math.abs(left.y - right.y),
          Math.abs(left.z - right.z)
        )
        if (diff > worst.diff) worst = { label: `${leftId}/${kind}`, diff }
      }
    }
    return { ...worst, compared }
  }

  it('量真实骨架：镜像后 left.x ≈ -right.x 且 y / z 相等', () => {
    const { root, joints, handles } = createMannequinRig(new THREE.MeshStandardMaterial())
    // 躯干只绕 X（绕 X 的旋转是自镜像的），这样整具身体在世界坐标里就是镜像的
    const source = { ...asymmetric(), spine: { x: 12, y: 0, z: 0 } }
    const pose = mirrorMannequinPose(source, 'left', 'right')
    applyMannequinPose(root, pose)
    root.updateMatrixWorld(true)

    /*
     * 取**相对人台根节点**的坐标：世界坐标会带上物体自身的位置，
     * 那部分与镜像无关，混进来只会让容差失去意义。
     */
    const toLocal = (node) => root.worldToLocal(node.getWorldPosition(new THREE.Vector3()))
    const pairs = [
      ['leftShoulder', 'rightShoulder'],
      ['leftElbow', 'rightElbow'],
      ['leftHip', 'rightHip'],
      ['leftKnee', 'rightKnee']
    ]
    // 关节枢轴 + 手柄（手柄是"关节末端"，肢体朝向错了它一定会偏）
    const maps = [
      ['枢轴', joints],
      ['手柄', handles]
    ]

    const worst = measureMirrorDeviation(pairs, maps, toLocal)
    // 容差 1e-4：骨架是"全身高 = 1"的单位模型，1e-4 ≈ 0.2mm；
    // 浮点三角函数误差在 1e-15 量级，这个容差足够严。
    expect(worst.diff).toBeLessThan(1e-4)
    // 确实量到了 4 对 × 2 张表 = 8 个点，避免"循环没跑"式的假通过
    expect(worst.compared).toBe(8)
    // 偏差为 0 时没有"最差点"，label 保持空 —— 顺带断言"完全对称"
    expect(worst.label).toBe('')
  })

  it('躯干被扭过时：四肢相对躯干仍严格镜像（世界坐标不对称是设计取舍）', () => {
    const { root, joints, handles } = createMannequinRig(new THREE.MeshStandardMaterial())
    const pose = mirrorMannequinPose(asymmetric(), 'left', 'right')
    applyMannequinPose(root, pose)
    root.updateMatrixWorld(true)

    const spine = joints.get('spine')
    const maps = [
      ['枢轴', joints],
      ['手柄', handles]
    ]
    // 手臂挂在 spine 下、腿挂在 root 下，各自用**直接父节点**的局部空间量，
    // 躯干的扭转就被完全约掉了。
    const armWorst = measureMirrorDeviation(
      [
        ['leftShoulder', 'rightShoulder'],
        ['leftElbow', 'rightElbow']
      ],
      maps,
      (node) => spine.worldToLocal(node.getWorldPosition(new THREE.Vector3()))
    )
    const legWorst = measureMirrorDeviation(
      [
        ['leftHip', 'rightHip'],
        ['leftKnee', 'rightKnee']
      ],
      maps,
      (node) => root.worldToLocal(node.getWorldPosition(new THREE.Vector3()))
    )
    expect(armWorst.diff).toBeLessThan(1e-4)
    expect(legWorst.diff).toBeLessThan(1e-4)

    // 反证：世界坐标下确实不再镜像（说明上面那条不是因为"恒真"才通过）
    const toRootLocal = (node) => root.worldToLocal(node.getWorldPosition(new THREE.Vector3()))
    const elbowLeft = toRootLocal(joints.get('leftElbow'))
    const elbowRight = toRootLocal(joints.get('rightElbow'))
    expect(Math.abs(elbowLeft.x + elbowRight.x)).toBeGreaterThan(1e-3)
  })
})

/**
 * 关节关键帧通道的写入侧。
 *
 * 三条硬要求：
 * 1. **同刻覆盖**而不是追加（同刻帧会让插值除以 0）；
 * 2. 只给一个关节打帧时，同刻帧里其它关节的值必须保留；
 * 3. `manualJoints` 取并集并把这次写入的关节算进去（否则有预设时外观不跟随）。
 */
describe('按关节写关键帧', () => {
  const transformOf = (x = 0) => ({
    position: { x, y: 0.875, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1.75, y: 1.75, z: 1.75 }
  })

  const write = (keyframes, overrides = {}) =>
    writeMannequinPoseKeyframe(keyframes, {
      id: 'kf-new',
      objectId: 'm1',
      timeSeconds: 1,
      transform: transformOf(),
      pose: { ...createNeutralMannequinPose(), head: { x: 0, y: 20, z: 0 }, spine: { x: 5, y: 0, z: 0 } },
      presetId: 'stand',
      manualJoints: ['head'],
      ...overrides
    })

  it('subsetPose：只保留指定关节，未知/缺失关节被跳过', () => {
    const source = {
      head: { x: 1, y: 2, z: 3 },
      spine: { x: 4, y: 5, z: 6 },
      leftKnee: { x: 999, y: 0, z: 0 }
    }
    const subset = subsetPose(source, ['head', 'leftKnee', 'nope', 'rightHip'])
    expect(Object.keys(subset).sort()).toEqual(['head', 'leftKnee'])
    expect(subset.head).toEqual({ x: 1, y: 2, z: 3 })
    // 越界被夹住（膝 x 上限 150）
    expect(subset.leftKnee.x).toBe(150)
    // 不改原对象
    expect(source.head).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('subsetPose：非数组 / 空输入返回空姿势', () => {
    expect(subsetPose({ head: { x: 1, y: 1, z: 1 } }, null)).toEqual({})
    expect(subsetPose(null, ['head'])).toEqual({})
  })

  it('写全部关节：关键帧带完整姿势与整体变换', () => {
    const { keyframes, keyframe } = write([], { jointIds: null })
    expect(keyframes).toHaveLength(1)
    expect(keyframe.timeSeconds).toBe(1)
    expect(keyframe.transform.position).toEqual({ x: 0, y: 0.875, z: 0 })
    expect(keyframe.transform.size).toEqual({ x: 1.75, y: 1.75, z: 1.75 })
    expect(Object.keys(keyframe.transform.mannequinPose)).toHaveLength(10)
    expect(keyframe.transform.mannequinPose.head.y).toBe(20)
    expect(keyframe.transform.mannequinPresetId).toBe('stand')
  })

  it('只写一个关节：关键帧姿势里只有它，manualJoints 记上它', () => {
    const { keyframe } = write([], { jointIds: ['head'] })
    expect(Object.keys(keyframe.transform.mannequinPose)).toEqual(['head'])
    expect(keyframe.transform.mannequinManualJoints).toEqual(['head'])
  })

  it('同刻再打另一个关节：覆盖同一条帧，并保留上一个关节的值', () => {
    const first = write([], { jointIds: ['head'] })
    expect(first.keyframes).toHaveLength(1)
    const second = write(first.keyframes, { id: 'kf-second', jointIds: ['spine'] })
    // 仍然只有一条帧（不是两条同刻帧）
    expect(second.keyframes).toHaveLength(1)
    // 沿用原有的 id（时间轴选中态挂在 id 上）
    expect(second.keyframe.id).toBe('kf-new')
    const pose = second.keyframe.transform.mannequinPose
    expect(Object.keys(pose).sort()).toEqual(['head', 'spine'])
    expect(pose.head.y).toBe(20)
    expect(pose.spine.x).toBe(5)
    // manualJoints 是并集
    expect(second.keyframe.transform.mannequinManualJoints.sort()).toEqual(['head', 'spine'])
  })

  it('同刻覆盖不会动到其它时刻 / 其它物体的帧', () => {
    const other = {
      id: 'kf-other',
      objectId: 'm1',
      timeSeconds: 3,
      interpolation: 'linear',
      transform: { ...transformOf(9), mannequinPose: { head: { x: 0, y: 90, z: 0 } } }
    }
    const otherObject = { ...other, id: 'kf-other-2', objectId: 'm2', timeSeconds: 1 }
    const { keyframes, keyframe } = write([other, otherObject], { jointIds: ['head'] })
    expect(keyframes).toHaveLength(3)
    expect(keyframe.id).toBe('kf-new')
    const untouched = keyframes.find((item) => item.id === 'kf-other')
    expect(untouched.timeSeconds).toBe(3)
    expect(untouched.interpolation).toBe('linear')
    expect(untouched.transform.mannequinPose.head.y).toBe(90)
    // 另一个物体在同刻的那条也不受影响
    expect(keyframes.find((item) => item.id === 'kf-other-2').transform.position.x).toBe(9)
  })

  it('无效输入返回原数组（不抛异常）', () => {
    const list = []
    expect(writeMannequinPoseKeyframe(list, { objectId: 'm1', timeSeconds: Number.NaN }).keyframe).toBe(null)
    expect(writeMannequinPoseKeyframe(list, { timeSeconds: 1 }).keyframes).toBe(list)
  })
})
