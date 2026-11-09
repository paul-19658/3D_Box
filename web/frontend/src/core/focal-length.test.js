/**
 * 焦距换算测试。
 *
 * 最重要的是"与 three.js 完全一致"这条：界面显示的焦距必须与渲染器
 * 实际使用的视野严格对应，否则用户按 50mm 构图、导出却是另一个视角。
 * 这里直接按 three.js 的公式独立算一遍做交叉验证。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILM_GAUGE_MM,
  FOCAL_LENGTH_PRESETS,
  MAX_FOV_DEGREES,
  MIN_FOV_DEGREES,
  aspectChangePatch,
  aspectRatioOf,
  clampFovDegrees,
  describeFocalLength,
  equivalentFullFrameFocalLength,
  filmHeightMm,
  filmWidthMm,
  focalLengthFromFovDegrees,
  fovDegreesFromFocalLength,
  horizontalFovDegrees
} from './focal-length'

const RAD2DEG = 180 / Math.PI
const DEG2RAD = Math.PI / 180

/** three.js PerspectiveCamera 的参考实现（逐字照抄公式，用于交叉验证）。 */
function threeFovFromFocal(focal, aspect, gauge = 35) {
  const filmHeight = gauge / Math.max(aspect, 1)
  return RAD2DEG * 2 * Math.atan((0.5 * filmHeight) / focal)
}
function threeFocalFromFov(fov, aspect, gauge = 35) {
  const filmHeight = gauge / Math.max(aspect, 1)
  return (0.5 * filmHeight) / Math.tan(DEG2RAD * 0.5 * fov)
}

describe('aspectRatioOf', () => {
  it('从 aspectWidth / aspectHeight 得到画幅比', () => {
    expect(aspectRatioOf({ aspectWidth: 16, aspectHeight: 9 })).toBeCloseTo(16 / 9, 9)
    expect(aspectRatioOf({ aspectWidth: 9, aspectHeight: 16 })).toBeCloseTo(9 / 16, 9)
  })

  it('非法输入退回 16:9，不产生 NaN', () => {
    expect(aspectRatioOf({ aspectWidth: 0, aspectHeight: 9 })).toBeCloseTo(16 / 9, 9)
    expect(aspectRatioOf(null)).toBeCloseTo(16 / 9, 9)
  })
})

describe('感光元件尺寸（长边占满 gauge）', () => {
  it('横屏时宽度等于 gauge，高度按比例缩小', () => {
    const aspect = 16 / 9
    expect(filmWidthMm(aspect)).toBeCloseTo(35, 9)
    expect(filmHeightMm(aspect)).toBeCloseTo(35 / (16 / 9), 9)
  })

  it('竖屏时高度等于 gauge，宽度按比例缩小', () => {
    const aspect = 9 / 16
    expect(filmHeightMm(aspect)).toBeCloseTo(35, 9)
    expect(filmWidthMm(aspect)).toBeCloseTo(35 * (9 / 16), 9)
  })

  it('正方形时宽高都等于 gauge', () => {
    expect(filmWidthMm(1)).toBeCloseTo(35, 9)
    expect(filmHeightMm(1)).toBeCloseTo(35, 9)
  })
})

