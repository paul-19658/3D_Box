<template>
  <nav class="tool-rail" aria-label="工具">
    <div class="tool-rail__group">
      <button
        v-for="item in tools"
        :key="item.id"
        type="button"
        class="rail-btn"
        :class="{ 'is-active': isActive(item) }"
        :title="item.label"
        @click="$emit('select', item.id)"
      >
        <span class="rail-btn__glyph" v-html="item.glyph"></span>
      </button>
    </div>

    <div class="tool-rail__group">
      <button
        v-for="item in creators"
        :key="item.id"
        type="button"
        class="rail-btn"
        :title="item.label"
        @click="create(item)"
      >
        <span class="rail-btn__glyph" v-html="item.glyph"></span>
      </button>
    </div>

    <div class="tool-rail__group">
      <button type="button" class="rail-btn" title="导入模型" @click="$emit('import')">
        <span class="rail-btn__glyph" v-html="importGlyph"></span>
      </button>
    </div>
  </nav>
</template>

<script>
/**
 * 左侧工具条：选择 / 移动 / 旋转 / 缩放 / 涂色 / 切割，以及快速添加与导入。
 *
 * 图标使用内联 SVG 字符串：不引入图标库，避免为了几个图标多一个依赖，
 * 也便于按主题通过 currentColor 自动适配。
 */
const glyph = (path, extra = '') => `<svg viewBox="0 0 20 20" aria-hidden="true">${path}${extra}</svg>`

const stroke = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"'

export default {
  name: 'ToolRail',

  props: {
    tool: { type: String, default: 'select' },
    transformMode: { type: String, default: 'translate' }
  },

  data() {
    return {
      tools: [
        { id: 'select', label: '选择', glyph: glyph(`<path d="M5 3l10 6.4-4.4 1.2L9.4 15z" ${stroke} />`) },
        {
          id: 'translate',
          label: '移动',
          glyph: glyph(
            `<path d="M10 3v14M3 10h14M10 3l-2 2M10 3l2 2M10 17l-2-2M10 17l2-2M3 10l2-2M3 10l2 2M17 10l-2-2M17 10l-2 2" ${stroke} />`
          )
        },
        {
          id: 'rotate',
          label: '旋转',
          glyph: glyph(`<path d="M15.5 7A6 6 0 1 0 16 11" ${stroke} /><path d="M16 3.5V7h-3.5" ${stroke} />`)
        },
        {
          id: 'scale',
          label: '缩放',
          glyph: glyph(`<path d="M4 16V9h7" ${stroke} /><path d="M4 16l7-7M13 4h3v3" ${stroke} />`)
        },
        {
          id: 'paint',
          label: '面涂色',
          glyph: glyph(`<path d="M4 14l7-7 3 3-7 7H4z" ${stroke} /><path d="M12 5l3 3" ${stroke} />`)
        },
        { id: 'cut', label: '平面切割', glyph: glyph(`<path d="M3 13h14M6 4l8 12" ${stroke} />`) }
      ],
      creators: [
        {
          id: 'box',
          label: '方块',
          action: 'add',
          glyph: glyph(`<path d="M10 3l6 3.2v7.6L10 17l-6-3.2V6.2z" ${stroke} />`)
        },
        {
          id: 'wall',
          label: '墙体',
          action: 'add',
          glyph: glyph(`<rect x="3" y="6" width="14" height="8" rx="1" ${stroke} />`)
        },
        {
          id: 'floor',
          label: '地面',
          action: 'add',
          glyph: glyph(`<path d="M3 12l7-4 7 4-7 4z" ${stroke} />`)
        },
        {
          id: 'cylinder',
          label: '圆柱',
          action: 'add',
          glyph: glyph(
            `<ellipse cx="10" cy="5.5" rx="5" ry="2.2" ${stroke} /><path d="M5 5.5v9c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2v-9" ${stroke} />`
          )
        },
        {
          id: 'sphere',
          label: '球体',
          action: 'add',
          glyph: glyph(`<circle cx="10" cy="10" r="6" ${stroke} />`)
        },
        {
          id: 'mannequin',
          label: '人台',
          action: 'mannequin',
          glyph: glyph(
            `<circle cx="10" cy="4.6" r="2.2" ${stroke} /><path d="M10 6.8v5.4M10 8.4 6.6 10.4M10 8.4l3.4 2M10 12.2 7.6 16.6M10 12.2l2.4 4.4" ${stroke} />`
          )
        },
        {
          // 导航线：走 creators 而不是 tools，因为它先"新建一条线"，
          // 再让视口进入绘制模式。放在 creators 里，语义和"添加物体"一致。
          id: 'path',
          label: '导航线绘制',
          action: 'path',
          glyph: glyph(
            `<circle cx="4" cy="15.5" r="1.5" ${stroke} /><circle cx="10" cy="10" r="1.5" ${stroke} /><circle cx="16" cy="4.5" r="1.5" ${stroke} /><path d="M5.1 14.4 8.9 11.1M11.1 8.9 14.9 5.6" ${stroke} stroke-dasharray="2 2" />`
          )
        }
      ],
      importGlyph: glyph(
        `<path d="M10 12.5V3.5M6.8 6.6 10 3.4l3.2 3.2" ${stroke} /><path d="M4 12.5v3.1h12v-3.1" ${stroke} />`
      )
    }
  },

  methods: {
    /**
     * 变换类按钮（移动/旋转/缩放）高亮看的是 `transformMode`，
     * 其余按钮看的是 `tool`；两者共用一个视觉状态，才不会出现"点了没反应"。
     */
    isActive(item) {
      if (item.id === 'translate' || item.id === 'rotate' || item.id === 'scale') {
        return this.tool === 'select' && this.transformMode === item.id
      }
      return this.tool === item.id
    },
    create(item) {
      if (item.action === 'mannequin') {
        this.$emit('add-mannequin')
        return
      }
      if (item.action === 'path') {
        this.$emit('add-path')
        return
      }
      // 墙体与地面在桌面版里是"按住拖出尺寸"的，走 quick-build 才能保留手感；
      // 立方体 / 圆柱 / 球体有固定默认尺寸，直接落一个即可。
      if (item.id === 'wall' || item.id === 'floor') {
        this.$emit('quick-build', item.id)
        return
      }
      this.$emit('add', item.id)
    }
  }
}
</script>

<style scoped>
.tool-rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  width: var(--rail-width);
  padding: 8px 0;
  border-right: 1px solid var(--line);
  background: var(--bg-1);
  flex: none;
  overflow-y: auto;
}

.tool-rail__group {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
  width: 100%;
  align-items: center;
}

.tool-rail__group:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.rail-btn {
  display: grid;
  place-items: center;
  width: 38px;
  height: 34px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
  transition: all 0.14s ease;
}

.rail-btn:hover {
  background: var(--bg-3);
  color: var(--text-0);
}

.rail-btn.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}

.rail-btn__glyph {
  display: grid;
  place-items: center;
}
</style>
