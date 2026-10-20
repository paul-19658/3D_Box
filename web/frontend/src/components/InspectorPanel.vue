<template>
  <section class="inspector">
    <header class="inspector__head">
      <span>{{ title }}</span>
      <div class="tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="tab"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>
    </header>

    <div class="inspector__body">
      <!-- ---------------------------------------------------------- -->
      <!-- 物体属性                                                    -->
      <!-- ---------------------------------------------------------- -->
      <template v-if="target === 'selection' && object">
        <div class="panel__section">
          <p class="section-title">{{ kindLabel }} · {{ object.id.slice(0, 8) }}</p>
          <label class="field">
            <span class="field__label">名称</span>
            <input class="input" :value="object.name" @change="patch({ name: value($event) })" />
          </label>
          <label class="field">
            <span class="field__label">颜色</span>
            <input
              class="input"
              type="color"
              :value="object.color"
              @input="patch({ color: $event.target.value })"
            />
          </label>
          <label class="field">
            <span class="field__label">描述</span>
            <input
              class="input"
              :value="object.description || ''"
              placeholder="给 AI 的补充说明"
              @change="patch({ description: value($event) })"
            />
          </label>
          <label v-if="object.kind !== 'mannequin' && object.kind !== 'imported'" class="field">
            <span class="field__label">显示</span>
            <select
              class="select"
              :value="object.displayMode || 'solid'"
              @change="patch({ displayMode: $event.target.value })"
            >
              <option value="solid">实体</option>
              <option value="transparent">半透明</option>
              <option value="wireframe">线框</option>
            </select>
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">变换</p>
          <div class="field">
            <span class="field__label">位置</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`p-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(object.position[axis])"
                @change="patchVector('position', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">旋转</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`r-${axis}`"
                class="input"
                type="number"
                step="1"
                :value="round(object.rotation[axis])"
                @change="patchVector('rotation', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">尺寸</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`s-${axis}`"
                class="input"
                type="number"
                step="0.1"
                min="0.1"
                :value="round(object.size[axis])"
                @change="patchVector('size', axis, $event)"
              />
            </div>
          </div>
        </div>

        <div v-if="object.mannequin" class="panel__section">
          <p class="section-title">人台</p>
          <label class="field">
            <span class="field__label">动作</span>
            <select class="select" :value="object.mannequin.presetId" @change="preset($event)">
              <option v-for="item in presets" :key="item.id" :value="item.id">{{ item.label }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">身高</span>
            <input
              class="input"
              type="number"
              step="0.01"
              min="1.2"
              max="2.2"
              :value="round(object.mannequin.heightMeters)"
              @change="$emit('update-height', { id: object.id, heightMeters: Number($event.target.value) })"
            />
          </label>
        </div>

        <div v-if="object.kind === 'imported' && object.importedAsset" class="panel__section">
          <p class="section-title">导入模型</p>
          <p class="meta-line">{{ object.importedAsset.sourceName }}</p>
          <p class="meta-line">
            {{ object.importedAsset.report.meshCount }} 网格 ·
            {{ object.importedAsset.report.triangleCount.toLocaleString() }} 三角面
          </p>
          <label class="field">
            <span class="field__label">预览</span>
            <select
              class="select"
              :value="object.previewQuality || 'original'"
              @change="patch({ previewQuality: $event.target.value })"
            >
              <option value="original">原始精度</option>
              <option value="lightweight">轻量预览</option>
            </select>
          </label>
          <label class="field">
            <span class="field__label">导出</span>
            <select
              class="select"
              :value="object.exportQuality || 'original'"
              @change="patch({ exportQuality: $event.target.value })"
            >
              <option value="original">原始精度</option>
              <option value="lightweight">轻量模型</option>
            </select>
          </label>
        </div>

        <!-- ---------------------------------------------------------- -->
        <!-- 导航线：节点编辑 + 绑定关系                                  -->
        <!-- ---------------------------------------------------------- -->
        <div v-if="object.kind === 'path'" class="panel__section">
          <p class="section-title">导航线</p>
          <p class="meta-line">
            共 {{ pathNodes.length }} 个节点。节点时刻由弧长比例自动分配：
            总时长 {{ round(timelineDuration) }} 秒下，第 {{ pathNodes.length }} 个节点落在
            {{ formatTime(nodeTimes[nodeTimes.length - 1] || 0) }}。
          </p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('path-add-node', object.id)">
              在最长段加节点
            </button>
            <button
              type="button"
              class="btn"
              :disabled="selectedNodeIndex === null"
              @click="removeSelectedNode"
            >
              删除选中节点
            </button>
            <button type="button" class="btn" @click="$emit('path-draw-again', object.id)">
              继续绘制
            </button>
            <button
              type="button"
              class="btn"
              :disabled="pathNodes.length < 2"
              @click="$emit('path-clear-nodes', object.id)"
            >
              清空节点
            </button>
          </div>

          <p class="section-title asset-panel__gap">节点列表</p>
          <p v-if="pathNodes.length === 0" class="meta-line">
            还没有节点。点"继续绘制"在场景里按住左键画一条，或点"在最长段加节点"。
          </p>
          <div
            v-for="node in pathNodes"
            :key="`node-${node.index}`"
            class="list-row"
            :class="{ 'is-active': node.index === selectedNodeIndex }"
            @click="$emit('path-select-node', { pathId: object.id, index: node.index })"
          >
            <span class="node-index">{{ node.index + 1 }}</span>
            <span class="list-row__name">X {{ round(node.x) }} · Z {{ round(node.z) }}</span>
            <span class="list-row__meta">{{ formatTime(nodeTimes[node.index] || 0) }}</span>
          </div>
        </div>

        <!-- 任意物体都能绑定到导航线上。 -->
        <div v-if="object.kind !== 'path' && paths.length > 0" class="panel__section">
          <p class="section-title">沿导航线运动</p>
          <label class="field">
            <span class="field__label">绑定</span>
            <select class="select" :value="bindingPathId" @change="bindPath($event)">
              <option value="">不绑定</option>
              <option v-for="path in paths" :key="path.id" :value="path.id">{{ path.name }}</option>
            </select>
          </label>
          <template v-if="object.pathBinding">
            <label class="field">
              <span class="field__label">朝向</span>
              <select
                class="select"
                :value="object.pathBinding.followRotation === false ? 'fixed' : 'path'"
                @change="patchBinding({ followRotation: $event.target.value === 'path' })"
              >
                <option value="path">跟随路径方向</option>
                <option value="fixed">保持自身朝向</option>
              </select>
            </label>
            <label class="field">
              <span class="field__label">时间偏移</span>
              <input
                class="input"
                type="number"
                step="0.1"
                :value="round(object.pathBinding.offsetSeconds || 0)"
                @change="patchBinding({ offsetSeconds: Number($event.target.value) || 0 })"
              />
            </label>
            <label class="field">
              <span class="field__label">离地高度</span>
              <input
                class="input"
                type="number"
                step="0.1"
                :value="round(object.pathBinding.heightOffset || 0)"
                @change="patchBinding({ heightOffset: Number($event.target.value) || 0 })"
              />
            </label>
            <p class="meta-line">绑定期间该物体的位置与朝向由路径决定，拖动播放头即可看到它沿路径走。</p>
          </template>
        </div>

        <div v-if="object.kind !== 'imported' && object.kind !== 'mannequin' && object.kind !== 'path'" class="panel__section">
          <p class="section-title">面涂色</p>
          <div class="swatch-row">
            <button
              v-for="color in paintPalette"
              :key="color"
              type="button"
              class="swatch"
              :style="{ background: color }"
              :title="color"
              @click="$emit('set-paint-color', color)"
            ></button>
          </div>
          <label class="field field--top">
            <span class="field__label">范围</span>
            <select
              class="select"
              :value="paintScope"
              @change="$emit('set-paint-scope', $event.target.value)"
            >
              <option value="object">整个物体</option>
              <option value="face">单块面片</option>
            </select>
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">布局</p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('apply-layout', 'align-x')">X 对齐</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'align-z')">Z 对齐</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'distribute-x')">X 等距</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'distribute-z')">Z 等距</button>
            <button type="button" class="btn" @click="$emit('apply-layout', 'ground')">落地</button>
          </div>
        </div>

        <div class="panel__section inspector__actions">
          <button type="button" class="btn" @click="$emit('duplicate-object')">复制</button>
          <button type="button" class="btn btn--danger" @click="$emit('delete-object')">删除</button>
        </div>
      </template>

      <!-- ---------------------------------------------------------- -->
      <!-- 灯光属性                                                    -->
      <!-- ---------------------------------------------------------- -->
      <template v-else-if="target === 'light' && light">
        <div class="panel__section">
          <p class="section-title">{{ lightKindLabel }} · 可编辑</p>
          <label class="field">
            <span class="field__label">名称</span>
            <input class="input" :value="light.name" @change="patchLight({ name: value($event) })" />
          </label>
          <label class="field">
            <span class="field__label">颜色</span>
            <input
              class="input"
              type="color"
              :value="light.color"
              @input="patchLight({ color: $event.target.value })"
            />
          </label>
          <label class="field">
            <span class="field__label">强度</span>
            <input
              class="input"
              type="number"
              step="0.1"
              min="0"
              max="20"
              :value="light.intensity"
              @change="patchLight({ intensity: clamp(Number($event.target.value), 0, 20) })"
            />
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">位置与朝向</p>
          <div class="field">
            <span class="field__label">位置</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`lp-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(light.position[axis])"
                @change="patchLightVector('position', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">目标</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`lt-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(light.target[axis])"
                @change="patchLightVector('target', axis, $event)"
              />
            </div>
          </div>
          <label v-if="light.kind === 'area' || light.kind === 'point'" class="field">
            <span class="field__label">尺寸</span>
            <input
              class="input"
              type="number"
              step="0.1"
              min="0.1"
              max="100"
              :value="light.size"
              @change="patchLight({ size: clamp(Number($event.target.value), 0.1, 100) })"
            />
          </label>
          <label v-if="light.kind === 'spot'" class="field">
            <span class="field__label">角度</span>
            <input
              class="input"
              type="number"
              step="1"
              min="1"
              max="89"
              :value="light.angleDegrees"
              @change="patchLight({ angleDegrees: clamp(Number($event.target.value), 1, 89) })"
            />
          </label>
          <p v-if="light.kind === 'area'" class="meta-line">
            面光不参与阴影计算，阴影由点光 / 聚光 / 日光投射。
          </p>
        </div>

        <div class="panel__section">
          <p class="section-title">添加灯光</p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('add-light', 'sun')">日光</button>
            <button type="button" class="btn" @click="$emit('add-light', 'spot')">聚光灯</button>
            <button type="button" class="btn" @click="$emit('add-light', 'point')">点光源</button>
            <button type="button" class="btn" @click="$emit('add-light', 'area')">面光</button>
          </div>
        </div>

        <div class="panel__section inspector__actions">
          <button type="button" class="btn btn--danger btn--block" @click="$emit('delete-light', light.id)">
            删除灯光
          </button>
        </div>
      </template>

      <!-- ---------------------------------------------------------- -->
      <!-- 摄影机                                                      -->
      <!-- ---------------------------------------------------------- -->
      <template v-else>
        <div class="panel__section">
          <p class="section-title">摄影机</p>
          <div class="field">
            <span class="field__label">位置</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`cp-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(camera.position[axis])"
                @change="patchCameraVector('position', axis, $event)"
              />
            </div>
          </div>
          <div class="field">
            <span class="field__label">看向</span>
            <div class="vector-row">
              <input
                v-for="axis in axes"
                :key="`ct-${axis}`"
                class="input"
                type="number"
                step="0.1"
                :value="round(camera.target[axis])"
                @change="patchCameraVector('target', axis, $event)"
              />
            </div>
          </div>
          <label class="field">
            <span class="field__label">视场角</span>
            <input
              class="input"
              type="number"
              step="1"
              min="10"
              max="120"
              :value="camera.fovDegrees"
              @change="$emit('update-camera', { fovDegrees: clamp(Number($event.target.value), 10, 120) })"
            />
          </label>
        </div>

        <div class="panel__section">
          <p class="section-title">画幅</p>
          <div class="btn-grid">
            <button
              v-for="preset in aspectPresets"
              :key="preset.label"
              type="button"
              class="btn"
              :class="{ 'is-selected': isAspect(preset) }"
              @click="$emit('update-camera', { aspectWidth: preset.width, aspectHeight: preset.height })"
            >
              {{ preset.label }}
            </button>
          </div>
          <p class="meta-line">当前 {{ camera.aspectWidth }} : {{ camera.aspectHeight }}</p>
        </div>

        <div class="panel__section">
          <p class="section-title">添加灯光</p>
          <div class="btn-grid">
            <button type="button" class="btn" @click="$emit('add-light', 'sun')">日光</button>
            <button type="button" class="btn" @click="$emit('add-light', 'spot')">聚光灯</button>
            <button type="button" class="btn" @click="$emit('add-light', 'point')">点光源</button>
            <button type="button" class="btn" @click="$emit('add-light', 'area')">面光</button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<script>
