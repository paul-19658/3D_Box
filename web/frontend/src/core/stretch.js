/**
 * 拉伸计算。移植自 `app/src/renderer/src/scene-core/stretch.ts`。
 *
 * 拉伸是"只动一个面"：尺寸变化时物体中心要反向偏移一半，
 * 这样对面才会保持在原位不动。最小尺寸 0.1 米，防止把物体压成零厚度。
 */

export function calculateStretch({ position, size, axis, sign, delta, worldAxis }) {
  const nextAxisSize = Math.max(0.1, size[axis] + sign * delta)
  const appliedSizeChange = nextAxisSize - size[axis]
  const appliedFaceDistance = appliedSizeChange * sign
  const centerDistance = appliedFaceDistance / 2

  return {
    size: { ...size, [axis]: nextAxisSize },
    position: {
      x: position.x + worldAxis.x * centerDistance,
      y: position.y + worldAxis.y * centerDistance,
      z: position.z + worldAxis.z * centerDistance
    }
  }
}
