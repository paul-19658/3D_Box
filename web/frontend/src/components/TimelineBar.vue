<template>
  <section class="timeline" :class="{ 'is-collapsed': !open }" :style="shellStyle">
    <!--
      顶部拖拽条：整个时间轴的高度由它调。
      单独做一条 6px 的"抓取带"而不是给 header 加 cursor，
      是因为 header 里有输入框和按钮，误触会打断编辑。
    -->
    <div
      v-if="open"
      class="timeline__resizer"
      title="拖动调整时间轴高度"
      @pointerdown="startResize"
    >
      <span></span>
    </div>

    <header class="timeline__bar">
      <div class="timeline__left">
        <button
          type="button"
          class="play-btn"
          :title="playing ? '暂停' : '播放'"
          @click="$emit('toggle-play')"
        >
          <svg v-if="!playing" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3.2 13 8l-8 4.8z" fill="currentColor" />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path d="M5 3.5h2.2v9H5zM8.8 3.5H11v9H8.8z" fill="currentColor" />
          </svg>
        </button>
        <span class="rate">1x</span>
        <span class="time-readout">
          <input
            class="time-input"
            type="number"
            step="0.1"
            min="0"
            :max="timeline.durationSeconds"
            :value="round(time)"
            @change="commitTime"
          />
          <span class="time-sep">/</span>
          <span>{{ formatTime(timeline.durationSeconds) }}</span>
        </span>
      </div>

      <div class="timeline__center">
        <button type="button" class="btn btn--ghost" @click="$emit('record-camera')">记录镜头</button>
        <button type="button" class="btn btn--ghost" @click="$emit('record-object')">记录关键帧</button>
      </div>

      <div class="timeline__right">
        <label class="duration-field">
          时长
          <input
            class="input duration-input"
            type="number"
            step="1"
            min="1"
            max="120"
            :value="timeline.durationSeconds"
            @change="$emit('update-duration', Number($event.target.value))"
          />
          秒
        </label>
        <button type="button" class="btn btn--ghost" @click="$emit('toggle-open')">
          {{ open ? '收起' : '展开' }}
        </button>
      </div>
    </header>

    <div v-show="open" class="timeline__scroll">
      <div class="timeline__track" :style="{ '--label-width': labelWidth }">
        <!--
          标尺同时支持"点击跳转"和"按住拖动连续跳转"。
          只用 @click 的话，用户按下→移动→松开会被浏览器当成一次 click
          落在松开位置，中途完全看不到播放头移动，手感就是"拖不动"。
        -->
        <div class="ruler" @pointerdown="startScrub">
          <span
            v-for="tick in ticks"
            :key="tick.time"
            class="ruler__tick"
            :style="{ left: tick.percentText }"
          >
            <span class="ruler__label">{{ tick.label }}</span>
          </span>
          <span class="playhead" :style="{ left: playheadPercentText }">
            <span class="playhead__grip"></span>
          </span>
        </div>

        <div class="lanes">
          <div class="lane">
            <span class="lane__label">镜头</span>
            <div class="lane__track">
              <button
                v-for="shot in timeline.cameraShots"
                :key="shot.id"
                type="button"
                class="marker marker--camera"
                :class="{ 'is-active': shot.id === selectedShotId }"
                :style="{ left: percent(shot.timeSeconds) }"
                :title="`${shot.name} · ${shot.transition}`"
                @click.stop="selectShot(shot)"
              >
                {{ shot.name }}
              </button>
            </div>
          </div>

          <div class="lane">
            <span class="lane__label">关键帧</span>
            <div class="lane__track">
              <button
                v-for="keyframe in timeline.objectKeyframes"
                :key="keyframe.id"
                type="button"
                class="marker marker--keyframe"
                :class="{ 'is-active': keyframe.id === selectedKeyframeId }"
                :style="{ left: percent(keyframe.timeSeconds) }"
                :title="`${objectName(keyframe.objectId)} · ${keyframe.interpolation}`"
                @click.stop="$emit('select-keyframe', keyframe.id)"
              >
                ◆
              </button>
            </div>
          </div>

          <!--
            导航线轨道：标记不来自 timeline.objectKeyframes，而是从
            路径节点位置**推导**出来的（节点时刻 = 累计弧长比例 × 总时长）。
            这样"沿路径拖节点 → 标记跟着走"是天然成立的，不需要双向同步。
          -->
          <div v-for="path in pathTracks" :key="path.id" class="lane">
            <span class="lane__label lane__label--path" :title="path.name">{{ path.name }}</span>
            <div class="lane__track lane__track--path">
              <span
                v-for="node in path.nodes"
                :key="node.key"
                class="path-marker"
                :class="{ 'is-active': node.key === selectedPathNodeKey }"
                :style="{ left: percent(node.timeSeconds) }"
                :title="`${path.name} 节点 ${node.index + 1} @ ${formatTime(node.timeSeconds)}`"
                @click.stop="$emit('select-path-node', { pathId: path.id, index: node.index })"
              ></span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <footer v-if="open && (selectedShotId || selectedKeyframeId)" class="timeline__actions">
      <template v-if="selectedShot">
        <span class="timeline__hint">已选镜头：{{ selectedShot.name }}</span>
        <button type="button" class="btn" @click="$emit('duplicate-shot', selectedShot.id)">复制镜头</button>
        <button type="button" class="btn btn--danger" @click="$emit('delete-shot', selectedShot.id)">
          删除镜头
        </button>
      </template>
      <template v-else-if="selectedKeyframe">
        <span class="timeline__hint">
          已选关键帧：{{ objectName(selectedKeyframe.objectId) }} @
          {{ formatTime(selectedKeyframe.timeSeconds) }}
        </span>
        <button type="button" class="btn" @click="$emit('duplicate-keyframe', selectedKeyframe.id)">
          复制关键帧
        </button>
        <button type="button" class="btn btn--danger" @click="$emit('delete-keyframe', selectedKeyframe.id)">
          删除关键帧
        </button>
      </template>
    </footer>
  </section>
