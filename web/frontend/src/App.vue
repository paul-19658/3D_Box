<template>
  <div class="app-shell" :data-theme="theme">
    <router-view />

    <div class="notice-stack" aria-live="polite">
      <transition-group name="notice">
        <div
          v-for="notice in notices"
          :key="notice.id"
          class="notice"
          :class="`notice--${notice.kind}`"
          role="status"
          @click="dismiss(notice.id)"
        >
          {{ notice.message }}
        </div>
      </transition-group>
    </div>

    <transition name="fade">
      <div v-if="busy" class="busy-veil">
        <div class="busy-card">
          <span class="spinner" aria-hidden="true"></span>
          <span>正在处理…</span>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { KEYBINDING_ACTIONS, matchAction } from '@/core/keybindings'

/** 通用动作里由外壳负责的那几个（工具键与播放归 Editor.vue）。 */
const OWNED_GLOBAL_ACTIONS = KEYBINDING_ACTIONS.filter((action) =>
  ['edit.undo', 'edit.redo', 'file.save'].includes(action.id)
)

/**
 * 应用外壳：只负责全局主题、通知与忙碌遮罩。
 * 具体业务界面在 views 下，避免这里变成第二个"巨型组件"。
 */
export default {
  name: 'App',

  computed: {
    theme() {
      return this.$store.state.theme
    },
    notices() {
      return this.$store.state.notices
    },
    busy() {
      return this.$store.state.busy
    },
    keybindings() {
      return this.$store.state.keybindings
    },
    ownedGlobalActions() {
      return OWNED_GLOBAL_ACTIONS
    }
  },

  mounted() {
    this.$store.dispatch('bootstrap')
    window.addEventListener('keydown', this.handleGlobalKeydown)
  },

  beforeDestroy() {
    window.removeEventListener('keydown', this.handleGlobalKeydown)
  },

  methods: {
    dismiss(id) {
      this.$store.commit('dismissNotice', id)
    },
    handleGlobalKeydown(event) {
      const target = event.target
      const typing =
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

      /*
       * 撤销 / 重做 / 保存走可配置注册表。
       *
       * 这里**只匹配本组件拥有的动作**：`Editor.vue` 也在监听 window 的
       * keydown（工具键、播放）。两边都拿全量动作去匹配的话，同一个键会被
       * 处理两次。各管各的，就不会互相抢。
       */
      const action = matchAction(this.keybindings, event, { actions: this.ownedGlobalActions })
      if (!action) return
      if (action.id === 'file.save') {
        event.preventDefault()
        this.$store.dispatch('saveProject', { saveAs: event.shiftKey })
        return
      }
      // 撤销/重做在读输入框时不该触发（用户可能只是想撤销输入的文字）。
      if (typing) return
      event.preventDefault()
      if (action.id === 'edit.undo') this.$store.commit('undoScene')
      if (action.id === 'edit.redo') this.$store.commit('redoScene')
    }
  }
}
</script>
