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
          <p class="validation__title">MP4 编码：{{ support.ok ? '可用' : '不可用' }}</p>
          <p class="meta-line">{{ support.message }}</p>
          <p v-if="support.ok && support.codec" class="meta-line">编码器：{{ support.codec }}</p>
        </div>

        <p class="section-title section-gap">导出内容</p>
        <label class="checkbox"
          ><input v-model="withVideo" type="checkbox" :disabled="!support.ok" /> MP4 视频（H.264，浏览器内编码）</label
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
 * 主产物是 **MP4**（浏览器内用 WebCodecs 编码 H.264 + mp4-muxer 封装），
 * 首帧 / 尾帧单图保留为附加产物——很多 AI 平台需要首尾帧成对上传。
 *
 * 为什么不再默认导出序列帧：
 * 5 秒 24fps 就是 120 张 PNG，每张几百 KB，落盘、下载、再交给剪辑软件
 * 转码，链路又长又占空间。而 WebCodecs 在 Chrome/Edge 111+ 上是原生能力，
 * 直接在浏览器里编成 MP4 只需一次上传。
 *
 * 但仍然**保留**序列帧选项：H.264 的可用性依赖硬件与系统，
 * 有些环境（无硬件加速的虚拟机、某些 Linux 发行版）确实没有可用的编码器。
 * 那种情况下序列帧是唯一可行的退路，所以不能删掉。
 *
 * 逐帧流程：
 * 1. `evaluateTimelineAtTime` 求出该帧的相机与物体变换；
 * 2. 把相机推到该帧位姿，渲染到一块可复用的 2D 画布（`captureFrameToCanvas`）；
 * 3. 交给编码器入队，或直接落盘成 PNG。
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
      support: { ok: false, message: '正在检测编码能力…' },
      supportChecked: false,
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
    supportTone() {
      if (!this.supportChecked) return 'unknown'
      return this.support.ok ? 'ok' : 'warning'
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
     */
    async refreshSupport() {
      const { width, height } = this.size
      this.supportChecked = false
      this.support = { ok: false, message: '正在检测编码能力…' }
      let result
      try {
        result = await probeMp4Support(width, height)
      } catch (error) {
        result = { ok: false, reason: 'no-codec', message: String(error?.message || error) }
      }
      this.support = { ...result, ...describeMp4Support(result) }
      this.supportChecked = true
      // 探测出不可用时自动勾上首尾帧，否则用户点"开始导出"会无事发生。
      if (!result.ok && !this.withEndpoints && !this.withSequence) this.withEndpoints = true
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

      try {
        if (this.withVideo && this.support.ok) {
          this.progress = { done: 0, total: plan.totalFrames, label: '编码' }
          // 复用同一块 2D 画布：每帧新建会带来明显的 GC 压力。
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
              const time = plan.sourceTimeSeconds(index)
              const frame = evaluateTimelineAtTime(this.timeline, this.camera, time)
              this.viewport.applyCameraState(frame.camera)
              this.viewport.captureFrameToCanvas(canvas, width, height)
              await session.addFrame(canvas, index)
              this.progress.done = index + 1
              // 让出主线程：编码是异步的，但循环本身是同步的，
              // 不让出的话进度条根本不会重绘，界面看起来像卡死。
              if (index % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
            }
            const blob = await session.finish()
            files.push(await api.exports.upload(mp4FileName(prefix), blob))
          } catch (error) {
            session.abort()
            throw error
          }
        }

        if (this.withSequence) {
          this.progress = { done: 0, total: plan.totalFrames, label: '序列帧' }
          for (let index = 0; index < plan.totalFrames; index += 1) {
            const time = plan.sourceTimeSeconds(index)
            const frame = evaluateTimelineAtTime(this.timeline, this.camera, time)
            this.viewport.applyCameraState(frame.camera)
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
            const frame = evaluateTimelineAtTime(this.timeline, this.camera, time)
            this.viewport.applyCameraState(frame.camera)
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
