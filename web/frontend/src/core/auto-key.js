/**
 * 自动关键帧（Auto Key）：纯逻辑层（无 DOM、无 Vue、无 three 依赖）。
 *
 * 对标 Maya 的 Auto Key / Blender 的 Auto Keying：开关打开后，
 * 用户对"可动画属性"的任何修改都会自动在当前播放头时刻打一个关键帧，
 * 省掉反复点「记录关键帧」。
 *
 * ## 为什么用"对比前后场景"而不是"在每个入口埋点"
 *
 * 改变换的入口有六七处（gizmo 拖拽、属性面板、多选拖拽、相机浮层、
 * 人台预设、AI 命令…），逐个埋点必然漏，而且以后新增入口还要记得补。
 * 这里改成在唯一写入层对比 `prevScene` 与 `nextScene`，天然全覆盖。
 * 代价是每次写入做一次浅层对比——物体数量通常在百以内，开销可忽略。
 *
 * ## 与求值层的约定
 *
 * 关键帧与镜头的**数据形状必须与求值层完全一致**，否则会静默出问题：
 * - 物体：`{ id, objectId, timeSeconds, interpolation, transform }`，
 *   其中 `transform` 的字段被 `evaluateTrack` 读取；
 * - 相机：`{ id, name, timeSeconds, transition, camera }`。
 * 形状不一致时求值不会报错，只会算出错误画面，因此这里集中构造。
 */

/** 浮点比较容差：小于这个量级的差异不算"用户改了东西"。 */
const EPSILON = 1e-6

/**
 * 从物体提取"可动画"字段。
 *
 * 刻意只取位姿与人台姿势：颜色、名称、显隐、锁定都不该进关键帧，
 * 否则改个颜色就会打一帧，撤销栈很快被垃圾帧填满。
 *
 * `mannequinManualJoints` 必须一起存：外观层靠它判断哪些关节是
 * 用户手动摆过的。漏掉它会导致预览时手动关节被动作预设覆盖回去。
 */
export function buildObjectTransform(object) {
  if (!object) return null
  const transform = {
    position: cloneVector(object.position),
    rotation: cloneVector(object.rotation),
    size: cloneVector(object.size)
  }
  if (object.mannequin) {
    transform.mannequinPose = object.mannequin.pose
      ? clonePose(object.mannequin.pose)
      : undefined
    transform.mannequinPresetId = object.mannequin.presetId
    transform.mannequinManualJoints = Array.isArray(object.mannequin.manualJoints)
      ? [...object.mannequin.manualJoints]
      : undefined
  }
  return transform
}

/**
 * 从相机提取"可动画"字段。
 *
 * **刻意不含 `aspectWidth` / `aspectHeight`**：画幅是全局输出设置，
 * 不是随时间变化的动画属性。把画幅打进镜头关键帧会导致
 * "改一次画幅，所有镜头都变成旧画幅"。
 */
export function buildCameraState(camera) {
  if (!camera) return null
  return {
    position: cloneVector(camera.position),
    target: cloneVector(camera.target),
    fovDegrees: number(camera.fovDegrees),
    aspectWidth: number(camera.aspectWidth),
    aspectHeight: number(camera.aspectHeight)
  }
}

function cloneVector(value) {
  if (!value || typeof value !== 'object') return { x: 0, y: 0, z: 0 }
  return { x: number(value.x), y: number(value.y), z: number(value.z) }
}

function clonePose(pose) {
  if (!pose || typeof pose !== 'object') return undefined
  const result = {}
  for (const [jointId, value] of Object.entries(pose)) {
    result[jointId] = cloneVector(value)
  }
  return result
}

function number(value) {
  return Number.isFinite(value) ? value : 0
}

function vectorChanged(a, b) {
  if (!a || !b) return true
  return (
    Math.abs(number(a.x) - number(b.x)) > EPSILON ||
    Math.abs(number(a.y) - number(b.y)) > EPSILON ||
    Math.abs(number(a.z) - number(b.z)) > EPSILON
  )
}

function poseChanged(a, b) {
  if (!a && !b) return false
  if (!a || !b) return true
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (vectorChanged(a[key], b[key])) return true
  }
  return false
}

function jointsChanged(a, b) {
  const left = Array.isArray(a) ? a : []
  const right = Array.isArray(b) ? b : []
  if (left.length !== right.length) return true
  return left.some((value, index) => value !== right[index])
}