</template>

<script>
/**
 * 时间轴：镜头轨道 + 物体关键帧轨道 + 导航线节点轨道 + 标尺与播放头。
 *
 * 标尺刻度按"总时长的 1/10"自适应：5 秒场景显示 0.5 秒一格，
 * 30 秒场景显示 3 秒一格，避免刻度文字挤在一起。
 *
 * 关于"黑条"的修复：
 * 旧版本把播放头画成 `bottom: -100px` 的绝对定位细线，并且轨道区
 * 没有 `overflow: hidden`。结果是播放头拖出一条贯穿到面板外的黑线，
 * 标记超出 100% 时也会溢出到侧栏上。现在播放头被限制在轨道内部（100%），
 * 轨道自己做裁剪，任何超出范围的东西都画不出去。
 */

/**
 * 时间轴允许的高度范围（像素）。
 *
 * 下限 176 是"三条轨道都看得见"的最小值：
 * 抓取带 6 + 工具条 38 + 标尺 26 + 三条 24px 轨道（含间距）+ 底部留白。
 * 之前定成 132，一旦有导航线，第三条轨道必须滚动才能看到，
 * 用户会以为"导航线根本没进时间轴"。
 */
const MIN_HEIGHT = 176
const MAX_HEIGHT = 460

export default {
  name: 'TimelineBar',

  props: {
    timeline: { type: Object, required: true },
    time: { type: Number, default: 0 },
    playing: { type: Boolean, default: false },
    open: { type: Boolean, default: true },
    selectedShotId: { type: String, default: null },
    selectedKeyframeId: { type: String, default: null },
    selectedPathNodeKey: { type: String, default: null },
    /** 由父组件算好的导航线轨道（含节点时刻），见 core/nav-path.js。 */
    pathTracks: { type: Array, default: () => [] },
    objects: { type: Array, default: () => [] }
  },

  data() {
    return {
      // 高度存本地而不是 store：这是纯界面偏好，不该进撤销栈。
      height: MIN_HEIGHT,
      resizing: false
    }
  },

  computed: {
    duration() {
      return Math.max(this.timeline.durationSeconds, 0.1)
    },
    shellStyle() {
      if (!this.open) return {}
      return { height: `${this.height}px` }
    },
    /**
     * 左侧标签列宽度。
     *
     * 导航线可能有很多条，名字也可能很长。固定 48px 会截断成"导航…"，
     * 用户分不清是哪条。这里按轨道里的最长名字估算，并夹在合理区间内。
     */
    labelWidth() {
      const names = ['关键帧', '镜头', ...this.pathTracks.map((path) => path.name)]
      const longest = names.reduce((max, name) => Math.max(max, (name || '').length), 0)
      // 中文按 12px 宽估算，数字/字母更窄，混合时取 11px 比较稳。
      return `${Math.min(Math.max(longest * 11 + 10, 48), 108)}px`
    },
    playheadPercentText() {
      return `${this.playheadPercent}%`
    },
    playheadPercent() {
      return Math.min(Math.max((this.time / this.duration) * 100, 0), 100)
    },
    ticks() {
      const count = 10
      const step = this.duration / count
      return Array.from({ length: count + 1 }, (_, index) => {
        const time = index * step
        return {
          time,
          percentText: `${(time / this.duration) * 100}%`,
          label: this.formatTick(time, step)
        }
      })
    },
    selectedShot() {
      return this.timeline.cameraShots.find((shot) => shot.id === this.selectedShotId) || null
    },
    selectedKeyframe() {
      return this.timeline.objectKeyframes.find((item) => item.id === this.selectedKeyframeId) || null
    }
  },

  methods: {
    round(value) {
      return Math.round(value * 100) / 100
    },
    formatTime(value) {
      const seconds = Math.max(0, Number(value) || 0)
      return `${seconds.toFixed(2)}s`
    },
    formatTick(time, step) {
      return step >= 1 ? `${Math.round(time)}s` : `${time.toFixed(1)}s`
    },
    percent(timeSeconds) {
      return `${Math.min(Math.max((timeSeconds / this.duration) * 100, 0), 100)}%`
    },
    objectName(objectId) {
      const object = this.objects.find((item) => item.id === objectId)
      return object ? object.name : objectId.slice(0, 6)
    },
    commitTime(event) {
      const value = Number(event.target.value)
      if (!Number.isFinite(value)) return
      this.$emit('update-time', Math.min(Math.max(value, 0), this.duration))
    },
    /** 把横向像素位置换算成时间并上报。 */
    seekFromClientX(clientX, trackElement) {
      const rect = trackElement.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
      this.$emit('update-time', ratio * this.duration)
    },

    /**
     * 按住标尺拖动播放头。
     *
     * 用 pointerdown + 全局 pointermove/pointerup：
     * 指针移出标尺范围（甚至移出窗口）时仍能继续拖动，
     * 松手时统一解绑，不会残留监听器。
     */
    startScrub(event) {
      if (event.button !== 0) return
      const ruler = event.currentTarget
      this.seekFromClientX(event.clientX, ruler)

      const move = (moveEvent) => this.seekFromClientX(moveEvent.clientX, ruler)
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },

    /**
     * 拖动顶边调整时间轴高度。
     *
     * 用 `clientY` 的**差值**改变高度，而不是"屏幕高度 - clientY"：
     * 后者在窗口缩放或有缩放比例时会跳一下，手感很怪。
     */
    startResize(event) {
      if (event.button !== 0) return
      event.preventDefault()
      const startY = event.clientY
      const startHeight = this.height
      this.resizing = true

      const move = (moveEvent) => {
        const next = startHeight - (moveEvent.clientY - startY)
        this.height = Math.min(Math.max(next, MIN_HEIGHT), MAX_HEIGHT)
      }
      const up = () => {
        this.resizing = false
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },

    selectShot(shot) {
      this.$emit('select-shot', shot.id)
      this.$emit('update-time', shot.timeSeconds)
    }
  }
}
</script>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--line);
  background: var(--bg-1);
  flex: none;
  overflow: hidden;
}

