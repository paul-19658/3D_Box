<template>
  <header class="topbar">
    <div class="topbar__left">
      <div class="brand">
        <svg viewBox="0 0 1024 1024" aria-hidden="true">
          <path
            d="M512 96 896 320v384L512 928 128 704V320z"
            fill="none"
            stroke="currentColor"
            stroke-width="56"
            stroke-linejoin="round"
          />
          <path
            d="M128 320l384 224 384-224M512 544v384"
            fill="none"
            stroke="currentColor"
            stroke-width="56"
          />
        </svg>
      </div>

      <div class="project-chip">
        <input
          ref="nameInput"
          class="project-chip__name"
          :value="projectName"
          maxlength="60"
          spellcheck="false"
          @change="commitName"
          @keydown.enter="blurName"
        />
        <span v-if="isDirty" class="project-chip__dot" title="有未保存的修改"></span>
        <button type="button" class="icon-btn" title="工程列表" @click="$emit('open-projects')">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2 4h4l1.4 1.6H14V12H2z" fill="none" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>
      </div>

      <div class="history-group">
        <button
          type="button"
          class="icon-btn"
          :disabled="!canUndo"
          title="撤销 (Ctrl+Z)"
          @click="$emit('undo')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6 4 2.5 7.5 6 11M2.5 7.5H10a3.5 3.5 0 0 1 0 7H8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          :disabled="!canRedo"
          title="重做 (Ctrl+Shift+Z)"
          @click="$emit('redo')"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M10 4l3.5 3.5L10 11M13.5 7.5H6a3.5 3.5 0 0 0 0 7h2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
          </svg>
        </button>
      </div>
    </div>

    <div class="topbar__center" role="tablist" aria-label="工作模式">
      <button
        type="button"
        role="tab"
        class="pill"
        :class="{ 'is-active': !previewActive }"
        :aria-selected="!previewActive"
        @click="$emit('select-panel', 'scene')"
      >
        场景调度
      </button>
      <button
        type="button"
        role="tab"
        class="pill"
        :class="{ 'is-active': previewActive }"
        :aria-selected="previewActive"
        @click="$emit('select-panel', 'preview')"
      >
        成片预演
      </button>
    </div>

    <div class="topbar__right">
      <span v-if="readOnlyBanner" class="readonly-banner" :title="readOnlyBanner">
        {{ readOnlyBanner }}
      </span>
      <button type="button" class="btn btn--ghost" title="切换主题" @click="$emit('toggle-theme')">
        {{ theme === 'dark' ? '浅色' : '深色' }}
      </button>
      <button type="button" class="btn btn--ghost" title="AI 设置" @click="$emit('open-ai-settings')">
        AI
      </button>
      <button
        type="button"
        class="btn btn--ghost"
        :class="{ 'is-alert': errorCount > 0 }"
        :title="errorCount > 0 ? `已捕获 ${errorCount} 条错误，点击导出诊断日志` : '导出诊断日志'"
        @click="$emit('export-diagnostics')"
      >
        诊断{{ errorCount > 0 ? ` (${errorCount})` : '' }}
      </button>
      <button
        type="button"
        class="btn"
        :disabled="readOnly"
        :title="readOnly ? '只读模式下不能保存' : '保存'"
        @click="$emit('save')"
      >
        保存
      </button>

      <div class="menu-wrap">
        <button type="button" class="btn" @click="menuOpen = !menuOpen">
          导出
          <svg viewBox="0 0 16 16" aria-hidden="true" class="caret">
            <path d="M4 6.5 8 10.5l4-4" fill="none" stroke="currentColor" stroke-width="1.4" />
          </svg>
        </button>
        <div v-if="menuOpen" class="menu" @mouseleave="menuOpen = false">
          <button type="button" class="menu__item" @click="pick('export-image')">导出参考图</button>
          <button type="button" class="menu__item" @click="pick('export-video')">导出动画视频</button>
          <button type="button" class="menu__item" @click="pick('export-model')">导出模型</button>
        </div>
      </div>

      <div class="menu-wrap">
        <button type="button" class="icon-btn" title="更多" @click="fileMenuOpen = !fileMenuOpen">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="3" r="1.3" fill="currentColor" />
            <circle cx="8" cy="8" r="1.3" fill="currentColor" />
            <circle cx="8" cy="13" r="1.3" fill="currentColor" />
          </svg>
        </button>
        <div v-if="fileMenuOpen" class="menu" @mouseleave="fileMenuOpen = false">
          <button type="button" class="menu__item" @click="pick('new')">新建场景</button>
          <button type="button" class="menu__item" :disabled="readOnly" @click="pick('save-as')">
            另存为…
          </button>
          <button type="button" class="menu__item" @click="pick('open-recent')">最近工程…</button>
          <button v-if="isAdmin" type="button" class="menu__item" @click="pick('open-admin')">
            管理…
          </button>
          <button type="button" class="menu__item" @click="pick('logout')">
            退出（{{ username || '未登录' }}）
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<script>
/**
 * 顶栏：品牌、工程名、撤销重做、工作模式切换与导出入口。
 *
 * 这里刻意只做"发事件"，不直接改场景：所有修改都回到 Editor 走 editScene，
 * 保证撤销栈与自动保存不会被绕过。
 */