describe('焦距 ↔ 视场角', () => {
  const aspects = [16 / 9, 9 / 16, 1, 4 / 3, 2.39]

  it('与 three.js 的公式完全一致（逐字交叉验证）', () => {
    for (const aspect of aspects) {
      for (const focal of [14, 24, 35, 50, 85, 135, 200]) {
        expect(fovDegreesFromFocalLength(focal, aspect)).toBeCloseTo(threeFovFromFocal(focal, aspect), 9)
      }
    }
  })

  it('逆运算也一致', () => {
    for (const aspect of aspects) {
      for (const fov of [20, 35, 42, 60, 90, 110]) {
        expect(focalLengthFromFovDegrees(fov, aspect)).toBeCloseTo(threeFocalFromFov(fov, aspect), 9)
      }
    }
  })

  it('正反算互逆', () => {
    for (const aspect of aspects) {
      for (const focal of [18, 35, 50, 120]) {
        const fov = fovDegreesFromFocalLength(focal, aspect)
        expect(focalLengthFromFovDegrees(fov, aspect)).toBeCloseTo(focal, 6)
      }
    }
  })

  it('焦距越长视野越窄（单调性）', () => {
    let previous = Infinity
    for (const focal of [14, 24, 35, 50, 85, 135]) {
      const fov = fovDegreesFromFocalLength(focal, 16 / 9)
      expect(fov).toBeLessThan(previous)
      previous = fov
    }
  })

  it('同一焦距在横屏与竖屏下的垂直视野不同（长边定视野的直接结果）', () => {
    const landscape = fovDegreesFromFocalLength(50, 16 / 9)
    const portrait = fovDegreesFromFocalLength(50, 9 / 16)
    // 竖屏时长边是高度，所以垂直视野更宽
    expect(portrait).toBeGreaterThan(landscape)
  })

  it('横屏下横向视野不随画幅变化（横向就是长边）', () => {
    const wide = horizontalFovDegrees(fovDegreesFromFocalLength(50, 16 / 9), 16 / 9)
    const wider = horizontalFovDegrees(fovDegreesFromFocalLength(50, 21 / 9), 21 / 9)
    expect(wide).toBeCloseTo(wider, 6)
  })

  it('非法输入返回 null，不产生 NaN/Infinity', () => {
    expect(fovDegreesFromFocalLength(0, 16 / 9)).toBeNull()
    expect(fovDegreesFromFocalLength(-5, 16 / 9)).toBeNull()
    expect(fovDegreesFromFocalLength(NaN, 16 / 9)).toBeNull()
    expect(focalLengthFromFovDegrees(0, 16 / 9)).toBeNull()
    expect(focalLengthFromFovDegrees(180, 16 / 9)).toBeNull()
    expect(focalLengthFromFovDegrees(NaN, 16 / 9)).toBeNull()
  })

  it('默认画幅规格是 35mm，与 three.js 默认一致', () => {
    expect(DEFAULT_FILM_GAUGE_MM).toBe(35)
  })
})

describe('horizontalFovDegrees', () => {
  it('16:9 下横向视野比垂直视野宽', () => {
    const horizontal = horizontalFovDegrees(42, 16 / 9)
    expect(horizontal).toBeGreaterThan(42)
  })

  it('竖屏下横向视野比垂直视野窄', () => {
    const horizontal = horizontalFovDegrees(42, 9 / 16)
    expect(horizontal).toBeLessThan(42)
  })

  it('正方形时两者相等', () => {
    expect(horizontalFovDegrees(42, 1)).toBeCloseTo(42, 9)
  })
})

describe('等效全画幅焦距', () => {
  it('16:9 下（长边 35mm 即画幅宽）等效值略大于实际值', () => {
    const equivalent = equivalentFullFrameFocalLength(50, 16 / 9)
    // 16:9 的感光面是 35 × 19.69，对角线 40.2 < 43.27，所以等效焦距更大
    expect(equivalent).toBeGreaterThan(50)
    expect(equivalent).toBeLessThan(60)
  })

  it('非法输入返回 null', () => {
    expect(equivalentFullFrameFocalLength(0, 16 / 9)).toBeNull()
  })
})

describe('describeFocalLength', () => {
  it('给出焦距与等效值，便于写进提示词', () => {
    const text = describeFocalLength(50, 16 / 9)
    expect(text).toContain('50mm')
    expect(text).toContain('等效全画幅')
  })

  it('非法输入返回空串而不是 "NaNmm"', () => {
    expect(describeFocalLength(0, 16 / 9)).toBe('')
    expect(describeFocalLength(null, 16 / 9)).toBe('')
  })
})

describe('焦段预设', () => {
  it('覆盖常用焦段且每个都能算出合法视野', () => {
    expect(FOCAL_LENGTH_PRESETS.length).toBeGreaterThanOrEqual(5)
    for (const preset of FOCAL_LENGTH_PRESETS) {
      const fov = fovDegreesFromFocalLength(preset.mm, 16 / 9)
      expect(fov).toBeGreaterThanOrEqual(MIN_FOV_DEGREES)
      expect(fov).toBeLessThanOrEqual(MAX_FOV_DEGREES)
    }
  })

  it('包含长焦预设（放宽视野范围后 135mm 必须可用）', () => {
    expect(FOCAL_LENGTH_PRESETS.some((preset) => preset.mm >= 135)).toBe(true)
  })
})

