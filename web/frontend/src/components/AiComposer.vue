<template>
  <section
    ref="root"
    class="composer"
    :class="{
      'is-expanded': expanded,
      'is-sending': sending || verifying,
      'is-collapsed': !expanded
    }"
  >
    <!-- 对话记录：仅展开时显示在输入卡上方 -->
    <div v-if="expanded && messages.length > 0" class="composer__transcript">
      <header class="composer__transcript-head">
        <span>对话</span>
        <button type="button" class="ghost-link" @click.stop="$emit('clear-messages')">清空</button>
      </header>
      <div ref="transcriptList" class="composer__transcript-list">
        <article
          v-for="(message, index) in messages"
          :key="index"
          class="msg"
          :class="message.role === 'user' ? 'msg--user' : 'msg--assistant'"
        >
          <pre v-if="displayMessage(message.content)" class="msg__text">{{
            displayMessage(message.content)
          }}</pre>
          <div v-if="messageImages(message).length > 0" class="msg__images">
            <button
              v-for="(image, imageIndex) in messageImages(message)"
              :key="imageIndex"
              type="button"
              class="msg__image"
              :title="image.name || `参考图 ${imageIndex + 1}`"
              @click.stop="openImagePreview(image)"
            >
              <img :src="thumbSrc(image)" :alt="image.name || `参考图 ${imageIndex + 1}`" />
            </button>
          </div>
        </article>
        <div v-if="verifying || sending" class="msg msg--assistant msg--pending">
          <pre class="msg__text">{{
            verifying ? '正在截取画面供 Agent 观察…' : '正在思考…'
          }}</pre>
        </div>
      </div>
    </div>

    <div
      class="composer__card"
      role="button"
      :tabindex="expanded ? -1 : 0"
      :aria-expanded="expanded ? 'true' : 'false'"
      @mousedown.stop
      @click="onCardClick"
    >
      <!-- 参考图缩略图（展开） -->
      <div v-if="expanded && pendingImages.length > 0" class="composer__thumbs">
        <div v-for="(image, index) in pendingImages" :key="index" class="thumb">
          <img :src="thumbSrc(image)" :alt="image.name || '参考图'" />
          <button type="button" class="thumb__remove" title="移除" @click.stop="removeImage(index)">
            ×
          </button>
        </div>
      </div>

      <!-- 输入行 -->
      <div class="composer__prompt" :class="{ 'composer__prompt--collapsed': !expanded }">
        <template v-if="expanded">
          <textarea
            ref="input"
            v-model="draft"
            class="composer__input"
            rows="2"
            :placeholder="placeholder"
            :disabled="sending || verifying"
            @keydown.enter.exact.prevent="submit"
            @input="autoGrow"
            @focus="expand"
          ></textarea>
          <span v-if="selectionChip" class="object-chip" :title="`当前选中：${selectionChip}`">
            <span class="object-chip__icon" aria-hidden="true">
              <svg viewBox="0 0 14 14">
                <rect x="2" y="2" width="10" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.2" />
                <path d="M7 3.5v3.2M7 9.2v.3M5.2 5.6l1.8 1.1 1.8-1.1" fill="none" stroke="currentColor" stroke-width="1.2" />
              </svg>
            </span>
            {{ selectionChip }}
          </span>
        </template>
        <template v-else>
          <div class="composer__collapsed-text">
            <span v-if="draft.trim()" class="composer__preview">{{ draft }}</span>
            <span v-else class="composer__placeholder">{{ placeholder }}</span>
            <span v-if="selectionChip" class="object-chip object-chip--mini" :title="selectionChip">
              <span class="object-chip__icon" aria-hidden="true">⚡</span>
              {{ selectionChipShort }}
            </span>
          </div>
        </template>

        <button
          v-if="!expanded"
          type="button"
          class="send-btn"
          :disabled="sending || verifying || !canSend"
          :title="sendTitle"
          @click.stop="submit"
        >
          <span v-if="sending || verifying" class="spinner spinner--sm"></span>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2.8 3.6 7.2a.75.75 0 0 0 1.06 1.06L7.25 5.67V12.5a.75.75 0 0 0 1.5 0V5.67l2.59 2.59A.75.75 0 1 0 12.4 7.2L8 2.8Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      <!-- 展开底栏 -->
      <div v-if="expanded" class="composer__toolbar">
        <div class="composer__toolbar-left">
          <button
            type="button"
            class="round-btn"
            title="添加参考图"
            :disabled="sending || verifying || pendingImages.length >= maxImages"
            @click.stop="pickImages"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
            </svg>
          </button>
          <button type="button" class="round-btn" title="AI 设置" @click.stop="$emit('open-settings')">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="5" cy="6" r="2" fill="none" stroke="currentColor" stroke-width="1.3" />
              <circle cx="11" cy="5.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
              <circle cx="8.5" cy="11" r="2" fill="none" stroke="currentColor" stroke-width="1.3" />
            </svg>
          </button>
          <div
            ref="modelPill"
            class="model-pill"
            :class="{
              'is-warn': providers.length > 0 && !hasApiKey,
              'is-open': modelMenuOpen
            }"
          >
            <button
              type="button"
              class="model-pill__trigger"
              :disabled="sending || verifying || providers.length === 0"
              :title="providerLabel"
              :aria-expanded="modelMenuOpen ? 'true' : 'false'"
              @click.stop="toggleModelMenu"
            >
              <span class="model-pill__mark" aria-hidden="true">
                <svg viewBox="0 0 14 14">
                  <rect x="1.5" y="1.5" width="6" height="6" rx="1.2" fill="currentColor" opacity="0.9" />
                  <rect x="6.5" y="6.5" width="6" height="6" rx="1.2" fill="currentColor" opacity="0.55" />
                </svg>
              </span>
              <span class="model-pill__label">{{ providers.length === 0 ? '未配置服务' : providerLabel }}</span>
              <span v-if="providers.length > 0 && !hasApiKey" class="model-pill__warn">未配置</span>
              <span class="model-pill__chevron" aria-hidden="true">▾</span>
            </button>
            <div v-if="modelMenuOpen" class="model-menu" role="listbox" @mousedown.stop @click.stop>
              <button
                v-for="provider in providers"
                :key="provider.id"
                type="button"
                class="model-menu__item"
                :class="{ 'is-active': provider.id === activeProviderId }"
                role="option"
                :aria-selected="provider.id === activeProviderId ? 'true' : 'false'"
                @click="pickProvider(provider.id)"
              >
                <span class="model-menu__name">{{ provider.name || '未命名服务' }}</span>
                <span v-if="providerModelHint(provider)" class="model-menu__model">{{
                  providerModelHint(provider)
                }}</span>
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="send-btn"
          :disabled="sending || verifying || !canSend"
          :title="sendTitle"
          @click.stop="submit"
        >
          <span v-if="sending || verifying" class="spinner spinner--sm"></span>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2.8 3.6 7.2a.75.75 0 0 0 1.06 1.06L7.25 5.67V12.5a.75.75 0 0 0 1.5 0V5.67l2.59 2.59A.75.75 0 1 0 12.4 7.2L8 2.8Z"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>

      <input
        ref="imageInput"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        class="hidden-input"
        @change="handleImages"
      />
    </div>
  </section>
