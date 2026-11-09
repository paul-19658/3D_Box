/**
 * 相机视角导航：纯逻辑层（无 DOM、无 Vue、无 three 依赖）。
 *
 * 用途：把"用户在视口里的导航手势"翻译成"场景摄影机的新位姿"。
 *
 * 为什么单独成模块：
 * 1. 这是唯一会写回场景相机的计算，必须能被穷举单测；
 * 2. 导航方案是可插拔的（当前 WASD 飞行，未来可能换成纯 Maya 环绕），
 *    策略与执行分离后，换方案不用碰组件；
 * 3. `core/` 不许依赖 DOM，因此"按键 → 位移量"这类换算全部收在这里，
 *    组件只负责把键盘状态喂进来。
 *
 * 坐标约定（重要，项目里踩过坑）：
 * - three 的 `Camera` 是 **-Z 朝向目标**，普通 `Object3D` 是 **+Z**。
 *   本模块一律按**相机语义**（-Z 为前）计算，组件里不要再二次翻转。
 * - 位移用**米**，与场景单位一致。
 */

/** 导航方案标识。当前默认 `wasd`，保留 `orbit` 以便随时切换。 */
export const CAMERA_NAV_SCHEMES = ['wasd', 'orbit']

export const DEFAULT_CAMERA_NAV_SCHEME = 'wasd'

/**
 * WASD 默认参数。
 *
 * 速度刻意做成"每秒米数"而不是"每帧米数"：
 * 帧率在 30~144 之间浮动，按帧给位移会让快机器上移动变快，
 * 同一份操作在不同机器上手感不一致。
 */
export const WASD_DEFAULTS = {
  /** 水平移动速度（米/秒）。 */
  moveSpeed: 6,
  /** 升降速度（米/秒）。比水平略慢，俯仰时不易失控。 */
  verticalSpeed: 4,
  /** 中键拖拽转向灵敏度（弧度/像素）。 */
  lookSensitivity: 0.0032,
  /** 俯仰角上下限（弧度），防止翻过头导致画面上下颠倒。 */
  maxPitch: Math.PI / 2 - 0.02,
  /** 按住 Shift 时的加速倍率。 */
  boostMultiplier: 2.5
}

/**
 * 判定键盘事件是否来自"正在输入"的元素。
 *
 * 为什么必须判：编辑器里有大量数值输入框与工程名输入框，
 * 用户在框里打 "wasd" 会被当成相机移动，输入框内容反而进不去。
 * 这类冲突必须在设计阶段解决，事后补必然漏。
 *
 * @param {EventTarget|null} target
 */
export function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false
  const tagName = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : ''
  if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') return true
  return target.isContentEditable === true
}

/**
 * 把键盘状态翻译成"相机本地坐标系下的移动意图"。
 *
 * 返回值是本地轴上的分量，不是世界坐标：
 * 前后沿相机自身的 -Z（相机前方），左右沿 +X（相机右方）。
 * 组件拿到后要经相机四元数旋转才是世界位移——这样"往前飞"永远是
 * "朝我看的方向飞"，而不是永远朝世界 -Z。
 *
 * @param {{forward:boolean,backward:boolean,left:boolean,right:boolean,up:boolean,down:boolean}} keys
 * @returns {{x:number,y:number,z:number}} 本地轴意图，各分量 ∈ {-1,0,1}
 */
export function movementIntentFromKeys(keys) {
  const state = keys || {}
  const forward = state.forward ? 1 : 0
  const backward = state.backward ? 1 : 0
  const left = state.left ? 1 : 0
  const right = state.right ? 1 : 0
  const up = state.up ? 1 : 0
  const down = state.down ? 1 : 0
  // 相反方向同时按下应互相抵消，否则会出现"按着 W 又按 S 反而更快"的怪现象。
  return {
    x: right - left,
    y: up - down,
    z: backward - forward
  }
}

