/**
 * 面涂色。移植自 `app/src/renderer/src/scene-core/face-paint.ts`。
 *
 * 核心概念是"面片组"：法线夹角在 20 度以内、且互相连通的三角形被视为同一个面。
 * 用户点一下就能涂满整个平面，而不是只涂一个三角形——这是"零基础友好"的关键。
 *
 * 实现上用 WeakMap 缓存拓扑，避免每次点击都重算邻接关系。
 */

import * as THREE from 'three'

const normalAngleLimit = THREE.MathUtils.degToRad(20)
const normalDotLimit = Math.cos(normalAngleLimit)
const coordinatePrecision = 100_000

const topologyCache = new WeakMap()

function triangleCount(geometry) {
  const position = geometry.getAttribute('position')
  if (!position) return 0
  return Math.floor((geometry.index?.count ?? position.count) / 3)
}

function vertexIndex(geometry, triangle, corner) {
  return geometry.index?.getX(triangle * 3 + corner) ?? triangle * 3 + corner
}

function vertexPoint(geometry, triangle, corner, target) {
  const position = geometry.getAttribute('position')
  return target.fromBufferAttribute(position, vertexIndex(geometry, triangle, corner))
}

function pointKey(point) {
  return `${Math.round(point.x * coordinatePrecision)},${Math.round(point.y * coordinatePrecision)},${Math.round(point.z * coordinatePrecision)}`
}

