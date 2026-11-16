<template>
  <div class="dialog-veil" @click.self="close">
    <section class="dialog dialog--wide" role="dialog" aria-label="快捷键设置">
      <header class="dialog__head">
        <span>快捷键设置</span>
        <button type="button" class="btn btn--ghost" @click="close">关闭</button>
      </header>

      <div class="dialog__body">
        <div class="panel__section">
          <p class="section-title">预设</p>
          <div class="btn-grid">
            <button
              v-for="preset in presets"
              :key="preset.id"
              type="button"
              class="btn"
              :class="{ 'is-selected': activePreset === preset.id }"
              :title="preset.description"
              @click="applyPreset(preset.id)"
            >
              {{ preset.label }}
            </button>
          </div>
          <p class="meta-line">
            预设只覆盖"变换工具 / 播放"这几项——相机飞行键三套都是 WASD，
            因为 Maya 的飞行模式与 Blender 的 fly 模式用的也是 WASD。
          </p>
        </div>

        <!--
          录制提示条：进入录制态时把"按任意键"这件事说清楚，
          并给出明确的取消方式（Esc）。没有它用户会不知道界面在等什么。
        -->
        <p v-if="recording" class="shortcut-recording" role="status">
          正在录制「{{ recordingLabel }}」——请按下要绑定的按键，Esc 取消。
        </p>

        <p v-if="conflicts.length > 0" class="field-hint field-hint--warn">
          有 {{ conflicts.length }} 处冲突：{{ conflictSummary }}。
          同一按键被两个"会同时生效"的动作占用时，只有排在前面的动作会响应。
        </p>

        <div v-for="group in groups" :key="group.label" class="panel__section">
          <p class="section-title">{{ group.label }}</p>
          <div
            v-for="action in group.actions"
            :key="action.id"
            class="shortcut-row"
            :class="{ 'is-recording': recording === action.id }"
          >
            <span class="shortcut-row__label">{{ action.label }}</span>
            <span v-if="action.kind === 'hold'" class="shortcut-row__tag">按住</span>
            <span v-else class="shortcut-row__tag shortcut-row__tag--ghost">按一下</span>
            <button
              type="button"
              class="shortcut-key"
              :class="{ 'is-empty': !display(action.id), 'is-conflict': conflictedActions.has(action.id) }"
              :title="recording === action.id ? '按下要绑定的按键' : '点击后按下新按键'"
              @click="startRecording(action)"
            >
              {{ recording === action.id ? '按下按键…' : display(action.id) || '未绑定' }}
            </button>
            <button
              type="button"
              class="mini-btn"
              title="清除这个绑定"
              @click="clearBinding(action.id)"
            >
              清除
            </button>
          </div>
        </div>
      </div>

      <footer class="dialog__foot">
        <span class="meta-line">改动会立即生效并记在本机。</span>
        <button type="button" class="btn" @click="reset">恢复默认</button>
      </footer>
    </section>
  </div>
</template>

<script>
import {
  KEYBINDING_PRESETS,
  bindingFromEvent,
  findConflicts,
  formatBinding,
  groupedActions,
  matchesPreset
} from '@/core/keybindings'

/**
 * 快捷键设置面板。
 *
 * 两个刻意的设计：
 *
 * 1. **改动即时生效、即时持久化**，没有"确定/取消"。快捷键是试出来的——
 *    用户改完想立刻按一下看看，如果还要点确定才能试，体验会很别扭。
 *
 * 2. **冲突只提示、不拦截**。不同 scope 用同一个键是**合法**的
 *    （`W` 既是"移动工具"又是"相机前进"，因为两者不会同时生效）。
 *    真正冲突时也只提示"只有排在前面的动作会响应"，让用户自己决定——
 *    直接拒绝会让人不知道自己错在哪。
 */