/**
 * 计算这一帧的相机世界位移。
 *
 * @param {object} params
 * @param {number} params.deltaSeconds 距上一帧的秒数（已做上限保护）
 * @param {object} params.intent `movementIntentFromKeys` 的结果
 * @param {boolean} [params.boost] 是否按住加速键
 * @param {number[]} params.quaternion 相机四元数 `[x,y,z,w]`
 * @param {object} [params.speed] 速度覆盖，默认 `WASD_DEFAULTS`
 * @returns {{x:number,y:number,z:number}} 世界坐标位移（米）
 */
export function computeFlyOffset({
  deltaSeconds,
  intent,
  boost = false,
  quaternion,
  speed = WASD_DEFAULTS
}) {
  const step = clampDelta(deltaSeconds)
  const axis = intent || { x: 0, y: 0, z: 0 }
  if (axis.x === 0 && axis.y === 0 && axis.z === 0) return { x: 0, y: 0, z: 0 }

  const factor = boost ? speed.boostMultiplier : 1
  // 水平与垂直分开给速度：俯仰飞行时升降不该跟着水平速度放大。
  const local = {
    x: axis.x * speed.moveSpeed * factor * step,
    y: axis.y * speed.verticalSpeed * factor * step,
    z: axis.z * speed.moveSpeed * factor * step
  }
  return rotateByQuaternion(local, quaternion)
}

/**
 * 帧间隔上限保护。
 *
 * 切到别的标签页再回来时，`requestAnimationFrame` 的间隔可能是好几秒，
 * 不设上限会让相机"瞬移"到很远的地方。0.1 秒≈10fps 的下限足够平滑。
 */
export function clampDelta(deltaSeconds) {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0
  return Math.min(deltaSeconds, 0.1)
}

/**
 * 用四元数旋转一个向量（本地 → 世界）。
 *
 * 手写而不用 three 的 `Vector3.applyQuaternion`，是为了让本模块保持
 * 零依赖、能在 Node 里直接跑单测（`core/` 的硬约定）。
 * 公式：v' = v + 2w(q×v) + 2(q×(q×v))
 */
export function rotateByQuaternion(vector, quaternion) {
  if (!Array.isArray(quaternion) || quaternion.length !== 4) return { ...vector }
  const [qx, qy, qz, qw] = quaternion
  const { x, y, z } = vector
  const cross = (ax, ay, az, bx, by, bz) => ({
    x: ay * bz - az * by,
    y: az * bx - ax * bz,
    z: ax * by - ay * bx
  })
  const t = cross(qx, qy, qz, x, y, z)
  const t2 = cross(qx, qy, qz, t.x, t.y, t.z)
  return {
    x: x + 2 * (qw * t.x + t2.x),
    y: y + 2 * (qw * t.y + t2.y),
    z: z + 2 * (qw * t.z + t2.z)
  }
}

/**
 * 中键拖拽 → 新的相机朝向（yaw / pitch）。
 *
 * @param {object} params
 * @param {number} params.yaw 当前偏航角（弧度）
 * @param {number} params.pitch 当前俯仰角（弧度）
 * @param {number} params.deltaX 鼠标水平位移（像素）
 * @param {number} params.deltaY 鼠标垂直位移（像素）
 * @param {number} [params.sensitivity]
 * @returns {{yaw:number,pitch:number}}
 */
export function applyLookDelta({ yaw, pitch, deltaX, deltaY, sensitivity = WASD_DEFAULTS.lookSensitivity }) {
  const safeYaw = Number.isFinite(yaw) ? yaw : 0
  const safePitch = Number.isFinite(pitch) ? pitch : 0
  const nextYaw = safeYaw - (Number(deltaX) || 0) * sensitivity
  // 鼠标下移（deltaY > 0）应该"低头"，因此 pitch 取负增量。
  const rawPitch = safePitch - (Number(deltaY) || 0) * sensitivity
  return {
    yaw: nextYaw,
    pitch: Math.min(Math.max(rawPitch, -WASD_DEFAULTS.maxPitch), WASD_DEFAULTS.maxPitch)
  }
}

