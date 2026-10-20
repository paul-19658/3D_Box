/**
 * 人台外观层：Quaternius CC0 骨骼模型的加载、预设姿势采样与动作播放。
 * 移植自 `app/src/renderer/src/mannequin/mannequin-visual.ts`。
 *
 * 分工：
 * - `mannequin.js` 里的控制骨架负责"用户能抓的关节"，是纯几何体；
 * - 本模块负责"看起来像个人"，是带蒙皮的 GLB 模型。
 *
 * 两者靠骨骼方向对齐：控制骨架的关节朝向（joint → 子节点）驱动
 * GLB 对应骨骼的朝向，因此拖动白模关节时外观会同步跟着动。
 *
 * 三个容易出错的地方，都在代码里标了注释：
 * 1. 骨骼左右是**镜像**的（左肩映射到 `upperarm_r`），这是模型自身约定；
 * 2. 预设姿势要从动作片段的特定时刻**采样**，而不是手写角度；
 * 3. 播放动画时必须停掉姿态覆盖，否则动画会被每帧覆盖回去。
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'

/**
 * 人台模型地址。
 *
 * 放在 `public/` 而不是 `src/assets/` 走 import，是刻意的：
 * 1. 7.3MB 的二进制不该被任何打包器当成模块解析——webpack 的
 *    asset/resource 虽然能处理，但 vitest（Vite 内核）会因为
 *    `.glb` 不是合法 JS 而直接报"invalid JS syntax"，把纯逻辑测试一起拖垮；
 * 2. 放 public 后它是纯静态文件，构建不参与哈希与压缩，加载路径稳定；
 * 3. `core/` 保持纯净：这个模块只依赖一个字符串常量，不引入打包器特性。
 *
 * URL 用相对路径，配合 SPA 的根路径部署（后端把 dist 挂在 /）。
 */
export const MANNEQUIN_ASSET_URL = 'mannequin/quaternius-ual1-standard.glb'

/**
 * 每个预设对应哪个动作片段、在第几秒采样。
 *
 * 这些时间点是原版实测挑出来的：取"动作循环里最有代表性的那一帧"，
 * 比如站立取 0.6s（重心最稳），伸手取 1s（手臂完全抬起的瞬间）。
 */
export const OFFICIAL_POSE_SOURCES = {
  stand: { clip: 'Idle_Loop', timeSeconds: 0.6 },
  sit: { clip: 'Sitting_Idle_Loop', timeSeconds: 0.5 },
  'raise-hand': { clip: 'Interact', timeSeconds: 1 },
  walk: { clip: 'Walk_Loop', timeSeconds: 0 },
  run: { clip: 'Sprint_Loop', timeSeconds: 0 }
}

/**
 * 把工程文档里的 `mannequin` 数据翻译成外观层需要的状态。
 *
 * 动作时间不存盘：它来自时间轴的当前时间（与原版一致）。
 * 也就是说人台在原地"活着"——站立时播待机、跑步时播冲刺，
 * 播放头一动，动作就跟着走，不需要在工程文件里记录播放进度。
 *
 * `manualJoints` 决定哪些关节被用户手动覆盖过；只有这些关节
 * 才允许用控制骨架的朝向去矫正外观骨骼，否则会把采样出来的
 * 人体姿态改坏。
 */
export function mannequinVisualState(mannequin, actionTimeSeconds) {
  if (!mannequin) return {}
  return {
    presetId: mannequin.presetId,
    manualJoints: mannequin.manualJoints ?? [],
    actionTimeSeconds,
    presetBlend: mannequin.presetBlend
  }
}

/**
 * 控制骨架关节 → GLB 骨骼名。
 *
 * 注意左右是反的：模型的 `_r` 后缀骨骼在视觉上位于画面左侧
 * （模型面向 -Z，观察者在 +Z 看它），所以 left* 映射到 `*_r`。
 * 这里的 `child` 用来算"骨骼朝向"——拿它相对父骨骼的位置当作
 * 该关节伸出去的方向，再让外观骨骼对准这个方向。
 */
