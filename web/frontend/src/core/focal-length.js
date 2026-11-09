/**
 * 焦距 ↔ 视场角换算（纯逻辑，零依赖）。
 *
 * ## 为什么需要这个模块
 *
 * 焦距和视场角是**同一个量的两种表达**，不是两个独立参数。本项目内部
 * 只存 `fovDegrees`（它是唯一真值），焦距只是界面上更符合摄影直觉的
 * 另一种输入方式。存两份就会出现"改了 fov、焦距显示不同步"这类漂移，
 * 所以这里只做换算，不引入新字段。
 *
 * ## 口径：与 three.js 的 `PerspectiveCamera` 完全一致
 *
 * three.js 内置了物理相机模型（`filmGauge` 默认 35mm）：
 *
 * ```js
 * getFilmHeight() { return this.filmGauge / Math.max(this.aspect, 1) }
 * getFilmWidth()  { return this.filmGauge * Math.min(this.aspect, 1) }
 * setFocalLength(f) { this.fov = RAD2DEG * 2 * Math.atan(0.5 * this.getFilmHeight() / f) }
 * getFocalLength()  { return 0.5 * this.getFilmHeight() / Math.tan(DEG2RAD * 0.5 * this.fov) }
 * ```
 *
 * 关键含义：**画幅的长边永远占满整个 filmGauge**。
 * 于是横屏时横向视野固定、竖屏时纵向视野固定——换画幅不会让镜头
 * "突然变成另一个焦段"。这与渲染器内部算法逐字一致，
 * 因此界面上显示的焦距与实际渲染出的视野永远对得上。
 *
 * 本模块刻意**不 import THREE**：它要能进 `core/` 的纯逻辑层，
 * 被时间轴求值（逐帧）与界面同时调用。
 */

/** 默认画幅规格（mm），与 three.js `PerspectiveCamera.filmGauge` 默认值一致。 */
export const DEFAULT_FILM_GAUGE_MM = 35

/**
 * 垂直视场角的允许范围（度）。
 *
 * 这组数字**必须只有一个来源**：之前 InspectorPanel 与 AI 命令里各写了一遍
 * `10 / 120`，加焦距时才发现它把镜头卡在约 5.7~112mm，135mm 长焦根本设不出来。
 *
 * 放宽到 5°~140° 后，16:9 下大约对应 3.6mm ~ 225mm，覆盖超广角到长焦。
 * 下限 5° 是防止数值退化（视野趋近 0 时投影矩阵会出现极端值），
 * 上限 140° 是避免超过 180° 后出现镜像。
 */
export const MIN_FOV_DEGREES = 5
export const MAX_FOV_DEGREES = 140

/** 把视场角夹到允许范围内；非法值回退默认 42°。 */
export function clampFovDegrees(value) {
  const fov = Number(value)
  if (!Number.isFinite(fov)) return 42
  return Math.min(Math.max(fov, MIN_FOV_DEGREES), MAX_FOV_DEGREES)
}

/** 常用焦段预设（mm），给界面做一键选择。 */
export const FOCAL_LENGTH_PRESETS = [
  { mm: 14, label: '14 超广角' },
  { mm: 24, label: '24 广角' },
  { mm: 35, label: '35 人文' },
  { mm: 50, label: '50 标准' },
  { mm: 85, label: '85 人像' },
  { mm: 135, label: '135 长焦' }
]

/**
 * 本项目的画幅比（宽/高）。
 *
 * 复用 `aspectWidth / aspectHeight` 而不是另存一个数：项目里已经有这两个
 * 字段，再存一份 aspect 就会出现两处不一致。
 */
export function aspectRatioOf(camera) {
  const width = Number(camera?.aspectWidth)
  const height = Number(camera?.aspectHeight)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 16 / 9
  return width / height
}

/** 感光元件高度（mm）。长边占满 gauge，所以高 = gauge / max(aspect, 1)。 */
export function filmHeightMm(aspect, filmGauge = DEFAULT_FILM_GAUGE_MM) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  return filmGauge / Math.max(safeAspect, 1)
}

/** 感光元件宽度（mm）。长边占满 gauge，所以宽 = gauge * min(aspect, 1)。 */
export function filmWidthMm(aspect, filmGauge = DEFAULT_FILM_GAUGE_MM) {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  return filmGauge * Math.min(safeAspect, 1)
}

/**
 * 焦距 → 垂直视场角（度）。
 *
 * 注意是**垂直**视场角：three.js 的 `camera.fov` 就是垂直角，
 * 项目的 `fovDegrees` 也一直按垂直角使用（视锥计算、导出都依赖这一点）。
 */
export function fovDegreesFromFocalLength(focalLengthMm, aspect, filmGauge = DEFAULT_FILM_GAUGE_MM) {
  const focal = Number(focalLengthMm)
  if (!Number.isFinite(focal) || focal <= 0) return null
  const slope = (0.5 * filmHeightMm(aspect, filmGauge)) / focal
  return (2 * Math.atan(slope) * 180) / Math.PI
}

/** 垂直视场角（度）→ 焦距（mm）。`fovDegreesFromFocalLength` 的逆运算。 */
export function focalLengthFromFovDegrees(fovDegrees, aspect, filmGauge = DEFAULT_FILM_GAUGE_MM) {
  const fov = Number(fovDegrees)
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) return null
  const slope = Math.tan(((fov / 2) * Math.PI) / 180)
  if (slope <= 0) return null
  return (0.5 * filmHeightMm(aspect, filmGauge)) / slope
}

