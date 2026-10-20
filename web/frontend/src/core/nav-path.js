/**
 * 导航线（路径）的几何与时间求值。
 *
 * 设计要点（决定了这个模块为什么这么写）：
 *
 * 1. **节点时间是"算出来的"，不是存下来的。**
 *    每个节点在时间轴上的时刻 = 累计弧长比例 × 总时长。
 *    好处是"沿路径拖节点 → 时间轴标记跟着移动"天然成立：
 *    拖动改变了各段长度，各段比例随之变化，标记自然跟着走。
 *    如果额外存一份 timeSeconds，就会出现"位置和标记对不上"的脏数据，
 *    还得在每次拖动时同步两边——那正是最容易写出 bug 的地方。
 *
 * 2. **节点用局部坐标，路径对象只有 position 参与运算。**
 *    旋转 / 缩放不参与：路径是一条地面引导线，允许旋转会让
 *    "沿路径运动"的朝向计算变得难以解释，也会让手工输入的坐标失真。
 *
 * 3. **绑定物体的位置由路径驱动，覆盖自身关键帧。**
 *    规则简单可预期：绑定优先级最高。
 *
 * 本文件保持纯函数、不依赖 three.js，方便在 Node 里直接单测。
 */

const EPSILON = 1e-6

export const PATH_KIND = 'path'
/** 绘制时每隔多远落一个节点（米）。 */
export const PATH_NODE_SPACING = 0.6
/** 少于两个节点画不出方向。 */
export const PATH_MIN_NODES = 2
export const PATH_COLOR = '#4b93ff'

function vector(x, y, z) {
  return { x, y, z }
}

export function isPathObject(object) {
  return Boolean(object) && object.kind === PATH_KIND
}

/** 统一成 {x, y, z}，顺带过滤掉坏节点（历史工程 / 手改文件都可能出现）。 */
export function sanitizePathNodes(nodes) {
  if (!Array.isArray(nodes)) return []
  const result = []
  for (const node of nodes) {
    if (!node || !Number.isFinite(node.x) || !Number.isFinite(node.z)) continue
    result.push(vector(node.x, Number.isFinite(node.y) ? node.y : 0, node.z))
  }
  return result
}

/** 路径节点是局部坐标，叠加路径对象自身的位置得到世界坐标。 */
export function pathWorldPoints(path) {
  const origin = path?.position ?? { x: 0, y: 0, z: 0 }
  return sanitizePathNodes(path?.pathNodes).map((node) =>
    vector(origin.x + node.x, origin.y + node.y, origin.z + node.z)
  )
}

export function distanceBetween(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y, second.z - first.z)
}

export function pathSegmentLengths(points) {
  const lengths = []
  for (let index = 1; index < points.length; index += 1) {
    lengths.push(distanceBetween(points[index - 1], points[index]))
  }
  return lengths
}

export function pathTotalLength(points) {
  return pathSegmentLengths(points).reduce((sum, length) => sum + length, 0)
}

/**
 * 每个节点对应的时间轴时刻。
 *
 * 按累计弧长比例分配：等速运动。总长为 0（节点重合）时退化成等分，
 * 避免除零，也让退化路径仍然能在时间轴上按顺序显示节点。
 */
export function pathNodeTimes(points, durationSeconds) {
  const duration = Math.max(Number(durationSeconds) || 0, 0)
  if (points.length === 0) return []
  if (points.length === 1) return [0]

  const lengths = pathSegmentLengths(points)
  const total = lengths.reduce((sum, length) => sum + length, 0)
  const times = [0]

  if (total <= EPSILON) {
    const step = duration / (points.length - 1)
    for (let index = 1; index < points.length; index += 1) times.push(step * index)
    return times
  }

  let travelled = 0
  for (const length of lengths) {
    travelled += length
    times.push((travelled / total) * duration)
  }
  return times
}

/** 段方向（已归一化）。两点重合时给 +Z，保证朝向计算永远有定义。 */
export function pathSegmentDirection(from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const length = Math.hypot(dx, dy, dz)
  if (length <= EPSILON) return vector(0, 0, 1)
  return vector(dx / length, dy / length, dz / length)
}

/**
 * 让物体"朝着路径前进方向"的偏航角（度）。
 *
 * 约定物体本地 **+Z** 为正面——这与 three.js `Object3D.lookAt` 的语义一致，
 * 也避免了相机（-Z 朝前）那套约定带来的混乱。
 */
export function pathYawDegrees(direction) {
  return (Math.atan2(direction.x, direction.z) * 180) / Math.PI
}

