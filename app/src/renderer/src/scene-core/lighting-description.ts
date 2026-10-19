import type { SceneLightData, Vector3Value } from '../../../shared/project-document'

/**
 * 光照的自然语言描述。
 *
 * 把“可编辑灯光 + 固定场景光”整理成人类可读、也能直接放进提示词的文字，
 * 让生成式 AI 视频/图像模型知道：光从哪个方向来、是什么色调、强度如何、谁在投射阴影。
 *
 * 本模块是纯函数实现，不依赖 three.js，便于单元测试，也能在导出与对话等
 * 非渲染场景中复用。
 */

export const LIGHT_KIND_LABELS: Record<SceneLightData['kind'], string> = {
  point: '点光源',
  spot: '聚光灯',
  area: '面光',
  sun: '日光'
}

/**
 * 固定场景光（半球环境光 + 方向补光）的参数。
 * 与三维视口中的实现保持单一来源，避免描述与实际渲染漂移。
 */
export const FIXED_HEMISPHERE_LIGHT = {
  skyColor: '#ffffff',
  groundColor: '#a9b0b1',
  intensity: 1.15
} as const

export const FIXED_FILL_LIGHT = {
  color: '#e5f4f1',
  intensity: 0.42,
  position: { x: -5, y: 4, z: -3 } as Vector3Value,
  target: { x: 0, y: 0, z: 0 } as Vector3Value
} as const

/**
 * 同时投射阴影的灯光数量上限。
 * 面光（RectAreaLight）在 three.js 中不支持阴影，因此不占用名额。
 */
export const MAX_SHADOW_CASTING_LIGHTS = 2

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function roundVector(value: Vector3Value): Vector3Value {
  return { x: round(value.x), y: round(value.y), z: round(value.z) }
}

/**
 * 选出真正投射阴影的灯光 id：只统计可见且支持阴影的灯光，按场景顺序取前 N 盏。
 * 三维视口与文字描述都调用本函数，保证“说的”和“看到的”一致。
 */
export function resolveShadowCasterIds(lights: SceneLightData[]): Set<string> {
  const ids = new Set<string>()
  for (const light of lights) {
    if (ids.size >= MAX_SHADOW_CASTING_LIGHTS) break
    if (!light.visible) continue
    if (light.kind === 'area') continue
    ids.add(light.id)
  }
  return ids
}

/**
 * 光源相对被照物体的水平方位，输出八方向（前方 / 右前方 / 右侧 …）。
 *
 * 坐标约定与摄影机一致：+X 为画面右侧，+Z 为靠近摄影机的场景前方。
 * 把水平位移归一化后按 ±22.5 度分界判定，组合出“左后方”这类方位，
 * 生成式模型对组合方位比单一“左侧”更容易还原真实光照关系。
 */
export function lightSideText(position: Vector3Value, target: Vector3Value): string {
  const deltaX = position.x - target.x
  const deltaZ = position.z - target.z
  const horizontal = Math.hypot(deltaX, deltaZ)
  if (horizontal < 0.05) return '正上方'
  const unitX = deltaX / horizontal
  const unitZ = deltaZ / horizontal
  // sin(22.5°) ≈ 0.383，低于该阈值视为该轴方向不显著。
  const threshold = 0.383
  const rightText = unitX > threshold ? '右' : unitX < -threshold ? '左' : ''
  const frontText = unitZ > threshold ? '前' : unitZ < -threshold ? '后' : ''
  return `${rightText}${frontText}方`
}

/**
 * 光源相对被照物体的高度。用俯仰角判断，避免“很高的灯但离得很近”这类误判。
 */
export function lightHeightText(position: Vector3Value, target: Vector3Value): string {
  const horizontal = Math.hypot(position.x - target.x, position.z - target.z)
  const elevation = (Math.atan2(position.y - target.y, Math.max(horizontal, 0.001)) * 180) / Math.PI
  if (elevation >= 65) return '接近正上方（顶光）'
  if (elevation >= 35) return '较高（高位光）'
  if (elevation >= 10) return '略高（中位光）'
  if (elevation > -10) return '与物体同高（平光）'
  return '低于物体（底光）'
}

interface RgbColor {
  r: number
  g: number
  b: number
}

function parseHexColor(color: string): RgbColor | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/**
 * 把十六进制颜色翻译成“暖白光 / 冷青色光”这类可读色调。
 *
 * 判定分两步：先用“色度占比” (max-min)/max 判断是中性白、淡色还是浓色，
 * 再用色相区分冷暖。直接用 HSL 饱和度会把 #fff1d6 这类高明度暖白误判成
 * 高饱和橙色——它的绝对色差很小，视觉上仍是暖白。
 */
