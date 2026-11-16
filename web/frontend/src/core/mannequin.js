/**
 * 人台骨架、姿势约束与预设动作。
 * 移植自 `app/src/renderer/src/mannequin/mannequin.ts`。
 *
 * 关节角度单位是度，XYZ 欧拉序。每个关节有独立的旋转范围，
 * 超出范围会被夹紧而不是报错——拖拽时手感优先。
 *
 * 5 个预设只是"起始姿势"，用户可以继续拖动单个关节微调。
 */

import * as THREE from 'three'
import { MANNEQUIN_JOINT_IDS, createId } from './project-document'
import { upsertObjectKeyframe } from './auto-key'
import { updateMannequinVisual } from './mannequin-visual'

export const MANNEQUIN_JOINTS = [
  { id: 'head', label: '头部', group: '上身', limits: { x: [-45, 45], y: [-70, 70], z: [-30, 30] } },
  { id: 'spine', label: '躯干', group: '上身', limits: { x: [-35, 35], y: [-50, 50], z: [-30, 30] } },
  {
    id: 'leftShoulder',
    label: '左上臂',
    group: '手臂',
    limits: { x: [-120, 120], y: [-80, 80], z: [-175, 70] }
  },
  {
    id: 'rightShoulder',
    label: '右上臂',
    group: '手臂',
    limits: { x: [-120, 120], y: [-80, 80], z: [-70, 175] }
  },
  { id: 'leftElbow', label: '左前臂', group: '手臂', limits: { x: [0, 145], y: [-20, 20], z: [-15, 15] } },
  {
    id: 'rightElbow',
    label: '右前臂',
    group: '手臂',
    limits: { x: [0, 145], y: [-20, 20], z: [-15, 15] }
  },
  { id: 'leftHip', label: '左大腿', group: '腿部', limits: { x: [-110, 65], y: [-45, 45], z: [-45, 35] } },
  { id: 'rightHip', label: '右大腿', group: '腿部', limits: { x: [-110, 65], y: [-45, 45], z: [-35, 45] } },
  { id: 'leftKnee', label: '左小腿', group: '腿部', limits: { x: [0, 150], y: [0, 0], z: [0, 0] } },
  { id: 'rightKnee', label: '右小腿', group: '腿部', limits: { x: [0, 150], y: [0, 0], z: [0, 0] } }
]

const zero = () => ({ x: 0, y: 0, z: 0 })

export function createNeutralMannequinPose() {
  return {
    head: zero(),
    spine: zero(),
    leftShoulder: { x: 0, y: 0, z: -6 },
    rightShoulder: { x: 0, y: 0, z: 6 },
    leftElbow: zero(),
    rightElbow: zero(),
    leftHip: zero(),
    rightHip: zero(),
    leftKnee: zero(),
    rightKnee: zero()
  }
}

function poseWith(updates) {
  return { ...createNeutralMannequinPose(), ...updates }
}

/**
 * 预设动作。
 *
 * `sourceClip` / `sampleTimeSeconds` 是给外观层用的：它们指向
 * Quaternius 模型里真实的动画片段与采样时刻。`pose` 只是**近似值**，
 * 用于控制骨架的初始朝向；外观真正的姿势由 mannequin-visual.js
 * 从动画片段采样得到（那才是精确的人体姿态）。
 */
export const MANNEQUIN_PRESETS = [
  {
    id: 'stand',
    label: '站立',
    pose: createNeutralMannequinPose(),
    sourceClip: 'Idle_Loop',
    sampleTimeSeconds: 0.6
  },
  {
    id: 'sit',
    label: '坐下',
    sourceClip: 'Sitting_Idle_Loop',
    sampleTimeSeconds: 0.5,
    pose: poseWith({
      spine: { x: 8, y: 0, z: 0 },
      leftHip: { x: -88, y: 0, z: -4 },
      rightHip: { x: -88, y: 0, z: 4 },
      leftKnee: { x: 92, y: 0, z: 0 },
      rightKnee: { x: 92, y: 0, z: 0 },
      leftShoulder: { x: -18, y: 0, z: -12 },
      rightShoulder: { x: -18, y: 0, z: 12 },
      leftElbow: { x: 58, y: 0, z: 0 },
      rightElbow: { x: 58, y: 0, z: 0 }
    })
  },
  {
    id: 'raise-hand',
    label: '伸手',
    sourceClip: 'Interact',
    sampleTimeSeconds: 1,
    pose: poseWith({
      rightShoulder: { x: -8, y: 0, z: 165 },
      rightElbow: { x: 18, y: 0, z: 0 },
      head: { x: 0, y: 18, z: 0 }
    })
  },
  {
    id: 'walk',
    label: '行走',
    sourceClip: 'Walk_Loop',
    sampleTimeSeconds: 0,
    pose: poseWith({
      leftShoulder: { x: 30, y: 0, z: -8 },
      rightShoulder: { x: -30, y: 0, z: 8 },
      leftElbow: { x: 18, y: 0, z: 0 },
      rightElbow: { x: 24, y: 0, z: 0 },
      leftHip: { x: -32, y: 0, z: -3 },
      rightHip: { x: 26, y: 0, z: 3 },
      leftKnee: { x: 20, y: 0, z: 0 },
      rightKnee: { x: 8, y: 0, z: 0 }
    })
  },
  {
    id: 'run',
    label: '跑步',
    sourceClip: 'Sprint_Loop',
    sampleTimeSeconds: 0,
    pose: poseWith({
      spine: { x: -16, y: 0, z: 0 },
      leftShoulder: { x: 58, y: 0, z: -10 },
      rightShoulder: { x: -62, y: 0, z: 10 },
      leftElbow: { x: 72, y: 0, z: 0 },
      rightElbow: { x: 78, y: 0, z: 0 },
      leftHip: { x: -58, y: 0, z: -4 },
      rightHip: { x: 42, y: 0, z: 4 },
      leftKnee: { x: 38, y: 0, z: 0 },
      rightKnee: { x: 104, y: 0, z: 0 }
    })
  }
]

