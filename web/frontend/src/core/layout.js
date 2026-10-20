/**
 * 排列与对齐。移植自 `app/src/renderer/src/scene-core/layout.ts`。
 *
 * 全部基于"世界包围盒"计算，因此旋转过的物体也能正确对齐。
 * 锁定物体与不可见物体不参与计算，也不被移动。
 */

import { objectWorldBounds } from './geometry'

function boundValue(object, axis, mode) {
  const bounds = objectWorldBounds(object)
  if (mode === 'start') return bounds.min[axis]
  if (mode === 'end') return bounds.max[axis]
  return (bounds.min[axis] + bounds.max[axis]) / 2
}

export function alignObjects(objects, selectedIds, axis, mode) {
  const selected = objects.filter((object) => selectedIds.has(object.id) && !object.locked)
  if (selected.length < 2) return objects
  const target =
    mode === 'start'
      ? Math.min(...selected.map((object) => boundValue(object, axis, mode)))
      : mode === 'end'
        ? Math.max(...selected.map((object) => boundValue(object, axis, mode)))
        : selected.reduce((sum, object) => sum + boundValue(object, axis, mode), 0) / selected.length

  return objects.map((object) => {
    if (!selectedIds.has(object.id) || object.locked) return object
    const delta = target - boundValue(object, axis, mode)
    return { ...object, position: { ...object.position, [axis]: object.position[axis] + delta } }
  })
}

/** 等距排列：保持首尾不动，中间物体均分剩余空隙。 */
export function distributeObjects(objects, selectedIds, axis) {
  const selected = objects
    .filter((object) => selectedIds.has(object.id) && !object.locked)
    .map((object) => ({ object, bounds: objectWorldBounds(object) }))
    .sort((a, b) => a.bounds.min[axis] - b.bounds.min[axis])
  if (selected.length < 3) return objects

  const start = selected[0].bounds.min[axis]
  const end = selected[selected.length - 1].bounds.max[axis]
  const occupied = selected.reduce((sum, item) => sum + (item.bounds.max[axis] - item.bounds.min[axis]), 0)
  const gap = Math.max((end - start - occupied) / (selected.length - 1), 0)
  const positions = new Map()
  let cursor = start
  for (const item of selected) {
    const width = item.bounds.max[axis] - item.bounds.min[axis]
    const currentCenter = (item.bounds.min[axis] + item.bounds.max[axis]) / 2
    positions.set(item.object.id, item.object.position[axis] + cursor + width / 2 - currentCenter)
    cursor += width + gap
  }

  return objects.map((object) => {
    const position = positions.get(object.id)
    return position === undefined ? object : { ...object, position: { ...object.position, [axis]: position } }
  })
}

/** 落地：把物体包围盒的最低点对齐到 y=0。 */
export function placeOnGround(objects, selectedIds) {
  return objects.map((object) => {
    if (!selectedIds.has(object.id) || object.locked) return object
    const bounds = objectWorldBounds(object)
    return { ...object, position: { ...object.position, y: object.position.y - bounds.min.y } }
  })
}

function overlapsInPlan(candidate, existing, clearance = 0) {
  const bounds = objectWorldBounds(candidate)
  return existing.some((object) => {
    if (!object.visible) return false
    const occupied = objectWorldBounds(object)
    return !(
      bounds.max.x + clearance <= occupied.min.x ||
      bounds.min.x - clearance >= occupied.max.x ||
      bounds.max.z + clearance <= occupied.min.z ||
      bounds.min.z - clearance >= occupied.max.z
    )
  })
}

/**
 * 为新物体寻找不与现有物体重叠的位置。
 *
 * 先尝试贴着已有物体的四边放置，再从近到远按环状网格搜索。
 * 找不到空位时返回原位，而不是抛错——用户可以先手动摆放。
 */