function lerpPoint(from, to, amount) {
  return vector(
    from.x + (to.x - from.x) * amount,
    from.y + (to.y - from.y) * amount,
    from.z + (to.z - from.z) * amount
  )
}

/**
 * 在某一时刻取样：返回世界位置 + 前进方向。
 * 线性插值（需求明确要求"使用线性插值"），不做缓动，
 * 这样"沿路径匀速走"的观感才成立。
 */
export function samplePathAtTime(points, timeSeconds, durationSeconds) {
  if (points.length === 0) return null
  const times = pathNodeTimes(points, durationSeconds)
  const lastIndex = points.length - 1
  if (lastIndex === 0) {
    return { position: { ...points[0] }, direction: vector(0, 0, 1), segmentIndex: 0, amount: 0 }
  }

  const duration = Math.max(Number(durationSeconds) || 0, 0)
  const time = Math.min(Math.max(Number(timeSeconds) || 0, 0), duration)

  if (time <= times[0]) {
    return {
      position: { ...points[0] },
      direction: pathSegmentDirection(points[0], points[1]),
      segmentIndex: 0,
      amount: 0
    }
  }
  if (time >= times[lastIndex]) {
    return {
      position: { ...points[lastIndex] },
      direction: pathSegmentDirection(points[lastIndex - 1], points[lastIndex]),
      segmentIndex: lastIndex - 1,
      amount: 1
    }
  }

  for (let index = 1; index <= lastIndex; index += 1) {
    if (time > times[index]) continue
    const span = times[index] - times[index - 1]
    const amount = span <= EPSILON ? 0 : (time - times[index - 1]) / span
    return {
      position: lerpPoint(points[index - 1], points[index], amount),
      direction: pathSegmentDirection(points[index - 1], points[index]),
      segmentIndex: index - 1,
      amount
    }
  }

  return {
    position: { ...points[lastIndex] },
    direction: pathSegmentDirection(points[lastIndex - 1], points[lastIndex]),
    segmentIndex: lastIndex - 1,
    amount: 1
  }
}

/** 折线上离目标点最近的位置（用于"点击路径插入节点"这类场景）。 */
export function closestPointOnPolyline(points, target) {
  if (points.length === 0) return null
  if (points.length === 1) return { position: { ...points[0] }, segmentIndex: 0, amount: 0 }
  let best = null
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const lengthSq = dx * dx + dy * dy + dz * dz
    let amount = 0
    if (lengthSq > EPSILON) {
      amount =
        ((target.x - from.x) * dx + (target.y - from.y) * dy + (target.z - from.z) * dz) / lengthSq
      amount = Math.min(Math.max(amount, 0), 1)
    }
    const position = lerpPoint(from, to, amount)
    const distance = distanceBetween(position, target)
    if (!best || distance < best.distance) best = { position, segmentIndex: index - 1, amount, distance }
  }
  return best
}

/** 顶点到射线的距离（射线方向已归一化）。 */
export function distancePointToRay(point, origin, direction) {
  const vx = point.x - origin.x
  const vy = point.y - origin.y
  const vz = point.z - origin.z
  const along = Math.max(vx * direction.x + vy * direction.y + vz * direction.z, 0)
  const px = origin.x + direction.x * along
  const py = origin.y + direction.y * along
  const pz = origin.z + direction.z * along
  return Math.hypot(point.x - px, point.y - py, point.z - pz)
}

/**
 * 线段上离射线最近的点（Ericson《Real-Time Collision Detection》5.1.9 的退化版：
 * 射线参数不设上界，所以只需要解出线段参数 s 并夹到 [0, 1]）。
 */
function closestPointOnSegmentToRay(origin, direction, from, to) {
  const d2x = to.x - from.x
  const d2y = to.y - from.y
  const d2z = to.z - from.z
  const rx = origin.x - from.x
  const ry = origin.y - from.y
  const rz = origin.z - from.z

  const b12 = direction.x * d2x + direction.y * d2y + direction.z * d2z
  const c22 = d2x * d2x + d2y * d2y + d2z * d2z
  const d1r = direction.x * rx + direction.y * ry + direction.z * rz
  const d2r = d2x * rx + d2y * ry + d2z * rz
  // a11 = direction·direction = 1，所以分母可以省掉一项。
  const denominator = c22 - b12 * b12

  let amount = 0
  if (Math.abs(denominator) > EPSILON) amount = (d2r - b12 * d1r) / denominator
  amount = Math.min(Math.max(amount, 0), 1)

  return vector(from.x + d2x * amount, from.y + d2y * amount, from.z + d2z * amount)
}

