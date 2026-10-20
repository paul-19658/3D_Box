/**
 * 光照描述：把灯光整理成人类可读、也能直接放进提示词的文字。
 *
 * 与后端 `app/services/scene_output.py::describe_lighting` 必须输出一致的内容。
 * 保持一致的原因：导出的场景说明由后端生成，画布中的提示由前端生成，
 * 两边措辞不一致会让用户怀疑软件"说的和做的不一样"。
 */

import { FIXED_FILL_LIGHT, FIXED_HEMISPHERE_LIGHT } from './project-document'

export const MAX_SHADOW_CASTING_LIGHTS = 2

const LIGHT_KIND_LABELS = {
  point: '点光源',
  spot: '聚光灯',
  area: '面光',
  sun: '日光'
}

function round(value) {
  return Math.round(value * 100) / 100
}

function roundVector(value) {
  return { x: round(value.x), y: round(value.y), z: round(value.z) }
}

/**
 * 选出真正投射阴影的灯光 id。
 * 渲染与文字描述共用本函数，杜绝"描述说投影但画面没有"。
 */
export function resolveShadowCasterIds(lights) {
  const ids = new Set()
  for (const light of lights) {
    if (ids.size >= MAX_SHADOW_CASTING_LIGHTS) break
    if (!light.visible) continue
    // 面光（RectAreaLight）在 three.js 中不支持阴影，不占名额。
    if (light.kind === 'area') continue
    ids.add(light.id)
  }
  return ids
}

/**
 * 光源相对被照物体的水平方位，输出八方向。
 *
 * 坐标约定与摄影机一致：+X 为画面右侧，+Z 为靠近摄影机的场景前方。
 * 按 sin(22.5°) ≈ 0.383 分界判定，组合出"左后方"这类方位。
 */
export function lightSideText(position, target) {
  const deltaX = position.x - target.x
  const deltaZ = position.z - target.z
  const horizontal = Math.hypot(deltaX, deltaZ)
  if (horizontal < 0.05) return '正上方'
  const unitX = deltaX / horizontal
  const unitZ = deltaZ / horizontal
  const threshold = 0.383
  const rightText = unitX > threshold ? '右' : unitX < -threshold ? '左' : ''
  const frontText = unitZ > threshold ? '前' : unitZ < -threshold ? '后' : ''
  return `${rightText}${frontText}方`
}

/** 光源相对被照物体的高度，按俯仰角判定。 */
export function lightHeightText(position, target) {
  const horizontal = Math.hypot(position.x - target.x, position.z - target.z)
  const elevation = (Math.atan2(position.y - target.y, Math.max(horizontal, 0.001)) * 180) / Math.PI
  if (elevation >= 65) return '接近正上方（顶光）'
  if (elevation >= 35) return '较高（高位光）'
  if (elevation >= 10) return '略高（中位光）'
  if (elevation > -10) return '与物体同高（平光）'
  return '低于物体（底光）'
}

function parseHexColor(color) {
  const match = /^#([0-9a-f]{6})$/i.exec((color || '').trim())
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

/**
 * 把十六进制颜色翻译成"暖白光 / 冷青色光"这类可读色调。
 *
 * 判定分两步：先用色度占比判断中性白/淡色/浓色，再用色相区分冷暖。
 * 直接用 HSL 饱和度会把 #fff1d6 这类高明度暖白误判成高饱和橙色。
 */
export function lightColorText(color) {
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

export function lightIntensityText(intensity) {
  if (intensity <= 0.05) return '几乎关闭'
  if (intensity < 1) return '较弱'
  if (intensity < 3) return '适中'
  if (intensity < 6) return '较强'
  return '很强'
}

export function describeLight(light, castShadow) {
  const sideText = lightSideText(light.position, light.target)
  const heightText = lightHeightText(light.position, light.target)
  const colorText = lightColorText(light.color)
  const intensityText = lightIntensityText(light.intensity)
  const shadowText = castShadow ? '，投射可见阴影' : ''
  const hiddenText = light.visible ? '' : '（当前已隐藏，不参与照明）'
  const kindLabel = LIGHT_KIND_LABELS[light.kind] || '灯光'
  return {
    id: light.id,
    name: light.name,
    kind: light.kind,
    kindLabel,
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
    summary: `${kindLabel}「${light.name}」：位于物体${sideText}、${heightText}，${colorText}，强度 ${round(
      light.intensity
    )}（${intensityText}）${shadowText}${hiddenText}。`
  }
}

function fixedAmbientText() {
  const fillSide = lightSideText(FIXED_FILL_LIGHT.position, FIXED_FILL_LIGHT.target)
  const fillHeight = lightHeightText(FIXED_FILL_LIGHT.position, FIXED_FILL_LIGHT.target)
  return `固定环境光：半球光（天空 ${FIXED_HEMISPHERE_LIGHT.skyColor} / 地面 ${FIXED_HEMISPHERE_LIGHT.groundColor}，强度 ${FIXED_HEMISPHERE_LIGHT.intensity}）与方向补光（${FIXED_FILL_LIGHT.color}，强度 ${FIXED_FILL_LIGHT.intensity}，来自物体${fillSide}、${fillHeight}），为整个场景提供基础照明，不会产生阴影。`
}

export function describeLighting(lights) {
  const shadowCasterIds = resolveShadowCasterIds(lights)
  const described = lights.map((light) => describeLight(light, shadowCasterIds.has(light.id)))
  const visibleLights = described.filter((light) => light.visible)
  const shadowCasterNames = described.filter((light) => light.castShadow).map((light) => light.name)

  const promptLines = ['光照：']
  for (const light of described) promptLines.push(`- ${light.summary}`)
  promptLines.push(`- ${fixedAmbientText()}`)
  if (shadowCasterNames.length > 0) {
    promptLines.push(`- 阴影：仅 ${shadowCasterNames.join('、')} 投射阴影；阴影方向应与该光源位置一致。`)
  } else {
    promptLines.push('- 阴影：当前没有灯光投射阴影，画面以均匀照明为主。')
  }

  const visibleShadowCasters = described.filter((light) => light.castShadow).length
  const primary = visibleLights[0]
  const summaryLine = primary
    ? `光照：共 ${lights.length} 盏可编辑灯光（可见 ${visibleLights.length} 盏，其中 ${visibleShadowCasters} 盏投射阴影），另有固定半球环境光与方向补光。主光为${primary.summary}`
    : '光照：没有可编辑灯光，仅使用固定半球环境光与方向补光。'

  return { lights: described, visibleLights, shadowCasterNames, promptLines, summaryLine }
}