/**
 * 对比两个物体的可动画字段，判断是否发生了变化。
 *
 * 只比较"会进关键帧"的字段，与 `buildObjectTransform` 严格对应：
 * 两边字段集合不一致时，这里会判成"没变"而漏掉关键帧，
 * 所以新增可动画字段必须同时改这两个函数。
 */
export function objectTransformChanged(prevObject, nextObject) {
  if (!prevObject || !nextObject) return false
  if (vectorChanged(prevObject.position, nextObject.position)) return true
  if (vectorChanged(prevObject.rotation, nextObject.rotation)) return true
  if (vectorChanged(prevObject.size, nextObject.size)) return true

  const prevMannequin = prevObject.mannequin
  const nextMannequin = nextObject.mannequin
  if (!prevMannequin && !nextMannequin) return false
  if (!prevMannequin || !nextMannequin) return true
  if (poseChanged(prevMannequin.pose, nextMannequin.pose)) return true
  if (prevMannequin.presetId !== nextMannequin.presetId) return true
  return jointsChanged(prevMannequin.manualJoints, nextMannequin.manualJoints)
}

/** 相机是否发生了"该打帧"的变化（不含画幅）。 */
export function cameraChanged(prevCamera, nextCamera) {
  if (!prevCamera || !nextCamera) return false
  if (vectorChanged(prevCamera.position, nextCamera.position)) return true
  if (vectorChanged(prevCamera.target, nextCamera.target)) return true
  return Math.abs(number(prevCamera.fovDegrees) - number(nextCamera.fovDegrees)) > EPSILON
}

/**
 * 对比前后场景，找出需要自动打帧的目标。
 *
 * 只处理"前后都存在且内容变了"的物体：
 * - 新增物体不打帧（Maya 里新建对象不会自动产生关键帧）；
 * - 删除物体不打帧（否则删掉的物体会在时间轴上留下孤儿轨道）。
 *
 * @returns {{objects: Array<{objectId:string, transform:object}>, camera: object|null}}
 */
export function collectAutoKeyTargets(prevScene, nextScene) {
  const empty = { objects: [], camera: null }
  if (!prevScene || !nextScene) return empty

  const prevObjects = Array.isArray(prevScene.objects) ? prevScene.objects : []
  const nextObjects = Array.isArray(nextScene.objects) ? nextScene.objects : []
  const prevById = new Map(prevObjects.filter((item) => item?.id).map((item) => [item.id, item]))

  const objects = []
  for (const nextObject of nextObjects) {
    if (!nextObject?.id) continue
    const prevObject = prevById.get(nextObject.id)
    if (!prevObject) continue
    // 锁定的物体不该被写动画：用户锁它就是为了防误改。
    if (nextObject.locked) continue
    if (!objectTransformChanged(prevObject, nextObject)) continue
    const transform = buildObjectTransform(nextObject)
    if (transform) objects.push({ objectId: nextObject.id, transform })
  }

  const camera = cameraChanged(prevScene.camera, nextScene.camera)
    ? buildCameraState(nextScene.camera)
    : null

  return { objects, camera }
}

/**
 * 在指定时刻写入物体关键帧：**同一时刻已存在则覆盖，不追加**。
 *
 * 为什么必须覆盖：实测同一时刻存在两个关键帧时，求值会取后一个、
 * 静默丢弃前一个；若同一时刻堆了 30 帧，中间时刻的插值会出现
 * 异常跳变（x 从 0 直接跳到 64.5）。也就是说"重复追加"不会崩，
 * 但数据会悄悄劣化——这类问题在成片里才发现，反馈链太长。
 *
 * @param {Array} keyframes 现有全部关键帧
 * @param {{objectId:string, timeSeconds:number, transform:object, id:string, interpolation?:string}} input
 * @returns {Array} 新的关键帧数组（已按时间排序）
 */
export function upsertObjectKeyframe(keyframes, input) {
  const list = Array.isArray(keyframes) ? keyframes : []
  const time = number(input.timeSeconds)
  const rest = list.filter(
    (item) => !(item.objectId === input.objectId && Math.abs(number(item.timeSeconds) - time) <= EPSILON)
  )
  const existing = list.find(
    (item) => item.objectId === input.objectId && Math.abs(number(item.timeSeconds) - time) <= EPSILON
  )
  const next = {
    // 覆盖时沿用原 id：时间轴上的选中状态与轨道高亮都挂在 id 上，
    // 换新 id 会让"正在选中的那一帧"突然消失。
    id: existing?.id || input.id,
    objectId: input.objectId,
    timeSeconds: time,
    interpolation: input.interpolation || existing?.interpolation || 'smooth',
    transform: input.transform
  }
  return [...rest, next].sort((a, b) => number(a.timeSeconds) - number(b.timeSeconds))
}