export function cloneMannequinPose(pose) {
  return Object.fromEntries(MANNEQUIN_JOINT_IDS.map((id) => [id, { ...pose[id] }]))
}

export function createMannequinData(heightMeters = 1.75) {
  return {
    heightMeters,
    pose: createNeutralMannequinPose(),
    presetId: 'stand',
    manualJoints: []
  }
}

function clamp(value, limits) {
  return Math.min(Math.max(value, limits[0]), limits[1])
}

/** 任何非有限数字（含 undefined / null / NaN / 字符串）一律按 0 处理。 */
function finiteOrZero(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

/**
 * 夹取关节角度。
 *
 * 除了限位，还负责**把非法值归一**：`undefined` / `NaN` 一律当 0。
 * 这条以前没有，而它是有真实后果的——关键帧里少一个关节（按关节通道打帧、
 * 或手改过的工程）时，`pose[id]` 是 undefined，`value.x` 会直接抛
 * `Cannot read properties of undefined`，整个渲染循环挂掉。
 * 现在缺关节只会让它回到中立角度，画面照常。
 */
export function constrainMannequinJoint(jointId, value) {
  const definition = MANNEQUIN_JOINTS.find((joint) => joint.id === jointId)
  const source = value && typeof value === 'object' ? value : {}
  if (!definition) {
    return { x: finiteOrZero(source.x), y: finiteOrZero(source.y), z: finiteOrZero(source.z) }
  }
  return {
    x: clamp(finiteOrZero(source.x), definition.limits.x),
    y: clamp(finiteOrZero(source.y), definition.limits.y),
    z: clamp(finiteOrZero(source.z), definition.limits.z)
  }
}

/**
 * 把任意来源的姿势净化成"每个关节都有三个有限数字"的完整姿势。
 *
 * 三件事一次做完：补齐缺失关节、丢掉未知关节、夹到限位内。
 * 姿势库、库条目写回、以及从工程读回的姿势都走这里，
 * 保证"库里的姿势"和"面板显示的姿势"永远是同一套形状。
 */
export function sanitizeMannequinPose(pose) {
  const source = pose && typeof pose === 'object' ? pose : {}
  const result = {}
  for (const jointId of MANNEQUIN_JOINT_IDS) {
    result[jointId] = constrainMannequinJoint(jointId, source[jointId])
  }
  return result
}

// ----------------------------------------------------------------------
// 姿势参数调整（参数面板用）
// ----------------------------------------------------------------------

/** 关节按身体部位分组，供参数面板渲染（顺序与 MANNEQUIN_JOINTS 一致）。 */
export function mannequinJointGroups() {
  const groups = []
  for (const joint of MANNEQUIN_JOINTS) {
    let group = groups.find((item) => item.label === joint.group)
    if (!group) {
      group = { label: joint.group, joints: [] }
      groups.push(group)
    }
    group.joints.push(joint)
  }
  return groups
}

/**
 * 改一个关节的某一个轴的角度，返回**新的** `{ pose, manualJoints }`。
 *
 * 两个必须做对的地方：
 *
 * 1. **限位**：角度要过 `constrainMannequinJoint`。肘/膝这类单向关节的限位是
 *    `[0, 145]`，不管面板还是别处写入都不能越界，否则模型会反折。
 * 2. **`manualJoints` 必须记上这个关节**。人台有两层姿势：
 *    - 控制骨架（白模）始终由 `pose` 驱动；
 *    - 外观 GLB 在有预设时显示官方动作采样，**只有 `manualJoints` 里的关节**
 *      才被 `pose` 覆盖。
 *    不记的话用户拖了滑块、画面却不动（因为预设动作把它盖住了），
 *    看起来就像功能坏了。
 *
 * 只改一个轴，另外两轴保持原值——否则拖 X 会把 Y/Z 清零。
 */
export function applyJointAngle(mannequin, jointId, axis, angle) {
  const current = mannequin?.pose ?? createNeutralMannequinPose()
  if (!MANNEQUIN_JOINTS.some((joint) => joint.id === jointId)) return null
  if (!['x', 'y', 'z'].includes(axis)) return null
  const value = Number(angle)
  if (!Number.isFinite(value)) return null

  const previous = current[jointId] ?? zero()
  const next = constrainMannequinJoint(jointId, { ...previous, [axis]: value })
  const manualJoints = Array.isArray(mannequin?.manualJoints) ? [...mannequin.manualJoints] : []
  if (!manualJoints.includes(jointId)) manualJoints.push(jointId)
  return { pose: { ...current, [jointId]: next }, manualJoints }
}

/**
 * 重置姿势：回到"预设姿势"（选了预设时）或中立姿势，并清空手动覆盖。
 *
 * 有预设时必须回到**预设的 pose** 而不是中立姿势：`applyMannequinPreset` 写的就是
 * 预设自带的 pose，回到中立会让控制骨架和外观对不上。
 */
export function resetMannequinPose(mannequin) {
  const presetId = mannequin?.presetId
  const preset = presetId ? MANNEQUIN_PRESETS.find((item) => item.id === presetId) : null
  return {
    pose: preset
      ? JSON.parse(JSON.stringify(preset.pose))
      : createNeutralMannequinPose(),
    manualJoints: []
  }
}

// ----------------------------------------------------------------------
// 姿势库（保存 / 命名 / 随时切回自定义姿势）
// ----------------------------------------------------------------------

/** 姿势名长度上限：再长只会把列表撑爆，工程文件里也是一整段废话。 */
export const POSE_LIBRARY_NAME_MAX_LENGTH = 24

/** 空名时的默认名前缀，最终形如「姿势 1」。 */
export const POSE_LIBRARY_DEFAULT_NAME_PREFIX = '姿势 '

/**
 * 姿势名净化。
 *
 * 三条确定行为（测试里固定下来）：
 * 1. 控制字符（换行 / 制表 / NUL）替换成空格再合并连续空白——否则列表里会错行；
 * 2. 首尾空白裁掉，全空白等于"没填名字"；
 * 3. 超长截断到 `POSE_LIBRARY_NAME_MAX_LENGTH`（按 UTF-16 码元截断，
 *    中文与 emoji 不会被截成半个字符之外的东西，最坏情况是 emoji 少一半）。
 */
export function sanitizePoseLibraryName(name) {
  if (typeof name !== 'string') return ''
  /*
   * 控制字符逐个替换成空格，而不是写 `replace(/[\u0000-\u001f]/g, ' ')`：
   * 后者会触发 ESLint 的 no-control-regex（正则里的控制字符几乎总是笔误），
   * 这里用码点判断既等价又不用加禁用注释。
   */
  const withoutControls = Array.from(name, (character) => {
    const code = character.codePointAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
  return withoutControls
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, POSE_LIBRARY_NAME_MAX_LENGTH)
}

/** 空名时按「姿势 N」自动编号，跳过已被占用的名字。 */
function defaultPoseLibraryName(existingNames) {
  const taken = new Set(Array.isArray(existingNames) ? existingNames : [])
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = `${POSE_LIBRARY_DEFAULT_NAME_PREFIX}${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${POSE_LIBRARY_DEFAULT_NAME_PREFIX}1`
}

/**
 * 新建一个姿势库条目。
 *
 * `pose` 走 `sanitizeMannequinPose` 深拷贝：库条目必须是**快照**，
 * 不能和场景里那份姿势共享引用——否则用户之后拖滑块会把库里的姿势一起改掉，
 * 而撤销栈里也各留一份互相牵连的对象。
 *
 * `options.id` / `options.createdAt` 可注入（测试要确定性），
 * 不传时分别用 `createId()` 与当前时间。
 * 重名**允许**：条目之间靠 id 区分，不靠名字——「更新为当前」「删除」
 * 都按 id 操作，重名不会互相覆盖（见 `applyLibraryPose` 的调用点）。
 */
export function createPoseLibraryEntry(name, pose, options = {}) {
  const existingNames = Array.isArray(options.existingNames) ? options.existingNames : []
  const sanitized = sanitizePoseLibraryName(name)
  return {
    id: typeof options.id === 'string' && options.id ? options.id : createId(),
    name: sanitized || defaultPoseLibraryName(existingNames),
    pose: sanitizeMannequinPose(pose),
    createdAt:
      typeof options.createdAt === 'string' && options.createdAt
        ? options.createdAt
        : new Date().toISOString()
  }
}

/**
 * 把库里的姿势应用到人台，返回新的 `{ pose, presetId, manualJoints }`。
 *
 * 两个必须做对的地方：
 *
 * 1. **`presetId` 置 null**。人台外观有两层：有预设时只让 `manualJoints` 里的
 *    关节跟随 `pose`，其余关节显示官方动作采样。库里存的是**完整自定义姿势**，
 *    留着预设会让"看起来只有一半生效"——躯干还是走路的样子，只有手动关节变了。
 *    置 null 后外观与控制骨架都由 `pose` 驱动，两层一致。
 * 2. **`manualJoints` 填全部关节**。面板上的「手动 / 预设」标记读的就是它；
 *    只填一部分的话，明明整条姿势都被覆盖了，面板却显示一半"跟随预设"。
 *
 * 条目无效（没有 pose）时返回 null，调用方据此跳过写入。
 */
export function applyLibraryPose(mannequin, entry) {
  const pose = entry?.pose
  if (!pose || typeof pose !== 'object') return null
  return {
    pose: sanitizeMannequinPose(pose),
    presetId: null,
    manualJoints: [...MANNEQUIN_JOINT_IDS]
  }
}

// ----------------------------------------------------------------------
// 镜像 / 对称
// ----------------------------------------------------------------------

/**
 * 四肢的左右配对。
 *
 * **刻意不含 `head` / `spine`**：这两个是中轴关节，它们的"左右"是同一个对象，
 * 没有可以镜像的配对。把躯干也算进去的话，用户精心扭出来的上身会在点
 * "左→右"的瞬间被抹平——"一键对称四肢"本来是省事的操作，顺手改掉躯干
 * 就变成了意外。所以镜像只处理这 8 个关节（4 对）。
 */
export const MANNEQUIN_MIRROR_PAIRS = [
  { left: 'leftShoulder', right: 'rightShoulder' },
  { left: 'leftElbow', right: 'rightElbow' },
  { left: 'leftHip', right: 'rightHip' },
  { left: 'leftKnee', right: 'rightKnee' }
]

/** 镜像侧别。顺序固定，供界面/测试遍历。 */
export const MANNEQUIN_SIDES = ['left', 'right']

/**
 * 单个关节值的镜像：`(rx, ry, rz) → (rx, -ry, -rz)`。
 *
 * ## 推导（绕 x=0 平面镜像）
 *
 * 设 M = diag(-1, 1, 1)（绕 x=0 平面作镜像）。左右骨骼的局部坐标系互为镜像，
 * 即右侧局部系 R = M·L·M。要让右侧关节在世界空间摆出左侧姿势的镜像，
 * 右侧的旋转必须是
 *
 *     R' = M · Rx(a)·Ry(b)·Rz(c) · M
 *
 * 把 M 分配到三个因子里（M·M = I）：
 *
 *     M·Rx(a)·M = Rx(a)      // 转轴 (1,0,0) 被 M 映到 (-1,0,0)，
 *                            // 绕反向轴转 a 等价于绕原轴转 -a，两次取反抵消
 *     M·Ry(b)·M = Ry(-b)     // 转轴 (0,1,0) 被 M 映到自身，但旋转手性翻转
 *     M·Rz(c)·M = Rz(-c)     // 同上
 *
 * 于是
 *
 *     M·(Rx(a)Ry(b)Rz(c))·M = Rx(a)·Ry(-b)·Rz(-c)
 *
 * 因为控制骨架、外观 GLB 的欧拉序都是 XYZ（three.js 默认 'XYZ'），这个结论
 * 可以直接作用在欧拉角上，不需要转四元数/矩阵：
 *
 *     (rx, ry, rz) → (rx, -ry, -rz)
 *
 * ## 为什么不需要再夹一次限位
 *
 * `MANNEQUIN_JOINTS` 的限位本身就是**镜像对称**的（例如左肩 z:[-175,70]
 * 对应右肩 z:[-70,175]，左髋 z:[-45,35] 对应右髋 z:[-35,45]），
 * 所以镜像后的值天然落在目标关节的范围内。这里仍然过一遍
 * `constrainMannequinJoint`，防的是"手改过的工程里存了越界值"。
 */
export function mirrorJointValue(value) {
  const source = value && typeof value === 'object' ? value : {}
  /*
   * 取反时把 0 归一成正 0：`-0` 与 `0` 在 JSON 里都序列化成 `0`，
   * 但 `Object.is(-0, 0)` 为 false，会让深比较、指纹、面板显示出现
   * 一堆毫无意义的"差异"。这里顺手抹掉。
   */
  const negate = (number) => (number === 0 ? 0 : -number)
  return {
    x: finiteOrZero(source.x),
    y: negate(finiteOrZero(source.y)),
    z: negate(finiteOrZero(source.z))
  }
}

/**
 * 镜像会把哪一侧的关节算出来覆盖掉（`fromSide` 的**对侧**）。
 *
 * 返回 4 个关节 id。调用方要把它们记进 `manualJoints`：有动作预设时，
 * 外观层只让 `manualJoints` 里的关节跟随 `pose`，不记的话"镜像只改了白模"。
 */
export function mirrorTargetJointIds(fromSide) {
  const targetSide = fromSide === 'left' ? 'right' : 'left'
  return MANNEQUIN_MIRROR_PAIRS.map((pair) => pair[targetSide])
}

/**
 * 把一侧四肢的角度镜像到另一侧，返回**新的完整姿势**。
 *
 * 语义是"让两侧一样"：只覆盖 `toSide` 的 4 个关节，`fromSide` 保持不动，
 * `head` / `spine` 也保持不动（见 `MANNEQUIN_MIRROR_PAIRS` 的注释）。
 *
 * `fromSide` / `toSide` 非法或相同时返回净化后的副本（无操作），
 * 这样调用方不必先判参数合法性，也不会因为手滑传入同样的两侧而算出一堆 0。
 */
export function mirrorMannequinPose(pose, fromSide, toSide) {
  const result = sanitizeMannequinPose(pose)
  const valid = MANNEQUIN_SIDES.includes(fromSide) && MANNEQUIN_SIDES.includes(toSide)
  if (!valid || fromSide === toSide) return result
  for (const pair of MANNEQUIN_MIRROR_PAIRS) {
    if (pair[fromSide] === undefined || pair[toSide] === undefined) continue
    result[pair[toSide]] = constrainMannequinJoint(pair[toSide], mirrorJointValue(result[pair[fromSide]]))
  }
  return result
}

// ----------------------------------------------------------------------
// 关节关键帧通道（按关节打帧 / 只保留部分关节）
// ----------------------------------------------------------------------

/** 关键帧"同一时刻"的判定容差，与 `upsertObjectKeyframe` 保持一致。 */
const KEYFRAME_TIME_EPSILON = 1e-6

/**
 * 只保留指定关节，返回新的姿势对象。
 *
 * 按关节打帧时用它把"整套姿势"裁成"这次要打的关节"：
 * 写进关键帧的姿势越小，插值时该关节的通道就越干净，
 * 也不会顺手把别的关节钉死在同一时刻。
 *
 * 未知关节、缺失关节、非法数值一律跳过（不会写出 `undefined` 或 NaN）。
 */
export function subsetPose(pose, jointIds) {
  const source = pose && typeof pose === 'object' ? pose : {}
  const ids = Array.isArray(jointIds) ? jointIds : []
  const result = {}
  for (const jointId of ids) {
    if (!MANNEQUIN_JOINT_IDS.includes(jointId)) continue
    const value = source[jointId]
    if (!value || typeof value !== 'object') continue
    result[jointId] = constrainMannequinJoint(jointId, value)
  }
  return result
}

function cloneVectorValue(value) {
  const source = value && typeof value === 'object' ? value : {}
  return { x: finiteOrZero(source.x), y: finiteOrZero(source.y), z: finiteOrZero(source.z) }
}

/**
 * 把当前姿势（或其中一部分关节）写入某个物体在某一时刻的关键帧。
 *
 * 关键行为：
 *
 * 1. **同一时刻覆盖，不追加**。复用 `upsertObjectKeyframe`，它会沿用原有
 *    keyframe id（时间轴上的选中态挂在 id 上）并替换 transform。
 *    追加两条同刻帧会让插值除以 0，也会让"这一帧到底听谁的"变得不确定。
 * 2. **按通道合并**。只给一个关节打帧时，既有关键帧里其它关节的值必须保留，
 *    否则"只动画左臂"会顺手把右臂、腿、躯干一起清空。
 * 3. `manualJoints` 取并集，并把这次写入的关节也算进去：有动作预设时，
 *    外观层只让 `manualJoints` 里的关节跟随 `pose`。
 *
 * @param {Array} keyframes 现有全部关键帧
 * @param {object} input
 * @param {string} input.id 新关键帧 id（同刻覆盖时沿用原有的）
 * @param {string} input.objectId
 * @param {number} input.timeSeconds
 * @param {object} input.transform 当前物体的整体变换（`buildObjectTransform()` 的产物）
 * @param {object} input.pose 当前完整姿势
 * @param {string[]|null} [input.jointIds] 只打这些关节；不传/为空表示"全部关节"
 * @param {string} [input.presetId] 关键帧记录的动作预设
 * @param {string[]} [input.manualJoints] 当前人台的 manualJoints
 * @param {string} [input.interpolation] 默认沿用既有帧或 'smooth'
 * @returns {{keyframes: Array, keyframe: object|null}}
 */
export function writeMannequinPoseKeyframe(keyframes, input) {
  const list = Array.isArray(keyframes) ? keyframes : []
  const time = Number(input?.timeSeconds)
  if (!Number.isFinite(time) || !input?.objectId) return { keyframes: list, keyframe: null }

  const jointIds = Array.isArray(input.jointIds) && input.jointIds.length > 0 ? input.jointIds : null
  const keyedPose = jointIds ? subsetPose(input.pose, jointIds) : sanitizeMannequinPose(input.pose)
  const existing = list.find(
    (item) =>
      item.objectId === input.objectId &&
      Math.abs(Number(item.timeSeconds) - time) <= KEYFRAME_TIME_EPSILON
  )

  const base = input.transform && typeof input.transform === 'object' ? input.transform : {}
  const transform = {
    position: cloneVectorValue(base.position),
    rotation: cloneVectorValue(base.rotation),
    size: cloneVectorValue(base.size),
    // 既有关键帧的姿势打底，本次要打的关节覆盖上去（通道合并）。
    mannequinPose: { ...(existing?.transform?.mannequinPose ?? {}), ...keyedPose },
    mannequinPresetId: input.presetId ?? existing?.transform?.mannequinPresetId ?? null,
    mannequinManualJoints: [
      ...new Set([
        ...(existing?.transform?.mannequinManualJoints ?? []),
        ...(Array.isArray(input.manualJoints) ? input.manualJoints : []),
        ...Object.keys(keyedPose)
      ])
    ]
  }

  const next = upsertObjectKeyframe(list, {
    id: input.id,
    objectId: input.objectId,
    timeSeconds: time,
    interpolation: input.interpolation,
    transform
  })
  const keyframe =
    next.find(
      (item) =>
        item.objectId === input.objectId &&
        Math.abs(Number(item.timeSeconds) - time) <= KEYFRAME_TIME_EPSILON
    ) ?? null
  return { keyframes: next, keyframe }
}

function partMaterial(source) {
  return source.clone()
}

function cylinderPart(radius, length, offsetY, material) {
  const mesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 0.005), 5, 10),
    partMaterial(material)
  )
  mesh.position.y = offsetY
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function jointNode(parent, position) {
  const group = new THREE.Group()
  group.position.copy(position)
  parent.add(group)
  return group
}