/**
 * 在一组指定线段上，找离射线最近的落点。
 *
 * `segments` 传入的是段索引（i 表示 points[i] → points[i+1]）。
 * 拖节点时只传它相邻的两段：这样节点只能在邻居之间滑动，
 * 不会因为指针扫过远处而"跳"到路径另一头。
 */
export function closestPointOnSegmentsToRay(points, segments, origin, direction) {
  let best = null
  for (const segmentIndex of segments) {
    if (segmentIndex < 0 || segmentIndex + 1 >= points.length) continue
    const from = points[segmentIndex]
    const to = points[segmentIndex + 1]
    const position = closestPointOnSegmentToRay(origin, direction, from, to)
    const distance = distancePointToRay(position, origin, direction)
    if (!best || distance < best.distance) best = { position, segmentIndex, distance }
  }
  return best
}

/** 某个节点可滑动的相邻段索引。 */
export function adjacentSegmentsFor(points, index) {
  const segments = []
  if (index > 0) segments.push(index - 1)
  if (index + 1 < points.length) segments.push(index)
  return segments
}

/** 在最长的段中点插入一个节点，返回新节点插入位置（索引 + 局部坐标）。 */
export function pathInsertionPoint(points) {
  if (points.length < 2) {
    const last = points[points.length - 1] ?? vector(0, 0, 0)
    return { index: points.length, position: vector(last.x, last.y, last.z + 1) }
  }
  const lengths = pathSegmentLengths(points)
  let longestIndex = 0
  for (let index = 1; index < lengths.length; index += 1) {
    if (lengths[index] > lengths[longestIndex]) longestIndex = index
  }
  return {
    index: longestIndex + 1,
    position: lerpPoint(points[longestIndex], points[longestIndex + 1], 0.5)
  }
}

/** 绑定关系：记下绑定当时的离地高度，人物 / 方块才不会陷进地面。 */
export function createPathBinding(object, pathId, heightOffset) {
  return {
    pathId,
    followRotation: true,
    offsetSeconds: 0,
    heightOffset: Number.isFinite(heightOffset) ? heightOffset : object?.position?.y ?? 0
  }
}

/**
 * 把所有"绑定了路径"的物体按当前时间摆到路径上。
 *
 * 只对确实存在绑定、且路径仍有节点的物体生效；
 * 其余物体原样返回（同一个引用），避免制造无意义的新对象。
 */
export function applyPathBindings(objects, timeSeconds, durationSeconds) {
  if (!Array.isArray(objects) || objects.length === 0) return objects
  if (!objects.some((object) => object.pathBinding)) return objects

  const byId = new Map(objects.map((object) => [object.id, object]))
  let changed = false

  const result = objects.map((object) => {
    const binding = object.pathBinding
    if (!binding || !binding.pathId) return object
    const path = byId.get(binding.pathId)
    if (!path || path.kind !== PATH_KIND) return object

    const points = pathWorldPoints(path)
    if (points.length === 0) return object

    const time = (Number(timeSeconds) || 0) + (Number(binding.offsetSeconds) || 0)
    const sample = samplePathAtTime(points, time, durationSeconds)
    if (!sample) return object

    changed = true
    const heightOffset = Number(binding.heightOffset) || 0
    const rotation =
      binding.followRotation === false
        ? object.rotation
        : { x: 0, y: pathYawDegrees(sample.direction), z: 0 }

    return {
      ...object,
      position: {
        x: sample.position.x,
        y: sample.position.y + heightOffset,
        z: sample.position.z
      },
      rotation
    }
  })

  return changed ? result : objects
}

/**
 * 供时间轴渲染的"导航线关键帧"。
 *
 * 这些标记是派生出来的，不写进 `timeline.objectKeyframes`：
 * 一旦存两份数据，就必然出现"路径改了但时间轴没跟上"的错位。
 */
export function buildPathKeyframes(objects, durationSeconds) {
  const markers = []
  for (const object of objects ?? []) {
    if (object.kind !== PATH_KIND) continue
    const points = pathWorldPoints(object)
    const times = pathNodeTimes(points, durationSeconds)
    times.forEach((timeSeconds, index) => {
      markers.push({
        id: `${object.id}:${index}`,
        objectId: object.id,
        name: object.name,
        index,
        timeSeconds,
        position: points[index]
      })
    })
  }
  return markers.sort((first, second) => first.timeSeconds - second.timeSeconds)
}

/** 哪些物体绑在了这条路径上。 */
export function boundObjectsOf(pathId, objects) {
  return (objects ?? []).filter((object) => object?.pathBinding?.pathId === pathId)
}