.timeline.is-collapsed {
  height: auto;
}

/*
 * 抓取带。
 *
 * 6px 高、光标为 ns-resize，中间一段短横线提示"这里能拖"。
 * 必须 flex: none，否则会被 flex 布局压缩到 0 高而拖不到。
 */
.timeline__resizer {
  display: grid;
  place-items: center;
  height: 6px;
  flex: none;
  cursor: ns-resize;
  background: var(--bg-1);
}

.timeline__resizer span {
  width: 44px;
  height: 2px;
  border-radius: 2px;
  background: var(--line-strong);
  transition: background 0.15s ease;
}

.timeline__resizer:hover span {
  background: var(--accent);
}

.timeline__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  flex: none;
}

.timeline__left,
.timeline__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.timeline__center {
  flex: 1;
  display: flex;
  justify-content: center;
  gap: 8px;
}

.play-btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--bg-2);
  color: var(--text-0);
  cursor: pointer;
}

.play-btn:hover {
  border-color: var(--accent);
  color: var(--accent-strong);
}

.play-btn svg {
  width: 13px;
  height: 13px;
}

.rate {
  color: var(--text-2);
  font-size: 11px;
}

.time-readout {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}

.time-input {
  width: 54px;
  height: 22px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--text-0);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.time-input:focus {
  border-color: var(--accent);
  background: var(--bg-0);
  outline: none;
}

