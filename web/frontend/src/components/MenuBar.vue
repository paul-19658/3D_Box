<template>
  <nav class="menubar" role="menubar" aria-label="主菜单">
    <div v-for="menu in menus" :key="menu.id" class="menubar__item">
      <button
        type="button"
        class="menubar__title"
        :class="{ 'is-open': openMenu === menu.id }"
        role="menuitem"
        :aria-haspopup="true"
        :aria-expanded="String(openMenu === menu.id)"
        @click="toggle(menu.id)"
        @mouseenter="hoverTitle(menu.id)"
      >
        {{ menu.label }}
      </button>

      <div v-if="openMenu === menu.id" class="menubar__dropdown" role="menu">
        <template v-for="entry in menu.entries">
          <div v-if="entry.separator" :key="entry.id" class="menubar__separator" role="separator"></div>
          <button
            v-else
            :key="entry.id"
            type="button"
            class="menubar__entry"
            :class="{ 'is-checked': entry.checked, 'is-danger': entry.danger }"
            :disabled="entry.disabled"
            role="menuitemradio"
            :aria-checked="entry.checked === undefined ? undefined : String(Boolean(entry.checked))"
            @click="pick(entry)"
          >
            <span class="menubar__tick" aria-hidden="true">{{ entry.checked ? '✓' : '' }}</span>
            <span class="menubar__label">{{ entry.label }}</span>
            <span v-if="entry.accel" class="menubar__accel">{{ entry.accel }}</span>
          </button>
        </template>
      </div>
    </div>

    <!-- 右侧状态区：把"当前处于什么模式"直接写在菜单栏上，省得用户去视口里找。 -->
    <div class="menubar__status">
      <span v-if="cameraViewActive" class="menubar__badge">相机视角</span>
      <span v-if="autoKeyEnabled" class="menubar__badge menubar__badge--record">自动关键帧</span>
    </div>
  </nav>
</template>

<script>
/**
 * 顶部菜单栏：对标桌面三维软件的 Menu Bar。
 *
 * 两条设计约定：
 * 1. **只发事件，不改状态**。菜单项一律 emit 动作名，由 Editor 决定怎么处理，
 *    这样撤销栈与自动保存不会被绕过（与 TopBar 同一原则）。
 * 2. **菜单结构在组件内集中声明**，而不是由父组件拼装。菜单是纯 UI 关注点，
 *    放这里能让 Editor 只关心"动作怎么执行"，加一项菜单不用改父组件。
 */