/**
 * 由 yaw / pitch 与注视距离反算场景相机的 `{position, target}`。
 *
 * 本项目的场景相机用「机位 + 注视点」表达，而不是欧拉角，
 * 所以飞行过程中必须保留一个"注视距离"，否则 target 会塌到机位上，
 * 导致画面变成纯旋转（Maya 里 dolly 到底的感觉），用户会迷路。
 *
 * @param {object} params
 * @param {{x:number,y:number,z:number}} params.position 新的机位
 * @param {number} params.yaw
 * @param {number} params.pitch
 * @param {number} params.distance 注视距离（米）
 * @returns {{position:object,target:object}}
 */
export function cameraTargetFromOrientation({ position, yaw, pitch, distance }) {
  const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 1
  const safeYaw = Number.isFinite(yaw) ? yaw : 0
  const safePitch = Number.isFinite(pitch) ? pitch : 0
  // 与相机语义一致：前方是 -Z。yaw 绕 Y，pitch 绕 X。
  const cosPitch = Math.cos(safePitch)
  const forward = {
    x: -Math.sin(safeYaw) * cosPitch,
    y: Math.sin(safePitch),
    z: -Math.cos(safeYaw) * cosPitch
  }
  return {
    position: { x: position.x, y: position.y, z: position.z },
    target: {
      x: position.x + forward.x * safeDistance,
      y: position.y + forward.y * safeDistance,
      z: position.z + forward.z * safeDistance
    }
  }
}

/**
 * 由「机位 + 注视点」反算 yaw / pitch / 距离，用于进入飞行模式时对齐朝向。
 *
 * @param {{position:object,target:object}} camera
 * @returns {{yaw:number,pitch:number,distance:number}}
 */
export function orientationFromCameraTarget(camera) {
  const position = camera?.position || { x: 0, y: 0, z: 0 }
  const target = camera?.target || { x: 0, y: 0, z: 0 }
  const dx = (target.x ?? 0) - (position.x ?? 0)
  const dy = (target.y ?? 0) - (position.y ?? 0)
  const dz = (target.z ?? 0) - (position.z ?? 0)
  const distance = Math.hypot(dx, dy, dz)
  if (distance < 1e-6) return { yaw: 0, pitch: 0, distance: 0 }
  return {
    // 与 cameraTargetFromOrientation 互为逆运算：forward.x = -sin(yaw)cos(pitch)
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.asin(Math.min(Math.max(dy / distance, -1), 1)),
    distance
  }
}

/**
 * 导航方案注册表：把"方案名"映射到"如何消费输入"。
 *
 * 字段含义：
 * - `consumesKeyboard`：是否由本模块处理 WASD；
 * - `consumesPointerLook`：是否由本模块处理中键拖拽转向；
 * - `ownsCamera`：**相机是否由本模块独占驱动**。
 *
 * `ownsCamera` 这个字段是踩坑之后加的，非常关键：
 * OrbitControls 的 `update()` 每帧都会执行 `camera.lookAt(target)`，
 * 并按 `position - target` 反推球坐标再写回位置。因此只要它还在跑，
 * 手工推进的相机就会被两件事破坏：
 *   1. 朝向被强制指回旧 target，用户在 navState 里的 yaw/pitch 不生效；
 *   2. 相机飞近注视点时半径趋近 0，球坐标退化，相机被钉死在 target 上
 *      （表现为"往前飞了一段后突然不动了"）。
 * 所以 `wasd` 方案必须独占相机（跳过 `controls.update()`），
 * 而 `orbit` 方案正好相反——它就是要让 OrbitControls 来驱动。
 */
export const NAV_SCHEME_HANDLERS = {
  wasd: { consumesKeyboard: true, consumesPointerLook: true, ownsCamera: true },
  orbit: { consumesKeyboard: false, consumesPointerLook: false, ownsCamera: false }
}

export function navSchemeHandler(scheme) {
  return NAV_SCHEME_HANDLERS[scheme] || NAV_SCHEME_HANDLERS[DEFAULT_CAMERA_NAV_SCHEME]
}

/**
 * 相机视角下是否应该继续运行 OrbitControls.update()。
 *
 * 非相机视角时始终为真（编辑视角本来就归 OrbitControls 管）。
 */
export function shouldRunOrbitControls(cameraViewActive, scheme) {
  if (!cameraViewActive) return true
  return !navSchemeHandler(scheme).ownsCamera
}