export function lightColorText(color: string): string {
  const rgb = parseHexColor(color)
  if (!rgb) return '未知色调'
  const red = rgb.r / 255
  const green = rgb.g / 255
  const blue = rgb.b / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  if (max === 0) return '中性白光'
  const chroma = delta / max
  if (chroma < 0.06) return '中性白光'
  let hue = 0
  if (delta > 0) {
    if (max === red) hue = 60 * (((green - blue) / delta) % 6)
    else if (max === green) hue = 60 * ((blue - red) / delta + 2)
    else hue = 60 * ((red - green) / delta + 4)
  }
  if (hue < 0) hue += 360
  const warm = hue < 90 || hue >= 300
  const cool = hue >= 90 && hue < 270
  if (chroma < 0.3) return warm ? '暖白光' : cool ? '冷白光' : '淡色光'
  if (hue < 20 || hue >= 330) return '偏红色光'
  if (hue < 45) return '暖橙色光'
  if (hue < 70) return '暖黄色光'
  if (hue < 160) return '偏绿色光'
  if (hue < 200) return '冷青色光'
  if (hue < 270) return '偏蓝色光'
  return '偏紫色光'
}

export function lightIntensityText(intensity: number): string {
  if (intensity <= 0.05) return '几乎关闭'
  if (intensity < 1) return '较弱'
  if (intensity < 3) return '适中'
  if (intensity < 6) return '较强'
  return '很强'
}

export interface LightDescription {
  id: string
  name: string
  kind: SceneLightData['kind']
  kindLabel: string
  color: string
  colorText: string
  intensity: number
  intensityText: string
  position: Vector3Value
  target: Vector3Value
  visible: boolean
  castShadow: boolean
  sideText: string
  heightText: string
  /** 一句话摘要，可直接用于提示词或对话。 */
  summary: string
}

export function describeLight(light: SceneLightData, castShadow: boolean): LightDescription {
  const sideText = lightSideText(light.position, light.target)
  const heightText = lightHeightText(light.position, light.target)
  const colorText = lightColorText(light.color)
  const intensityText = lightIntensityText(light.intensity)
  const shadowText = castShadow ? '，投射可见阴影' : ''
  const hiddenText = light.visible ? '' : '（当前已隐藏，不参与照明）'
  const summary = `${LIGHT_KIND_LABELS[light.kind]}「${light.name}」：位于物体${sideText}、${heightText}，${colorText}，强度 ${round(light.intensity)}（${intensityText}）${shadowText}${hiddenText}。`
  return {
    id: light.id,
    name: light.name,
    kind: light.kind,
    kindLabel: LIGHT_KIND_LABELS[light.kind],
    color: light.color,
    colorText,
    intensity: round(light.intensity),
    intensityText,
    position: roundVector(light.position),
    target: roundVector(light.target),
    visible: light.visible,
    castShadow,
    sideText,
    heightText,
    summary
  }
}

export interface LightingDescription {
  lights: LightDescription[]
  visibleLights: LightDescription[]
  shadowCasterNames: string[]
  /** 供提示词使用的多行文本。 */
  promptLines: string[]
  /** 一句话摘要，供 AI 对话使用。 */
  summaryLine: string
}

function fixedAmbientText(): string {
  const fillSide = lightSideText(FIXED_FILL_LIGHT.position, FIXED_FILL_LIGHT.target)
  const fillHeight = lightHeightText(FIXED_FILL_LIGHT.position, FIXED_FILL_LIGHT.target)
  return `固定环境光：半球光（天空 ${FIXED_HEMISPHERE_LIGHT.skyColor} / 地面 ${FIXED_HEMISPHERE_LIGHT.groundColor}，强度 ${FIXED_HEMISPHERE_LIGHT.intensity}）与方向补光（${FIXED_FILL_LIGHT.color}，强度 ${FIXED_FILL_LIGHT.intensity}，来自物体${fillSide}、${fillHeight}），为整个场景提供基础照明，不会产生阴影。`
}

/**
 * 汇总整个场景的光照，供场景说明 JSON、建议提示词与 AI 对话共用。
 */
export function describeLighting(lights: SceneLightData[]): LightingDescription {
  const shadowCasterIds = resolveShadowCasterIds(lights)
  const described = lights.map((light) => describeLight(light, shadowCasterIds.has(light.id)))
  const visibleLights = described.filter((light) => light.visible)
  const shadowCasterNames = described.filter((light) => light.castShadow).map((light) => light.name)

  const promptLines: string[] = ['光照：']
  for (const light of described) {
    promptLines.push(`- ${light.summary}`)
  }
  promptLines.push(`- ${fixedAmbientText()}`)
  if (shadowCasterNames.length > 0) {
    promptLines.push(
      `- 阴影：仅 ${shadowCasterNames.join('、')} 投射阴影；阴影方向应与该光源位置一致。`
    )
  } else {
    promptLines.push('- 阴影：当前没有灯光投射阴影，画面以均匀照明为主。')
  }

  const visibleShadowCasters = described.filter((light) => light.castShadow).length
  const primary = visibleLights[0]
  const summaryLine = primary
    ? `光照：共 ${lights.length} 盏可编辑灯光（可见 ${visibleLights.length} 盏，其中 ${visibleShadowCasters} 盏投射阴影），另有固定半球环境光与方向补光。主光为${primary.summary}`
    : `光照：没有可编辑灯光，仅使用固定半球环境光与方向补光。`

  return {
    lights: described,
    visibleLights,
    shadowCasterNames,
    promptLines,
    summaryLine
  }
}
