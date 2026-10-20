/**
 * MP4 编码（WebCodecs VideoEncoder + mp4-muxer）。
 *
 * 为什么放在 `media/` 而不是 `core/`：
 * `core/` 有硬性约定——不许依赖 DOM / 浏览器全局。这里的 `VideoEncoder`、
 * `VideoFrame`、`OffscreenCanvas` 全是浏览器 API，放进 `core/` 会让
 * Vitest 在 Node 里直接炸。纯逻辑（codec 候选表、时间戳换算、文件名、
 * 能力文案）留在 `core/video.js`，这里只做"把浏览器 API 接起来"。
 *
 * 三个必须踩对的坑：
 *
 * 1. **timestamp 单位是微秒**，不是毫秒也不是帧号。写成毫秒的话 5 秒视频
 *    会变成 5 毫秒，播放器打开就是"一闪而过"。
 * 2. **`VideoFrame` 必须 `close()`**。它是 GPU/系统内存的句柄，不释放的话
 *    几十帧后浏览器就 OOM 崩掉——而且崩得毫无征兆。
 * 3. **必须等编码队列消化**。`encode()` 是入队即返回，不等的话几十帧
 *    会瞬间堆进队列，内存曲线直接起飞。所以每帧后检查 `encodeQueueSize`。
 */

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import {
  MP4_CODEC_CANDIDATES,
  mp4FrameDurationUs,
  mp4KeyFrameInterval,
  mp4TimestampUs
} from '@/core/video'

/** 队列超过这个深度就等一等。太小会拖慢导出，太大会吃掉几百 MB 内存。 */
const MAX_QUEUE_DEPTH = 8

export function isWebCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
}

/**
 * 探测本机能否编码 MP4，并挑出一个可用的 codec。
 *
 * 逐个试 `MP4_CODEC_CANDIDATES`：不同机器的 H.264 profile 支持差别很大
 * （实测有的机器 Baseline/Main 全不可用，只有 High 能用），
 * 所以只能运行时问浏览器，不能写死。
 */
export async function probeMp4Support(width, height) {
  if (!isWebCodecsAvailable()) return { ok: false, reason: 'no-webcodecs' }

  for (const candidate of MP4_CODEC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.codec,
        width,
        height,
        bitrate: 8_000_000,
        framerate: 24,
        // 不指定 avc.format：让浏览器自己选，指定 'annexb' 反而会被部分版本拒绝。
        hardwareAcceleration: 'no-preference'
      })
      if (support?.supported) {
        return { ok: true, codec: candidate.codec, label: candidate.label }
      }
    } catch {
      // 这个候选不被支持（或抛错），试下一个。
    }
  }
  return { ok: false, reason: 'no-codec' }
}

/**
 * 创建一个 MP4 编码会话。
 *
 * 用法：
 *   const session = await createMp4Session({ width, height, frameRate, bitrate })
 *   for (...) await session.addFrame(canvas, frameIndex)
 *   const blob = await session.finish()
 */
export async function createMp4Session({ width, height, frameRate, bitrate = 8_000_000 }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('视频尺寸无效。')
  }
  // H.264 要求宽高为偶数，奇数会让编码器直接拒绝。
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new Error(`视频宽高必须为偶数，当前是 ${width}×${height}。`)
  }

  const support = await probeMp4Support(width, height)
  if (!support.ok) {
    const error = new Error(
      support.reason === 'no-webcodecs'
        ? '当前浏览器不支持 WebCodecs，无法导出 MP4。'
        : '当前浏览器没有可用的 H.264 编码器，无法导出 MP4。'
    )
    error.code = support.reason
    throw error
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height },
    /*
     * fastStart: 'in-memory' 把 moov（索引表）写到文件开头。
     *
     * 默认行为是把 moov 放在末尾，文件本身是合法的，但很多平台
     * （尤其是网页播放器和 AI 视频平台的上传校验）需要先读到索引表
     * 才能解析，会判定为"文件损坏"。代价是要在内存里多留一份数据，
     * 对几十秒的短视频完全可以接受。
     */
    fastStart: 'in-memory'
  })

  let failure = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      failure = error
    }
  })

  encoder.configure({
    codec: support.codec,
    width,
    height,
    bitrate,
    framerate: frameRate,
    // 明确声明走 avc 格式（带 AVCC 长度前缀），muxer 才能正确写 stsd。
    avc: { format: 'avc' }
  })

  const keyInterval = mp4KeyFrameInterval(frameRate)
  const frameDuration = mp4FrameDurationUs(frameRate)
  let closed = false

  /** 等编码队列降到安全水位，同时把编码器的异步错误尽早抛出来。 */
  const drainQueue = async () => {
    while (encoder.encodeQueueSize > MAX_QUEUE_DEPTH) {
      if (failure) throw failure
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
  }

  return {
    codec: support.codec,

    /**
     * 提交一帧。
     *
     * `source` 可以是 canvas / ImageBitmap / OffscreenCanvas——凡是
     * `new VideoFrame()` 能接受的都行。调用方负责复用同一块画布
     * （见 SceneViewport.captureFrameToCanvas），避免每帧新建。
     */
    async addFrame(source, frameIndex) {
      if (closed) throw new Error('编码会话已结束。')
      if (failure) throw failure

      await drainQueue()

      const frame = new VideoFrame(source, {
        timestamp: mp4TimestampUs(frameIndex, frameRate),
        duration: frameDuration
      })
      try {
        // 每秒一个关键帧：太少则拖动进度条要等很久，太多则文件显著变大。
        encoder.encode(frame, { keyFrame: frameIndex % keyInterval === 0 })
      } finally {
        // 必须在 encode() 之后立刻释放。漏掉这一句会稳定 OOM。
        frame.close()
      }
    },

    /** 收尾：冲刷编码器 → 写 moov → 返回可上传的 Blob。 */
    async finish() {
      if (closed) throw new Error('编码会话已结束。')
      closed = true
      await encoder.flush()
      if (failure) throw failure
      muxer.finalize()
      encoder.close()
      const { buffer } = muxer.target
      if (!buffer || buffer.byteLength === 0) throw new Error('编码结果为空，未生成有效的 MP4。')
      return new Blob([buffer], { type: 'video/mp4' })
    },

    /** 出错时的清理路径：关掉编码器但不产出文件。 */
    abort() {
      if (closed) return
      closed = true
      try {
        encoder.close()
      } catch {
        // 已经关掉了，忽略。
      }
    }
  }
}