/**
 * 属性面板：根据 `target` 在"物体 / 灯光 / 摄影机"三套表单之间切换。
 *
 * 数值输入统一用 `change` 而不是 `input`：拖拽或连续输入时不会每敲一个字符
 * 就往撤销栈压一帧，避免 Ctrl+Z 需要按很多次。
 */
import { MANNEQUIN_PRESETS } from '@/core/mannequin'
import { ASPECT_PRESETS, LIGHT_KIND_LABELS } from '@/core/project-document'

const KIND_LABELS = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面',
  custom: '自定义形状',
  imported: '导入模型',
  mannequin: '人台',
  path: '导航线'
}

export default {
  name: 'InspectorPanel',

  props: {
    target: { type: String, default: 'camera' },
    object: { type: Object, default: null },
    light: { type: Object, default: null },
    camera: { type: Object, required: true },
    paintColor: { type: String, default: '#ff6b6b' },
    paintScope: { type: String, default: 'object' },
    /** 场景里所有导航线对象（供"绑定到导航线"下拉框使用）。 */
    paths: { type: Array, default: () => [] },
    /** 时间轴总时长：用于展示节点会被分配到哪一刻。 */
    timelineDuration: { type: Number, default: 5 },
    /** 当前选中的导航线节点索引（仅当 object 是 path 时有意义）。 */
    selectedNodeIndex: { type: Number, default: null }
  },

  data() {
    return {
      activeTab: 'props',
      axes: ['x', 'y', 'z'],
      presets: MANNEQUIN_PRESETS,
      aspectPresets: ASPECT_PRESETS,
      lightKinds: LIGHT_KIND_LABELS,
      paintPalette: ['#ff6b6b', '#ffb020', '#37c98b', '#2f7cf6', '#9b7bf6', '#e9eef1', '#6a747b']
    }
  },

  computed: {
    title() {
      if (this.target === 'light') return '灯光属性'
      if (this.target === 'camera') return '摄影机'
      return '物体属性'
    },
    tabs() {
      return [
        { id: 'props', label: '属性' },
        { id: 'notes', label: '说明' }
      ]
    },
    kindLabel() {
      return this.object ? KIND_LABELS[this.object.kind] || this.object.kind : ''
    },
    lightKindLabel() {
      return this.light ? this.lightKinds[this.light.kind] || this.light.kind : ''
    },
    /** 当前物体的节点列表（附带索引，方便 v-for 与事件回传）。 */
    pathNodes() {
      const nodes = this.object?.kind === 'path' ? this.object.pathNodes : null
      if (!Array.isArray(nodes)) return []
      return nodes.map((node, index) => ({ ...node, index }))
    },
    /**
     * 每个节点会被分配到时间轴的哪一刻。
     *
     * 与 core/nav-path.js 的 pathNodeTimes 是同一套规则，
     * 但这里只用局部坐标算比例——世界坐标的平移不改变各段比例，
     * 所以结果完全一致，且不必关心父级的 position。
     */
    nodeTimes() {
      const nodes = this.pathNodes
      if (nodes.length === 0) return []
      if (nodes.length === 1) return [0]
      const lengths = []
      for (let index = 1; index < nodes.length; index += 1) {
        lengths.push(
          Math.hypot(
            nodes[index].x - nodes[index - 1].x,
            nodes[index].y - nodes[index - 1].y,
            nodes[index].z - nodes[index - 1].z
          )
        )
      }
      const total = lengths.reduce((sum, length) => sum + length, 0)
      const duration = Math.max(this.timelineDuration, 0)
      if (total <= 1e-6) {
        return nodes.map((_, index) => (duration / (nodes.length - 1)) * index)
      }
      const times = [0]
      let travelled = 0
      for (const length of lengths) {
        travelled += length
        times.push((travelled / total) * duration)
      }
      return times
    },
    bindingPathId() {
      return this.object?.pathBinding?.pathId ?? ''
    }
  },

  methods: {
    round(value) {
      return Math.round(value * 100) / 100
    },
    clamp(value, min, max) {
      if (!Number.isFinite(value)) return min
      return Math.min(Math.max(value, min), max)
    },
    value(event) {
      return event.target.value
    },
    patch(update) {
      if (!this.object) return
      this.$emit('update-object', { id: this.object.id, update })
    },
    patchVector(key, axis, event) {
      if (!this.object) return
      const number = Number(event.target.value)
      if (!Number.isFinite(number)) return
      const base = key === 'size' ? Math.max(number, 0.1) : number
      this.$emit('update-object', {
        id: this.object.id,
        update: { [key]: { ...this.object[key], [axis]: base } }
      })
    },
    patchLight(update) {
      if (!this.light) return
      this.$emit('update-light', { id: this.light.id, update })
    },
    patchLightVector(key, axis, event) {
      if (!this.light) return
      const number = Number(event.target.value)
      if (!Number.isFinite(number)) return
      this.$emit('update-light', {
        id: this.light.id,
        update: { [key]: { ...this.light[key], [axis]: number } }
      })
    },
    patchCameraVector(key, axis, event) {
      const number = Number(event.target.value)
      if (!Number.isFinite(number)) return
      this.$emit('update-camera', { [key]: { ...this.camera[key], [axis]: number } })
    },
    preset(event) {
      this.$emit('apply-preset', { id: this.object.id, presetId: event.target.value })
    },
    isAspect(preset) {
      return this.camera.aspectWidth === preset.width && this.camera.aspectHeight === preset.height
    },
    formatTime(value) {
      return `${(Math.max(Number(value) || 0, 0)).toFixed(2)}s`
    },
    /** 绑定 / 解绑导航线。解绑时同时清掉全部绑定字段。 */
    bindPath(event) {
      if (!this.object) return
      const pathId = event.target.value
      this.$emit('path-bind', { id: this.object.id, pathId: pathId || null })
    },
    patchBinding(update) {
      if (!this.object?.pathBinding) return
      this.$emit('update-object', {
        id: this.object.id,
        update: { pathBinding: { ...this.object.pathBinding, ...update } }
      })
    },
    removeSelectedNode() {
      if (!this.object || this.selectedNodeIndex === null) return
      this.$emit('path-remove-node', { id: this.object.id, index: this.selectedNodeIndex })
    }
  }
}
</script>

<style scoped>
.inspector {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 58%;
}

.inspector__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
  flex: none;
}

.tabs {
  display: flex;
  gap: 2px;
}

.tab {
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}

.tab.is-active {
  background: var(--bg-3);
  color: var(--text-0);
}

.inspector__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.inspector__actions {
  display: flex;
  gap: 6px;
}

.inspector__actions .btn {
  flex: 1;
}

.btn-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.btn.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.field--top {
  align-items: flex-start;
  margin-top: 8px;
}

.meta-line {
  margin: 0 0 4px;
  color: var(--text-2);
  font-size: 11px;
  line-height: 1.6;
}

/* 导航线节点序号：固定宽度的方框，让数字列对齐。 */
.node-index {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  border: 1px solid var(--accent);
  border-radius: 2px;
  color: var(--accent-strong);
  font-size: 10px;
}

.btn:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}
</style>