/**
 * 人台控制骨架的**人体比例表**。
 *
 * 数值含义：占全身高的比例，脚底 = 0、头顶 = 1，取 7.5 头身的成年人
 * （7.5 头身是服装/动画行业最常用的标准体型；真人约 7~7.5）。
 *
 * 骨架坐标系：脚底固定在 -0.5、头顶固定在 +0.5，根节点在 0（髋部），
 * 所以 `y = 比例 - 0.5`。这条**契约**必须成立，因为：
 *
 * 1. `createMannequinSceneObject` 把根节点放在 `position.y = 身高 / 2`，
 *    靠的就是"根节点在正中间"——否则人物会陷进地面或悬空；
 * 2. 根节点按 `size.y` 缩放，靠的就是"骨架总高恰好是 1"——否则身高不准；
 * 3. 外观模型 `normalizeVisual()` 按同一套基准归一化，靠的就是
 *    `MANNEQUIN_RIG_BOUNDS`——否则关节手柄和画出来的人体对不上。
 *
 * 这三处以前各写各的（骨架实际高 0.9883、脚底 -0.5475，外观却按 1.0 / -0.5
 * 归一化），结果髋关节比画出来的髋部低 13% 身高（≈24cm）、脚底还陷进地面
 * 8cm，看起来就是"人物比例不对"。
 */
