/**
 * 导航线几何与时间求值的单元测试。
 *
 * 这些断言覆盖的都是"错了就一定会被用户发现"的点：
 * 节点时刻按弧长分配、线性插值、朝向跟随、绑定覆盖关键帧。
 */

import { describe, it, expect } from 'vitest'
import {
  PATH_KIND,
  adjacentSegmentsFor,
  applyPathBindings,
  buildPathKeyframes,
  closestPointOnPolyline,
  closestPointOnSegmentsToRay,
  createPathBinding,
  distancePointToRay,
  pathInsertionPoint,
  pathNodeTimes,
  pathTotalLength,
  pathWorldPoints,
  pathYawDegrees,
  samplePathAtTime,
  sanitizePathNodes
} from './nav-path'

const duration = 10

/** 一条从 (0,0,0) 到 (10,0,0) 的直线，两段等长。 */
const straightPath = {
  id: 'path-1',
  kind: PATH_KIND,
  name: '导航线 01',
  position: { x: 0, y: 0, z: 0 },
  pathNodes: [
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 }
  ]
}

describe('导航线节点净化', () => {
  it('过滤掉坐标非法的节点', () => {
    const nodes = sanitizePathNodes([
      { x: 0, y: 0, z: 0 },
      { x: NaN, y: 0, z: 1 },
      { x: 2, z: 3 },
      null
    ])
    expect(nodes).toHaveLength(2)
    // 缺 y 的节点补 0，而不是丢掉整条节点。
    expect(nodes[1]).toEqual({ x: 2, y: 0, z: 3 })
  })

  it('非数组输入退化成空列表', () => {
    expect(sanitizePathNodes(undefined)).toEqual([])
    expect(sanitizePathNodes(null)).toEqual([])
  })
})

describe('世界坐标换算', () => {
  it('路径对象的位置会叠加到节点上', () => {
    const points = pathWorldPoints({
      ...straightPath,
      position: { x: 1, y: 2, z: 3 }
    })
    expect(points[0]).toEqual({ x: 1, y: 2, z: 3 })
    expect(points[2]).toEqual({ x: 11, y: 2, z: 3 })
  })

  it('总长按欧氏距离累加', () => {
    expect(pathTotalLength(straightPath.pathNodes)).toBeCloseTo(10, 6)
  })
})

describe('节点时刻分配', () => {
  it('等长段把时长等分', () => {
    expect(pathNodeTimes(straightPath.pathNodes, duration)).toEqual([0, 5, 10])
  })

  it('不等长段按弧长比例分配（等速运动）', () => {
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ]
    // 2 : 8 = 1 : 4 → 2s / 10s
    const times = pathNodeTimes(nodes, duration)
    expect(times[0]).toBe(0)
    expect(times[1]).toBeCloseTo(2, 6)
    expect(times[2]).toBeCloseTo(10, 6)
  })

  it('节点全部重合时退化成等分，不会除零', () => {
    const nodes = [
      { x: 1, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 }
    ]
    expect(pathNodeTimes(nodes, duration)).toEqual([0, 5, 10])
  })

  it('单个节点只有 0 时刻', () => {
    expect(pathNodeTimes([{ x: 0, y: 0, z: 0 }], duration)).toEqual([0])
  })
})

describe('沿路径取样', () => {
  it('起点、中点、终点线性插值', () => {
    const start = samplePathAtTime(straightPath.pathNodes, 0, duration)
    const middle = samplePathAtTime(straightPath.pathNodes, 2.5, duration)
    const end = samplePathAtTime(straightPath.pathNodes, duration, duration)

    expect(start.position).toEqual({ x: 0, y: 0, z: 0 })
    // 2.5s 在总长的 25% 处 = x = 2.5
    expect(middle.position.x).toBeCloseTo(2.5, 6)
    expect(end.position.x).toBeCloseTo(10, 6)
  })

  it('超出时长会被夹到端点', () => {
    const after = samplePathAtTime(straightPath.pathNodes, 99, duration)
    const before = samplePathAtTime(straightPath.pathNodes, -5, duration)
    expect(after.position.x).toBeCloseTo(10, 6)
    expect(before.position.x).toBeCloseTo(0, 6)
  })

  it('方向指向前进方向', () => {
    const sample = samplePathAtTime(straightPath.pathNodes, 5, duration)
    expect(sample.direction.x).toBeCloseTo(1, 6)
    expect(sample.direction.z).toBeCloseTo(0, 6)
  })

  it('空节点返回 null', () => {
    expect(samplePathAtTime([], 1, duration)).toBeNull()
  })
})