function edgeKey(first, second) {
  const firstKey = pointKey(first)
  const secondKey = pointKey(second)
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`
}

function createTopology(geometry) {
  const count = triangleCount(geometry)
  const neighbors = Array.from({ length: count }, () => [])
  const normals = Array.from({ length: count }, () => new THREE.Vector3())
  const edges = new Map()
  const first = new THREE.Vector3()
  const second = new THREE.Vector3()
  const third = new THREE.Vector3()

  for (let triangle = 0; triangle < count; triangle += 1) {
    vertexPoint(geometry, triangle, 0, first)
    vertexPoint(geometry, triangle, 1, second)
    vertexPoint(geometry, triangle, 2, third)
    normals[triangle].copy(second).sub(first).cross(third.clone().sub(first)).normalize()
    for (const [start, end] of [
      [first, second],
      [second, third],
      [third, first]
    ]) {
      const key = edgeKey(start, end)
      const matches = edges.get(key)
      if (matches) matches.push(triangle)
      else edges.set(key, [triangle])
    }
  }

  for (const triangles of edges.values()) {
    for (let firstIndex = 0; firstIndex < triangles.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < triangles.length; secondIndex += 1) {
        const firstTriangle = triangles[firstIndex]
        const secondTriangle = triangles[secondIndex]
        neighbors[firstTriangle].push(secondTriangle)
        neighbors[secondTriangle].push(firstTriangle)
      }
    }
  }

  return { neighbors, normals, regions: new Map() }
}

function topologyFor(geometry) {
  const cached = topologyCache.get(geometry)
  if (cached) return cached
  const topology = createTopology(geometry)
  topologyCache.set(geometry, topology)
  return topology
}

/**
 * 从种子三角形出发，广度优先收集同一"面片组"的所有三角形。
 * 结果按索引排序后缓存，保证多次点击同一面得到相同结果。
 */
export function surfaceTriangles(geometry, seedTriangle) {
  const topology = topologyFor(geometry)
  if (seedTriangle < 0 || seedTriangle >= topology.normals.length) return []
  const cached = topology.regions.get(seedTriangle)
  if (cached) return cached

  const region = []
  const queue = [seedTriangle]
  const visited = new Set(queue)
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const triangle = queue[queueIndex]
    region.push(triangle)
    for (const neighbor of topology.neighbors[triangle]) {
      if (
        visited.has(neighbor) ||
        topology.normals[triangle].dot(topology.normals[neighbor]) < normalDotLimit
      ) {
        continue
      }
      visited.add(neighbor)
      queue.push(neighbor)
    }
  }

  region.sort((first, second) => first - second)
  for (const triangle of region) topology.regions.set(triangle, region)
  return region
}

export function faceColorKey(meshKey, triangle) {
  return `${meshKey}:${triangle}`
}

function originalMaterialIndex(geometry, triangle) {
  const offset = triangle * 3
  const group = geometry.groups.find(
    (candidate) => offset >= candidate.start && offset < candidate.start + candidate.count
  )
  return group?.materialIndex ?? 0
}

function applyDisplayMode(material, displayMode) {
  if (displayMode === 'solid') return
  material.transparent = true
  material.opacity = displayMode === 'transparent' ? 0.34 : 0.62
  material.depthWrite = false
  if ('wireframe' in material) material.wireframe = displayMode === 'wireframe'
  material.needsUpdate = true
}

function createPaintMaterial(color, displayMode) {
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.82,
    metalness: 0,
    side: THREE.DoubleSide
  })
  applyDisplayMode(material, displayMode)
  return material
}

function tintMaterial(material, color) {
  if (material.color instanceof THREE.Color) {
    material.color.set(color)
    material.needsUpdate = true
    return material
  }
  return createPaintMaterial(color, 'solid')
}

function colorsForMesh(object, meshKey) {
  const result = new Map()
  for (const [key, color] of Object.entries(object.faceColors ?? {})) {
    const separator = key.lastIndexOf(':')
    if (separator < 0 || key.slice(0, separator) !== meshKey) continue
    const triangle = Number(key.slice(separator + 1))
    if (Number.isSafeInteger(triangle) && triangle >= 0) result.set(triangle, color)
  }
  return result
}

/**
 * 把面涂色结果应用到网格材质。
 *
 * 用"材质组"而不是逐三角形建材质：three.js 的 draw call 按 group 划分，
 * 把连续的同色三角形合并成一个 group 能显著减少绘制次数。
 */
export function applyPaintToMesh(mesh, object, meshKey, cloneGeometry = false) {
  const displayMode = object.displayMode ?? 'solid'
  const originalMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const baseMaterials = object.colorOverride
    ? originalMaterials.map((material) => tintMaterial(material, object.colorOverride))
    : originalMaterials
  for (const material of baseMaterials) applyDisplayMode(material, displayMode)

  const faceColors = colorsForMesh(object, meshKey)
  if (faceColors.size === 0) {
    mesh.material = baseMaterials.length === 1 ? baseMaterials[0] : baseMaterials
    return
  }

  if (cloneGeometry) mesh.geometry = mesh.geometry.clone()
  const geometry = mesh.geometry
  const materials = [...baseMaterials]
  const colorMaterialIndices = new Map()
  const materialIndexFor = (color) => {
    const cached = colorMaterialIndices.get(color)
    if (cached !== undefined) return cached
    const index = materials.length
    materials.push(createPaintMaterial(color, displayMode))
    colorMaterialIndices.set(color, index)
    return index
  }

  const count = triangleCount(geometry)
  const assignments = Array.from({ length: count }, (_, triangle) => {
    const color = faceColors.get(triangle)
    if (color) return materialIndexFor(color)
    const originalIndex = originalMaterialIndex(geometry, triangle)
    return originalIndex < baseMaterials.length ? originalIndex : 0
  })
  geometry.clearGroups()
  let groupStart = 0
  for (let triangle = 1; triangle <= assignments.length; triangle += 1) {
    if (triangle < assignments.length && assignments[triangle] === assignments[groupStart]) continue
    geometry.addGroup(groupStart * 3, (triangle - groupStart) * 3, assignments[groupStart] ?? 0)
    groupStart = triangle
  }
  mesh.material = materials
}

/** 生成"待涂色面"的高亮预览几何，用于鼠标悬停反馈。 */
export function createSurfacePreviewGeometry(mesh, triangles) {
  mesh.updateMatrixWorld(true)
  const positions = []
  const point = new THREE.Vector3()
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      vertexPoint(mesh.geometry, triangle, corner, point).applyMatrix4(mesh.matrixWorld)
      positions.push(point.x, point.y, point.z)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.computeVertexNormals()
  return geometry
}

/**
 * 把屏幕射线命中的三角形编号还原出来。
 * three.js 的 intersection 会给出 `faceIndex`，这里做边界校验。
 */
export function triangleFromIntersection(intersection) {
  const index = intersection?.faceIndex
  return Number.isInteger(index) && index >= 0 ? index : null
}
