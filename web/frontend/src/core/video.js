/**
 * 输出尺寸与视频帧计划。
 * 移植自 `output-size.ts` 与 `frame-plan.ts`。
 *
 * 尺寸一律取偶数：H.264 要求宽高为偶数，奇数会让编码器拒绝或补边。
 */

export function outputSize(camera, maxDimension = 1280) {
  const ratio = camera.aspectWidth / camera.aspectHeight
  const even = (value) => Math.max(2, Math.round(value / 2) * 2)
  if (ratio >= 1) return { width: even(maxDimension), height: even(maxDimension / ratio) }
  return { width: even(maxDimension * ratio), height: even(maxDimension) }
}

export function createVideoFramePlan(durationSeconds, frameRate) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('视频时长必须大于 0。')
  }
  if (!Number.isInteger(frameRate) || frameRate < 1 || frameRate > 120) {
    throw new Error('视频帧率无效。')
  }
  const totalFrames = Math.max(1, Math.round(durationSeconds * frameRate))
  return {
    frameRate,
    totalFrames,
    frameDurationSeconds: 1 / frameRate,
    sourceTimeSeconds: (frameIndex) => {
      if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= totalFrames) {
        throw new Error('视频帧编号无效。')
      }
      // 最后一帧展示最终关键状态，但不额外延长文件时长。
      return frameIndex === totalFrames - 1 ? durationSeconds : frameIndex / frameRate
    }
  }
}

// ----------------------------------------------------------------------
// MP4（H.264 + WebCodecs）
// ----------------------------------------------------------------------

/**
 * H.264 codec 候选，按"质量优先"排序。
 *
 * 为什么必须是一张表、而且要按尺寸在运行时试：
 * H.264 的支持是**硬件 / 系统相关**的，不同机器能用的 profile 不一样。
 * 实测这台机器上 `avc1.42E01E`（Baseline）与 `avc1.4D401F`（Main）都返回
 * `supported: false`，只有 `avc1.640028`（High）可用。
 * 写死任何一个字符串，都必然在另一些机器上失败。
 *
 * 尾部数字是 profile + level 的十六进制：
 *   42 = Baseline, 4D = Main, 64 = High
 *   28 = Level 4.0 (1080p30), 32 = Level 5.0 (更大尺寸)
 */
export const MP4_CODEC_CANDIDATES = [
  { codec: 'avc1.640032', label: 'H.264 High / Level 5.0' },
  { codec: 'avc1.640028', label: 'H.264 High / Level 4.0' },
  { codec: 'avc1.4D402A', label: 'H.264 Main / Level 4.2' },
  { codec: 'avc1.4D401F', label: 'H.264 Main / Level 3.1' },
  { codec: 'avc1.42E01F', label: 'H.264 Baseline / Level 3.1' },
  { codec: 'avc1.42E01E', label: 'H.264 Baseline / Level 3.0' }
]

/**
 * WebCodecs 的 `timestamp` 单位是**微秒**，不是毫秒也不是帧号。
 * 传成毫秒的话，视频时长会变成实际的千分之一（5 秒变 5 毫秒），
 * 播放器打开就是"一帧就结束"。
 */
export function mp4TimestampUs(frameIndex, frameRate) {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) throw new Error('视频帧编号无效。')
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('视频帧率无效。')
  return Math.round((frameIndex * 1_000_000) / frameRate)
}

/** 每帧的时长（微秒），写进 VideoFrame 的 duration，供播放器算帧率。 */
export function mp4FrameDurationUs(frameRate) {
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('视频帧率无效。')
  return Math.round(1_000_000 / frameRate)
}

/**
 * 关键帧间隔：每秒一个。
 *
 * 全部都是关键帧文件会大好几倍；间隔太长则拖动进度条要等很久才出画面。
 * 1 秒是"能顺滑拖动 + 文件不至于爆炸"的常用折中。
 */
export function mp4KeyFrameInterval(frameRate) {
  if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error('视频帧率无效。')
  return Math.max(1, Math.round(frameRate))
}

/** 导出文件名。去掉 Windows 不允许的字符，避免落盘失败。 */
export function mp4FileName(projectName, suffix = '') {
  const base = String(projectName || '未命名场景')
    // 与后端 safe_name 保持同一套白名单思路：只保留中英文、数字与 -_
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
  return `${base || '未命名场景'}${suffix || ''}.mp4`
}

/**
 * 把"编码能力探测结果"翻译成给用户看的一句话。
 *
 * 探测失败时不能只说"不支持"，否则用户不知道能做什么。
 * 这里明确给出替代路径（PNG 序列帧），并说明原因。
 */
export function describeMp4Support(result) {
  if (!result) return { ok: false, message: '还未检测编码能力。' }
  if (result.ok) {
    return {
      ok: true,
      message: `可直接导出 MP4（${result.label || result.codec}）。`
    }
  }
  if (result.reason === 'no-webcodecs') {
    return {
      ok: false,
      message: '当前浏览器没有 WebCodecs（VideoEncoder），无法在本地编码 MP4。请改用 Chrome / Edge 111+，或勾选 PNG 序列帧。'
    }
  }
  if (result.reason === 'no-codec') {
    return {
      ok: false,
      message: '当前浏览器的 H.264 编码器不可用（常见于无硬件加速的环境）。可以勾选 PNG 序列帧，或换一台机器重试。'
    }
  }
  return { ok: false, message: result.message || 'MP4 编码不可用。' }
}
