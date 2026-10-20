/**
 * 视频导出的纯逻辑测试。
 *
 * 只测 `core/video.js` 里能脱离浏览器验证的部分：
 * 尺寸、帧计划、MP4 时间戳换算、codec 候选表、能力文案。
 *
 * 编码本身（WebCodecs / muxer）依赖浏览器 API，属于 `media/mp4-encoder.js`，
 * 由 `scripts/verify-mp4-export.cjs` 用真实浏览器验证。
 */

import { describe, it, expect } from 'vitest'
import {
  MP4_CODEC_CANDIDATES,
  createVideoFramePlan,
  describeMp4Support,
  mp4FileName,
  mp4FrameDurationUs,
  mp4KeyFrameInterval,
  mp4TimestampUs,
  outputSize
} from './video'

const camera16x9 = { aspectWidth: 16, aspectHeight: 9, fovDegrees: 42 }

describe('输出尺寸', () => {
  it('横版按最大边定宽', () => {
    expect(outputSize(camera16x9, 1280)).toEqual({ width: 1280, height: 720 })
  })

  it('竖版按最大边定高', () => {
    const camera = { ...camera16x9, aspectWidth: 9, aspectHeight: 16 }
    expect(outputSize(camera, 1280)).toEqual({ width: 720, height: 1280 })
  })

  it('宽高一律取偶数（H.264 硬性要求）', () => {
    // 1:1 且最大边是奇数时会算出奇数，必须被修正。
    const camera = { ...camera16x9, aspectWidth: 1, aspectHeight: 1 }
    const size = outputSize(camera, 721)
    expect(size.width % 2).toBe(0)
    expect(size.height % 2).toBe(0)
  })

  it('4:3 画幅不会被压扁', () => {
    const camera = { ...camera16x9, aspectWidth: 4, aspectHeight: 3 }
    expect(outputSize(camera, 1280)).toEqual({ width: 1280, height: 960 })
  })
})

describe('帧计划', () => {
  it('总帧数 = 时长 × 帧率', () => {
    const plan = createVideoFramePlan(5, 24)
    expect(plan.totalFrames).toBe(120)
    expect(plan.frameRate).toBe(24)
  })

  it('最后一帧展示最终状态', () => {
    const plan = createVideoFramePlan(5, 24)
    expect(plan.sourceTimeSeconds(plan.totalFrames - 1)).toBe(5)
  })

  it('中间帧按帧号推进', () => {
    const plan = createVideoFramePlan(5, 24)
    expect(plan.sourceTimeSeconds(0)).toBe(0)
    expect(plan.sourceTimeSeconds(24)).toBeCloseTo(1, 6)
  })

  it('非法时长与帧率会抛错', () => {
    expect(() => createVideoFramePlan(0, 24)).toThrow()
    expect(() => createVideoFramePlan(5, 0)).toThrow()
    expect(() => createVideoFramePlan(5, 200)).toThrow()
  })
})

describe('MP4 时间戳（微秒）', () => {
  it('第 0 帧是 0', () => {
    expect(mp4TimestampUs(0, 24)).toBe(0)
  })

  it('第 24 帧在 24fps 下正好是 1 秒 = 1000000 微秒', () => {
    expect(mp4TimestampUs(24, 24)).toBe(1_000_000)
  })

  it('用微秒而不是毫秒，否则时长会差 1000 倍', () => {
    const plan = createVideoFramePlan(5, 24)
    const lastUs = mp4TimestampUs(plan.totalFrames, 24)
    // 120 帧 / 24fps = 5 秒 = 5_000_000 微秒
    expect(lastUs).toBe(5_000_000)
    // 若是毫秒会得到 5000，这里明确守住单位。
    expect(lastUs).not.toBe(5000)
  })

  it('非 24 的帧率也算得对', () => {
    expect(mp4TimestampUs(30, 30)).toBe(1_000_000)
    expect(mp4TimestampUs(25, 25)).toBe(1_000_000)
  })

  it('每帧时长与帧率互为倒数', () => {
    expect(mp4FrameDurationUs(24)).toBe(41_667)
    expect(mp4FrameDurationUs(30)).toBe(33_333)
    expect(mp4FrameDurationUs(60)).toBe(16_667)
  })

  it('非法输入会抛错', () => {
    expect(() => mp4TimestampUs(-1, 24)).toThrow()
    expect(() => mp4TimestampUs(0, 0)).toThrow()
    expect(() => mp4FrameDurationUs(0)).toThrow()
  })
})

describe('关键帧间隔', () => {
  it('每秒一个关键帧', () => {
    expect(mp4KeyFrameInterval(24)).toBe(24)
    expect(mp4KeyFrameInterval(30)).toBe(30)
  })

  it('极低帧率下至少为 1', () => {
    expect(mp4KeyFrameInterval(0.2)).toBe(1)
  })
})

describe('codec 候选表', () => {
  it('全部是 avc1 前缀的 H.264', () => {
    for (const candidate of MP4_CODEC_CANDIDATES) {
      expect(candidate.codec.startsWith('avc1.')).toBe(true)
      expect(candidate.label).toMatch(/H\.264/)
    }
  })

  it('覆盖 High / Main / Baseline 三档 profile', () => {
    const profiles = MP4_CODEC_CANDIDATES.map((item) => item.codec.slice(5, 7))
    expect(profiles).toContain('64')
    expect(profiles).toContain('4D')
    expect(profiles).toContain('42')
  })

  it('候选之间不重复', () => {
    const codecs = MP4_CODEC_CANDIDATES.map((item) => item.codec)
    expect(new Set(codecs).size).toBe(codecs.length)
  })
})

describe('文件名', () => {
  it('补上 .mp4 后缀', () => {
    expect(mp4FileName('客厅方案')).toBe('客厅方案.mp4')
  })

  it('去掉 Windows 非法字符', () => {
    expect(mp4FileName('a/b:c*d?e"f<g>h|i')).toBe('abcdefghi.mp4')
  })

  it('空名字回退到默认值', () => {
    expect(mp4FileName('')).toBe('未命名场景.mp4')
    expect(mp4FileName(null)).toBe('未命名场景.mp4')
  })

  it('支持附加后缀（复用到首尾帧命名）', () => {
    expect(mp4FileName('场景', '_first')).toBe('场景_first.mp4')
  })
})

describe('能力文案', () => {
  it('可用时给出 codec 名', () => {
    const text = describeMp4Support({ ok: true, codec: 'avc1.640028', label: 'H.264 High' })
    expect(text.ok).toBe(true)
    expect(text.message).toContain('H.264 High')
  })

  it('没有 WebCodecs 时指引用户换浏览器或改用序列帧', () => {
    const text = describeMp4Support({ ok: false, reason: 'no-webcodecs' })
    expect(text.ok).toBe(false)
    expect(text.message).toContain('WebCodecs')
    expect(text.message).toContain('序列帧')
  })

  it('没有可用编码器时同样给替代路径', () => {
    const text = describeMp4Support({ ok: false, reason: 'no-codec' })
    expect(text.ok).toBe(false)
    expect(text.message).toContain('H.264')
    expect(text.message).toContain('序列帧')
  })

  it('未检测时不是 ok', () => {
    expect(describeMp4Support(null).ok).toBe(false)
  })
})