.time-sep {
  color: var(--text-2);
}

.duration-field {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-2);
  font-size: 11px;
}

.duration-input {
  width: 52px;
  height: 22px;
}

/* 轨道区可滚动：轨道多到放不下时（多条导航线）纵向滚动，而不是撑破面板。 */
.timeline__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

/*
 * 轨道区的外边距。
 *
 * **这里只留 12px，不要再把 label-width 加进来。**
 * 每个 `.lane` 内部本来就有一个宽 label-width 的 `.lane__label`，
 * 之前 padding-left 又加了一次 —— 结果是标尺的 0 秒刻度落在
 * labelWidth+12 处，而关键帧轨道的 0% 落在 2×labelWidth+20 处。
 * 两者差一整个标签列，这就是"时间轴和下方物体的轴对不齐"的根因。
 *
 * 现在标尺通过 --lane-gutter 让出与 `.lane` 相同的"标签 + 间隙"，
 * 两条轨道从同一个 x 起点开始。
 */
.timeline__track {
  --lane-gap: 8px;
  --lane-gutter: calc(var(--label-width, 48px) + var(--lane-gap));
  padding: 0 12px 8px 12px;
  display: flex;
  flex-direction: column;
}

.ruler {
  position: relative;
  height: 26px;
  border-bottom: 1px solid var(--line);
  cursor: pointer;
  /* 刻度标签贴着边缘时会溢出，裁掉才不会压到相邻区域。 */
  overflow: hidden;
  /* 与 `.lane__track` 共用同一条起点（标签列 + 间隙）。 */
  margin-left: var(--lane-gutter);
}

.ruler__tick {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--line);
}

.ruler__label {
  position: absolute;
  top: 5px;
  left: 4px;
  color: var(--text-2);
  font-size: 10px;
  white-space: nowrap;
}

/*
 * 播放头。
 *
 * 旧版 `bottom: -100px` + 无裁剪 = 那条"莫名的黑条"：
 * 竖线一直画到面板外面，横跨侧栏和工具栏。
 * 现在高度锁在标尺内部（top/bottom 都是 0），
 * 由 .ruler 的 overflow: hidden 兜底。
 */
.playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--accent);
  pointer-events: none;
}

.playhead__grip {
  position: absolute;
  top: 0;
  left: -4px;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  background: var(--accent);
}

.lanes {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 6px;
}

.lane {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
}

.lane__label {
  flex: none;
  width: var(--label-width, 48px);
  color: var(--text-2);
  font-size: 11px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lane__label--path {
  color: var(--accent-strong);
}

/*
 * 轨道容器统一裁剪。
 * 标记的 left 已经夹在 [0, 100%]，但标记自身有宽度，
 * 落在 100% 时仍会向右溢出——必须靠这里裁掉。
 */
.lane__track {
  position: relative;
  flex: 1;
  height: 100%;
  min-width: 0;
  border-radius: var(--radius-s);
  background: var(--bg-0);
  overflow: hidden;
}

/* 导航线轨道用一层 inset 内阴影做强调色描边，和关键帧轨道区分开。
   不用 color-mix()：旧版 Chromium 不支持，会整条退化成透明。 */
.lane__track--path {
  background: var(--bg-0);
  box-shadow: inset 0 0 0 1px var(--accent-soft);
}

.marker {
  position: absolute;
  top: 2px;
  bottom: 2px;
  padding: 0 6px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-s);
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 10px;
  cursor: pointer;
  transform: translateX(-1px);
  white-space: nowrap;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.marker--camera {
  border-radius: var(--radius-pill);
}

.marker--keyframe {
  padding: 0 4px;
  color: var(--warn);
}

.marker.is-active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

/* 导航线节点：菱形点，越小越不抢戏，但要有足够的点击面积。 */
.path-marker {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  border: 1px solid var(--accent);
  border-radius: 2px;
  background: var(--bg-1);
  cursor: pointer;
  transform: translateY(-50%) rotate(45deg);
}

.path-marker:hover {
  background: var(--accent-soft);
}

.path-marker.is-active {
  background: var(--accent);
}

.timeline__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 6px 12px;
  border-top: 1px solid var(--line);
  flex: none;
}

.timeline__hint {
  margin-right: auto;
  color: var(--text-2);
  font-size: 11px;
}
</style>