export function placeNewObject(object, existing) {
  if (existing.length === 0) return object
  const objectBounds = objectWorldBounds(object)
  const halfWidth = (objectBounds.max.x - objectBounds.min.x) / 2
  const halfDepth = (objectBounds.max.z - objectBounds.min.z) / 2
  const candidates = []

  for (const anchor of existing.filter((item) => item.visible)) {
    const anchorBounds = objectWorldBounds(anchor)
    const anchorCenterX = (anchorBounds.min.x + anchorBounds.max.x) / 2
    const anchorCenterZ = (anchorBounds.min.z + anchorBounds.max.z) / 2
    candidates.push(
      { x: anchorBounds.max.x + halfWidth, z: anchorCenterZ },
      { x: anchorCenterX, z: anchorBounds.max.z + halfDepth },
      { x: anchorBounds.min.x - halfWidth, z: anchorCenterZ },
      { x: anchorCenterX, z: anchorBounds.min.z - halfDepth }
    )
  }

  const step = Math.max(halfWidth * 2, halfDepth * 2, 2) + 0.5
  for (let ring = 1; ring <= 12; ring += 1) {
    for (let x = -ring; x <= ring; x += 1) {
      candidates.push({ x: x * step, z: -ring * step }, { x: x * step, z: ring * step })
    }
    for (let z = -ring + 1; z < ring; z += 1) {
      candidates.push({ x: -ring * step, z: z * step }, { x: ring * step, z: z * step })
    }
  }

  for (const candidate of candidates) {
    const placed = { ...object, position: { ...object.position, ...candidate } }
    if (!overlapsInPlan(placed, existing)) return placed
  }
  return object
}

function intervalGap(firstMin, firstMax, secondMin, secondMax) {
  if (firstMax < secondMin) return secondMin - firstMax
  if (secondMax < firstMin) return firstMin - secondMax
  return 0
}

/**
 * 拖动结束时把选区吸附到邻近物体的边缘。
 *
 * 只在其他两个轴已经"接近"时才吸附，避免把一个悬浮物体突然吸到远处墙边。
 */
export function snapSelectionToObjectEdges(objects, selectedIds, threshold = 0.3) {
  const moving = objects.filter((object) => selectedIds.has(object.id) && object.visible && !object.locked)
  const targets = objects.filter((object) => !selectedIds.has(object.id) && object.visible)
  if (moving.length === 0 || targets.length === 0) return { objects, axes: [] }

  const movingBounds = moving.reduce(
    (bounds, object) => bounds.union(objectWorldBounds(object)),
    objectWorldBounds(moving[0]).clone().makeEmpty()
  )
  const axes = ['x', 'y', 'z']
  const deltas = new Map()

  for (const axis of axes) {
    const otherAxes = axes.filter((candidate) => candidate !== axis)
    let closest = null
    for (const target of targets) {
      const targetBounds = objectWorldBounds(target)
      const spatiallyRelated = otherAxes.every(
        (otherAxis) =>
          intervalGap(
            movingBounds.min[otherAxis],
            movingBounds.max[otherAxis],
            targetBounds.min[otherAxis],
            targetBounds.max[otherAxis]
          ) <=
          threshold * 2
      )
      if (!spatiallyRelated) continue
      for (const delta of [
        targetBounds.min[axis] - movingBounds.max[axis],
        targetBounds.max[axis] - movingBounds.min[axis]
      ]) {
        if (Math.abs(delta) > threshold) continue
        if (closest === null || Math.abs(delta) < Math.abs(closest)) closest = delta
      }
    }
    if (closest !== null) deltas.set(axis, closest)
  }

  if (deltas.size === 0) return { objects, axes: [] }
  return {
    objects: objects.map((object) => {
      if (!selectedIds.has(object.id) || object.locked) return object
      const position = { ...object.position }
      for (const [axis, delta] of deltas) position[axis] += delta
      return { ...object, position }
    }),
    axes: [...deltas.keys()]
  }
}
