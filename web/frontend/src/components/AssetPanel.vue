<template>
  <section class="asset-panel">
    <header class="asset-panel__head">
      <span>项目资产</span>
      <span class="asset-panel__count">{{ objects.length }} 个物体 · {{ lights.length }} 盏灯</span>
    </header>

    <div class="asset-panel__body">
      <p class="section-title">场景物体</p>
      <p v-if="objects.length === 0" class="empty-hint">还没有物体，从左侧工具栏添加。</p>

      <!-- 摄影机作为场景对象列出：它和物体一样能被选中、用 gizmo 摆放。 -->
      <div class="list-row" :class="{ 'is-active': cameraSelected }" @click="$emit('select-camera')">
        <span class="dot dot--camera"></span>
        <input
          class="list-row__name rename-input"
          :value="cameraName"
          maxlength="40"
          @click.stop
          @change="$emit('rename-camera', $event.target.value)"
        />
        <span class="list-row__meta">摄影机</span>
      </div>

      <div
        v-for="object in objects"
        :key="object.id"
        class="list-row"
        :class="{ 'is-active': selectedIds.includes(object.id) }"
        @click="selectObject(object.id, $event)"
      >
        <span class="dot" :style="{ background: object.colorOverride || object.color }"></span>
        <input
          class="list-row__name rename-input"
          :value="object.name"
          maxlength="60"
          @click.stop
          @change="rename(object.id, $event)"
        />
        <span v-if="object.kind === 'imported'" class="list-row__meta">导入</span>
        <span v-else-if="object.kind === 'mannequin'" class="list-row__meta">人台</span>

        <button
          type="button"
          class="mini-btn"
          :title="object.visible ? '隐藏' : '显示'"
          @click.stop="$emit('toggle-visible', object.id)"
        >
          {{ object.visible ? '👁' : '—' }}
        </button>
        <button
          type="button"
          class="mini-btn"
          :class="{ 'is-on': object.locked }"
          :title="object.locked ? '解锁' : '锁定'"
          @click.stop="$emit('toggle-lock', object.id)"
        >
          {{ object.locked ? '🔒' : '🔓' }}
        </button>
      </div>

      <p class="section-title asset-panel__gap">灯光</p>
      <div
        v-for="light in lights"
        :key="light.id"
        class="list-row"
        :class="{ 'is-active': selectedLightId === light.id }"
        @click="$emit('select-light', light.id)"
      >
        <span class="dot dot--light" :style="{ background: light.color }"></span>
        <span class="list-row__name">{{ light.name }}</span>
        <span class="list-row__meta">{{ kindLabel(light.kind) }}</span>
      </div>
    </div>
  </section>
</template>

<script>
/**
 * 右侧"项目资产"面板：列出场景物体与灯光，提供显隐 / 锁定 / 改名。
 *
 * 改名用内联 input 而不是双击弹窗：资产列表的操作要"零跳转"，
 * 用户扫一眼就能改完一批名字。
 */
import { LIGHT_KIND_LABELS } from '@/core/project-document'

export default {
  name: 'AssetPanel',

  props: {
    objects: { type: Array, default: () => [] },
    lights: { type: Array, default: () => [] },
    selectedIds: { type: Array, default: () => [] },
    selectedLightId: { type: String, default: null },
    cameraSelected: { type: Boolean, default: false },
    cameraName: { type: String, default: '摄影机' }
  },

  methods: {
    kindLabel(kind) {
      return LIGHT_KIND_LABELS[kind] || kind
    },
    selectObject(id, event) {
      const ids = event.shiftKey
        ? this.selectedIds.includes(id)
          ? this.selectedIds.filter((item) => item !== id)
          : [...this.selectedIds, id]
        : [id]
      this.$emit('select-object', ids)
    },
    rename(id, event) {
      const name = event.target.value.trim()
      if (!name) {
        const target = this.objects.find((object) => object.id === id)
        event.target.value = target ? target.name : ''
        return
      }
      this.$emit('rename', { id, name })
    }
  }
}
</script>

<style scoped>
.asset-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 42%;
  border-bottom: 1px solid var(--line);
}

.asset-panel__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  color: var(--text-0);
  font-weight: 600;
  flex: none;
}

.asset-panel__count {
  color: var(--text-2);
  font-size: 11px;
  font-weight: 400;
}

.asset-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}

.asset-panel__gap {
  margin-top: 14px;
}

.dot {
  flex: none;
  width: 9px;
  height: 9px;
  border: 1px solid var(--line-strong);
  border-radius: 2px;
}

.dot--light {
  border-radius: 50%;
}

/* 摄影机用固定青色，与物体（物体色）、灯光（灯色）区分开。 */
.dot--camera {
  border-radius: 2px;
  background: #7fd1ff;
}

.rename-input {
  border: 1px solid transparent;
  background: transparent;
  padding: 0 2px;
  height: 20px;
  color: var(--text-0);
  outline: none;
}

.rename-input:focus {
  border-color: var(--accent);
  background: var(--bg-0);
}

.mini-btn {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.mini-btn:hover {
  background: var(--bg-3);
  color: var(--text-0);
}

.mini-btn.is-on {
  color: var(--warn);
}
</style>