export const MANNEQUIN_PROPORTIONS = {
  // 纵向关键点（占全身高比例，从脚底算起）——**实测自随附 GLB 的骨骼位置**，
  // 不是抄教科书：随附模型是 6 头身的风格化人体，肩在 0.77 而不是标准的 0.82。
  // 按教科书定骨架会让手柄比画出来的身体高 5% 身高（≈9cm），抓不准。
  //
  // 实测命令见 docs/AI_DEV_GUIDE.md「人台比例」一节（读 mannequinVisual.bones）。
  ankle: 0.056, // foot_*
  knee: 0.284, // calf_*
  hipJoint: 0.49, // thigh_*
  waist: 0.554, // spine_01（躯干枢轴）
  shoulder: 0.769, // upperarm_*
  headJoint: 0.834, // Head（颅底，头部旋转的枢轴）
  elbow: 0.637, // lowerarm_*
  wrist: 0.498, // hand_*

  // 横向半宽 / 半径（同样以全身高为 1）
  shoulderHalfSpan: 0.1,
  hipHalfSpan: 0.047,
  headRadius: 0.083, // 竖向半径：头高 = 0.166（6 头身，与模型一致）
  neckRadius: 0.026,
  upperArmRadius: 0.027,
  forearmRadius: 0.023,
  handRadius: 0.028,
  thighRadius: 0.045,
  shinRadius: 0.034,
  chestRadius: 0.08,
  pelvisRadius: 0.085,

  // 躯干分段：胸腔从这一高度一直到肩线
  chestBottom: 0.55,

  // 头横向压窄（人头宽约为头高的 0.65 倍）与纵深
  headWidthScale: 0.65,
  headDepthScale: 0.75,

  // 躯干横截面：胸宽 ≈ 1.2 倍半径、胸厚 ≈ 0.8 倍（人体横截面是扁椭圆）
  chestWidthScale: 1.2,
  chestDepthScale: 0.8,
  pelvisWidthScale: 1.25,
  pelvisHeightScale: 0.72,
  pelvisDepthScale: 0.85
}