export default {
  name: 'MenuBar',

  props: {
    /** 是否处于"相机视角"导航模式。 */
    cameraViewActive: { type: Boolean, default: false },
    /** 当前导航方案标识（`wasd` / `orbit`）。 */
    navScheme: { type: String, default: 'wasd' },
    /** 是否处于成片预演。 */
    previewActive: { type: Boolean, default: false },
    monitorOpen: { type: Boolean, default: false },
    theme: { type: String, default: 'dark' },
    canUndo: { type: Boolean, default: false },
    canRedo: { type: Boolean, default: false },
    isDirty: { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
    /** 自动关键帧总开关是否打开。 */
    autoKeyEnabled: { type: Boolean, default: false }
  },

  data() {
    return { openMenu: null }
  },

  computed: {
    /**
     * 菜单定义。
     *
     * `action` 是 emit 出去的动作名；`checked` 为布尔时渲染成单选式勾选项；
     * `disabled` 会实时反映只读/可撤销等状态，避免用户点了没反应。
     */
    menus() {
      const readOnly = this.readOnly
      return [
        {
          id: 'file',
          label: '文件',
          entries: [
            { id: 'new', label: '新建场景', action: 'new' },
            { id: 'save', label: '保存', action: 'save', accel: 'Ctrl+S', disabled: readOnly },
            { id: 'save-as', label: '另存为…', action: 'save-as', disabled: readOnly },
            { id: 'sep-1', separator: true },
            { id: 'open-projects', label: '工程列表…', action: 'open-projects' },
            { id: 'open-recent', label: '最近工程…', action: 'open-recent' },
            { id: 'sep-2', separator: true },
            { id: 'logout', label: '退出登录', action: 'logout' }
          ]
        },
        {
          id: 'edit',
          label: '编辑',
          entries: [
            { id: 'undo', label: '撤销', action: 'undo', accel: 'Ctrl+Z', disabled: !this.canUndo },
            { id: 'redo', label: '重做', action: 'redo', accel: 'Ctrl+Shift+Z', disabled: !this.canRedo }
          ]
        },
        {
          id: 'camera',
          label: '相机',
          entries: [
            {
              id: 'camera-view',
              label: this.cameraViewActive ? '退出相机视角' : '进入相机视角',
              action: 'camera-view',
              checked: this.cameraViewActive,
              disabled: this.previewActive
            },
            { id: 'sep-nav', separator: true },
            {
              id: 'nav-wasd',
              label: '导航：WASD 飞行',
              action: 'nav-scheme',
              payload: 'wasd',
              checked: this.navScheme === 'wasd'
            },
            {
              id: 'nav-orbit',
              label: '导航：Maya 环绕',
              action: 'nav-scheme',
              payload: 'orbit',
              checked: this.navScheme === 'orbit'
            }
          ]
        },
        {
          id: 'view',
          label: '视图',
          entries: [
            {
              id: 'preview',
              label: '成片预演',
              action: 'toggle-preview',
              checked: this.previewActive
            },
            { id: 'monitor', label: '摄影机监视器', action: 'toggle-monitor', checked: this.monitorOpen },
            { id: 'sep-theme', separator: true },
            {
              id: 'theme',
              label: this.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
              action: 'toggle-theme'
            }
          ]
        },
        {
          id: 'help',
          label: '帮助',
          entries: [{ id: 'shortcuts', label: '键盘快捷键…', action: 'help-shortcuts' }]
        }
      ]
    }
  },

  mounted() {
    document.addEventListener('pointerdown', this.handleOutside, true)
    window.addEventListener('keydown', this.handleKeydown)
  },

  beforeDestroy() {
    document.removeEventListener('pointerdown', this.handleOutside, true)
    window.removeEventListener('keydown', this.handleKeydown)
  },

  methods: {
    toggle(id) {
      this.openMenu = this.openMenu === id ? null : id
    },

    /**
     * 已经打开某个菜单时，划过别的标题直接切换——这是桌面菜单栏的通用手感。
     * 没打开任何菜单时不做反应，否则鼠标扫过顶部就会乱弹菜单。
     */
    hoverTitle(id) {
      if (this.openMenu !== null) this.openMenu = id
    },

    pick(entry) {
      if (entry.disabled) return
      this.openMenu = null
      this.$emit(entry.action, entry.payload)
    },

    /** 点击菜单栏以外的地方关闭。用捕获阶段，避免被组件内部的 stopPropagation 挡掉。 */
    handleOutside(event) {
      if (this.openMenu === null) return
      if (this.$el && this.$el.contains(event.target)) return
      this.openMenu = null
    },

    handleKeydown(event) {
      if (event.key === 'Escape' && this.openMenu !== null) {
        this.openMenu = null
      }
    }
  }
}
</script>

<style scoped>
.menubar {
  display: flex;
  align-items: center;
  gap: 2px;
  height: var(--menubar-height);
  padding: 0 8px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-2);
  flex: none;
  user-select: none;
}

.menubar__item {
  position: relative;
}

.menubar__title {
  height: 22px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  font-size: 12px;
  cursor: pointer;
}

.menubar__title:hover,
.menubar__title.is-open {
  background: var(--bg-3);
  color: var(--text-0);
}

.menubar__dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 60;
  min-width: 208px;
  padding: 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-m);
  background: var(--bg-1);
  box-shadow: var(--shadow-pop);
}

.menubar__entry {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-0);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.menubar__entry:hover:not(:disabled) {
  background: var(--bg-3);
}

.menubar__entry:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

.menubar__entry.is-danger {
  color: var(--danger);
}

.menubar__entry.is-checked .menubar__label {
  color: var(--accent-strong);
}

/* 勾选位固定宽度，避免有无勾选时文字左右跳动。 */
.menubar__tick {
  flex: none;
  width: 12px;
  color: var(--accent-strong);
  font-size: 11px;
}

.menubar__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.menubar__accel {
  flex: none;
  color: var(--text-2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.menubar__separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--line);
}

.menubar__status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding-right: 4px;
}

.menubar__badge {
  padding: 1px 8px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 11px;
}

/* 录制态用 danger 色：这是"正在写数据"的强提示，与普通状态区分开。 */
.menubar__badge--record {
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 16%, transparent);
  color: var(--danger);
}
</style>
