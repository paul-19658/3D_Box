<template>
  <div class="dialog-veil" @click.self="discard">
    <section class="dialog" role="dialog" aria-label="恢复未保存内容">
      <header class="dialog__head">
        <span>发现未保存的内容</span>
      </header>

      <div class="dialog__body">
        <p class="text">
          上次编辑似乎没有正常保存。可以恢复这份自动快照继续工作，
          也可以放弃它——手动保存过的工程文件不受影响。
        </p>
        <dl class="meta">
          <div class="meta__row">
            <dt>场景名称</dt>
            <dd>{{ snapshotName }}</dd>
          </div>
          <div class="meta__row">
            <dt>物体数量</dt>
            <dd>{{ objectCount }} 个</dd>
          </div>
          <div class="meta__row">
            <dt>快照时间</dt>
            <dd>{{ savedAt }}</dd>
          </div>
        </dl>
      </div>

      <footer class="dialog__foot">
        <button type="button" class="btn" @click="discard">放弃</button>
        <button type="button" class="btn btn--primary" @click="restore">恢复内容</button>
      </footer>
    </section>
  </div>
</template>

<script>
/**
 * 启动时的恢复提示。
 *
 * 故意做成"阻断式对话框"：自动快照存在说明上次异常退出，
 * 让用户明确选择一次，比静默恢复更安全（避免覆盖他刚打开的新工程）。
 */
export default {
  name: 'RecoveryDialog',

  computed: {
    snapshot() {
      return this.$store.state.recoverySnapshot
    },
    snapshotName() {
      return this.snapshot?.document?.name || '未命名场景'
    },
    objectCount() {
      return this.snapshot?.document?.scene?.objects?.length ?? 0
    },
    savedAt() {
      const value = this.snapshot?.document?.savedAt
      if (!value) return '未知'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    }
  },

  methods: {
    async restore() {
      await this.$store.dispatch('restoreRecovery')
    },
    async discard() {
      await this.$store.dispatch('discardRecovery')
    }
  }
}
</script>

<style scoped>
.text {
  margin: 0 0 14px;
  color: var(--text-1);
  line-height: 1.75;
}

.meta {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: var(--bg-2);
}

.meta__row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 3px 0;
}

.meta__row dt {
  color: var(--text-2);
}

.meta__row dd {
  margin: 0;
  color: var(--text-0);
}
</style>
