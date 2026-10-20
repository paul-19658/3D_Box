<template>
  <div class="dialog-veil" @click.self="$emit('close')">
    <section class="dialog" role="dialog" aria-label="导出模型">
      <header class="dialog__head">
        <span>导出模型</span>
        <button type="button" class="btn btn--ghost" @click="$emit('close')">关闭</button>
      </header>

      <div class="dialog__body">
        <label class="field">
          <span class="field__label">格式</span>
          <select v-model="format" class="select">
            <option value="glb">GLB（单文件，含纹理）</option>
            <option value="gltf">GLTF（内嵌资源）</option>
            <option value="obj">OBJ（纯几何）</option>
          </select>
        </label>

        <p class="meta-line">导出范围：{{ objectCount }} 个可见物体。隐藏对象不会写入文件。</p>

        <div v-if="report" class="report">
          <p class="section-title">文件概况</p>
          <p class="meta-line">
            网格 {{ report.meshCount }} · 三角面 {{ report.triangleCount.toLocaleString() }}
          </p>
          <p class="meta-line">材质 {{ report.materialCount }} · 纹理 {{ report.textureCount }}</p>
          <p
            v-for="issue in report.issues"
            :key="issue.message"
            class="meta-line"
            :class="`issue--${issue.severity}`"
          >
            {{ issue.message }}
          </p>
        </div>

        <div v-if="exported" class="result">
          <p class="section-title">已生成</p>
          <div class="result__row">
            <span class="result__name">{{ exported.fileName }}</span>
            <span class="result__meta">{{ formatSize(exported.byteLength) }}</span>
            <a class="btn" :href="downloadUrl(exported.fileName)" target="_blank" rel="noopener">下载</a>
          </div>
        </div>
      </div>

      <footer class="dialog__foot">
        <button type="button" class="btn" @click="exportText">导出场景说明</button>
        <button type="button" class="btn btn--primary" :disabled="busy || !viewport" @click="run">
          {{ busy ? '导出中…' : '导出模型' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script>
/**
 * 模型导出：把当前场景（只含可见物体）导出成 GLB / GLTF / OBJ。
 *
 * 说明文档（场景描述 + 建议提示词）单独提供入口：
 * 对"给 AI 生成视频"这条链路来说，文字描述往往比几何文件更关键。
 */
import { api } from '@/api/client'
import { base64ForModel } from '@/core/model-io'

export default {
  name: 'ModelExportDialog',

  props: {
    viewport: { type: Object, default: null }
  },

  data() {
    return {
      format: 'glb',
      busy: false,
      report: null,
      exported: null
    }
  },

  computed: {
    objects() {
      return this.$store.getters.objects
    },
    objectCount() {
      return this.objects.filter((object) => object.visible).length
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
    async run() {
      if (!this.viewport) return
      this.busy = true
      this.exported = null
      try {
        const result = await this.viewport.exportSceneModel(this.format)
        this.report = result.report
        const base64 = base64ForModel(result)
        const fileName = `${this.$store.state.projectName}.${this.format}`
        const saved = await api.exports.save(fileName, base64)
        this.exported = saved
        await this.$store.dispatch('notify', { kind: 'success', message: '模型已导出。' })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: `导出失败：${error.message}` })
      } finally {
        this.busy = false
      }
    },
    async exportText() {
      const scene = this.$store.getters.scene
      try {
        const descriptor = await api.sceneDescriptor(this.$store.state.projectName, scene)
        const prompt = await api.suggestedPrompt(this.$store.state.projectName, scene)
        const saved = await api.exports.saveText(
          `${this.$store.state.projectName}_场景说明.md`,
          [
            `# ${descriptor.projectName}`,
            '',
            '## 场景描述',
            '',
            ...descriptor.objects.map((object) => `- ${object.summary}`),
            '',
            '## 光照',
            '',
            descriptor.lighting.summaryLine,
            '',
            '## 建议提示词',
            '',
            prompt.prompt
          ].join('\n')
        )
        this.exported = saved
        await this.$store.dispatch('notify', { kind: 'success', message: '场景说明已导出。' })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: `导出失败：${error.message}` })
      }
    }
  }
}
</script>

<style scoped>
.meta-line {
  margin: 2px 0 0;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.7;
}

.report {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.issue--error {
  color: var(--danger);
}

.issue--warning {
  color: var(--warn);
}

.result {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.result__row {
  display: flex;
  align-items: center;
  gap: 8px;
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
