<template>
  <div class="projects">
    <header class="projects__bar">
      <div class="projects__brand">
        <span class="brand-mark">◇</span>
        <span>小白盒 · 工程管理</span>
      </div>
      <div class="projects__actions">
        <button type="button" class="btn" @click="$router.push('/editor')">返回编辑器</button>
        <button type="button" class="btn btn--primary" @click="newProject">新建场景</button>
      </div>
    </header>

    <main class="projects__body">
      <div class="projects__head">
        <h2>全部工程（{{ projects.length }}）</h2>
        <button type="button" class="btn btn--ghost" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>

      <p v-if="error" class="error-line">{{ error }}</p>
      <p v-if="!loading && projects.length === 0" class="empty-hint">
        还没有保存过工程。回到编辑器搭好场景后点"保存"即可出现在这里。
      </p>

      <div class="grid">
        <article v-for="project in projects" :key="project.projectId" class="card">
          <header class="card__head">
            <span class="card__name">{{ project.name || project.projectId }}</span>
          </header>
          <p class="card__meta">{{ project.displayName }}</p>
          <p class="card__meta">
            {{ formatSize(project.fileSizeBytes) }} · {{ formatTime(project.modifiedAt) }}
          </p>
          <footer class="card__foot">
            <button type="button" class="btn" @click="open(project)">打开</button>
            <button type="button" class="btn btn--danger" @click="remove(project)">删除</button>
          </footer>
        </article>
      </div>
    </main>
  </div>
</template>

<script>
/**
 * 工程列表页：浏览 / 打开 / 删除已保存的 .block3d 工程。
 *
 * 列表数据直接来自后端文件系统（`workspace/projects`），
 * 因此即使换了浏览器或清了缓存，工程依然在。
 */
import { api } from '@/api/client'

export default {
  name: 'ProjectsView',

  data() {
    return {
      projects: [],
      loading: false,
      error: ''
    }
  },

  created() {
    this.refresh()
  },

  methods: {
    async refresh() {
      this.loading = true
      this.error = ''
      try {
        const result = await api.projects.list()
        this.projects = result.projects || []
      } catch (error) {
        this.error = `读取工程列表失败：${error.message}`
      } finally {
        this.loading = false
      }
    },
    formatSize(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    },
    formatTime(value) {
      if (!value) return ''
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    },
    async open(project) {
      await this.$store.dispatch('openProject', project.projectId)
      this.$router.push('/editor')
    },
    async remove(project) {
      await this.$store.dispatch('deleteProject', project.projectId)
      await this.refresh()
    },
    newProject() {
      this.$store.dispatch('newProject')
      this.$router.push('/editor')
    }
  }
}
</script>

<style scoped>
.projects {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-0);
}

.projects__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--topbar-height);
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  flex: none;
}

.projects__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.brand-mark {
  color: var(--accent-strong);
  font-size: 16px;
}

.projects__actions {
  display: flex;
  gap: 8px;
}

.projects__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 32px;
}

.projects__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.projects__head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.error-line {
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-s);
  color: var(--danger);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.card {
  display: flex;
  flex-direction: column;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  background: var(--bg-1);
}

.card__name {
  font-weight: 600;
}

.card__meta {
  margin: 4px 0 0;
  color: var(--text-2);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card__foot {
  display: flex;
  gap: 6px;
  margin-top: 12px;
}

.card__foot .btn {
  flex: 1;
}
</style>