export default {
  name: 'ShortcutSettingsDialog',

  data() {
    return {
      /** 正在录制的动作 id；null 表示不在录制态。 */
      recording: null,
      /** 录制期间挂在 window 上的监听器，销毁时必须摘掉。 */
      recordingHandler: null,
      presets: KEYBINDING_PRESETS,
      groups: groupedActions(),
      /** 平台只影响显示（macOS 显示 ⌘ / ⌥ / ⇧）。 */
      platform:
        typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
          ? 'mac'
          : 'other'
    }
  },

  computed: {
    bindings() {
      return this.$store.state.keybindings
    },
    conflicts() {
      return findConflicts(this.bindings)
    },
    /** 参与冲突的动作 id 集合，用于把按键格子标红。 */
    conflictedActions() {
      const set = new Set()
      for (const conflict of this.conflicts) {
        for (const action of conflict.actions) set.add(action.id)
      }
      return set
    },
    conflictSummary() {
      return this.conflicts
        .map((conflict) => `${formatBinding(conflict.binding, this.platform)}（${conflict.actions.map((a) => a.label).join(' / ')}）`)
        .join('，')
    },
    /** 当前绑定表与哪套预设一致；都不同则为 null。 */
    activePreset() {
      const matched = KEYBINDING_PRESETS.find((preset) => matchesPreset(this.bindings, preset.id))
      return matched ? matched.id : null
    },
    recordingLabel() {
      const action = this.groups.flatMap((group) => group.actions).find((item) => item.id === this.recording)
      return action ? action.label : ''
    }
  },

  beforeDestroy() {
    this.stopRecording()
  },

  methods: {
    display(actionId) {
      return formatBinding(this.bindings[actionId], this.platform)
    },
    close() {
      this.stopRecording()
      this.$store.commit('setShortcutDialogOpen', false)
    },
    applyPreset(presetId) {
      this.stopRecording()
      this.$store.commit('applyKeybindingPreset', presetId)
    },
    reset() {
      this.stopRecording()
      this.$store.commit('resetKeybindings')
    },
    clearBinding(actionId) {
      this.$store.commit('setKeybinding', { actionId, binding: null })
    },

    /**
     * 进入录制态。
     *
     * 用 `capture: true` 抢在其它全局快捷键（撤销、工具切换、相机飞行）之前
     * 拿到事件，否则用户想绑 Ctrl+Z 会先把工程撤销一次。
     * 同时 `stopPropagation`，避免这一次按键被当成真实操作执行。
     */
    startRecording(action) {
      this.stopRecording()
      this.recording = action.id
      this.recordingHandler = (event) => {
        // 录制期间不响应任何真实快捷键。
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          this.stopRecording()
          return
        }
        const binding = bindingFromEvent(event)
        if (!binding) return
        this.$store.commit('setKeybinding', { actionId: action.id, binding })
        this.stopRecording()
      }
      window.addEventListener('keydown', this.recordingHandler, true)
    },

    stopRecording() {
      if (this.recordingHandler) {
        window.removeEventListener('keydown', this.recordingHandler, true)
        this.recordingHandler = null
      }
      this.recording = null
    }
  }
}
</script>

<style scoped>
.shortcut-recording {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-s);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 12px;
}

.shortcut-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-s);
}

.shortcut-row.is-recording {
  background: var(--accent-soft);
}

.shortcut-row__label {
  flex: 1;
  min-width: 0;
  color: var(--text-1);
  font-size: 12px;
}

.shortcut-row__tag {
  flex: none;
  font-size: 10px;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 1px 4px;
}

.shortcut-row__tag--ghost {
  opacity: 0.55;
}

.shortcut-key {
  flex: none;
  min-width: 104px;
  padding: 4px 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-s);
  background: var(--bg-2);
  color: var(--text-0);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.14s ease, color 0.14s ease;
}

.shortcut-key:hover {
  border-color: var(--accent);
  color: var(--accent-strong);
}

.shortcut-key.is-empty {
  color: var(--text-2);
}

.shortcut-key.is-conflict {
  border-color: var(--warn, #d08a2c);
  color: var(--warn, #d08a2c);
}
</style>
