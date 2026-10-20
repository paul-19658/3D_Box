<template>
  <div class="dialog-veil" @click.self="$emit('close')">
    <section class="dialog dialog--wide" role="dialog" aria-label="导出参考图">
      <header class="dialog__head">
        <span>导出参考图</span>
        <button type="button" class="btn btn--ghost" @click="$emit('close')">关闭</button>
      </header>

      <div class="dialog__body">
        <p class="hint">
          控制参考图会隐藏网格、灯光标记与坐标轴，只保留模型本身，可直接投喂给图生视频 / ControlNet。
        </p>

        <p class="section-title">通道</p>
        <div class="channel-grid">
          <label v-for="channel in channels" :key="channel.key" class="checkbox">
            <input v-model="selected" type="checkbox" :value="channel.key" />
            <span>{{ channel.label }}</span>
          </label>
        </div>

        <p class="section-title section-gap">输出</p>
        <label class="field">
          <span class="field__label">最大边</span>
          <select v-model.number="maxDimension" class="select">
            <option :value="1280">1280 px</option>
            <option :value="1920">1920 px</option>
            <option :value="2560">2560 px</option>
          </select>
        </label>
        <p class="meta-line">
          画幅 {{ camera.aspectWidth }}:{{ camera.aspectHeight }}，实际输出 {{ size.width }} ×
          {{ size.height }}（宽高取偶数，满足 H.264 要求）。
        </p>

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
        <button type="button" class="btn" @click="$emit('close')">关闭</button>
        <button type="button" class="btn btn--primary" :disabled="busy || !viewport" @click="exportChannels">
          {{ busy ? '导出中…' : '导出所选通道' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script>
/**
 * 参考图导出。
 *
 * 六个通道一次性渲染，避免用户来回点六次；渲染由视口组件的
 * `captureControlPasses` 完成——它负责临时替换材质并在 finally 里恢复，
 * 因此导出结束后画面不会残留。
 */
import { api } from '@/api/client'
import { outputSize } from '@/core/video'

export default {
  name: 'ImageExportDialog',

  props: {
    viewport: { type: Object, default: null }
  },

  data() {
    return {
      channels: [
        { key: 'white', label: '白模' },
        { key: 'depth', label: '深度' },
        { key: 'normal', label: '法线' },
        { key: 'objectId', label: '物体分色' },
        { key: 'mask', label: '遮罩' },
        { key: 'outline', label: '轮廓' }
      ],
      selected: ['white', 'depth', 'mask'],
      maxDimension: 1920,
      busy: false,
      exported: []
    }
  },

  computed: {
    camera() {
      return this.$store.getters.camera
    },
    size() {
      return outputSize(this.camera, this.maxDimension)
    }
  },

  methods: {
    formatSize(bytes) {
      if (!Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    },
    downloadUrl(fileName) {
      return api.exports.downloadUrl(fileName)
    },
    async exportChannels() {
      if (!this.viewport || this.selected.length === 0) return
      this.busy = true
      this.exported = []
      try {
        const passes = this.viewport.captureControlPasses(this.maxDimension)
        const prefix = this.$store.state.projectName
        const files = []
        for (const channel of this.channels) {
          if (!this.selected.includes(channel.key)) continue
          const base64 = passes[channel.key]
          if (!base64) continue
          const result = await api.exports.save(`${prefix}_${channel.label}.png`, base64)
          files.push(result)
        }
        this.exported = files
        await this.$store.dispatch('notify', {
          kind: 'success',
          message: `已导出 ${files.length} 张参考图，可在下方下载。`
        })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: `导出失败：${error.message}` })
      } finally {
        this.busy = false
      }
    }
  }
}
</script>

<style scoped>
.hint {
  margin: 0 0 12px;
  color: var(--text-1);
  line-height: 1.75;
}

.channel-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}

.section-gap {
  margin-top: 16px;
}

.meta-line {
  margin: 0;
  color: var(--text-2);
  font-size: 11px;
}

.result {
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
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
