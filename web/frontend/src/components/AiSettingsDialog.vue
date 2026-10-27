<template>
  <div class="dialog-veil" @click.self="$emit('close')">
    <section class="dialog dialog--wide" role="dialog" aria-label="AI 设置">
      <header class="dialog__head">
        <span>AI 服务设置</span>
        <button type="button" class="btn btn--ghost" @click="$emit('close')">关闭</button>
      </header>

      <div class="dialog__body">
        <p class="hint">
          密钥只保存在本机后端的
          <code>workspace/ai-environment.json</code>，不会随工程文件分发，也不会回传到浏览器。
        </p>

        <div class="provider-tabs">
          <button
            v-for="(provider, index) in form.providers"
            :key="provider.id"
            type="button"
            class="tab"
            :class="{ 'is-active': index === activeIndex }"
            @click="activeIndex = index"
          >
            {{ provider.name || `服务 ${index + 1}` }}
          </button>
          <button type="button" class="tab tab--add" @click="addProvider">+ 新增</button>
        </div>

        <template v-if="current">
          <label class="field">
            <span class="field__label">名称</span>
            <input v-model="current.name" class="input" maxlength="40" />
          </label>

          <label class="field">
            <span class="field__label">协议</span>
            <select v-model="current.kind" class="select">
              <option value="openai">OpenAI 官方</option>
              <option value="openai-compatible">OpenAI 兼容接口</option>
              <option value="anthropic">Anthropic Messages</option>
              <option value="custom">自定义（高级）</option>
            </select>
          </label>

          <label class="field">
            <span class="field__label">接口地址</span>
            <input v-model="current.baseUrl" class="input" placeholder="留空使用官方默认地址" />
          </label>

          <label class="field">
            <span class="field__label">模型</span>
            <input v-model="current.model" class="input" placeholder="例如 deepseek-chat / gpt-4o-mini" />
          </label>

          <label class="field">
            <span class="field__label">密钥</span>
            <input
              v-model="current.apiKey"
              class="input"
              type="password"
              :placeholder="current.hasApiKey ? '已保存，留空表示沿用' : '请输入 API Key'"
            />
          </label>

          <div class="field">
            <span class="field__label">温度</span>
            <input
              v-model.number="current.temperature"
              class="input"
              type="number"
              step="0.1"
              min="0"
              max="2"
            />
            <span class="field__label field__label--tight">最大长度</span>
            <input
              v-model.number="current.maxTokens"
              class="input"
              type="number"
              step="128"
              min="256"
              max="32768"
            />
          </div>

          <label class="field field--stack">
            <span class="field__label">系统提示词</span>
            <textarea v-model="form.systemPrompt" class="textarea" rows="8"></textarea>
          </label>

          <div class="actions">
            <button type="button" class="btn" @click="setActive">设为当前使用</button>
            <button
              v-if="form.providers.length > 1"
              type="button"
              class="btn btn--danger"
              @click="removeProvider"
            >
              删除该服务
            </button>
          </div>
        </template>
      </div>

      <footer class="dialog__foot">
        <button type="button" class="btn" @click="$emit('close')">取消</button>
        <button type="button" class="btn btn--primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </footer>
    </section>
  </div>
</template>

<script>
/**
 * AI 服务设置。
 *
 * 关键约束：表单里永远拿不到已保存的密钥明文，后端只回传 hasApiKey 布尔值。
 * 用户留空即"沿用旧值"，避免"打开设置再保存"意外清空密钥。
 */
import { AI_DEFAULT_SYSTEM_PROMPT } from '@/core/ai-defaults'

const createProvider = () => ({
  id: `provider-${Date.now().toString(36)}`,
  name: '新服务',
  kind: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.4,
  maxTokens: 2048,
  hasApiKey: false
})

export default {
  name: 'AiSettingsDialog',

  data() {
    return {
      activeIndex: 0,
      saving: false,
      form: {
        activeProviderId: null,
        providers: [],
        systemPrompt: AI_DEFAULT_SYSTEM_PROMPT
      }
    }
  },

  computed: {
    current() {
      return this.form.providers[this.activeIndex] || null
    }
  },

  created() {
    const settings = this.$store.state.aiSettings
    if (settings) {
      this.form.activeProviderId = settings.activeProviderId
      this.form.systemPrompt = settings.systemPrompt || AI_DEFAULT_SYSTEM_PROMPT
      this.form.providers = (settings.providers || []).map((provider) => ({
        ...provider,
        apiKey: ''
      }))
      const index = this.form.providers.findIndex((item) => item.id === settings.activeProviderId)
      this.activeIndex = index >= 0 ? index : 0
    }
    if (this.form.providers.length === 0) this.addProvider()
  },

  methods: {
    addProvider() {
      this.form.providers.push(createProvider())
      this.activeIndex = this.form.providers.length - 1
    },
    removeProvider() {
      this.form.providers.splice(this.activeIndex, 1)
      this.activeIndex = Math.max(this.activeIndex - 1, 0)
      if (!this.form.providers.some((item) => item.id === this.form.activeProviderId)) {
        this.form.activeProviderId = this.form.providers[0]?.id || null
      }
    },
    setActive() {
      if (!this.current) return
      this.form.activeProviderId = this.current.id
      this.$store.dispatch('notify', { kind: 'info', message: `已切换到「${this.current.name}」。` })
    },
    async save() {
      this.saving = true
      try {
        await this.$store.dispatch('saveAiSettings', {
          activeProviderId: this.form.activeProviderId || this.form.providers[0]?.id || null,
          systemPrompt: this.form.systemPrompt,
          // 去掉 hasApiKey：它是后端给前端看的只读标记，回传没有意义。
          providers: this.form.providers.map((provider) => {
            const copy = { ...provider }
            delete copy.hasApiKey
            return copy
          })
        })
        this.$emit('close')
      } finally {
        this.saving = false
      }
    }
  }
}
</script>

<style scoped>
.hint {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 12px;
  line-height: 1.7;
}

.hint code {
  color: var(--accent-strong);
}

.provider-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 12px;
}

.tab {
  padding: 4px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--bg-2);
  color: var(--text-1);
  cursor: pointer;
}

.tab.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.tab--add {
  border-style: dashed;
}

.field--stack {
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
}

.field--stack .field__label {
  width: auto;
}

.field__label--tight {
  width: auto;
  margin-left: 8px;
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>