/**
 * 骨架的包围盒契约：脚底 -0.5、头顶 +0.5、总高 1。
 *
 * `mannequin-visual.js` 用它归一化外观，测试会断言真实骨架确实落在这个范围内，
 * 所以两边不可能再各自漂移。
 */
export const MANNEQUIN_RIG_BOUNDS = { minY: -0.5, maxY: 0.5, height: 1 }

/** 把"占全身高比例"换算成骨架坐标（脚底 -0.5、头顶 +0.5）。 */
function rigY(fraction) {
  return fraction - 0.5
}

/**
 * 构建人台骨架。
 *
 * 骨架是"控制用"的可见白模：身高缩放由外层 object 的 `size` 统一实现，
 * 因此这里的尺寸是**单位身高（1.0）下的人体比例**，包围盒严格等于
 * `MANNEQUIN_RIG_BOUNDS`。
 */
export function createMannequinRig(material) {
  const P = MANNEQUIN_PROPORTIONS
  const root = new THREE.Group()
  root.name = '人台控制骨架'
  root.userData.mannequinControl = true
  const joints = new Map()
  const handles = new Map()

  // 髋部（骨盆）：横截面扁椭圆，纵向压扁
  const pelvis = new THREE.Mesh(new THREE.SphereGeometry(P.pelvisRadius, 16, 12), partMaterial(material))
  pelvis.scale.set(P.pelvisWidthScale, P.pelvisHeightScale, P.pelvisDepthScale)
  pelvis.position.y = rigY(P.hipJoint)
  pelvis.castShadow = true
  pelvis.receiveShadow = true
  root.add(pelvis)

  const spine = jointNode(root, new THREE.Vector3(0, rigY(P.waist), 0))
  joints.set('spine', spine)

  /*
   * 胸腔：从肩线稍下方一直到腰部。
   *
   * `cylinderPart(radius, length, offsetY)` 把胶囊**居中**放在 offsetY，
   * 所以 offsetY 取"该段中点到脊柱枢轴"的距离。
   */
  const chestLength = rigY(P.shoulder) - rigY(P.chestBottom)
  const torso = cylinderPart(
    P.chestRadius,
    chestLength,
    (rigY(P.shoulder) + rigY(P.chestBottom)) / 2 - rigY(P.waist),
    material
  )
  torso.scale.x = P.chestWidthScale
  torso.scale.z = P.chestDepthScale
  spine.add(torso)

  // 脖子：肩线到颅底
  const neckLength = rigY(P.headJoint) - rigY(P.shoulder)
  spine.add(
    cylinderPart(
      P.neckRadius,
      neckLength * 1.4,
      (rigY(P.headJoint) + rigY(P.shoulder)) / 2 - rigY(P.waist),
      material
    )
  )

  const headJoint = jointNode(spine, new THREE.Vector3(0, rigY(P.headJoint) - rigY(P.waist), 0))
  joints.set('head', headJoint)
  handles.set('spine', headJoint)

  /*
   * 头：球体竖向半径 = 头高的一半。头心放在 `headJoint + 半径` 处，
   * 于是头顶 = headJoint + 2×半径 = 0.834 + 0.166 = 1.0，正好落在包围盒上沿。
   */
  const head = new THREE.Mesh(new THREE.SphereGeometry(P.headRadius, 18, 14), partMaterial(material))
  head.scale.set(P.headWidthScale, 1, P.headDepthScale)
  head.position.y = P.headRadius
  head.castShadow = true
  head.receiveShadow = true
  headJoint.add(head)
  handles.set('head', jointNode(headJoint, new THREE.Vector3(0, 0.13, 0)))

  const addArm = (side) => {
    const sign = side === 'left' ? -1 : 1
    const shoulder = jointNode(
      spine,
      new THREE.Vector3(sign * P.shoulderHalfSpan, rigY(P.shoulder) - rigY(P.waist), 0)
    )
    joints.set(`${side}Shoulder`, shoulder)
    const upperArmLength = rigY(P.shoulder) - rigY(P.elbow)
    shoulder.add(cylinderPart(P.upperArmRadius, upperArmLength, -upperArmLength / 2, material))

    const elbow = jointNode(shoulder, new THREE.Vector3(0, -upperArmLength, 0))
    joints.set(`${side}Elbow`, elbow)
    handles.set(`${side}Shoulder`, elbow)

    const forearmLength = rigY(P.elbow) - rigY(P.wrist)
    elbow.add(cylinderPart(P.forearmRadius, forearmLength, -forearmLength / 2, material))

    // 手：从手腕再往下垂一小段（指尖大约落在 0.44 身高处）
    const handLength = rigY(P.wrist) - rigY(0.44)
    const hand = new THREE.Mesh(new THREE.SphereGeometry(P.handRadius, 12, 9), partMaterial(material))
    hand.scale.set(0.8, 1.5, 0.5)
    hand.position.y = -forearmLength - handLength / 2
    hand.castShadow = true
    hand.receiveShadow = true
    elbow.add(hand)
    handles.set(`${side}Elbow`, jointNode(elbow, new THREE.Vector3(0, -forearmLength - handLength, 0)))
  }

  const addLeg = (side) => {
    const sign = side === 'left' ? -1 : 1
    const hip = jointNode(root, new THREE.Vector3(sign * P.hipHalfSpan, rigY(P.hipJoint), 0))
    joints.set(`${side}Hip`, hip)

    const thighLength = rigY(P.hipJoint) - rigY(P.knee)
    hip.add(cylinderPart(P.thighRadius, thighLength, -thighLength / 2, material))

    const knee = jointNode(hip, new THREE.Vector3(0, -thighLength, 0))
    joints.set(`${side}Knee`, knee)
    handles.set(`${side}Hip`, knee)

    const shinLength = rigY(P.knee) - rigY(P.ankle)
    knee.add(cylinderPart(P.shinRadius, shinLength, -shinLength / 2, material))

    /*
     * 脚：脚底必须**恰好**落在 -0.5（包围盒契约）。
     * 所以脚的中心 = 脚底 + 半高，而不是随手写一个偏移。
     */
    const footHeight = 0.038
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.062, footHeight, 0.13), partMaterial(material))
    foot.position.set(0, -shinLength + (MANNEQUIN_RIG_BOUNDS.minY - rigY(P.ankle)) + footHeight / 2, 0.03)
    foot.castShadow = true
    foot.receiveShadow = true
    knee.add(foot)
    handles.set(`${side}Knee`, jointNode(knee, new THREE.Vector3(0, -shinLength, 0.03)))
  }

  addArm('left')
  addArm('right')
  addLeg('left')
  addLeg('right')
  root.userData.mannequinJoints = joints
  root.userData.mannequinHandles = handles
  applyMannequinPose(root, createNeutralMannequinPose())
  return { root, joints, handles }
}

