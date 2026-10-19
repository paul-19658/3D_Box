import { describe, expect, it } from 'vitest'
import type { SceneLightData } from '../../../shared/project-document'
import {
  MAX_SHADOW_CASTING_LIGHTS,
  describeLight,
  describeLighting,
  lightColorText,
  lightHeightText,
  lightIntensityText,
  lightSideText,
  resolveShadowCasterIds
} from './lighting-description'

function lightWith(overrides: Partial<SceneLightData> = {}): SceneLightData {
  return {
    id: 'light-1',
    name: '点光源 01',
    kind: 'point',
    position: { x: 3, y: 5, z: 3 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff1d6',
    intensity: 3.2,
    size: 0.35,
    angleDegrees: 45,
    visible: true,
    locked: false,
    ...overrides
  }
}

describe('lightSideText', () => {
  it('水平位移过小时判定为上方', () => {
    expect(lightSideText({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 })).toBe('正上方')
  })

  it('识别四个正方向', () => {
    expect(lightSideText({ x: 0, y: 1, z: 5 }, { x: 0, y: 0, z: 0 })).toBe('前方')
    expect(lightSideText({ x: 0, y: 1, z: -5 }, { x: 0, y: 0, z: 0 })).toBe('后方')
    expect(lightSideText({ x: 5, y: 1, z: 0 }, { x: 0, y: 0, z: 0 })).toBe('右方')
    expect(lightSideText({ x: -5, y: 1, z: 0 }, { x: 0, y: 0, z: 0 })).toBe('左方')
  })

  it('识别组合方位，便于生成式模型还原光位', () => {
    expect(lightSideText({ x: 5, y: 1, z: 5 }, { x: 0, y: 0, z: 0 })).toBe('右前方')
    expect(lightSideText({ x: -5, y: 1, z: -5 }, { x: 0, y: 0, z: 0 })).toBe('左后方')
  })

  it('以目标点为参照，而不是世界原点', () => {
    expect(lightSideText({ x: 5, y: 1, z: 10 }, { x: 0, y: 0, z: 5 })).toBe('右前方')
  })
})

describe('lightHeightText', () => {
  it('按俯仰角区分顶光、高位光与平光', () => {
    expect(lightHeightText({ x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('顶光')
    expect(lightHeightText({ x: 3, y: 3, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('高位光')
    expect(lightHeightText({ x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('平光')
    expect(lightHeightText({ x: 0, y: -3, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('底光')
  })

  it('距离很近但位置偏高时仍按俯仰角判断', () => {
    expect(lightHeightText({ x: 0.5, y: 3, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('顶光')
  })
})

describe('lightColorText', () => {
  it('识别中性白光', () => {
    expect(lightColorText('#ffffff')).toBe('中性白光')
    expect(lightColorText('#f2f2f2')).toBe('中性白光')
  })

  it('高明度暖白按“暖白光”描述，而不是误报高饱和橙色', () => {
    expect(lightColorText('#fff1d6')).toBe('暖白光')
    expect(lightColorText('#e5f4f1')).toBe('冷白光')
  })

  it('识别浓色暖色与冷色', () => {
    expect(lightColorText('#ff3b30')).toBe('偏红色光')
    expect(lightColorText('#ffb020')).toBe('暖橙色光')
    expect(lightColorText('#3b6bff')).toBe('偏蓝色光')
    expect(lightColorText('#33d6c0')).toBe('冷青色光')
  })

  it('非法颜色返回未知色调而不是抛错', () => {
    expect(lightColorText('not-a-color')).toBe('未知色调')
    expect(lightColorText('#fff')).toBe('未知色调')
  })
})

describe('lightIntensityText', () => {
  it('按强度分档', () => {
    expect(lightIntensityText(0)).toBe('几乎关闭')
    expect(lightIntensityText(0.5)).toBe('较弱')
    expect(lightIntensityText(2)).toBe('适中')
    expect(lightIntensityText(4)).toBe('较强')
    expect(lightIntensityText(9)).toBe('很强')
  })
})

describe('resolveShadowCasterIds', () => {
  it('只统计可见且支持阴影的灯光，并受名额上限约束', () => {
    const lights = [
      lightWith({ id: 'a', kind: 'sun' }),
      lightWith({ id: 'b', kind: 'spot' }),
      lightWith({ id: 'c', kind: 'point' })
    ]
    const ids = resolveShadowCasterIds(lights)
    expect(ids.size).toBe(MAX_SHADOW_CASTING_LIGHTS)
    expect(ids.has('a')).toBe(true)
    expect(ids.has('b')).toBe(true)
    expect(ids.has('c')).toBe(false)
  })

  it('面光不占用阴影名额（three.js 面光不支持阴影）', () => {
    const lights = [lightWith({ id: 'area', kind: 'area' }), lightWith({ id: 'sun', kind: 'sun' })]
    const ids = resolveShadowCasterIds(lights)
    expect(ids.has('area')).toBe(false)
    expect(ids.has('sun')).toBe(true)
  })

  it('隐藏的灯光不投射阴影，名额顺延给后续可见灯光', () => {
    const lights = [
      lightWith({ id: 'hidden', kind: 'sun', visible: false }),
      lightWith({ id: 'visible', kind: 'spot' })
    ]
    const ids = resolveShadowCasterIds(lights)
    expect(ids.has('hidden')).toBe(false)
    expect(ids.has('visible')).toBe(true)
  })
})

describe('describeLight', () => {
  it('摘要包含方位、高度、色调、强度与阴影信息', () => {
    const description = describeLight(lightWith(), true)
    expect(description.summary).toContain('点光源')
    expect(description.summary).toContain('投射可见阴影')
    expect(description.summary).toContain('暖白光')
    expect(description.castShadow).toBe(true)
  })

  it('隐藏的灯光在摘要中明确说明不参与照明', () => {
    const description = describeLight(lightWith({ visible: false }), false)
    expect(description.summary).toContain('已隐藏')
  })
})

describe('describeLighting', () => {
  it('汇总可见数量、阴影灯名与提示词行', () => {
    const lights = [
      lightWith({ id: 'a', name: '主光', kind: 'sun' }),
      lightWith({ id: 'b', name: '补光', kind: 'point', visible: false })
    ]
    const result = describeLighting(lights)
    expect(result.lights).toHaveLength(2)
    expect(result.visibleLights).toHaveLength(1)
    expect(result.shadowCasterNames).toEqual(['主光'])
    expect(result.promptLines[0]).toBe('光照：')
    expect(result.promptLines.join('\n')).toContain('固定环境光')
    expect(result.summaryLine).toContain('共 2 盏可编辑灯光')
  })

  it('没有可编辑灯光时说明仅使用固定环境光', () => {
    const result = describeLighting([])
    expect(result.summaryLine).toContain('没有可编辑灯光')
    expect(result.promptLines.join('\n')).toContain('没有灯光投射阴影')
  })

  it('提示词明确列出投射阴影的灯光名称', () => {
    const result = describeLighting([lightWith({ name: '太阳', kind: 'sun' })])
    expect(result.promptLines.join('\n')).toContain('仅 太阳 投射阴影')
  })
})