describe('朝向', () => {
  it('沿 +Z 前进时偏航角为 0', () => {
    expect(pathYawDegrees({ x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6)
  })

  it('沿 +X 前进时偏航角为 90 度', () => {
    expect(pathYawDegrees({ x: 1, y: 0, z: 0 })).toBeCloseTo(90, 6)
  })
})

describe('节点滑动限制', () => {
  it('首尾节点只有一个相邻段', () => {
    const points = straightPath.pathNodes
    expect(adjacentSegmentsFor(points, 0)).toEqual([0])
    expect(adjacentSegmentsFor(points, points.length - 1)).toEqual([points.length - 2])
  })

  it('中间节点可以在前后两段上滑动', () => {
    expect(adjacentSegmentsFor(straightPath.pathNodes, 1)).toEqual([0, 1])
  })

  it('射线投影落在相邻段的范围内，不会跳到路径另一头', () => {
    const points = [
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ]
    // 指针指向 x = 8（第二段），但只允许在相邻段（0 和 1）里取最近点。
    const hit = closestPointOnSegmentsToRay(
      points,
      adjacentSegmentsFor(points, 1),
      { x: 8, y: 10, z: 0 },
      { x: 0, y: -1, z: 0 }
    )
    // 第二段上离 (8,10,0) 最近的点就是 (8,0,0)。
    expect(hit.position.x).toBeCloseTo(8, 6)
    expect(hit.segmentIndex).toBe(1)
  })
})

describe('射线距离', () => {
  it('点到射线的垂距', () => {
    const distance = distancePointToRay(
      { x: 0, y: 3, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }
    )
    expect(distance).toBeCloseTo(0, 6)
  })

  it('射线背后的点按起点算距离', () => {
    const distance = distancePointToRay(
      { x: 0, y: -3, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 }
    )
    expect(distance).toBeCloseTo(3, 6)
  })
})

describe('折线最近点与插入', () => {
  it('能把任意点吸附到折线上', () => {
    const hit = closestPointOnPolyline(straightPath.pathNodes, { x: 3, y: 2, z: 0 })
    expect(hit.position.x).toBeCloseTo(3, 6)
    expect(hit.position.y).toBeCloseTo(0, 6)
  })

  it('在最长段的中点插入新节点', () => {
    const nodes = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 11, y: 0, z: 0 }
    ]
    const insertion = pathInsertionPoint(nodes)
    // 第二段最长（10 米），中点 x = 6，插入索引 2。
    expect(insertion.index).toBe(2)
    expect(insertion.position.x).toBeCloseTo(6, 6)
  })
})

describe('绑定关系', () => {
  it('createPathBinding 记下离地高度', () => {
    const binding = createPathBinding({ position: { x: 0, y: 1.1, z: 0 } }, 'path-1', 1.1)
    expect(binding).toMatchObject({ pathId: 'path-1', followRotation: true, offsetSeconds: 0 })
    expect(binding.heightOffset).toBeCloseTo(1.1, 6)
  })

  it('绑定的物体被摆到路径上，朝向跟随路径', () => {
    const box = {
      id: 'box-1',
      kind: 'box',
      position: { x: 0, y: 1.1, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      pathBinding: { pathId: 'path-1', followRotation: true, offsetSeconds: 0, heightOffset: 1.1 }
    }
    const result = applyPathBindings([straightPath, box], 5, duration)
    const bound = result.find((item) => item.id === 'box-1')
    // 5s 在 10s 的一半 → x = 5
    expect(bound.position.x).toBeCloseTo(5, 6)
    // 高度 = 路径高度 0 + 离地 1.1
    expect(bound.position.y).toBeCloseTo(1.1, 6)
    expect(bound.rotation.y).toBeCloseTo(90, 6)
  })

  it('followRotation = false 时保留自身朝向', () => {
    const box = {
      id: 'box-1',
      kind: 'box',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 42, z: 0 },
      pathBinding: { pathId: 'path-1', followRotation: false, offsetSeconds: 0, heightOffset: 0 }
    }
    const result = applyPathBindings([straightPath, box], 5, duration)
    expect(result.find((item) => item.id === 'box-1').rotation.y).toBeCloseTo(42, 6)
  })

  it('offsetSeconds 让物体提前出发', () => {
    const box = {
      id: 'box-1',
      kind: 'box',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      pathBinding: { pathId: 'path-1', followRotation: true, offsetSeconds: 2, heightOffset: 0 }
    }
    const result = applyPathBindings([straightPath, box], 3, duration)
    // 3s + 偏移 2s = 5s → x = 5
    expect(result.find((item) => item.id === 'box-1').position.x).toBeCloseTo(5, 6)
  })

  it('路径被删除后绑定的物体保持原位，不报错', () => {
    const box = {
      id: 'box-1',
      kind: 'box',
      position: { x: 3, y: 0, z: 3 },
      rotation: { x: 0, y: 0, z: 0 },
      pathBinding: { pathId: 'missing', followRotation: true, offsetSeconds: 0, heightOffset: 0 }
    }
    const result = applyPathBindings([box], 5, duration)
    expect(result[0].position).toEqual({ x: 3, y: 0, z: 3 })
  })

  it('没有任何绑定时原样返回同一引用（避免无意义的新数组）', () => {
    const objects = [{ id: 'a', kind: 'box' }]
    expect(applyPathBindings(objects, 1, duration)).toBe(objects)
  })
})

describe('时间轴标记', () => {
  it('每个节点生成一个标记，时刻按弧长分配', () => {
    const markers = buildPathKeyframes([straightPath], duration)
    expect(markers).toHaveLength(3)
    expect(markers.map((marker) => marker.timeSeconds)).toEqual([0, 5, 10])
    expect(markers[0].id).toBe('path-1:0')
    expect(markers[2].index).toBe(2)
  })

  it('多条路径的标记按时间统一排序', () => {
    const second = {
      id: 'path-2',
      kind: PATH_KIND,
      name: '导航线 02',
      position: { x: 0, y: 0, z: 0 },
      pathNodes: [
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 }
      ]
    }
    const markers = buildPathKeyframes([straightPath, second], duration)
    const times = markers.map((marker) => marker.timeSeconds)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('非导航线对象不产生标记', () => {
    const markers = buildPathKeyframes([{ id: 'box', kind: 'box' }], duration)
    expect(markers).toHaveLength(0)
  })
})
