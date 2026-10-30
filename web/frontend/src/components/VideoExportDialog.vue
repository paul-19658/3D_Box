<template>
  <div class="dialog-veil" @click.self="close">
    <section class="dialog dialog--wide" role="dialog" aria-label="导出动画视频">
      <header class="dialog__head">
        <span>导出动画</span>
        <button type="button" class="btn btn--ghost" @click="close">关闭</button>
      </header>

      <div class="dialog__body">
        <label class="field">
          <span class="field__label">平台预设</span>
          <select v-model="profileId" class="select" @change="validate">
            <option v-for="profile in profiles" :key="profile.id" :value="profile.id">
              {{ profile.name }}
            </option>
          </select>
        </label>

        <div class="field">
          <span class="field__label">帧率</span>
          <input
            v-model.number="frameRate"
            class="input"
            type="number"
            step="1"
            min="12"
            max="60"
            @change="onFrameRateChange"
          />
          <span class="field__label field__label--tight">最大边</span>
          <select v-model.number="maxDimension" class="select" @change="onDimensionChange">
            <option :value="720">720 px</option>
            <option :value="1280">1280 px</option>
            <option :value="1920">1920 px</option>
          </select>
        </div>

        <p class="meta-line">
          时长 {{ timeline.durationSeconds }} 秒 · {{ totalFrames }} 帧 · 输出 {{ size.width }} ×
          {{ size.height }} · {{ frameRate }} fps
        </p>

        <div v-if="validation" class="validation" :class="`validation--${validationStatus}`">
          <p class="validation__title">平台校验：{{ validation.verificationLabel || validationStatus }}</p>
          <ul v-if="validation.errors.length" class="validation__list">
            <li v-for="message in validation.errors" :key="message" class="validation__error">
              {{ message }}
            </li>
          </ul>
          <ul v-if="validation.warnings.length" class="validation__list">
            <li v-for="message in validation.warnings" :key="message" class="validation__warn">
              {{ message }}
            </li>
          </ul>
          <p v-if="validation.estimatedFileSizeMb" class="meta-line">
            预估体积约 {{ validation.estimatedFileSizeMb }} MB
          </p>
        </div>

        <!--
          MP4 能力提示。
          不能只在按钮上禁用：用户需要知道"为什么不行"和"那我该怎么办"。
        -->
        <div class="validation" :class="`validation--${supportTone}`">
          <p class="validation__title">MP4 编码：{{ supportTitle }}</p>
          <p class="meta-line">{{ support.message }}</p>
          <p v-if="support.mode === 'local' && support.codec" class="meta-line">
            编码器：{{ support.codec }}
          </p>
        </div>

        <p class="section-title section-gap">导出内容</p>
        <label class="checkbox"
          ><input v-model="withVideo" type="checkbox" :disabled="!support.ok" />
          MP4 视频（H.264{{ support.mode === 'server' ? '，服务器编码' : support.mode === 'local' ? '，本机编码' : '' }}）</label
        >
        <label class="checkbox"><input v-model="withEndpoints" type="checkbox" /> 首帧 / 尾帧单图（PNG）</label>
        <label class="checkbox"
          ><input v-model="withSequence" type="checkbox" /> 另存 PNG 序列帧（体积大，仅调试用）</label
        >

        <p v-if="!support.ok && !withEndpoints && !withSequence" class="meta-line meta-line--warn">
          至少勾选一项导出内容。
        </p>

        <div v-if="progress.total > 0" class="progress">
          <div class="progress__bar">
            <div class="progress__fill" :style="{ width: `${progressPercent}%` }"></div>
          </div>
          <p class="meta-line">{{ progress.label }} {{ progress.done }} / {{ progress.total }}</p>
        </div>

        <div v-if="exported.length > 0" class="result">
          <p class="section-title">已生成</p>
          <div v-for="file in exported" :key="file.fileName" class="result__row">
            <span class="result__name">{{ file.fileName }}</span>
            <span class="result__meta">{{ formatSize(file.byteLength) }}</span>
            <a class="btn" :href="downloadUrl(file.fileName)" target="_blank" rel="noopener">下载</a>
          </div>
        </div>
      </div>

      <footer class="dialog__foot">
        <button type="button" class="btn" @click="close">关闭</button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="busy || !viewport || !canExport"
          @click="run"
        >
          {{ busy ? '导出中…' : '开始导出' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script>
/**
 * 动画导出。
 *
 * 主产物是 **MP4**：
 * 1. 本机 WebCodecs 可用 → 浏览器内编 H.264（快、不占服务器）；
 * 2. 本机不可用但后端有 ffmpeg → 逐帧 JPEG 上传，服务器合成；
 * 3. 两边都没有 → 只能出首尾帧 / PNG 序列。
 *
 * 首帧 / 尾帧单图保留为附加产物——很多 AI 平台需要首尾帧成对上传。
 * 序列帧选项仍保留，仅调试用。
 *
 * 逐帧流程：
 * 1. `evaluateTimelineAtTime` 求出该帧的相机与物体变换；
 * 2. 把相机推到该帧位姿，渲染到一块可复用的 2D 画布（`captureFrameToCanvas`）；
 * 3. 交给本地编码器，或收集成 JPEG 上传服务器。
 *
 * 导出结束会恢复相机，并解除"导出模式"，避免"导完视频画面被改掉"。
 */
import { api } from '@/api/client'
import { evaluateTimelineAtTime } from '@/core/timeline'
import {
  outputSize,
  createVideoFramePlan,
  mp4FileName,
  describeMp4Support
} from '@/core/video'
import { createMp4Session, probeMp4Support } from '@/media/mp4-encoder'

export default {
  name: 'VideoExportDialog',

  props: {
    viewport: { type: Object, default: null }
  },

  data() {
    return {
      profileId: 'generic-16x9',
      frameRate: 24,
      maxDimension: 1280,
      withVideo: true,
      withEndpoints: true,
      withSequence: false,
      busy: false,
      /** 编码能力探测结果：null 表示还没测完。 */
      support: { ok: false, mode: 'none', message: '正在检测编码能力…' },
      supportChecked: false,
      serverMp4Encode: false,
      progress: { done: 0, total: 0, label: '' },
      exported: []
    }
  },

  computed: {
    timeline() {
      return this.$store.getters.timeline
    },
    camera() {
      return this.$store.getters.camera
    },
    profiles() {
      return this.$store.state.platformProfiles?.profiles || []
    },
    size() {
      return outputSize(this.camera, this.maxDimension)
    },
    totalFrames() {
      try {
        return createVideoFramePlan(this.timeline.durationSeconds, this.frameRate).totalFrames
      } catch {
        return 0
      }
    },
    validation() {
      return this.$store.state.videoValidation
    },
    validationStatus() {
      if (!this.validation) return 'unknown'
      if (this.validation.errors.length > 0) return 'error'
      if (this.validation.warnings.length > 0) return 'warning'
      return 'ok'
    },
    supportTitle() {
      if (!this.supportChecked) return '检测中'
      if (this.support.mode === 'local') return '本机可用'
      if (this.support.mode === 'server') return '服务器兜底'
      return '不可用'
    },
    supportTone() {
      if (!this.supportChecked) return 'unknown'
      if (this.support.mode === 'local') return 'ok'
      if (this.support.mode === 'server') return 'warning'
      return 'warning'
    },
    progressPercent() {
      if (this.progress.total === 0) return 0
      return Math.round((this.progress.done / this.progress.total) * 100)
    },
    canExport() {
      if (this.withVideo && this.support.ok) return true
      return this.withEndpoints || this.withSequence
    }
  },

  created() {
    this.profileId = this.$store.state.videoProfileId || this.profileId
    this.validate()
    this.refreshSupport()
  },

  methods: {
    formatSize(bytes) {
      if (!Number.isFinite(bytes)) return ''
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    },
    downloadUrl(fileName) {
      return api.exports.downloadUrl(fileName)
    },
    validate() {
      this.$store.commit('setVideoProfileId', this.profileId)
      this.$store.dispatch('validateVideoProfile', {
        width: this.size.width,
        height: this.size.height,
        frameRate: this.frameRate,
        durationSeconds: this.timeline.durationSeconds,
        bitrate: 8_000_000
      })
    },

    /**
     * 重新探测编码能力。
     *
     * 尺寸变了要重测：H.264 的 level 与分辨率绑定，
     * 1080p 能用的 profile 在 4K 下可能就超 level 了。
     * 同时问后端是否有 ffmpeg，决定能不能走服务器兜底。
     */
    async refreshSupport() {
      const { width, height } = this.size
      this.supportChecked = false
      this.support = { ok: false, mode: 'none', message: '正在检测编码能力…' }
      let result
      let serverOk = false
      try {
        const [local, meta] = await Promise.all([
          probeMp4Support(width, height),
          api.meta().catch(() => ({ serverMp4Encode: false }))
        ])
        result = local
        serverOk = Boolean(meta?.serverMp4Encode)
      } catch (error) {
        result = { ok: false, reason: 'no-codec', message: String(error?.message || error) }
      }
      this.serverMp4Encode = serverOk
      this.support = { ...result, ...describeMp4Support(result, { serverAvailable: serverOk }) }
      this.supportChecked = true
      // 本机与服务器都编不出 MP4 时，自动勾上首尾帧，避免点导出无事发生。
      if (!this.support.ok && !this.withEndpoints && !this.withSequence) this.withEndpoints = true
    },

    onFrameRateChange() {
      this.validate()
    },

    onDimensionChange() {
      this.validate()
      this.refreshSupport()
    },

    dataUrlToBlob(dataUrl) {
      const [meta, base64] = dataUrl.split(',')
      const mime = /:(.*?);/.exec(meta)?.[1] || 'image/png'
      const binary = atob(base64 || '')
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return new Blob([bytes], { type: mime })
    },

    canvasToJpegBlob(canvas, quality = 0.92) {
      return new Promise((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (!blob) reject(new Error('无法导出帧图像。'))
            else resolve(blob)
          },
          'image/jpeg',
          quality
        )
      })
    },

    /**
     * 本机 WebCodecs 编码；失败时若服务器可用则改走上传帧。
     */
    async exportMp4Local(plan, width, height, prefix, renderFrameAt) {
      this.progress = { done: 0, total: plan.totalFrames, label: '本机编码' }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const session = await createMp4Session({
        width,
        height,
        frameRate: this.frameRate,
        bitrate: 8_000_000
      })
      try {
        for (let index = 0; index < plan.totalFrames; index += 1) {
          await renderFrameAt(plan.sourceTimeSeconds(index))
          this.viewport.captureFrameToCanvas(canvas, width, height)
          await session.addFrame(canvas, index)
          this.progress.done = index + 1
          if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
        }
        const blob = await session.finish()
        return api.exports.upload(mp4FileName(prefix), blob)
      } catch (error) {
        session.abort()
        throw error
      }
    },

    /** 逐帧抓 JPEG → 一次性上传 → 后端 ffmpeg。 */
    async exportMp4Server(plan, width, height, prefix, renderFrameAt) {
      this.progress = { done: 0, total: plan.totalFrames, label: '渲染帧' }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const frameBlobs = []
      for (let index = 0; index < plan.totalFrames; index += 1) {
        await renderFrameAt(plan.sourceTimeSeconds(index))
        this.viewport.captureFrameToCanvas(canvas, width, height)
        frameBlobs.push(await this.canvasToJpegBlob(canvas))
        this.progress.done = index + 1
        if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
      }
      this.progress = { done: 0, total: 1, label: '服务器编码' }
      const result = await api.exports.encodeMp4(mp4FileName(prefix), this.frameRate, frameBlobs)
      this.progress.done = 1
      return result
    },

    async run() {
      if (!this.viewport) return
      this.busy = true
      this.exported = []
      const originalCamera = JSON.parse(JSON.stringify(this.camera))
      const { width, height } = this.size
      const plan = createVideoFramePlan(this.timeline.durationSeconds, this.frameRate)
      const prefix = this.$store.state.projectName
      const files = []

      // 编码期间暂停主渲染循环，避免两处同时改渲染器尺寸。
      this.viewport.setExporting(true)

      /*
       * 逐帧渲染的统一步骤：把该时刻的相机与**所有物体**都摆到位，再取像素。
       *
       * 抽出来是因为三条产物路径（MP4 / 序列帧 / 首尾帧）必须走完全一样的
       * 求值与应用流程。之前 MP4 与序列帧这两条只应用了相机，
       * 物体变换算完就丢了，导出结果自然是一张静止画面。
       */
      const renderFrameAt = async (time) => {
        const frame = evaluateTimelineAtTime(this.timeline, this.camera, time)
        this.viewport.applyCameraState(frame.camera)
        this.viewport.applyTimelineFrame(this.timeline, time)
        return frame
      }

      try {
        if (this.withVideo && this.support.ok) {
          const preferLocal = this.support.mode === 'local'
          if (preferLocal) {
            try {
              files.push(await this.exportMp4Local(plan, width, height, prefix, renderFrameAt))
            } catch (error) {
              // 编码中途失败时，若服务器有 ffmpeg，自动改走兜底，避免用户白渲一遍再手动重试。
              if (!this.serverMp4Encode) throw error
              await this.$store.dispatch('notify', {
                kind: 'warning',
                message: `本机编码失败，改走服务器：${error.message}`
              })
              files.push(await this.exportMp4Server(plan, width, height, prefix, renderFrameAt))
            }
          } else {
            files.push(await this.exportMp4Server(plan, width, height, prefix, renderFrameAt))
          }
        }

        if (this.withSequence) {
          this.progress = { done: 0, total: plan.totalFrames, label: '序列帧' }
          for (let index = 0; index < plan.totalFrames; index += 1) {
            await renderFrameAt(plan.sourceTimeSeconds(index))
            const base64 = this.viewport.captureImageBase64(this.maxDimension)
            const blob = this.dataUrlToBlob(`data:image/png;base64,${base64}`)
            const fileName = `${prefix}_frame_${String(index).padStart(4, '0')}.png`
            files.push(await api.exports.upload(fileName, blob))
            this.progress.done = index + 1
            if (index % 6 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
          }
        }

        if (this.withEndpoints) {
          this.progress = { done: 0, total: 2, label: '首尾帧' }
          let done = 0
          for (const [label, time] of [
            ['first', 0],
            ['last', this.timeline.durationSeconds]
          ]) {
            await renderFrameAt(time)
            const base64 = this.viewport.captureImageBase64(this.maxDimension)
            files.push(await api.exports.save(`${prefix}_${label}.png`, base64))
            done += 1
            this.progress.done = done
          }
        }

        this.exported = files
        await this.$store.dispatch('notify', {
          kind: 'success',
          message: `已导出 ${files.length} 个文件，可在下方下载。`
        })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: `导出失败：${error.message}` })
      } finally {
        this.viewport.setExporting(false)
        this.viewport.applyCameraState(originalCamera)
        /*
         * 把物体摆回编辑时的位置。
         *
         * 导出过程会逐帧改写物体节点的 position / rotation / scale。
         * 不复位的话，导完视频场景就停在最后一帧上——用户会以为
         * "导出把场景改坏了"。用时间轴求值取 0 时刻是不行的：
         * 0 时刻也有自己的关键帧值，未必等于编辑态。
         * 所以直接按 store 里的原始数据复位。
         */
        this.viewport.restoreObjectTransforms()
        this.progress = { done: 0, total: 0, label: '' }
        this.busy = false
      }
    },

    close() {
      this.$emit('close')
    }
  }
}
</script>

<style scoped>
.meta-line {
  margin: 4px 0 0;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.7;
}

.meta-line--warn {
  color: var(--warn);
}

.field__label--tight {
  width: auto;
  margin-left: 8px;
}

.section-gap {
  margin-top: 16px;
}

.checkbox {
  display: flex;
  margin-bottom: 4px;
}

.validation {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg-2);
}

.validation--ok {
  border-color: var(--success);
}

.validation--warning {
  border-color: var(--warn);
}

.validation--error {
  border-color: var(--danger);
}

.validation__title {
  margin: 0 0 6px;
  font-weight: 600;
}

.validation__list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.7;
}

.validation__error {
  color: var(--danger);
}

.validation__warn {
  color: var(--warn);
}

.progress {
  margin-top: 14px;
}

.progress__bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg-3);
  overflow: hidden;
}

.progress__fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.18s ease;
}

.result {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
  max-height: 180px;
  overflow-y: auto;
}

.result__row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.result__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.result__meta {
  color: var(--text-2);
  font-size: 11px;
}
</style>
