<template>
  <nav class="tool-rail" aria-label="工具">
    <div class="tool-rail__group">
      <button
        v-for="item in tools"
        :key="item.id"
        type="button"
        class="rail-btn"
        :class="{ 'is-active': isActive(item) }"
        :title="item.hint"
        @click="pick(item)"
      >
        <span class="rail-btn__glyph" v-html="item.glyph"></span>
        <span v-if="item.key" class="rail-btn__key" aria-hidden="true">{{ item.key }}</span>
      </button>
    </div>

    <div class="tool-rail__group">
      <button
        v-for="item in creators"
        :key="item.id"
        type="button"
        class="rail-btn"
        :title="item.hint"
        @click="create(item)"
      >
        <span class="rail-btn__glyph" v-html="item.glyph"></span>
      </button>
    </div>

    <div class="tool-rail__group">
      <button type="button" class="rail-btn" title="导入模型（glTF / GLB / OBJ）" @click="$emit('import')">
        <span class="rail-btn__glyph" v-html="importGlyph"></span>
      </button>
    </div>
  </nav>
</template>

<script>
/**
 * 左侧工具条（对标 Maya 的 Tool Box）。
 *
 * 图标造型照 Maya 的语义走：移动=四向箭头、旋转=环形箭头、缩放=方框+斜向箭头、
 * 选择=箭头光标；几何体用"三面可见"的立体画法。整体仍保持单色——
 * 用 `currentColor` 的 3 档透明度（1 / .62 / .32）做出受光面、侧面、背面的
 * 层次，既接近 Maya 实心图标的体量感，又能跟随主题色与选中态。
 *
 * 不引入图标库：几个图标不值得多一个依赖，而且内联 SVG 才能用
 * `currentColor` 自动适配主题与 hover/active 态。
 */