export default {
  name: 'TopBar',

  props: {
    projectName: { type: String, default: '未命名场景' },
    isDirty: { type: Boolean, default: false },
    canUndo: { type: Boolean, default: false },
    canRedo: { type: Boolean, default: false },
    theme: { type: String, default: 'dark' },
    /** 已捕获的错误条数，用来提示"这里可以导出日志"。 */
    errorCount: { type: Number, default: 0 },
    /**
     * 是否处于"成片预演"。
     *
     * 这个状态由 store 持有、从父组件传进来，而不是顶栏自己记。
     * 因为进入预演要做的事远不止换个高亮：视口要切成成片画幅、
     * 时间轴要自动循环、编辑工具要全部收起。顶栏只是"开关的把手"，
     * 真正的状态必须能被别处读取和驱动（例如按 Esc 退出预演）。
     */
    previewActive: { type: Boolean, default: false },
    username: { type: String, default: '' },
    isAdmin: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    readOnlyBanner: { type: String, default: '' }
  },

  data() {
    return {
      menuOpen: false,
      fileMenuOpen: false
    }
  },

  methods: {
    commitName(event) {
      const value = event.target.value.trim()
      event.target.value = value || this.projectName
      this.$emit('rename', value)
    },
    blurName(event) {
      event.target.blur()
    },
    pick(action) {
      this.menuOpen = false
      this.fileMenuOpen = false
      this.$emit(action)
    }
  }
}
</script>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--topbar-height);
  padding: 0 10px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  flex: none;
}

.topbar__left,
.topbar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar__left {
  flex: 1;
  min-width: 0;
}

.topbar__center {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar__right {
  flex: 1;
  justify-content: flex-end;
}

.brand {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg-2);
  color: var(--accent-strong);
}

.brand svg {
  width: 16px;
  height: 16px;
}

.project-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  height: 28px;
  padding: 0 4px 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  background: var(--bg-2);
}

.project-chip__name {
  width: 150px;
  border: none;
  background: transparent;
  color: var(--text-0);
  font-weight: 600;
  outline: none;
}

.project-chip__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}

.history-group {
  display: flex;
  gap: 2px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--bg-3);
  color: var(--text-0);
}

.icon-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.icon-btn svg {
  width: 16px;
  height: 16px;
}

.caret {
  width: 12px;
  height: 12px;
}

.menu-wrap {
  position: relative;
}

.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  min-width: 150px;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-m);
  background: var(--bg-1);
  box-shadow: var(--shadow-pop);
}

.menu__item {
  display: block;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-0);
  text-align: left;
  cursor: pointer;
}

.menu__item:hover:not(:disabled) {
  background: var(--bg-3);
}

.menu__item:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.readonly-banner {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 4px 10px;
  border: 1px solid var(--warn);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--warn) 18%, transparent);
  color: var(--warn);
  font-size: 12px;
}
</style>