const VISUAL_BONE_NAMES = {
  spine: { bone: 'spine_01', child: 'spine_02' },
  head: { bone: 'Head' },
  leftShoulder: { bone: 'upperarm_r', child: 'lowerarm_r' },
  rightShoulder: { bone: 'upperarm_l', child: 'lowerarm_l' },
  leftElbow: { bone: 'lowerarm_r', child: 'hand_r' },
  rightElbow: { bone: 'lowerarm_l', child: 'hand_l' },
  leftHip: { bone: 'thigh_r', child: 'calf_r' },
  rightHip: { bone: 'thigh_l', child: 'calf_l' },
  leftKnee: { bone: 'calf_r', child: 'foot_r' },
  rightKnee: { bone: 'calf_l', child: 'foot_l' }
}

let assetPromise = null
let posePromise = null

/**
 * 加载 GLB。
 *
 * 失败时把 promise 置回 null，否则一次网络抖动会让后续重试永远拿到
 * 同一个 rejected promise，表现为"人台再也加载不出来"。
 */
function loadAsset() {
  if (!assetPromise) {
    assetPromise = new GLTFLoader()
      .loadAsync(MANNEQUIN_ASSET_URL)
      .catch((error) => {
        assetPromise = null
        throw error
      })
  }
  return assetPromise
}

function boneMap(root) {
  const bones = new Map()
  root.traverse((object) => {
    if (object instanceof THREE.Bone) bones.set(object.name, object)
  })
  return bones
}

function snapshotBones(root) {
  return new Map(
    [...boneMap(root)].map(([name, bone]) => [
      name,
      {
        position: bone.position.clone(),
        quaternion: bone.quaternion.clone(),
        scale: bone.scale.clone()
      }
    ])
  )
}

/** 采样全部预设姿势。只做一次，结果被所有实例共享。 */
function loadOfficialPoses() {
  if (!posePromise) {
    posePromise = loadAsset()
      .then((source) => {
        const poses = new Map()
        for (const [presetId, sourcePose] of Object.entries(OFFICIAL_POSE_SOURCES)) {
          // 必须用 SkeletonUtils.clone：普通 clone 不复制骨骼绑定关系，
          // 拿到的 SkinnedMesh 会指向原模型的骨骼，播放时会互相干扰。
          const sourceRoot = cloneSkeleton(source.scene)
          const clip = THREE.AnimationClip.findByName(source.animations, sourcePose.clip)
          if (!clip) throw new Error(`人台动作资源缺少“${sourcePose.clip}”。`)
          const mixer = new THREE.AnimationMixer(sourceRoot)
          mixer.clipAction(clip).play()
          // setTime 之后一定要 updateMatrixWorld：采样读的是世界矩阵链。
          mixer.setTime(Math.min(sourcePose.timeSeconds, clip.duration))
          sourceRoot.updateMatrixWorld(true)
          poses.set(presetId, snapshotBones(sourceRoot))
          mixer.stopAllAction()
        }
        return poses
      })
      .catch((error) => {
        posePromise = null
        throw error
      })
  }
  return posePromise
}

function findNamedObject(root, name) {
  const object = root.getObjectByName(name)
  if (!object) throw new Error(`人台资源缺少骨骼“${name}”。`)
  return object
}

/**
 * 归一化：把模型缩放到 1 米高、脚底对齐 y=-0.5。
 *
 * 为什么是 -0.5 而不是 0：控制骨架的根节点在髋部（y=0），
 * 整个身体向下延伸约 0.5 米。外观必须用同一套基准，
 * 否则人物会浮在空中或陷进地里。
 */
function normalizeVisual(content) {
  content.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(content)
  const size = bounds.getSize(new THREE.Vector3())
  if (!Number.isFinite(size.y) || size.y <= 0) throw new Error('人台资源没有有效高度。')
  const center = bounds.getCenter(new THREE.Vector3())
  const scale = 1 / size.y
  content.scale.setScalar(scale)
  content.position.set(-center.x * scale, -0.5 - bounds.min.y * scale, -center.z * scale)
  content.updateMatrixWorld(true)
  return content
}

/**
 * 换成白模材质。
 *
 * 原版是白模草稿工具，人台不该带贴图与自发光；
 * 同时关掉 frustumCulled，避免蒙皮变形后包围盒失准导致整块消失。
 */