/** 只摆控制骨架（纯几何体），不涉及外观层。 */
function applyMannequinControlPose(root, pose) {
  const joints = root.userData.mannequinJoints
  if (!joints) return
  for (const definition of MANNEQUIN_JOINTS) {
    const joint = joints.get(definition.id)
    if (!joint) continue
    /*
     * 用可选链读关节值：姿势可能是**部分**的（按关节通道打帧时，某个关键帧
     * 里只有被打了帧的关节）。缺关节时 `constrainMannequinJoint` 会把它按 0 摆，
     * 而不是让 `pose[id].x` 抛异常把整个渲染循环打断。
     */
    const value = constrainMannequinJoint(definition.id, pose?.[definition.id])
    joint.rotation.set(
      THREE.MathUtils.degToRad(value.x),
      THREE.MathUtils.degToRad(value.y),
      THREE.MathUtils.degToRad(value.z)
    )
  }
  root.updateMatrixWorld(true)
}

/**
 * 应用姿势：控制骨架 + 外观层。
 *
 * `visualState` 决定外观怎么摆：
 * - 省略时按"纯手动"处理（全部关节跟随控制骨架）；
 * - 传 `{ presetId, manualJoints }` 时，预设姿势打底、手动关节覆盖；
 * - 传 `{ actionTimeSeconds }` 时播放动作循环。
 *
 * 外观层可能还没加载完（GLB 是异步的），此时本函数只摆控制骨架，
 * 等外观就绪后由调用方再补一次即可。
 */
