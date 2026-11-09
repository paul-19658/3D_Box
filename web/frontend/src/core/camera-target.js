/**
 * 相机 target 绑定：让相机锁定并跟随场景里的一个物体。
 *
 * 对标 Maya 的「把相机 center of interest 约束到某个物体」：
 * 设定之后，相机的看向点不再是一个写死的坐标，而是那个物体**当前**的位置。
 * 物体动了（包括走导航线、播关键帧动画），相机就跟着看过去。
 *
 * ## 为什么存 `targetObjectId` 而不是每帧把坐标烘进 `camera.target`
 *
 * 如果把物体位置烘进 `target`，那么物体一动就要重算并改相机数据：
 * - 播放时每帧都在改相机 → 撤销栈与"是否有未保存修改"会被动画自己刷爆；
 * - 导出逐帧求值时会基于已烘过的值再算，误差会累积。
 * 存一个引用、在求值时解析，语义干净且可逆：解除绑定后 `target` 还是原来的静态点。
 *
 * ## 坐标原点不一致的坑
 *
 * 本项目物体的 `position` 语义**按类型不同**：
 * - 基本体（box/cylinder/sphere/wall/floor/custom/path）创建时
 *   `position.y = size.y / 2`，也就是 position 就是**几何中心**；
 * - 人台与导入模型创建时 `position.y = 0`，position 在**底部**（脚底 / 模型原点）。
 *
 * 所以"看向一个物体"不能一律用 `position`，否则对着人台就是对着脚看。
 * `objectFocusPoint()` 负责抹平这个差异，新增物体类型时**必须**在这里登记。
 */

/** position 位于物体底部的类型；其余类型 position 即几何中心。 */
const BASE_ORIGIN_KINDS = new Set(['mannequin', 'imported'])

/**
 * 计算"相机看向该物体时应该对准的点"，即物体在竖直方向上的视觉中心。
 *
 * 基本体直接返回 position；底部原点的类型抬升半个高度。
 * 只依赖 position / size / kind，不建几何体，因此可以在逐帧求值里调用。
 */
export function objectFocusPoint(object) {
  if (!object || typeof object !== 'object') return null
  const position = object.position
  if (!position) return null
  const x = Number.isFinite(position.x) ? position.x : 0
  const y = Number.isFinite(position.y) ? position.y : 0
  const z = Number.isFinite(position.z) ? position.z : 0
  if (!BASE_ORIGIN_KINDS.has(object.kind)) return { x, y, z }
  const height = Number.isFinite(object.size?.y) ? object.size.y : 0
  return { x, y: y + height / 2, z }
}

/** 相机是否绑定了物体 target（只表示"有引用"，不代表已启用）。 */
export function isTargetBound(camera) {
  return Boolean(camera && typeof camera.targetObjectId === 'string' && camera.targetObjectId.length > 0)
}

/**
 * 看向绑定是否**实际生效**，即"有引用且开关打开"。
 *
 * 分成两个概念是有意的：`targetObjectId` 只是记着"绑的是谁"，
 * `lookAtEnabled` 决定这一刻用不用它。用户想临时回到手动朝向、
 * 又不想丢掉绑定关系时，关掉开关即可，再勾回来无需重新拖拽。
 *
 * `lookAtEnabled` 缺省（v14 及更早的工程没有这个字段）视为启用，
 * 保证老工程行为不变。
 */
export function isTargetActive(camera) {
  if (!isTargetBound(camera)) return false
  return camera.lookAtEnabled !== false
}

/**
 * 解算相机在某组物体下的实际看向点。
 *
 * 绑定失效（物体被删、或还没加载出来）时**退回静态 `target`**，
 * 而不是让相机看向原点：静默跳视角比"看起来没绑定"更难排查。
 * 绑定被**关闭**（`lookAtEnabled === false`）时同样退回静态 `target`，
 * 但绑定关系保留，随时可以重新打开。
 *
 * @param {object} camera 相机（可能带 `targetObjectId`）
 * @param {Array} objects 该时刻的物体列表（应已应用关键帧与导航线绑定）
 * @returns {object} 新的相机对象（未生效时原样返回同一个引用）
 */
export function resolveCameraTarget(camera, objects) {
  if (!isTargetActive(camera)) return camera
  const list = Array.isArray(objects) ? objects : []
  const bound = list.find((object) => object?.id === camera.targetObjectId)
  const focus = objectFocusPoint(bound)
  if (!focus) return camera
  return { ...camera, target: focus }
}

/**
 * 绑定是否指向一个仍然存在的物体。
 *
 * UI 用它区分"已绑定"和"绑定的物体已经不在了"——后者要给用户一个明确的
 * 解除入口，否则用户会看到 target 数字在跳却不知道原因。
 * 注意这里**不看开关**：关掉开关但物体还在时，绑定依然是"健康"的。
 */
export function isTargetBindingAlive(camera, objects) {
  if (!isTargetBound(camera)) return false
  const list = Array.isArray(objects) ? objects : []
  return list.some((object) => object?.id === camera.targetObjectId)
}

/** 生成带绑定的相机补丁；传 null 表示解除绑定。 */
export function targetBindingPatch(objectId) {
  if (!objectId) return { targetObjectId: null }
  return { targetObjectId: String(objectId) }
}

/** 生成"启用/关闭看向"的相机补丁。 */
export function lookAtEnabledPatch(enabled) {
  return { lookAtEnabled: Boolean(enabled) }
}