</template>

<script>
/**
 * 底部 AI 输入卡（展开 / 收起）。
 *
 * - 收起：胶囊条，展示草稿摘要 + 青色发送钮；
 * - 展开：多行输入、选中物体芯片、参考图、模型切换；
 * - 点击卡片展开；点页面其他区域收起（含 AI 运行中，便于腾出视口）。
 */
const MAX_IMAGES = 4

export default {
  name: 'AiComposer',

  props: {
    sending: { type: Boolean, default: false },
    verifying: { type: Boolean, default: false },
    settings: { type: Object, default: null },
    pendingImages: { type: Array, default: () => [] },
    messages: { type: Array, default: () => [] },
    selectedObject: { type: Object, default: null }
  },

  data() {
    return {
      draft: '',
      expanded: false,
      modelMenuOpen: false,
      maxImages: MAX_IMAGES
    }
  },

  computed: {
    providers() {
      return this.settings?.providers || []
    },
    activeProviderId() {
      return this.settings?.activeProviderId || this.providers[0]?.id || ''
    },
    activeProvider() {
      return this.providers.find((item) => item.id === this.activeProviderId) || null
    },
    providerLabel() {
      if (!this.activeProvider) return '未配置服务'
      return this.providerOptionLabel(this.activeProvider)
    },
    hasApiKey() {
      const provider = this.activeProvider
      if (!provider) return false
      if (provider.kind === 'custom') return true
      return Boolean(provider.hasApiKey)
    },
    canSend() {
      return this.draft.trim().length > 0 || this.pendingImages.length > 0
    },
    placeholder() {
      if (this.verifying) return '正在复核相机画面…'
      if (this.sending) return '正在生成…'
      return '描述要搭建或调整的场景…'
    },
    sendTitle() {
      if (this.verifying) return '正在复核…'
      if (this.sending) return '正在生成…'
      return '发送 (Enter)'
    },
    selectionChip() {
      return this.selectedObject?.name || ''
    },
    selectionChipShort() {
      const name = this.selectionChip
      if (!name) return ''
      return name.length > 4 ? name.slice(0, 4) : name
    }
  },

  watch: {
    messages() {
      this.$nextTick(this.scrollTranscript)
    },
    sending(value) {
      // 仅在本轮开始时自动展开；运行中用户收起后不再强行打开。
      if (value) this.expanded = true
      this.$nextTick(this.scrollTranscript)
    },
    verifying() {
      this.$nextTick(this.scrollTranscript)
    }
  },

  mounted() {
    document.addEventListener('mousedown', this.onDocumentMouseDown, true)
  },

  beforeDestroy() {
    document.removeEventListener('mousedown', this.onDocumentMouseDown, true)
  },

  methods: {
    providerOptionLabel(provider) {
      const name = (provider.name || '').trim() || '未命名服务'
      const model = (provider.model || '').trim()
      if (model && model !== name) return `${name} · ${model}`
      return model || name
    },
    providerModelHint(provider) {
      const name = (provider.name || '').trim()
      const model = (provider.model || '').trim()
      if (!model || model === name) return ''
      return model
    },
    displayMessage(content) {
      return String(content || '')
        .replace(/```json\s*[\s\S]*?```/gi, '```json\n[场景命令已折叠]\n```')
        .replace(/\n\n\[已附带 \d+ 张参考图\]\s*$/u, '')
        .trim()
    },
    scrollTranscript() {
      const list = this.$refs.transcriptList
      if (!list) return
      list.scrollTop = list.scrollHeight
    },
    expand() {
      if (this.expanded) return
      this.expanded = true
      this.$nextTick(() => {
        this.autoGrow()
        this.$refs.input?.focus()
        this.scrollTranscript()
      })
    },
    collapse() {
      if (!this.expanded) return
      this.modelMenuOpen = false
      this.expanded = false
    },
    onCardClick() {
      if (!this.expanded) this.expand()
    },
    onDocumentMouseDown(event) {
      const root = this.$refs.root
      const modelPill = this.$refs.modelPill
      const target = event.target
      const insideRoot =
        root instanceof HTMLElement && target instanceof Node && root.contains(target)
      const insideModel =
        modelPill instanceof HTMLElement && target instanceof Node && modelPill.contains(target)
      if (this.modelMenuOpen && !insideModel) {
        this.modelMenuOpen = false
      }
      if (!this.expanded) return
      if (insideRoot) return
      this.collapse()
    },
    toggleModelMenu() {
      if (this.sending || this.verifying || this.providers.length === 0) return
      this.modelMenuOpen = !this.modelMenuOpen
    },
    pickProvider(providerId) {
      this.modelMenuOpen = false
      if (!providerId || providerId === this.activeProviderId) return
      this.$emit('switch-provider', providerId)
    },
    autoGrow() {
      const element = this.$refs.input
      if (!element) return
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 96)}px`
    },
    submit() {
      if (!this.canSend || this.sending || this.verifying) return
      const content = this.draft.trim()
      this.$emit('send', content)
      this.draft = ''
      this.expanded = true
      this.$nextTick(this.autoGrow)
    },
    pickImages() {
      this.$refs.imageInput.click()
    },
    removeImage(index) {
      this.$emit('remove-image', index)
    },
    thumbSrc(image) {
      if (!image) return ''
      if (image.dataUrl) return image.dataUrl
      return `data:${image.mimeType || 'image/png'};base64,${image.base64Data || ''}`
    },
    messageImages(message) {
      return Array.isArray(message?.images) ? message.images : []
    },
    openImagePreview(image) {
      const src = this.thumbSrc(image)
      if (!src) return
      window.open(src, '_blank', 'noopener')
    },
    async handleImages(event) {
      const files = [...event.target.files]
      event.target.value = ''
      const room = MAX_IMAGES - this.pendingImages.length
      if (room <= 0) {
        this.$emit('error', `最多附带 ${MAX_IMAGES} 张参考图。`)
        return
      }
      const images = []
      for (const file of files.slice(0, room)) {
        if (!file.type.startsWith('image/')) continue
        images.push({
          name: file.name,
          mimeType: file.type || 'image/png',
          base64Data: await this.toBase64(file)
        })
      }
      if (images.length > 0) {
        this.expand()
        this.$emit('attach-images', images)
      }
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
  --ai-cyan: #5ce1ff;
  --ai-cyan-strong: #7aecff;
  --ai-surface: rgba(22, 24, 28, 0.92);
  --ai-surface-2: rgba(36, 38, 44, 0.95);
  --ai-border: rgba(255, 255, 255, 0.12);

  position: absolute;
  left: 50%;
  bottom: 18px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, calc(100% - 48px));
  transform: translateX(-50%);
  transition: width 0.22s ease;
}

.composer.is-expanded {
  width: min(560px, calc(100% - 48px));
}

.composer__card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--ai-border);
  border-radius: 28px;
  background: var(--ai-surface);
  backdrop-filter: blur(18px);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
  cursor: text;
  transition:
    border-radius 0.2s ease,
    padding 0.2s ease,
    box-shadow 0.2s ease;
}

.composer.is-collapsed .composer__card {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  padding: 6px 8px 6px 18px;
  border-radius: 999px;
  cursor: pointer;
}

.composer.is-sending .composer__card {
  position: relative;
  isolation: isolate;
  border-color: color-mix(in srgb, var(--ai-cyan) 75%, transparent);
  box-shadow:
    0 18px 48px rgba(0, 0, 0, 0.45),
    0 0 0 1px color-mix(in srgb, var(--ai-cyan) 40%, transparent),
    0 0 28px color-mix(in srgb, var(--ai-cyan) 42%, transparent),
    0 0 56px color-mix(in srgb, var(--ai-cyan) 22%, transparent);
  animation: composer-glow-pulse 1.6s ease-in-out infinite;
}

/* 外圈柔光：不旋转元素本身，避免胶囊形被拧歪 */
.composer.is-sending .composer__card::before {
  content: '';
  position: absolute;
  inset: -40%;
  z-index: -1;
  background: radial-gradient(
    closest-side,
    color-mix(in srgb, var(--ai-cyan) 55%, transparent),
    color-mix(in srgb, var(--ai-cyan) 18%, transparent) 42%,
    transparent 72%
  );
  opacity: 0.55;
  animation: composer-halo-breathe 1.8s ease-in-out infinite;
  pointer-events: none;
}

/* 横向扫光 */
.composer.is-sending .composer__card::after {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: inherit;
  background: linear-gradient(
    105deg,
    transparent 18%,
    color-mix(in srgb, var(--ai-cyan) 14%, transparent) 42%,
    color-mix(in srgb, var(--ai-cyan-strong) 36%, transparent) 50%,
    color-mix(in srgb, #fff 22%, var(--ai-cyan)) 52%,
    color-mix(in srgb, var(--ai-cyan) 14%, transparent) 58%,
    transparent 82%
  );
  background-size: 220% 100%;
  animation: composer-shimmer 1.9s ease-in-out infinite;
  pointer-events: none;
}

.composer.is-sending .composer__card > * {
  position: relative;
  z-index: 1;
}

.composer.is-sending .composer__placeholder {
  color: color-mix(in srgb, var(--ai-cyan-strong) 78%, #fff);
  text-shadow: 0 0 12px color-mix(in srgb, var(--ai-cyan) 55%, transparent);
  animation: composer-text-pulse 1.4s ease-in-out infinite;
}

.composer.is-sending .composer__input::placeholder {
  color: color-mix(in srgb, var(--ai-cyan-strong) 72%, #fff);
}

@keyframes composer-glow-pulse {
  0%,
  100% {
    border-color: color-mix(in srgb, var(--ai-cyan) 55%, transparent);
    box-shadow:
      0 18px 48px rgba(0, 0, 0, 0.45),
      0 0 0 1px color-mix(in srgb, var(--ai-cyan) 35%, transparent),
      0 0 22px color-mix(in srgb, var(--ai-cyan) 32%, transparent),
      0 0 44px color-mix(in srgb, var(--ai-cyan) 16%, transparent);
  }
  50% {
    border-color: color-mix(in srgb, var(--ai-cyan-strong) 90%, #fff);
    box-shadow:
      0 18px 48px rgba(0, 0, 0, 0.45),
      0 0 0 1px color-mix(in srgb, var(--ai-cyan-strong) 65%, transparent),
      0 0 38px color-mix(in srgb, var(--ai-cyan) 62%, transparent),
      0 0 76px color-mix(in srgb, var(--ai-cyan) 34%, transparent);
  }
}

@keyframes composer-halo-breathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.92);
  }
  50% {
    opacity: 0.75;
    transform: scale(1.05);
  }
}

@keyframes composer-shimmer {
  0% {
    background-position: 140% 0;
    opacity: 0.4;
  }
  45%,
  55% {
    opacity: 0.95;
  }
  100% {
    background-position: -140% 0;
    opacity: 0.4;
  }
}

@keyframes composer-text-pulse {
  0%,
  100% {
    opacity: 0.72;
  }
  50% {
    opacity: 1;
  }
}

.composer__prompt {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.composer__prompt--collapsed {
  flex-wrap: nowrap;
  align-items: center;
  gap: 10px;
}

.composer__input {
  flex: 1 1 180px;
  max-height: 96px;
  min-height: 44px;
  padding: 4px 2px;
  border: none;
  background: transparent;
  color: #f2f4f6;
  font-size: 14px;
  line-height: 1.55;
  outline: none;
  resize: none;
}

.composer__input::placeholder {
  color: rgba(255, 255, 255, 0.35);
}

.composer__input:disabled {
  opacity: 0.7;
}

.composer__collapsed-text {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}

.composer__preview,
.composer__placeholder {
  overflow: hidden;
  color: #f2f4f6;
  font-size: 14px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.composer__placeholder {
  color: rgba(255, 255, 255, 0.38);
}

.object-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 140px;
  height: 26px;
  padding: 0 9px 0 7px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.28);
  color: #f4f6f8;
  font-size: 12px;
  white-space: nowrap;
  text-overflow: ellipsis;
  flex: none;
}

.object-chip--mini {
  max-width: 72px;
  height: 22px;
  padding: 0 7px;
  font-size: 11px;
}

.object-chip__icon {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  color: rgba(255, 255, 255, 0.85);
  flex: none;
}

.object-chip__icon svg {
  width: 14px;
  height: 14px;
}

.composer__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.composer__toolbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.round-btn {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 50%;
  background: var(--ai-surface-2);
  color: rgba(255, 255, 255, 0.78);
  cursor: pointer;
  flex: none;
}

.round-btn:hover:not(:disabled) {
  color: #fff;
  border-color: rgba(255, 255, 255, 0.22);
}

.round-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.round-btn svg {
  width: 15px;
  height: 15px;
}

.model-pill {
  position: relative;
  min-width: 0;
  max-width: 260px;
}

.model-pill.is-warn .model-pill__trigger {
  border-color: color-mix(in srgb, var(--warn) 45%, transparent);
}

.model-pill.is-open .model-pill__trigger {
  border-color: rgba(92, 225, 255, 0.35);
  color: #fff;
}

.model-pill.is-open .model-pill__chevron {
  transform: rotate(180deg);
  color: rgba(255, 255, 255, 0.7);
}

.model-pill__trigger {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 999px;
  background: var(--ai-surface-2);
  color: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  text-align: left;
}

.model-pill__trigger:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.22);
  color: #fff;
}

.model-pill__trigger:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.model-pill__mark {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  color: #fff;
  flex: none;
}

.model-pill__mark svg {
  width: 14px;
  height: 14px;
}

.model-pill__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.2;
}

.model-pill__warn {
  color: var(--warn);
  font-size: 10px;
  flex: none;
}

.model-pill__chevron {
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px;
  flex: none;
  transition: transform 0.15s ease;
}

.model-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 100%;
  max-width: min(320px, 70vw);
  max-height: 220px;
  overflow: auto;
  padding: 6px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: rgba(18, 20, 24, 0.96);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(16px);
}

.model-menu__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: rgba(255, 255, 255, 0.88);
  cursor: pointer;
  text-align: left;
}

.model-menu__item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.model-menu__item.is-active {
  background: color-mix(in srgb, var(--ai-cyan) 16%, transparent);
  color: #fff;
}

.model-menu__name {
  font-size: 12px;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.model-menu__model {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.model-menu__item.is-active .model-menu__model {
  color: color-mix(in srgb, var(--ai-cyan) 70%, #fff);
}

.send-btn {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  background: linear-gradient(180deg, var(--ai-cyan-strong), var(--ai-cyan));
  color: #0b1218;
  cursor: pointer;
  box-shadow: 0 0 18px color-mix(in srgb, var(--ai-cyan) 35%, transparent);
  flex: none;
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.06);
}

.send-btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
  box-shadow: none;
}

.composer.is-sending .send-btn:disabled {
  opacity: 1;
  cursor: wait;
  filter: none;
  background: linear-gradient(180deg, #b8f7ff, var(--ai-cyan-strong) 40%, var(--ai-cyan));
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--ai-cyan-strong) 45%, transparent),
    0 0 22px color-mix(in srgb, var(--ai-cyan) 70%, transparent),
    0 0 40px color-mix(in srgb, var(--ai-cyan) 40%, transparent);
  animation: send-busy-pulse 1.2s ease-in-out infinite;
}

.send-btn svg {
  width: 16px;
  height: 16px;
}

.spinner--sm {
  width: 14px;
  height: 14px;
  border-width: 2px;
  border-top-color: #0b1218;
}

.composer.is-sending .spinner--sm {
  width: 16px;
  height: 16px;
  border-color: rgba(11, 18, 24, 0.22);
  border-top-color: #061018;
  border-right-color: rgba(11, 18, 24, 0.55);
  animation: spin 0.55s linear infinite;
}

@keyframes send-busy-pulse {
  0%,
  100% {
    transform: scale(1);
    box-shadow:
      0 0 0 2px color-mix(in srgb, var(--ai-cyan-strong) 40%, transparent),
      0 0 18px color-mix(in srgb, var(--ai-cyan) 55%, transparent),
      0 0 32px color-mix(in srgb, var(--ai-cyan) 28%, transparent);
  }
  50% {
    transform: scale(1.06);
    box-shadow:
      0 0 0 3px color-mix(in srgb, var(--ai-cyan-strong) 65%, transparent),
      0 0 28px color-mix(in srgb, var(--ai-cyan) 85%, transparent),
      0 0 52px color-mix(in srgb, var(--ai-cyan) 48%, transparent);
  }
}

.composer__thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.thumb {
  position: relative;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  background: #111;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb__remove {
  position: absolute;
  top: 1px;
  right: 1px;
  width: 16px;
  height: 16px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.composer__transcript {
  display: flex;
  flex-direction: column;
  max-height: min(240px, 32vh);
  overflow: hidden;
  border: 1px solid var(--ai-border);
  border-radius: 18px;
  background: var(--ai-surface);
  backdrop-filter: blur(18px);
  box-shadow: 0 14px 36px rgba(0, 0, 0, 0.4);
}

.composer__transcript-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
}

.ghost-link {
  padding: 0;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  font-size: 11px;
  cursor: pointer;
}

.ghost-link:hover {
  color: #fff;
}

.composer__transcript-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  overflow: auto;
}

.msg {
  max-width: 94%;
}

.msg--user {
  align-self: flex-end;
}

.msg--assistant {
  align-self: flex-start;
}

.msg__text {
  margin: 0;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  color: #e8ecef;
  font-family: inherit;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg--user .msg__text {
  border-color: color-mix(in srgb, var(--ai-cyan) 28%, transparent);
  background: color-mix(in srgb, var(--ai-cyan) 10%, rgba(255, 255, 255, 0.04));
}

.msg__images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}

.msg__image {
  display: block;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  overflow: hidden;
  background: rgba(0, 0, 0, 0.25);
  cursor: zoom-in;
}

.msg__image img {
  display: block;
  width: 72px;
  height: 72px;
  object-fit: cover;
}

.msg--pending .msg__text {
  color: rgba(255, 255, 255, 0.45);
  font-style: italic;
}

.hidden-input {
  display: none;
}
</style>