function applyWhiteboxMaterial(root, source) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return
    object.geometry = object.geometry.clone()
    object.material = source.clone()
    object.castShadow = true
    object.receiveShadow = true
    object.frustumCulled = false
  })
}

function buildBindings(root) {
  return new Map(
    Object.entries(VISUAL_BONE_NAMES).map(([jointId, names]) => {
      const bone = findNamedObject(root, names.bone)
      if (!(bone instanceof THREE.Bone)) throw new Error(`“${names.bone}”不是有效骨骼。`)
      const restQuaternion = bone.quaternion.clone()
      const endpoint = names.child ? findNamedObject(root, names.child) : undefined
      // 静止姿态下"这根骨头指向哪"：取子骨骼在父空间的局部位置。
      const localDirection = names.child ? endpoint.position.clone() : new THREE.Vector3(0, 1, 0)
      const restDirectionInParent = localDirection.applyQuaternion(restQuaternion).normalize()
      return [jointId, { bone, endpoint, restQuaternion, restDirectionInParent }]
    })
  )
}

/**
 * 创建外观实例。
 *
 * 每次调用都会 clone 一份模型：人台可以放多个，各自独立摆姿势，
 * 共用同一份源数据只会让骨骼互相串味。
 */
export async function createMannequinVisual(material) {
  const [source, officialPoses] = await Promise.all([loadAsset(), loadOfficialPoses()])

  const content = normalizeVisual(cloneSkeleton(source.scene))
  applyWhiteboxMaterial(content, material)

  const root = new THREE.Group()
  root.name = 'Quaternius CC0 人台外观'
  root.userData.mannequinVisualRoot = true
  root.add(content)

  const actionClips = new Map()
  for (const [presetId, action] of Object.entries(OFFICIAL_POSE_SOURCES)) {
    const clip = THREE.AnimationClip.findByName(source.animations, action.clip)
    if (!clip) throw new Error(`人台动作资源缺少“${action.clip}”。`)
    actionClips.set(presetId, clip)
  }

  return {
    root,
    bindings: buildBindings(content),
    bones: boneMap(content),
    restPose: snapshotBones(content),
    officialPoses,
    actionClips,
    mixer: new THREE.AnimationMixer(content)
  }
}

/** 导出用的静态快照：把蒙皮变形烘焙进顶点，摆脱骨骼依赖。 */
export function bakeSkinnedPose(root) {
  root.updateMatrixWorld(true)
  const vertex = new THREE.Vector3()
  root.traverse((object) => {
    if (!(object instanceof THREE.SkinnedMesh)) return
    object.skeleton.update()
    const geometry = object.geometry.clone()
    const sourcePositions = geometry.getAttribute('position')
    if (!(sourcePositions instanceof THREE.BufferAttribute)) return
    const bakedPositions = sourcePositions.clone()
    for (let index = 0; index < bakedPositions.count; index += 1) {
      object.getVertexPosition(index, vertex)
      bakedPositions.setXYZ(index, vertex.x, vertex.y, vertex.z)
    }
    geometry.setAttribute('position', bakedPositions)
    geometry.deleteAttribute('skinIndex')
    geometry.deleteAttribute('skinWeight')
    geometry.computeVertexNormals()
    object.geometry = geometry
  })
}

/**
 * 更新外观姿态。
 *
 * `state` 取值：
 * - `presetId`：用哪个预设的基础姿势
 * - `manualJoints`：用户手动拖过的关节（只有这些关节会被控制骨架覆盖）
 * - `actionTimeSeconds`：非空则播动作循环（此时预设姿势不参与）
 * - `presetBlend`：两个预设之间插值，用于时间轴切换动作的过渡
 */