export function applyMannequinPose(root, pose, visualState) {
  applyMannequinControlPose(root, pose)
  const handles = root.userData.mannequinHandles
  const visual = root.userData.mannequinVisual
  const joints = root.userData.mannequinJoints
  const state = visualState ?? root.userData.mannequinVisualState ?? {}
  root.userData.mannequinVisualState = state
  if (joints && handles && visual) {
    updateMannequinVisual(visual, joints, handles, state)
  }
}

/** 把关节拖向世界空间中的目标点，返回新姿势（不修改原姿势）。 */
export function poseMannequinJointToward(root, startPose, jointId, worldTarget) {
  const joints = root.userData.mannequinJoints
  const joint = joints?.get(jointId)
  if (!joint?.parent) return cloneMannequinPose(startPose)

  applyMannequinPose(root, startPose)
  const origin = joint.getWorldPosition(new THREE.Vector3())
  const desired = worldTarget.clone().sub(origin)
  if (desired.lengthSq() < 1e-10) return cloneMannequinPose(startPose)
  const parentWorldQuaternion = joint.parent.getWorldQuaternion(new THREE.Quaternion()).invert()
  desired.normalize().applyQuaternion(parentWorldQuaternion).normalize()

  const nextPose = cloneMannequinPose(startPose)
  if (jointId.endsWith('Elbow') || jointId.endsWith('Knee')) {
    const projectedLength = Math.hypot(desired.y, desired.z)
    if (projectedLength < 1e-6) return nextPose
    nextPose[jointId] = constrainMannequinJoint(jointId, {
      x: THREE.MathUtils.radToDeg(Math.atan2(-desired.z, -desired.y)),
      y: startPose[jointId].y,
      z: startPose[jointId].z
    })
    return nextPose
  }

  const reference =
    jointId === 'head' || jointId === 'spine' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, -1, 0)
  const rotation = new THREE.Quaternion()
  if (reference.dot(desired) < -0.9999) {
    const direction = jointId.startsWith('left') ? -1 : 1
    rotation.setFromAxisAngle(new THREE.Vector3(0, 0, direction), Math.PI)
  } else {
    rotation.setFromUnitVectors(reference, desired)
  }
  const euler = new THREE.Euler().setFromQuaternion(rotation, 'XYZ')
  const start = startPose[jointId]
  const nearest = (value, reference) => {
    let result = value
    while (result - reference > 180) result -= 360
    while (result - reference < -180) result += 360
    return result
  }
  nextPose[jointId] = constrainMannequinJoint(jointId, {
    x: nearest(THREE.MathUtils.radToDeg(euler.x), start.x),
    y: nearest(THREE.MathUtils.radToDeg(euler.y), start.y),
    z: nearest(THREE.MathUtils.radToDeg(euler.z), start.z)
  })
  return nextPose
}

export function readMannequinPose(root) {
  const joints = root.userData.mannequinJoints
  if (!joints) return undefined
  return Object.fromEntries(
    MANNEQUIN_JOINTS.map(({ id }) => {
      const joint = joints.get(id)
      const value = joint
        ? {
            x: THREE.MathUtils.radToDeg(joint.rotation.x),
            y: THREE.MathUtils.radToDeg(joint.rotation.y),
            z: THREE.MathUtils.radToDeg(joint.rotation.z)
          }
        : zero()
      return [id, constrainMannequinJoint(id, value)]
    })
  )
}
