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

      const mod = event.ctrlKey || event.metaKey
      if (mod && event.key.toLowerCase() === 'z' && !typing) {
        event.preventDefault()
        if (event.shiftKey) this.$store.commit('redoScene')
        else this.$store.commit('undoScene')
        return
      }
      if (mod && event.key.toLowerCase() === 's') {
        event.preventDefault()
        this.$store.dispatch('saveProject', { saveAs: event.shiftKey })
      }
    }
  }
}
</script>