const glyph = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`

/** 主受光面 / 侧面 / 背光面三档明度，统一从这里取，保证 14 个图标观感一致。 */
const F = 'fill="currentColor"'
const M = 'fill="currentColor" fill-opacity="0.62"'
const B = 'fill="currentColor" fill-opacity="0.32"'

export default {
  name: 'ToolRail',

  props: {
    tool: { type: String, default: 'select' },
    transformMode: { type: String, default: 'translate' }
  },

  data() {
    return {
      tools: [
        {
          id: 'select',
          label: '选择',
          key: 'Q',
          hint: '选择（Q）',
          // Maya 的选择工具：箭头光标，带一点后掠尾翼的实心造型。
          glyph: glyph(
            `<path d="M6.4 3.2 6.4 17.6 10.1 14.2 12.4 19.6 14.9 18.5 12.6 13.2 17.4 12.8Z" ${F} />` +
              `<path d="M6.4 3.2 6.4 17.6 10.1 14.2 8.7 10.9Z" ${M} />`
          )
        },
        {
          id: 'translate',
          label: '移动',
          key: 'W',
          hint: '移动（W）',
          // Maya 的移动操纵器：四向箭头加中心方块。
          glyph: glyph(
            `<path d="M12 2.6 15.1 6.3H8.9Z" ${F} />` +
              `<path d="M12 21.4 15.1 17.7H8.9Z" ${F} />` +
              `<path d="M2.6 12 6.3 8.9v6.2Z" ${F} />` +
              `<path d="M21.4 12 17.7 8.9v6.2Z" ${F} />` +
              `<path d="M10.6 6.4h2.8V9.2h2.8v2.8h-2.8v2.8h-2.8V12H7.8V9.2h2.8Z" ${M} />` +
              `<rect x="10.6" y="10.6" width="2.8" height="2.8" ${F} />`
          )
        },
        {
          id: 'rotate',
          label: '旋转',
          key: 'E',
          hint: '旋转（E）',
          // Maya 的旋转操纵器：环形箭头。
          glyph: glyph(
            `<path d="M12 3.4a8.6 8.6 0 0 1 8.4 6.9h-2.2A6.5 6.5 0 0 0 12 5.6Z" ${B} />` +
              `<path d="M4.4 12A7.6 7.6 0 1 0 12 4.4v2.2A5.4 5.4 0 1 1 6.6 12Z" ${M} />` +
              `<path d="M16.9 3.2 19 8.9l-5.9-.3Z" ${F} />` +
              `<path d="M9.4 5.6a6.4 6.4 0 0 1 2.6-.5v1.9a4.5 4.5 0 0 0-1.9.4Z" ${F} />`
          )
        },
        {
          id: 'scale',
          label: '缩放',
          key: 'R',
          hint: '缩放（R）',
          // Maya 的缩放操纵器：内小方块 + 外大方块 + 斜向箭头。
          glyph: glyph(
            `<rect x="13.2" y="3.4" width="7.4" height="7.4" rx="0.8" ${M} />` +
              `<rect x="3.4" y="13.2" width="7.4" height="7.4" rx="0.8" ${B} />` +
              `<path d="M3.6 12.3 12.3 3.6l1.5 1.5-8.7 8.7Z" ${F} />` +
              `<path d="M9.2 3.4h5.4v2.1h-3.3v3.3H9.2Z" ${F} />`
          )
        },
        {
          id: 'paint',
          label: '面涂色',
          hint: '面涂色',
          // Maya 的绘制类工具用画笔表示。
          glyph: glyph(
            `<path d="M15.2 3.1 20.9 8.8 12.6 17.1 6.9 11.4Z" ${M} />` +
              `<path d="M8.9 12.7 11.3 15.1 7.6 18.8H3.2Z" ${F} />` +
              `<path d="M15.2 3.1 20.9 8.8l-1.5 1.5L13.7 4.6Z" ${F} />`
          )
        },
        {
          id: 'cut',
          label: '平面切割',
          hint: '平面切割',
          // 切面：一块半透明平面被一条斜向刀线穿过。
          glyph: glyph(
            `<path d="M2.8 14.6 12 9.4l9.2 5.2-9.2 5.2Z" ${M} />` +
              `<path d="M2.8 14.6 12 9.4l9.2 5.2-9.2 5.2Z" fill="none" stroke="currentColor" stroke-opacity="0.45" />` +
              `<path d="M5.4 5 18.6 19" ${F} />` +
              `<path d="M18.6 19 16 17.9l1.8-1.6Z" ${F} />`
          )
        }
      ],
      creators: [
        {
          id: 'box',
          label: '方块',
          action: 'add',
          hint: '添加方块',
          // 立方体：顶面/正面/侧面三档明度，比一根线框更像 Maya 的原始几何体图标。
          glyph: glyph(
            `<path d="M12 2.9 21 7.6 12 12.3 3 7.6Z" ${M} />` +
              `<path d="M3 7.6 12 12.3v8.8L3 16.4Z" ${B} />` +
              `<path d="M21 7.6 12 12.3v8.8l9-4.7Z" ${F} />`
          )
        },
        {
          id: 'wall',
          label: '墙体',
          action: 'add',
          hint: '拖动创建墙体',
          glyph: glyph(
            `<path d="M2.8 8.6 18 4.2v11.2L2.8 19.8Z" ${M} />` +
              `<path d="M18 4.2 21.2 6.1v11.2L18 15.4Z" ${B} />`
          )
        },
        {
          id: 'floor',
          label: '地面',
          action: 'add',
          hint: '拖动创建地面',
          glyph: glyph(
            `<path d="M2.6 15.4 11.6 9.4l9.8 5.2-9.8 5.4Z" ${M} />` +
              `<path d="M2.6 15.4 11.6 9.4l9.8 5.2-9.8 5.4Z" fill="none" stroke="currentColor" stroke-opacity="0.4" />` +
              `<path d="M6.4 15.9 11.9 12l5.7 3-5.6 3.1Z" ${B} />`
          )
        },
        {
          id: 'cylinder',
          label: '圆柱',
          action: 'add',
          hint: '添加圆柱',
          glyph: glyph(
            `<path d="M4.2 6.2v11.6c0 1.7 3.5 3.1 7.8 3.1s7.8-1.4 7.8-3.1V6.2Z" ${M} />` +
              `<path d="M15.6 6.2v11.6c0 1.7-1.6 3.1-3.6 3.1s-3.6-1.4-3.6-3.1V6.2Z" ${B} />` +
              `<ellipse cx="12" cy="6.2" rx="7.8" ry="3.1" ${F} />`
          )
        },
        {
          id: 'sphere',
          label: '球体',
          action: 'add',
          hint: '添加球体',
          // 球：主圆 + 左上受光斑 + 右下暗面，单色也能读出球感。
          glyph: glyph(
            `<circle cx="12" cy="12.2" r="8.6" ${M} />` +
              `<path d="M12 3.6a8.6 8.6 0 0 1 8.6 8.6A8.6 8.6 0 0 1 12 20.8 8.6 8.6 0 0 1 3.4 12.2 8.6 8.6 0 0 1 12 3.6Zm0 2.2a6.4 6.4 0 1 0 0 12.8 6.4 6.4 0 0 0 0-12.8Z" ${B} />` +
              `<circle cx="12" cy="12.2" r="8.6" ${M} />` +
              `<path d="M8.6 7.4a6.4 6.4 0 0 1 6.3-1.2 8.7 8.7 0 0 0-8.6 6.1 6.4 6.4 0 0 1 2.3-4.9Z" ${F} />`
          )
        },
        {
          id: 'mannequin',
          label: '人台',
          action: 'mannequin',
          hint: '添加人台',
          // 人形剪影：头 + 躯干 + 四肢，实心填充比细线更像"人台"。
          glyph: glyph(
            `<circle cx="12" cy="4.4" r="2.5" ${F} />` +
              `<path d="M10.3 7.6h3.4l1.5 5.1-1.7.5-.6-2.1v2.5l1.1 6.2h-2.1L12 15.2l-.4 4.6H9.5l1.1-6.2v-2.5l-.6 2.1-1.7-.5Z" ${M} />` +
              `<path d="M9.7 8.1 6.6 9.9l-.9 4.4 1.7.4.9-3.6 1.2-.9Z" ${B} />` +
              `<path d="M14.3 8.1l3.1 1.8.9 4.4-1.7.4-.9-3.6-1.2-.9Z" ${B} />`
          )
        },
        {
          // 导航线：先"新建一条线"，再让视口进入绘制模式。
          id: 'path',
          label: '导航线绘制',
          action: 'path',
          hint: '绘制导航线',
          glyph: glyph(
            `<path d="M5.6 17.2 11 11.6l6.4-6.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-dasharray="2.6 2.2" stroke-linecap="round" />` +
              `<circle cx="4.6" cy="18.4" r="2" ${B} />` +
              `<circle cx="12" cy="10.6" r="2" ${M} />` +
              `<circle cx="19.4" cy="3.6" r="2.2" ${F} />`
          )
        }
      ],
      importGlyph: glyph(
        // 导入：托盘 + 向下的实心箭头（"放进场景里"）。
        `<path d="M12 2.8 6.9 8.4h3.1v6.2h4V8.4h3.1Z" ${F} />` +
          `<path d="M3.4 14.2h2.3v5.1h12.6v-5.1h2.3v7.4H3.4Z" ${M} />`
      )
    }
  },

  methods: {
    /**
     * 变换类按钮（移动/旋转/缩放）高亮看的是 `transformMode`，
     * 其余按钮看的是 `tool`；两者共用一个视觉状态，才不会出现"点了没反应"。
     *
     * 选择按钮额外要求 `transformMode === 'select'`：否则"选择"会和当前的
     * 变换按钮**同时高亮**（工具条上出现两个激活项，Maya 里不会这样）。
     */
    isActive(item) {
      if (item.id === 'translate' || item.id === 'rotate' || item.id === 'scale') {
        return this.tool === 'select' && this.transformMode === item.id
      }
      if (item.id === 'select') {
        return this.tool === 'select' && this.transformMode === 'select'
      }
      return this.tool === item.id
    },
    /**
     * 选择按钮走单独的 `select-only` 事件：它要额外清掉操纵器
     * （Maya 的 Q 就是"只选择、不显示操纵器"）。
     *
     * 不能简单地把 `setTool('select')` 改成"顺带清操纵器"——内部还有多处
     * 用 `setTool('select')` 收尾（快速建造完成、切割完成等），那些地方
     * 必须保留操纵器，否则用户建完墙体就没法直接拖了。
     */
    pick(item) {
      if (item.id === 'select') {
        this.$emit('select-only')
        return
      }
      this.$emit('select', item.id)
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
  position: relative;
  display: grid;
  place-items: center;
  width: 40px;
  height: 38px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-1);
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
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
  width: 24px;
  height: 24px;
}

.rail-btn__glyph :deep(svg) {
  width: 100%;
  height: 100%;
  display: block;
}

/*
 * 快捷键角标：Maya 里 Q/W/E/R 对应选择/移动/旋转/缩放。
 * 放在右下角、选中时高亮，起"提示 + 确认"作用，不挤占图标本身的面积。
 */
.rail-btn__key {
  position: absolute;
  right: 3px;
  bottom: 2px;
  font-size: 9px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-2);
  pointer-events: none;
}

.rail-btn:hover .rail-btn__key {
  color: var(--text-1);
}

.rail-btn.is-active .rail-btn__key {
  color: var(--accent-strong);
}
</style>