/**
 * 在指定时刻写入相机镜头：同一时刻已存在则覆盖。
 *
 * `transition` 沿用现有规则：第一个镜头用 `cut`，其余用 `smooth`。
 * 覆盖已有镜头时保留它原本的 transition——用户手动调过的切换方式
 * 不该被自动打帧改回去。
 */
export function upsertCameraShot(shots, input) {
  const list = Array.isArray(shots) ? shots : []
  const time = number(input.timeSeconds)
  const existing = list.find((item) => Math.abs(number(item.timeSeconds) - time) <= EPSILON)
  const rest = list.filter((item) => Math.abs(number(item.timeSeconds) - time) > EPSILON)
  const next = {
    id: existing?.id || input.id,
    name: existing?.name || input.name,
    timeSeconds: time,
    transition: existing?.transition || (rest.length === 0 ? 'cut' : 'smooth'),
    camera: input.camera
  }
  return [...rest, next].sort((a, b) => number(a.timeSeconds) - number(b.timeSeconds))
}

/**
 * 自动打帧总开关：判断此刻是否应该生效。
 *
 * 播放中**不打帧**是有意的安全取舍：播放时播放头在跑，
 * 此时拖动物体会把关键帧写到"正好路过"的时刻上，
 * 产生用户完全没预期的数据。Maya 允许这么做，但对本项目
 * 的目标用户（零基础创作者）来说，静默写入的代价更大。
 */
export function shouldAutoKey({ enabled, playing, readOnly, timeSeconds, durationSeconds }) {
  if (!enabled) return false
  if (playing) return false
  if (readOnly) return false
  if (!Number.isFinite(timeSeconds)) return false
  if (Number.isFinite(durationSeconds) && timeSeconds < 0) return false
  return true
}

/**
 * 主入口：把自动关键帧应用到一次场景变更上。
 *
 * 与"改属性"合并成**同一个新场景对象**返回，这样一次操作在撤销栈里
 * 只留一帧。分成两次 `editScene` 的话，用户要按两次 Ctrl+Z 才能撤回
 * 一次拖动，手感会很怪。
 *
 * @param {object} prevScene 变更前的场景
 * @param {object} nextScene 变更后的场景
 * @param {object} options
 * @param {boolean} options.enabled 自动打帧开关
 * @param {boolean} [options.playing] 是否正在播放
 * @param {boolean} [options.readOnly] 是否只读工程
 * @param {number} options.timeSeconds 当前播放头时刻
 * @param {() => string} options.createId id 生成器（由调用方注入，保持本模块纯净）
 * @param {object} [options.targets] 已算好的 `collectAutoKeyTargets()` 结果。
 *   调用方若还需要这份数据（例如"手动编辑覆盖"也要用），可先算一次传进来，
 *   避免同一帧重复遍历场景。
 * @returns {object} 可能已插入关键帧的新场景
 */
export function applyAutoKey(prevScene, nextScene, options) {
  if (!prevScene || !nextScene) return nextScene
  if (!shouldAutoKey(options)) return nextScene
  if (!nextScene.timeline) return nextScene

  const targets = options.targets ?? collectAutoKeyTargets(prevScene, nextScene)
  if (targets.objects.length === 0 && !targets.camera) return nextScene

  let keyframes = nextScene.timeline.objectKeyframes
  for (const target of targets.objects) {
    keyframes = upsertObjectKeyframe(keyframes, {
      id: options.createId(),
      objectId: target.objectId,
      timeSeconds: options.timeSeconds,
      transform: target.transform
    })
  }

  let shots = nextScene.timeline.cameraShots
  if (targets.camera) {
    shots = upsertCameraShot(shots, {
      id: options.createId(),
      name: `镜头 ${String(shots.length + 1).padStart(2, '0')}`,
      timeSeconds: options.timeSeconds,
      camera: targets.camera
    })
  }

  return {
    ...nextScene,
    timeline: {
      ...nextScene.timeline,
      objectKeyframes: keyframes,
      cameraShots: shots
    }
  }
}
