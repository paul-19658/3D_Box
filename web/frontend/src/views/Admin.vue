<template>
  <div class="admin">
    <header class="admin__bar">
      <div class="admin__brand">
        <span class="brand-mark">◇</span>
        <span>3D导演台 测试版 · 管理</span>
      </div>
      <div class="admin__actions">
        <button type="button" class="btn" @click="$router.push('/editor')">返回编辑器</button>
      </div>
    </header>

    <div class="admin__tabs" role="tablist">
      <button
        type="button"
        class="pill"
        :class="{ 'is-active': tab === 'users' }"
        @click="tab = 'users'"
      >
        用户
      </button>
      <button
        type="button"
        class="pill"
        :class="{ 'is-active': tab === 'projects' }"
        @click="tab = 'projects'"
      >
        全部工程
      </button>
    </div>

    <main class="admin__body">
      <p v-if="error" class="error-line">{{ error }}</p>

      <section v-if="tab === 'users'">
        <div class="admin__head">
          <h2>用户（{{ users.length }}）</h2>
          <button type="button" class="btn btn--ghost" :disabled="loading" @click="refreshUsers">
            {{ loading ? '刷新中…' : '刷新' }}
          </button>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>账号</th>
                <th>角色</th>
                <th>状态</th>
                <th>密码</th>
                <th>工程数</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in users" :key="user.id">
                <td>{{ user.username }}</td>
                <td>{{ user.role === 'admin' ? '管理员' : '普通用户' }}</td>
                <td>{{ user.isActive ? '启用' : '禁用' }}</td>
                <td>{{ user.hasPassword ? '已设置' : '未设置' }}</td>
                <td>{{ user.projectCount }}</td>
                <td>{{ formatTime(user.lastLoginAt) }}</td>
                <td class="table__ops">
                  <button
                    type="button"
                    class="btn btn--ghost"
                    :disabled="busyId === user.id"
                    @click="toggleRole(user)"
                  >
                    {{ user.role === 'admin' ? '取消管理员' : '设为管理员' }}
                  </button>
                  <button
                    type="button"
                    class="btn btn--ghost"
                    :disabled="busyId === user.id"
                    @click="toggleActive(user)"
                  >
                    {{ user.isActive ? '禁用' : '启用' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-else>
        <div class="admin__head">
          <h2>全部工程（{{ projects.length }}）</h2>
          <div class="admin__filters">
            <select v-model="ownerFilter" class="select" @change="refreshProjects">
              <option value="">全部用户</option>
              <option v-for="user in users" :key="user.id" :value="user.id">
                {{ user.username }}
              </option>
            </select>
            <button type="button" class="btn btn--ghost" :disabled="loading" @click="refreshProjects">
              {{ loading ? '刷新中…' : '刷新' }}
            </button>
          </div>
        </div>
        <p v-if="!loading && projects.length === 0" class="empty-hint">还没有工程。</p>
        <div class="grid">
          <article v-for="project in projects" :key="project.projectId" class="card">
            <header class="card__head">
              <span class="card__name">{{ project.name || project.projectId }}</span>
            </header>
            <p class="card__meta">所有者：{{ project.ownerUsername }}</p>
            <p class="card__meta">
              {{ formatSize(project.fileSizeBytes) }} · {{ formatTime(project.modifiedAt) }}
            </p>
            <footer class="card__foot">
              <button type="button" class="btn" @click="openReadonly(project)">只读查看</button>
              <button type="button" class="btn btn--danger" @click="remove(project)">删除</button>
            </footer>
          </article>
        </div>
      </section>
    </main>
  </div>
</template>

<script>
import { api } from '@/api/client'

export default {
  name: 'AdminView',

  data() {
    return {
      tab: 'users',
      users: [],
      projects: [],
      ownerFilter: '',
      loading: false,
      busyId: null,
      error: ''
    }
  },

  created() {
    this.refreshUsers()
    this.refreshProjects()
  },

  methods: {
    formatSize(bytes) {
      if (!Number.isFinite(bytes)) return '—'
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    },
    formatTime(value) {
      if (!value) return '—'
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
    },
    async refreshUsers() {
      this.loading = true
      this.error = ''
      try {
        const result = await api.admin.users()
        this.users = result.users || []
      } catch (error) {
        this.error = `读取用户失败：${error.message}`
      } finally {
        this.loading = false
      }
    },
    async refreshProjects() {
      this.loading = true
      this.error = ''
      try {
        const result = await api.admin.projects(this.ownerFilter || undefined)
        this.projects = result.projects || []
      } catch (error) {
        this.error = `读取工程失败：${error.message}`
      } finally {
        this.loading = false
      }
    },
    async toggleRole(user) {
      const role = user.role === 'admin' ? 'user' : 'admin'
      this.busyId = user.id
      try {
        await api.admin.updateUser(user.id, { role })
        await this.refreshUsers()
        await this.$store.dispatch('notify', { kind: 'success', message: '已更新角色。' })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: error.message })
      } finally {
        this.busyId = null
      }
    },
    async toggleActive(user) {
      this.busyId = user.id
      try {
        await api.admin.updateUser(user.id, { isActive: !user.isActive })
        await this.refreshUsers()
        await this.$store.dispatch('notify', {
          kind: 'success',
          message: user.isActive ? '已禁用账号。' : '已启用账号。'
        })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: error.message })
      } finally {
        this.busyId = null
      }
    },
    async openReadonly(project) {
      await this.$store.dispatch('openProjectReadOnly', project.projectId)
      this.$router.push('/editor')
    },
    async remove(project) {
      if (!window.confirm(`确定删除工程「${project.name || project.projectId}」？此操作不可恢复。`)) {
        return
      }
      try {
        await api.admin.removeProject(project.projectId)
        await this.refreshProjects()
        await this.$store.dispatch('notify', { kind: 'info', message: '工程已删除。' })
      } catch (error) {
        await this.$store.dispatch('notify', { kind: 'error', message: error.message })
      }
    }
  }
}
</script>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-0);
}

.admin__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--topbar-height);
  padding: 0 16px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-1);
  flex: none;
}

.admin__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}

.brand-mark {
  color: var(--accent-strong);
  font-size: 16px;
}

.admin__tabs {
  display: flex;
  gap: 8px;
  padding: 12px 24px 0;
}

.admin__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 24px 32px;
}

.admin__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.admin__head h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.admin__filters {
  display: flex;
  gap: 8px;
  align-items: center;
}

.error-line {
  margin: 0 0 12px;
  padding: 8px 12px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-s);
  color: var(--danger);
}

.empty-hint {
  color: var(--text-2);
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  background: var(--bg-1);
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.table th,
.table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  white-space: nowrap;
}

.table th {
  color: var(--text-2);
  font-weight: 600;
}

.table__ops {
  display: flex;
  gap: 6px;
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