export function updateMannequinVisual(visual, joints, handles, state = {}) {
  const origin = new THREE.Vector3()
  const endpoint = new THREE.Vector3()
  const parentQuaternion = new THREE.Quaternion()
  const desiredDirection = new THREE.Vector3()
  const correction = new THREE.Quaternion()

  // 有动作时间就不叠预设姿势：否则动画每帧被静态姿势盖掉，看起来"不动"。
  const actionClip =
    state.actionTimeSeconds !== undefined && state.presetId && !state.presetBlend
      ? visual.actionClips.get(state.presetId)
      : undefined

  if (actionClip) {
    const duration = actionClip.duration
    const actionTime =
      duration > 0 ? (((state.actionTimeSeconds ?? 0) % duration) + duration) % duration : 0
    visual.mixer.stopAllAction()
    const action = visual.mixer.clipAction(actionClip)
    action.reset().play()
    action.time = actionTime
    visual.mixer.update(0)
    visual.root.userData.mannequinActionClip = actionClip.name
    visual.root.userData.mannequinActionTime = actionTime
  } else {
    visual.mixer.stopAllAction()
    delete visual.root.userData.mannequinActionClip
    delete visual.root.userData.mannequinActionTime
  }

  const firstPose = state.presetBlend?.from
    ? visual.officialPoses.get(state.presetBlend.from)
    : state.presetId
      ? visual.officialPoses.get(state.presetId)
      : undefined
  const secondPose = state.presetBlend?.to
    ? visual.officialPoses.get(state.presetBlend.to)
    : firstPose
  const blend = THREE.MathUtils.clamp(state.presetBlend?.amount ?? 0, 0, 1)

  if (!actionClip) {
    for (const [name, bone] of visual.bones) {
      const rest = visual.restPose.get(name)
      const first = firstPose?.get(name) ?? rest
      const second = secondPose?.get(name) ?? first
      if (!first || !second) continue
      bone.position.copy(first.position).lerp(second.position, blend)
      bone.quaternion.copy(first.quaternion).slerp(second.quaternion, blend)
      bone.scale.copy(first.scale).lerp(second.scale, blend)
    }
  }

  /*
   * 哪些关节要被控制骨架"接管"：
   * - 有预设姿势时，只接管用户手动改过的关节（否则会把预设姿势改坏）；
   * - 没有任何姿势信息时，接管全部关节（纯手动模式）。
   */
  const overridden = new Set(
    state.presetId || state.presetBlend ? state.manualJoints ?? [] : [...visual.bindings.keys()]
  )

  visual.root.updateMatrixWorld(true)
  for (const [jointId, binding] of visual.bindings) {
    if (!overridden.has(jointId)) continue
    const joint = joints.get(jointId)
    const handle = handles.get(jointId)
    const parent = binding.bone.parent
    if (!joint || !handle || !parent) continue

    // 控制骨架里"关节 → 下一个关节"的世界方向，就是外观骨骼该指的方向。
    joint.getWorldPosition(origin)
    handle.getWorldPosition(endpoint)
    desiredDirection.copy(endpoint).sub(origin)
    if (desiredDirection.lengthSq() < 1e-10) continue
    desiredDirection.normalize()

    // 转到父骨骼的局部空间，再求一个"从静止方向转到目标方向"的增量四元数。
    parent.getWorldQuaternion(parentQuaternion).invert()
    desiredDirection.applyQuaternion(parentQuaternion).normalize()
    correction.setFromUnitVectors(binding.restDirectionInParent, desiredDirection)
    binding.bone.quaternion.copy(correction.multiply(binding.restQuaternion))
    binding.bone.updateMatrix()
    binding.bone.updateMatrixWorld(true)
  }
}

/**
 * 关节手柄的真实世界位置。
 *
 * 用了官方预设姿势时，控制骨架的关节位置与外观骨骼并不完全重合
 * （预设是采样出来的真实人体姿态）。此时拖拽手柄应该跟着外观走，
 * 否则用户会觉得"抓的位置和看到的位置差了半只手"。
 */
export function mannequinVisualHandlePosition(root, jointId, target = new THREE.Vector3()) {
  const visual = root.userData.mannequinVisual
  const state = root.userData.mannequinVisualState
  const binding = visual?.bindings.get(jointId)
  const usesOfficialPose = Boolean(state?.presetId || state?.presetBlend)
  const manuallyOverridden = state?.manualJoints?.includes(jointId) ?? false
  if (!usesOfficialPose || manuallyOverridden || !binding?.endpoint) return null
  return binding.endpoint.getWorldPosition(target)
}
