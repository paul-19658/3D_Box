<template>
  <aside class="camera-overlay">
    <header class="camera-overlay__head">
      <span class="camera-overlay__title">摄影机</span>
      <span class="camera-overlay__fov"
        >{{ camera.fovDegrees }}° · {{ camera.aspectWidth }}:{{ camera.aspectHeight }}</span
      >
    </header>

    <div class="camera-overlay__body">
      <div class="vector-row">
        <label v-for="axis in axes" :key="`pos-${axis}`" class="cell">
          <span>{{ axis.toUpperCase() }}</span>
          <input
            class="input"
            type="number"
            step="0.1"
            :value="round(camera.position[axis])"
            @change="update('position', axis, $event)"
          />
        </label>
      </div>
      <div class="vector-row">
        <label v-for="axis in axes" :key="`tgt-${axis}`" class="cell">
          <span>{{ axis.toUpperCase() }}</span>
          <input
            class="input"
            type="number"
            step="0.1"
            :value="round(camera.target[axis])"
            @change="update('target', axis, $event)"
          />
        </label>
      </div>
    </div>

    <footer class="camera-overlay__foot">
      <button type="button" class="btn btn--ghost" @click="$emit('focus')">对准场景</button>
    </footer>
  </aside>
</template>

<script>
/**
 * 视口左下角的摄影机浮层：直接输入机位与目标点。
 *
 * 做成浮层而非固定面板，是因为用户大部分时间在拖模型；
 * 只有需要"精确到 0.1 米"时才把注意力移到这里。
 */
export default {
  name: 'CameraOverlay',

  props: {
    camera: { type: Object, required: true }
  },

  data() {
    return { axes: ['x', 'y', 'z'] }
  },

  methods: {
    round(value) {
      return Math.round(value * 100) / 100
    },
    update(key, axis, event) {
      const value = Number(event.target.value)
      if (!Number.isFinite(value)) return
      this.$emit('update-camera', { [key]: { ...this.camera[key], [axis]: value } })
    }
  }
}
</script>

<style scoped>
.camera-overlay {
  position: absolute;
  left: 12px;
  bottom: 12px;
  width: 236px;
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  background: var(--panel-blur);
  backdrop-filter: blur(10px);
  box-shadow: var(--shadow-panel);
  overflow: hidden;
}

.camera-overlay__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
}

.camera-overlay__title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-1);
}

.camera-overlay__fov {
  color: var(--text-2);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}

.camera-overlay__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
}

.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell span {
  color: var(--text-2);
  font-size: 10px;
}

.cell .input {
  height: 22px;
  padding: 0 4px;
  font-size: 11px;
}

.camera-overlay__foot {
  padding: 0 8px 8px;
}

.camera-overlay__foot .btn {
  width: 100%;
  height: 24px;
  font-size: 11px;
}
</style>
