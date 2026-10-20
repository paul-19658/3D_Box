<template>
  <section class="composer" :class="{ 'is-sending': sending }">
    <div class="composer__card">
      <div class="composer__row">
        <textarea
          ref="input"
          v-model="draft"
          class="composer__input"
          rows="1"
          placeholder="选中一个元素或机位，描述如何调整…"
          @keydown.enter.exact.prevent="submit"
          @input="autoGrow"
        ></textarea>
        <button type="button" class="icon-btn" title="添加参考图" @click="pickImages">+</button>
      </div>

      <div class="composer__row composer__row--foot">
        <div class="model-chip">
          <select class="model-chip__select" :value="activeProviderId" @change="setProvider">
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">
              {{ provider.name }}<template v-if="provider.model"> · {{ provider.model }}</template>
            </option>
          </select>
          <span v-if="!hasApiKey" class="model-chip__warn" title="该服务尚未配置密钥">未配置</span>
        </div>

        <div class="composer__foot-right">
          <button type="button" class="icon-btn" title="AI 设置" @click="$emit('open-settings')">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3" />
              <path
                d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M4 4l1.1 1.1M10.9 10.9 12 12M12 4l-1.1 1.1M5.1 10.9 4 12"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
              />
            </svg>
          </button>
          <button
            type="button"
            class="send-btn"
            :disabled="sending || !draft.trim()"
            :title="sending ? '正在生成…' : '发送 (Enter)'"
            @click="submit"
          >
            <svg v-if="!sending" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 8 13.5 3l-4 10.5-2.2-3.4z" fill="currentColor" />
            </svg>
            <span v-else class="spinner spinner--sm"></span>
          </button>
        </div>
      </div>

      <input
        ref="imageInput"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        class="hidden-input"
        @change="handleImages"
      />
    </div>
  </section>
</template>

<script>
/**
 * 底部 AI 输入卡：自然语言 -> 场景命令。
 *
 * 交互约定：
 * - Enter 发送，Shift+Enter 换行；
 * - 服务商与模型在下拉里切换，密钥永远不落到前端（只显示"未配置"）；
 * - 参考图可选，作为图片消息附加给支持视觉的模型。
 */
export default {
  name: 'AiComposer',

  props: {
    sending: { type: Boolean, default: false },
    settings: { type: Object, default: null }
  },

  data() {
    return {
      draft: '',
      images: []
    }
  },

  computed: {
    providers() {
      return this.settings?.providers || []
    },
    activeProviderId() {
      return this.settings?.activeProviderId || this.providers[0]?.id || ''
    },
    hasApiKey() {
      const provider = this.providers.find((item) => item.id === this.activeProviderId)
      return provider ? provider.hasApiKey : false
    }
  },

  methods: {
    autoGrow() {
      const element = this.$refs.input
      if (!element) return
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 120)}px`
    },
    submit() {
      const content = this.draft.trim()
      if (!content || this.sending) return
      this.$emit('send', content)
      this.draft = ''
      this.$nextTick(this.autoGrow)
    },
    setProvider(event) {
      this.$emit('open-settings', { activeProviderId: event.target.value })
    },
    pickImages() {
      this.$refs.imageInput.click()
    },
    async handleImages(event) {
      const files = [...event.target.files]
      event.target.value = ''
      const images = []
      for (const file of files) {
        images.push({
          name: file.name,
          mimeType: file.type || 'image/png',
          data: await this.toBase64(file)
        })
      }
      if (images.length > 0) this.$emit('attach-images', images)
    },
    toBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
    }
  }
}
</script>

<style scoped>
.composer {
  position: absolute;
  left: 50%;
  bottom: 18px;
  width: min(680px, calc(100% - 48px));
  transform: translateX(-50%);
}

.composer__card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-l);
  background: var(--panel-blur);
  backdrop-filter: blur(14px);
  box-shadow: var(--shadow-pop);
}

.composer.is-sending .composer__card {
  border-color: var(--accent);
}

.composer__row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}

.composer__row--foot {
  align-items: center;
  justify-content: space-between;
}

.composer__input {
  flex: 1;
  max-height: 120px;
  min-height: 24px;
  padding: 4px 2px;
  border: none;
  background: transparent;
  color: var(--text-0);
  outline: none;
  resize: none;
  line-height: 1.55;
}

.composer__input::placeholder {
  color: var(--text-2);
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg-2);
  color: var(--text-1);
  cursor: pointer;
  flex: none;
}

.icon-btn:hover {
  color: var(--text-0);
  border-color: var(--line-strong);
}

.icon-btn svg {
  width: 14px;
  height: 14px;
}

.model-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--bg-2);
}

.model-chip__select {
  max-width: 220px;
  border: none;
  background: transparent;
  color: var(--text-1);
  font-size: 11px;
  outline: none;
  cursor: pointer;
}

.model-chip__warn {
  color: var(--warn);
  font-size: 10px;
}

.composer__foot-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.send-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #ffffff;
  cursor: pointer;
}

.send-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.send-btn svg {
  width: 16px;
  height: 16px;
}

.spinner--sm {
  width: 12px;
  height: 12px;
  border-width: 2px;
  border-top-color: #ffffff;
}
</style>
