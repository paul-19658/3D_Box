import { describe, expect, it } from 'vitest'

import {
  MAX_SHADOW_CASTING_LIGHTS,
  describeLighting,
  lightColorText,
  lightHeightText,
  lightSideText,
  resolveShadowCasterIds
} from '@/core/lighting-description'

const light = (overrides = {}) => ({
  id: 'light-1',
  name: '主光',
  kind: 'sun',
  position: { x: 6, y: 10, z: 5 },
  target: { x: 0, y: 1, z: 0 },
  color: '#fff5dc',
  intensity: 1.8,
  size: 1,
  angleDegrees: 5,
  visible: true,
  locked: false,
  ...overrides
})

describe('resolveShadowCasterIds', () => {
  it('最多只给两盏灯阴影名额', () => {
    const ids = resolveShadowCasterIds([light({ id: 'a' }), light({ id: 'b' }), light({ id: 'c' })])
    expect(ids.size).toBe(MAX_SHADOW_CASTING_LIGHTS)
    expect([...ids]).toEqual(['a', 'b'])
  })

  it('面光永远不投影，把名额让给后面的灯', () => {
    const ids = resolveShadowCasterIds([
      light({ id: 'area', kind: 'area' }),
      light({ id: 'spot', kind: 'spot' })
    ])
    expect(ids.has('area')).toBe(false)
    expect(ids.has('spot')).toBe(true)
  })

  it('隐藏的灯不占名额', () => {
    const ids = resolveShadowCasterIds([light({ id: 'hidden', visible: false }), light({ id: 'on' })])
    expect([...ids]).toEqual(['on'])
  })
})

describe('光照方向与高度描述', () => {
  it('把方位角转换成八向文字', () => {
    expect(lightSideText({ x: 10, y: 5, z: 0 }, { x: 0, y: 0, z: 0 })).toBe('右方')
    expect(lightSideText({ x: 0, y: 5, z: 10 }, { x: 0, y: 0, z: 0 })).toBe('前方')
    expect(lightSideText({ x: -10, y: 5, z: 0 }, { x: 0, y: 0, z: 0 })).toBe('左方')
    expect(lightSideText({ x: 0, y: 5, z: -10 }, { x: 0, y: 0, z: 0 })).toBe('后方')
  })

  it('四十五度附近组合出斜向方位，而不是硬切到正方向', () => {
    expect(lightSideText({ x: 10, y: 5, z: 10 }, { x: 0, y: 0, z: 0 })).toBe('右前方')
    expect(lightSideText({ x: -10, y: 5, z: -10 }, { x: 0, y: 0, z: 0 })).toBe('左后方')
  })

  it('光源几乎在正上方时说明水平偏移可忽略', () => {
    expect(lightSideText({ x: 0.01, y: 9, z: 0.01 }, { x: 0, y: 0, z: 0 })).toBe('正上方')
  })

  it('按俯仰角判断顶光 / 高位 / 平光 / 底光', () => {
    expect(lightHeightText({ x: 1, y: 20, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('顶光')
    expect(lightHeightText({ x: 6, y: 10, z: 5 }, { x: 0, y: 1, z: 0 })).toContain('高位')
    expect(lightHeightText({ x: 20, y: 1, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('平光')
    expect(lightHeightText({ x: 2, y: -5, z: 0 }, { x: 0, y: 0, z: 0 })).toContain('底光')
  })
})

describe('光色描述', () => {
  it('高亮度的暖白仍被识别为暖色，而不是"低饱和"', () => {
    expect(lightColorText('#fff1d6')).toContain('暖')
  })

  it('明显的冷色被识别为冷光', () => {
    expect(lightColorText('#cfe4ff')).toContain('冷')
  })

  it('纯白归为中性白光', () => {
    expect(lightColorText('#ffffff')).toContain('白')
  })

  it('非法色值给出明确兜底文案，不抛错', () => {
    expect(lightColorText('not-a-color')).toBe('未知色调')
  })
})

describe('describeLighting', () => {
  it('汇总里同时包含方向、高度与阴影说明', () => {
    const result = describeLighting([light()])
    expect(result.summaryLine).toContain('右前方')
    expect(result.summaryLine).toContain('高位')
    expect(result.summaryLine).toContain('投射可见阴影')
    expect(result.lights).toHaveLength(1)
    expect(result.lights[0].castShadow).toBe(true)
  })

  it('promptLines 覆盖每盏灯、固定环境光与阴影结论', () => {
    const result = describeLighting([light()])
    const text = result.promptLines.join('\n')
    expect(text).toContain('固定环境光')
    expect(text).toContain('阴影：仅')
    expect(text).toContain('主光')
  })

  it('空灯光列表给出明确提示，而不是空字符串', () => {
    expect(describeLighting([]).summaryLine).toContain('没有可编辑灯光')
  })

  it('面光不产生阴影，并提示画面以均匀照明为主', () => {
    const result = describeLighting([light({ kind: 'area' })])
    expect(result.lights[0].castShadow).toBe(false)
    expect(result.promptLines.join('\n')).toContain('没有灯光投射阴影')
    expect(result.summaryLine).toContain('0 盏投射阴影')
  })

  it('隐藏的灯在单灯描述里标注不参与照明，且不计入可见灯光', () => {
    const result = describeLighting([light({ visible: false })])
    expect(result.lights[0].summary).toContain('不参与照明')
    expect(result.visibleLights).toHaveLength(0)
  })

  it('全部灯光隐藏时，汇总退回"没有可编辑灯光"而不是指向一盏看不见的灯', () => {
    const result = describeLighting([light({ visible: false })])
    expect(result.summaryLine).toContain('没有可编辑灯光')
  })
})
