/**
 * 轻量预览与性能风险。移植自 `optimizer/*`。
 *
 * 轻量预览是"可逆"的：原模型始终保留，只是暂时隐藏；
 * 用户可随时切回原始精度，导出时也可单独选择精度。
 */

import * as THREE from 'three'
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js'

function geometryTriangles(geometry) {
  return geometry.index
    ? Math.floor(geometry.index.count / 3)
    : Math.floor((geometry.getAttribute('position')?.count ?? 0) / 3)
}

export function objectTriangles(root) {
  let triangles = 0
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) triangles += geometryTriangles(child.geometry)
  })
  return triangles
}

function canSimplify(mesh) {
  const position = mesh.geometry.getAttribute('position')
  return Boolean(
    position &&
    position.count >= 120 &&
    !(mesh instanceof THREE.SkinnedMesh) &&
    !mesh.geometry.getAttribute('skinIndex') &&
    (mesh.geometry.morphAttributes.position?.length ?? 0) === 0 &&
    mesh.geometry.groups.length <= 1
  )
}

/**
 * 生成减面后的副本。原模型不被修改。
 *
 * 不能减面的网格会被跳过而不是强行处理——破坏结构比慢一点更糟。
 */
export function createLightweightPreview(original, targetRatio) {
  const ratio = THREE.MathUtils.clamp(targetRatio, 0.1, 0.8)
  const root = original.clone(true)
  const modifier = new SimplifyModifier()
  let simplifiedMeshes = 0
  let skippedMeshes = 0
  root.traverse((child) => {
    if (child instanceof THREE.Light) child.visible = false
    if (!(child instanceof THREE.Mesh)) return
    if (!canSimplify(child)) {
      skippedMeshes += 1
      return
    }
    const sourceGeometry = child.geometry
    const positionCount = sourceGeometry.getAttribute('position').count
    const removeCount = Math.min(Math.floor(positionCount * (1 - ratio)), Math.max(positionCount - 12, 0))
    if (removeCount <= 0) {
      skippedMeshes += 1
      return
    }
    try {
      const simplified = modifier.modify(sourceGeometry.clone(), removeCount)
      if (geometryTriangles(simplified) >= geometryTriangles(sourceGeometry)) {
        simplified.dispose()
        skippedMeshes += 1
        return
      }
      simplified.computeVertexNormals()
      child.geometry = simplified
      simplifiedMeshes += 1
    } catch {
      skippedMeshes += 1
    }
  })
  return {
    root,
    report: {
      originalTriangles: objectTriangles(original),
      previewTriangles: objectTriangles(root),
      simplifiedMeshes,
      skippedMeshes
    }
  }
}

export function markImportedVariant(root, quality) {
  root.userData.importedQuality = quality
}

/** 切换原模型 / 轻量模型显隐，返回实际生效的精度。 */
export function setImportedVariantVisibility(container, requestedQuality) {
  const variants = container.children.filter(
    (child) =>
      child.userData.importedQuality === 'original' || child.userData.importedQuality === 'lightweight'
  )
  const hasLightweight = variants.some((child) => child.userData.importedQuality === 'lightweight')
  const resolved = requestedQuality === 'lightweight' && hasLightweight ? 'lightweight' : 'original'
  for (const variant of variants) variant.visible = variant.userData.importedQuality === resolved
  return resolved
}

/** 导出时克隆指定精度的模型，只保留一个变体。 */
export function cloneImportedVariant(container, requestedQuality) {
  const clone = container.clone(true)
  const resolved = setImportedVariantVisibility(clone, requestedQuality)
  for (const child of [...clone.children]) {
    if (
      (child.userData.importedQuality === 'original' || child.userData.importedQuality === 'lightweight') &&
      child.userData.importedQuality !== resolved
    ) {
      clone.remove(child)
    }
  }
  return clone
}

/**
 * 评估导入模型的性能风险等级。
 *
 * 阈值参考实际编辑体验：超过 50 万面在普通笔记本上开始明显掉帧，
 * 超过 200 万面则连选中都卡顿。
 */
export function assessModelPerformanceRisk(report) {
  if (!report) return null
  const triangles = report.triangleCount ?? 0
  if (triangles >= 2_000_000) {
    return {
      level: 'high',
      message: `模型约 ${triangles.toLocaleString()} 个三角面，编辑会明显变慢，建议使用轻量预览。`,
      suggestedRatio: 0.2
    }
  }
  if (triangles >= 500_000) {
    return {
      level: 'medium',
      message: `模型约 ${triangles.toLocaleString()} 个三角面，复杂视角下可能掉帧，可选择轻量预览。`,
      suggestedRatio: 0.4
    }
  }
  return {
    level: 'low',
    message: `模型约 ${triangles.toLocaleString()} 个三角面，可以按原始精度编辑。`,
    suggestedRatio: 0.6
  }
}