/**
 * 切换输出画幅时应该写入相机的补丁：**保持镜头不变**。
 *
 * 依据是本项目沿用的 three.js `filmGauge` 模型——**长边永远占满 filmGauge**。
 * 于是同一颗镜头换画幅，等价于摄影里"换传感器尺寸、镜头不换"：
 * 长边的视野固定，短边的视野随画幅比例变化；焦距保持不变。
 *
 * 反过来说，**只改 `aspectWidth/aspectHeight` 而不动 `fovDegrees` 是错的**：
 * `fovDegrees` 是垂直视场角，画幅一变它的含义就跟着变。实测（镜头 25.64mm）：
 *
 * | 画幅 | 只改画幅（旧行为） | 保持镜头（本函数） |
 * | --- | --- | --- |
 * | 16:9 | fov 42°，焦距 25.64mm | 同左 |
 * | 21:9 | fov 42°，焦距 **19.54mm**（无端变广角） | fov 32.7°，焦距 25.64mm |
 * | 9:16 | fov 42°，焦距 **45.59mm**（无端变长焦） | fov 68.6°，焦距 25.64mm |
 *
 * 也就是说旧行为下"选个宽画幅画面就变扁、选个竖画幅画面就变窄"，
 * 而面板上显示的焦距还是那个数——两边对不上。
 *
 * @returns {{aspectWidth:number, aspectHeight:number, fovDegrees:number}}
 */
export function aspectChangePatch(camera, width, height) {
  const nextWidth = Number(width)
  const nextHeight = Number(height)
  const safeWidth = Number.isFinite(nextWidth) && nextWidth > 0 ? nextWidth : 16
  const safeHeight = Number.isFinite(nextHeight) && nextHeight > 0 ? nextHeight : 9
  const patch = { aspectWidth: safeWidth, aspectHeight: safeHeight }

  const previousAspect = aspectRatioOf(camera)
  const previousFov = Number(camera?.fovDegrees)
  const focal = focalLengthFromFovDegrees(previousFov, previousAspect)
  // 老数据可能有非法 fov；此时退化为"不动视场角"，至少不会算出 NaN。
  if (!Number.isFinite(focal) || focal <= 0) return patch

  const nextFov = fovDegreesFromFocalLength(focal, safeWidth / safeHeight)
  if (!Number.isFinite(nextFov)) return patch
  patch.fovDegrees = clampFovDegrees(nextFov)
  return patch
}

/**
 * 水平视场角（度），用于界面提示与成片描述。
 *
 * 摄影里说"视角"通常指水平方向；而 `camera.fov` 是垂直方向。
 * 两者都提供出来，避免用户拿垂直角去和相机参数对比时觉得对不上。
 */
export function horizontalFovDegrees(fovDegrees, aspect) {
  const fov = Number(fovDegrees)
  if (!Number.isFinite(fov) || fov <= 0 || fov >= 180) return null
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const verticalSlope = Math.tan(((fov / 2) * Math.PI) / 180)
  return (2 * Math.atan(verticalSlope * safeAspect) * 180) / Math.PI
}

/**
 * 按"等效全画幅焦距"描述镜头，用于给 AI 平台的提示词。
 *
 * 用 43.27mm 对角线（36×24 全画幅）做口径，这是相机厂商标称"等效焦距"
 * 的通行做法。只在文案里出现，不参与渲染计算——渲染一律走 filmGauge 模型，
 * 免得出现"提示词写 50mm、渲染按另一个口径"这种不一致。
 */
export function equivalentFullFrameFocalLength(focalLengthMm, aspect) {
  const focal = Number(focalLengthMm)
  if (!Number.isFinite(focal) || focal <= 0) return null
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9
  const height = filmHeightMm(safeAspect)
  const width = filmWidthMm(safeAspect)
  const diagonal = Math.hypot(width, height)
  const fullFrameDiagonal = Math.hypot(36, 24)
  if (diagonal <= 0) return null
  return (focal * fullFrameDiagonal) / diagonal
}

/** 把焦距描述成一句人话，用于成片说明与提示词。 */
export function describeFocalLength(focalLengthMm, aspect) {
  const focal = Number(focalLengthMm)
  if (!Number.isFinite(focal) || focal <= 0) return ''
  const rounded = Math.round(focal * 10) / 10
  const equivalent = equivalentFullFrameFocalLength(focal, aspect)
  const equivalentText = equivalent ? `（等效全画幅 ${Math.round(equivalent)}mm）` : ''
  return `${rounded}mm${equivalentText}`
}

/**
 * 相机镜头的完整描述，用于成片说明与 AI 提示词。
 *
 * 为什么要写进提示词：AI 图像/视频平台对"50mm 镜头""长焦压缩感"这类
 * 摄影术语反应很直接，比"视场角 39 度"有效得多。这是本项目的核心价值
 * ——输出要能被 AI 理解。
 */
export function describeCameraLens(camera) {
  const aspect = aspectRatioOf(camera)
  const focal = focalLengthFromFovDegrees(camera?.fovDegrees, aspect)
  if (!Number.isFinite(focal)) return ''
  return describeFocalLength(focal, aspect)
}
