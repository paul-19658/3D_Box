/**
 * 导入 / 导出模型。移植自 `import-export/model-io.ts`。
 *
 * 支持：
 * - 导入 GLB / GLTF / OBJ（GLTF/OBJ 的外部依赖需要用户一并选中）；
 * - 导出 GLB / 内嵌资源 GLTF / OBJ。
 *
 * 导入后会分析模型并生成报告（网格数、三角面数、材质数、包围盒等），
 * 报告会进入工程文件，用于性能风险提示与轻量预览决策。
 */

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js'
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js'

/**
 * 把导入的根节点归一化到"最长边为 1"的单位空间。
 *
 * 这样做的原因：外部模型尺寸差异极大（从 0.01 到 1000 米），
 * 统一归一化后，用户的"尺寸"参数才有稳定含义。
 */
export function normalizeImportedRoot(root) {
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  if (bounds.isEmpty()) return root
  const size = bounds.getSize(new THREE.Vector3())
  const longest = Math.max(size.x, size.y, size.z, 1e-6)
  const scale = 1 / longest
  const center = bounds.getCenter(new THREE.Vector3())

  const wrapper = new THREE.Group()
  root.position.sub(center)
  root.scale.multiplyScalar(scale)
  wrapper.add(root)
  wrapper.updateMatrixWorld(true)
  return wrapper
}

/** 分析模型，生成可存入工程文件的报告。 */
export function analyzeModel(root) {
  let meshCount = 0
  let triangleCount = 0
  let materialCount = 0
  let textureCount = 0
  let cameraCount = 0
  let lightCount = 0
  const materials = new Set()
  const textures = new Set()

  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      meshCount += 1
      const geometry = child.geometry
      const count = geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count
      triangleCount += Math.floor((count ?? 0) / 3)
      for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
        if (!material || materials.has(material)) continue
        materials.add(material)
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value)
        }
      }
    }
    if (child instanceof THREE.Camera) cameraCount += 1
    if (child instanceof THREE.Light) lightCount += 1
  })

  materialCount = materials.size
  textureCount = textures.size
  const bounds = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3())
  const issues = []
  if (triangleCount > 800_000) {
    issues.push({
      severity: 'warning',
      message: `模型包含 ${triangleCount.toLocaleString()} 个三角面，编辑可能变慢。可切换轻量预览。`
    })
  }
  if (meshCount === 0) {
    issues.push({ severity: 'error', message: '模型里没有可显示的网格。' })
  }
  if (textureCount > 0) {
    issues.push({ severity: 'info', message: `模型使用 ${textureCount} 张纹理，已一并保存。` })
  }

  return {
    meshCount,
    triangleCount,
    materialCount,
    textureCount,
    cameraCount,
    lightCount,
    bounds: { x: bounds.x, y: bounds.y, z: bounds.z },
    issues
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

function textToBase64(text) {
  return btoa(unescape(encodeURIComponent(text)))
}

/**
 * 导入静态模型。
 *
 * @param {ArrayBuffer|string} data 主文件内容
 * @param {'glb'|'gltf'|'obj'} format
 * @param {Array<{name:string, data:ArrayBuffer|string}>} resources 关联文件（.bin / 纹理 / .mtl）
 */
export async function importStaticModel(data, format, resources = []) {
  if (format === 'obj') {
    const objText = typeof data === 'string' ? data : new TextDecoder().decode(data)
    const mtl = resources.find((item) => item.name.toLowerCase().endsWith('.mtl'))
    const loader = new OBJLoader()
    if (mtl) {
      const mtlText = typeof mtl.data === 'string' ? mtl.data : new TextDecoder().decode(mtl.data)
      const materialCreator = new MTLLoader().parse(mtlText, '')
      materialCreator.preload()
      loader.setMaterials(materialCreator)
    }
    return loader.parse(objText)
  }

  const loader = new GLTFLoader()
  const resourceMap = new Map(
    resources.map((item) => [item.name, typeof item.data === 'string' ? item.data : item.data])
  )
  const baseUrl = ''
  const originalFetch = globalThis.fetch
  // GLTFLoader 通过 URL 请求外部依赖，这里拦截并改为从已选文件里取，
  // 避免要求用户把模型和纹理放到同一目录并跑一个本地服务器。
  globalThis.fetch = async (url, options) => {
    const name = String(url).split('/').pop()
    if (resourceMap.has(name)) {
      const content = resourceMap.get(name)
      return new Response(content, { status: 200 })
    }
    return originalFetch(url, options)
  }
  try {
    const result = await loader.parseAsync(typeof data === 'string' ? data : data, baseUrl)
    return result.scene
  } finally {
    globalThis.fetch = originalFetch
  }
}

/** 导出静态模型。返回 { data, report, format }。 */
export async function exportStaticModel(root, format) {
  const report = analyzeModel(root)
  if (format === 'obj') {
    return { data: new OBJExporter().parse(root), report, format }
  }

  const exporter = new GLTFExporter()
  const isGlb = format === 'glb'
  const result = await exporter.parseAsync(root, {
    binary: isGlb,
    embedImages: !isGlb,
    onlyVisible: true
  })
  if (isGlb) {
    return { data: result, report, format }
  }
  return {
    data: JSON.stringify(result, null, 2),
    report,
    format
  }
}

export function base64ForModel(exported) {
  if (exported.data instanceof ArrayBuffer) return arrayBufferToBase64(exported.data)
  return textToBase64(exported.data)
}
