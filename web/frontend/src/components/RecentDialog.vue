<template>
  <div class="dialog-veil" @click.self="$emit('close')">
    <section class="dialog dialog--wide" role="dialog" aria-label="最近工程">
      <header class="dialog__head">
        <span>最近工程</span>
        <button type="button" class="btn btn--ghost" @click="$emit('close')">关闭</button>
      </header>

      <div class="dialog__body">
        <p v-if="entries.length === 0" class="empty-hint">还没有打开过任何工程。</p>

        <div v-for="entry in entries" :key="entry.projectId" class="recent-row">
          <div class="recent-row__main" @click="open(entry)">
            <span class="recent-row__name">{{ entry.name || entry.projectId }}</span>
            <span class="recent-row__meta">{{ formatTime(entry.lastOpenedAt) }}</span>
          </div>
          <button type="button" class="btn btn--ghost btn--danger" @click="remove(entry)">移除</button>
        </div>
      </div>

      <footer class="dialog__foot">
        <button type="button" class="btn" @click="showAll">全部工程…</button>
      </footer>
    </section>
  </div>
</template>

<script>
/**
 * 最近工程：只显示"最近打开过"的条目，与工程列表页互补。
 *
 * 移除只影响最近记录，不删除 .block3d 文件——这是两件容易混淆的事，
 * 因此按钮文案用"移除"而不是"删除"。
 */
export default {
  name: 'RecentDialog',

  computed: {
    entries() {
      return this.$store.state.recentProjects || []
    }
  },

  methods: {
    formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    },
    async open(entry) {
      await this.$store.dispatch('openProject', entry.projectId)
      this.$emit('close')
      if (this.$route.name !== 'editor') this.$router.push('/editor')
    },
    async remove(entry) {
      await this.$store.dispatch('forgetRecentProject', entry.projectId)
    },
    showAll() {
      this.$emit('close')
      this.$router.push('/projects')
    }
  }
}
</script>

<style scoped>
.recent-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg-2);
}

.recent-row__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  cursor: pointer;
}

.recent-row__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-row__meta {
  color: var(--text-2);
  font-size: 11px;
}
</style>