/**
 * 换画幅必须**保持镜头**（长边定视野）。
 *
 * 只改 aspectWidth/aspectHeight、不动 fovDegrees 是错的：fovDegrees 是垂直视场角，
 * 画幅一变它的含义就跟着变，于是同一颗镜头换画幅就变成别的焦段。
 * 实测旧行为（镜头 25.64mm）：16:9 → 21:9 变成 19.54mm、→ 9:16 变成 45.59mm。
 */
describe('aspectChangePatch', () => {
  const camera = { aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 }

  it('只给画幅时，会一并给出重算后的垂直视场角', () => {
    const patch = aspectChangePatch(camera, 21, 9)
    expect(patch.aspectWidth).toBe(21)
    expect(patch.aspectHeight).toBe(9)
    expect(typeof patch.fovDegrees).toBe('number')
  })

  it('16:9 → 21:9：垂直视场角变小，焦距不变', () => {
    const patch = aspectChangePatch(camera, 21, 9)
    expect(patch.fovDegrees).toBeLessThan(42)
    expect(patch.fovDegrees).toBeCloseTo(32.61, 1)
    expect(focalLengthFromFovDegrees(patch.fovDegrees, 21 / 9)).toBeCloseTo(
      focalLengthFromFovDegrees(42, 16 / 9),
      6
    )
  })

  it('16:9 → 9:16：垂直视场角变大（长边转到竖直方向），焦距不变', () => {
    const patch = aspectChangePatch(camera, 9, 16)
    expect(patch.fovDegrees).toBeGreaterThan(42)
    expect(focalLengthFromFovDegrees(patch.fovDegrees, 9 / 16)).toBeCloseTo(
      focalLengthFromFovDegrees(42, 16 / 9),
      6
    )
  })

  it('任何画幅下焦距与长边视野都不变', () => {
    const focal0 = focalLengthFromFovDegrees(42, 16 / 9)
    const long0 = RAD2DEG * 2 * Math.atan(DEFAULT_FILM_GAUGE_MM / 2 / focal0)
    for (const [w, h] of [[239, 100], [21, 9], [16, 9], [3, 2], [4, 3], [1, 1], [9, 16], [4, 5]]) {
      const patch = aspectChangePatch(camera, w, h)
      const focal = focalLengthFromFovDegrees(patch.fovDegrees, w / h)
      expect(focal).toBeCloseTo(focal0, 6)
      expect(RAD2DEG * 2 * Math.atan(DEFAULT_FILM_GAUGE_MM / 2 / focal)).toBeCloseTo(long0, 6)
    }
  })

  it('非法视场角时退化为只改画幅，不产出 NaN', () => {
    const patch = aspectChangePatch({ aspectWidth: 16, aspectHeight: 9, fovDegrees: 0 }, 21, 9)
    expect(patch.aspectWidth).toBe(21)
    expect('fovDegrees' in patch).toBe(false)
  })

  it('非法画幅退化为 16:9', () => {
    const patch = aspectChangePatch(camera, 0, -1)
    expect(patch.aspectWidth).toBe(16)
    expect(patch.aspectHeight).toBe(9)
  })
})

describe('视场角范围', () => {
  it('放宽到 5°~140°，覆盖约 3.6mm ~ 225mm', () => {
    expect(MIN_FOV_DEGREES).toBe(5)
    expect(MAX_FOV_DEGREES).toBe(140)
    const longest = focalLengthFromFovDegrees(MIN_FOV_DEGREES, 16 / 9)
    const shortest = focalLengthFromFovDegrees(MAX_FOV_DEGREES, 16 / 9)
    expect(longest).toBeGreaterThan(200)
    expect(shortest).toBeLessThan(4)
  })

  it('clampFovDegrees 夹紧越界值', () => {
    expect(clampFovDegrees(9999)).toBe(MAX_FOV_DEGREES)
    expect(clampFovDegrees(0.1)).toBe(MIN_FOV_DEGREES)
    expect(clampFovDegrees(42)).toBe(42)
  })

  it('clampFovDegrees 对非法值回退默认 42°', () => {
    expect(clampFovDegrees(NaN)).toBe(42)
    expect(clampFovDegrees(undefined)).toBe(42)
    expect(clampFovDegrees('不是数字')).toBe(42)
  })
})
