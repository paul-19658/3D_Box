import { APP_VERSION } from './app-meta'

/**
 * schema 19：场景新增 `poseLibrary`（姿势库：命名保存的完整人台关节表）。
 *
 * Web 版把人台整套关节角度命名保存在工程里，随时一键切回。
 * 本 Electron 版**只同步版本号与类型**，不实现姿势库界面；
 * 打开 Web 版工程时该字段原样透传（`parseProjectDocument` 只校验
 * objects / camera / lighting / timeline，其余字段不丢）。
 *
 * schema 18：导入模型在工程里新增 `importedAsset.files`（**文件引用**）。
 *
 * Web 版（`web/frontend/src/core/project-document.js`）把导入模型的主文件与
 * 依赖资源上传到 `exports` 目录，工程里只记文件名，重新打开时按引用取回。
 * 本 Electron 版仍然把模型内嵌进工程（`primaryData` / `encoding`），
 * 这里**只同步版本号**，不改内嵌的读写路径，也不认识 `files`——
 * 打开 Web 版工程时该物体仍然只保留 format / sourceName / report。
 *
 * schema 15：相机新增 `lookAtEnabled`（看向绑定是否启用）。
 *
 * schema 14：相机新增可空的 `targetObjectId`（把看向点绑定到某个物体并跟随）。
 *
 * 注意：本文件此前停在 12，而 `web/frontend/src/core/project-document.js`
 * 与 `web/backend/app/models/project.py` 已经是 13（新增 `kind: 'path'` 导航线）。
 * 三端版本号必须一致，否则同一份工程在不同端的校验结果会分叉。
 */
export const PROJECT_SCHEMA_VERSION = 19 as const
export const PROJECT_EXTENSION = 'block3d'

export type PrimitiveKind =
  'box' | 'cylinder' | 'sphere' | 'wall' | 'floor' | 'custom' | 'imported' | 'mannequin'
export type BasicPrimitiveKind = 'box' | 'cylinder' | 'sphere' | 'wall' | 'floor'
export type ObjectDisplayMode = 'solid' | 'transparent' | 'wireframe'
export type ImportedModelFormat = 'glb' | 'gltf' | 'obj'
export type ImportedModelQuality = 'original' | 'lightweight'

export interface Vector2Value {
  x: number
  y: number
}

export interface Vector3Value {
  x: number
  y: number
  z: number
}

export interface CustomProfileData {
  points: Vector2Value[]
  topPoints?: Vector2Value[]
}

export type CustomMeshEdge = [number, number]

export interface CustomMeshData {
  vertices: Vector3Value[]
  edges: CustomMeshEdge[]
  faces: number[][]
}

export interface MeshCutData {
  normal: Vector3Value
  offset: number
  keep: 'positive' | 'negative'
}

export interface StoredModelIssue {
  severity: 'info' | 'warning' | 'error'
  message: string
}

export interface StoredModelReport {
  meshCount: number
  triangleCount: number
  materialCount: number
  textureCount: number
  cameraCount: number
  lightCount: number
  bounds: Vector3Value
  issues: StoredModelIssue[]
}

export interface ImportedModelResource {
  name: string
  dataBase64: string
  mimeType?: string
}

export interface ImportedModelAsset {
  format: ImportedModelFormat
  sourceName: string
  primaryData: string
  encoding: 'base64' | 'text'
  resources?: ImportedModelResource[]
  report: StoredModelReport
}

export const MANNEQUIN_JOINT_IDS = [
  'head',
  'spine',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftHip',
  'rightHip',
  'leftKnee',
  'rightKnee'
] as const

export type MannequinJointId = (typeof MANNEQUIN_JOINT_IDS)[number]
export type MannequinPose = Record<MannequinJointId, Vector3Value>

export const MANNEQUIN_PRESET_IDS = ['stand', 'sit', 'raise-hand', 'walk', 'run'] as const
export type MannequinPresetId = (typeof MANNEQUIN_PRESET_IDS)[number]

export interface MannequinData {
  heightMeters: number
  pose: MannequinPose
  presetId?: MannequinPresetId
  manualJoints?: MannequinJointId[]
}

export interface SceneObjectData {
  id: string
  kind: PrimitiveKind
  name: string
  /** 用户填写的物体说明，例如“这是一个正方形的冰箱”。用于导出场景说明并交给 AI 参考。 */
  description?: string
  position: Vector3Value
  rotation: Vector3Value
  size: Vector3Value
  color: string
  colorOverride?: string
  faceColors?: Record<string, string>
  displayMode?: ObjectDisplayMode
  visible: boolean
  locked: boolean
  groupId?: string
  customMesh?: CustomMeshData
  /** Kept only while opening projects created before schema version 8. */
  customProfile?: CustomProfileData
  cuts?: MeshCutData[]
  importedAsset?: ImportedModelAsset
  useImportedLights?: boolean
  previewQuality?: ImportedModelQuality
  exportQuality?: ImportedModelQuality
  mannequin?: MannequinData
}

export interface CameraState {
  position: Vector3Value
  target: Vector3Value
  fovDegrees: number
  aspectWidth: number
  aspectHeight: number
  /**
   * schema 14：把"看向点"绑定到场景里的某个物体，相机会锁定并跟随它移动。
   * `null` 表示看向点就是上面的静态 `target` 坐标。
   */
  targetObjectId?: string | null
  /**
   * schema 15：看向绑定是否启用。关掉后相机改用静态 `target`，但绑定关系保留。
   * 缺省视为 `true`（v14 及更早的工程没有这个字段）。
   */
  lookAtEnabled?: boolean
}

export type SceneLightKind = 'point' | 'spot' | 'area' | 'sun'

export interface SceneLightData {
  id: string
  name: string
  kind: SceneLightKind
  position: Vector3Value
  target: Vector3Value
  color: string
  intensity: number
  size: number
  angleDegrees: number
  visible: boolean
  locked: boolean
}

export interface SceneLightingState {
  lights: SceneLightData[]
}

export type CameraTransition = 'smooth' | 'cut'

export interface CameraShotNode {
  id: string
  name: string
  timeSeconds: number
  transition: CameraTransition
  camera: CameraState
}

export type ObjectInterpolation = 'smooth' | 'linear'

export interface ObjectTransformState {
  position: Vector3Value
  rotation: Vector3Value
  size: Vector3Value
  mannequinPose?: MannequinPose
  mannequinPresetId?: MannequinPresetId
  mannequinManualJoints?: MannequinJointId[]
  mannequinPresetBlend?: {
    from?: MannequinPresetId
    to?: MannequinPresetId
    amount: number
  }
}

export interface ObjectKeyframeNode {
  id: string
  objectId: string
  timeSeconds: number
  interpolation: ObjectInterpolation
  transform: ObjectTransformState
}

export interface TimelineState {
  durationSeconds: number
  cameraShots: CameraShotNode[]
  objectKeyframes: ObjectKeyframeNode[]
}

/**
 * 姿势库条目（schema 19）。
 *
 * `pose` 是**完整**关节表：应用时 `presetId` 会被置为 null、全部关节都由这份
 * pose 驱动，缺一个关节就会让那个部位掉回中立角度。
 */
export interface PoseLibraryEntry {
  id: string
  name: string
  pose: MannequinPose
  createdAt: string
}

export const DEFAULT_CAMERA: CameraState = {
  position: { x: 7.5, y: 5.5, z: 8.5 },
  target: { x: 0, y: 1, z: 0 },
  fovDegrees: 42,
  aspectWidth: 16,
  aspectHeight: 9,
  targetObjectId: null,
  lookAtEnabled: true
}

export const DEFAULT_LIGHTING: SceneLightingState = {
  lights: [
    {
      id: 'light-main',
      name: '柔和主光',
      kind: 'area',
      position: { x: 6, y: 10, z: 5 },
      target: { x: 0, y: 1, z: 0 },
      color: '#fffaf1',
      intensity: 2.8,
      size: 4,
      angleDegrees: 45,
      visible: true,
      locked: false
    }
  ]
}

export const DEFAULT_TIMELINE: TimelineState = {
  durationSeconds: 5,
  cameraShots: [],
  objectKeyframes: []
}

export interface ProjectDocument {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  appVersion: string
  savedAt: string
  name: string
  scene: {
    objects: SceneObjectData[]
    camera: CameraState
    lighting: SceneLightingState
    timeline: TimelineState
    /** schema 19：姿势库。缺省视为空（v18 及更早的工程没有这个字段）。 */
    poseLibrary?: PoseLibraryEntry[]
  }
}

export interface ProjectContentInput {
  name: string
  objects: SceneObjectData[]
  camera: CameraState
  lighting: SceneLightingState
  timeline: TimelineState
  poseLibrary?: PoseLibraryEntry[]
}

export function createProjectDocument(input: ProjectContentInput): ProjectDocument {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    savedAt: new Date().toISOString(),
    name: input.name.trim() || '未命名场景',
    scene: {
      objects: input.objects,
      camera: input.camera,
      lighting: input.lighting,
      timeline: input.timeline,
      poseLibrary: input.poseLibrary ?? []
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVector2(value: unknown): value is Vector2Value {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y)
}

function isVector3(value: unknown): value is Vector3Value {
  return (
    isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
  )
}

function isMannequinPose(value: unknown): value is MannequinPose {
  return (
    isRecord(value) &&
    MANNEQUIN_JOINT_IDS.every(
      (jointId) =>
        isVector3(value[jointId]) &&
        Math.abs(value[jointId].x) <= 180 &&
        Math.abs(value[jointId].y) <= 180 &&
        Math.abs(value[jointId].z) <= 180
    )
  )
}

function isMannequinData(value: unknown): value is MannequinData {
  return (
    isRecord(value) &&
    isFiniteNumber(value.heightMeters) &&
    value.heightMeters >= 1.2 &&
    value.heightMeters <= 2.2 &&
    isMannequinPose(value.pose) &&
    (value.presetId === undefined ||
      MANNEQUIN_PRESET_IDS.includes(value.presetId as MannequinPresetId)) &&
    (value.manualJoints === undefined || isMannequinJointList(value.manualJoints))
  )
}

function isMannequinJointList(value: unknown): value is MannequinJointId[] {
  return (
    Array.isArray(value) &&
    value.length <= MANNEQUIN_JOINT_IDS.length &&
    value.every((jointId) => MANNEQUIN_JOINT_IDS.includes(jointId as MannequinJointId)) &&
    new Set(value).size === value.length
  )
}

function isColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function isFaceColors(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return (
    entries.length <= 1_000_000 &&
    entries.every(([key, color]) => /^\d+:\d+$/.test(key) && isColor(color))
  )
}

function isCustomProfile(value: unknown): value is CustomProfileData {
  return (
    isRecord(value) &&
    Array.isArray(value.points) &&
    value.points.length >= 3 &&
    value.points.length <= 64 &&
    value.points.every(isVector2) &&
    (value.topPoints === undefined ||
      (Array.isArray(value.topPoints) &&
        value.topPoints.length === value.points.length &&
        value.topPoints.every(isVector2)))
  )
}

function edgeKey(first: number, second: number): string {
  return first < second ? `${first}:${second}` : `${second}:${first}`
}

function isCustomMesh(value: unknown): value is CustomMeshData {
  if (
    !isRecord(value) ||
    !Array.isArray(value.vertices) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.faces) ||
    value.vertices.length < 3 ||
    value.vertices.length > 4096 ||
    value.edges.length > 8192 ||
    value.faces.length < 1 ||
    value.faces.length > 4096 ||
    !value.vertices.every(isVector3)
  ) {
    return false
  }

  const vertexCount = value.vertices.length
  const edgeKeys = new Set<string>()
  for (const edge of value.edges) {
    if (
      !Array.isArray(edge) ||
      edge.length !== 2 ||
      !Number.isInteger(edge[0]) ||
      !Number.isInteger(edge[1]) ||
      edge[0] < 0 ||
      edge[1] < 0 ||
      edge[0] >= vertexCount ||
      edge[1] >= vertexCount ||
      edge[0] === edge[1]
    ) {
      return false
    }
    const key = edgeKey(edge[0], edge[1])
    if (edgeKeys.has(key)) return false
    edgeKeys.add(key)
  }

  return value.faces.every((face) => {
    if (
      !Array.isArray(face) ||
      face.length < 3 ||
      face.length > 256 ||
      !face.every(
        (vertexIndex) =>
          Number.isInteger(vertexIndex) && vertexIndex >= 0 && vertexIndex < vertexCount
      ) ||
      new Set(face).size !== face.length
    ) {
      return false
    }
    return face.every((vertexIndex, index) =>
      edgeKeys.has(edgeKey(vertexIndex, face[(index + 1) % face.length]))
    )
  })
}

function addMeshEdge(edges: CustomMeshEdge[], first: number, second: number): void {
  if (first === second) return
  const key = edgeKey(first, second)
  if (edges.some(([start, end]) => edgeKey(start, end) === key)) return
  edges.push([first, second])
}

function cleanFaceLoop(indices: number[]): number[] {
  const cleaned = indices.filter((index, position) => index !== indices[position - 1])
  if (cleaned.length > 1 && cleaned[0] === cleaned.at(-1)) cleaned.pop()
  return new Set(cleaned).size >= 3 ? cleaned : []
}

export function customProfileToMesh(profile: CustomProfileData): CustomMeshData {
  const vertices: Vector3Value[] = profile.points.map((point) => ({
    x: point.x,
    y: -0.5,
    z: -point.y
  }))
  const topPoints = profile.topPoints ?? profile.points
  const topIndices = topPoints.map((point) => {
    const candidate = { x: point.x, y: 0.5, z: -point.y }
    const existing = vertices.findIndex(
      (vertex) =>
        Math.abs(vertex.x - candidate.x) <= 1e-8 &&
        Math.abs(vertex.y - candidate.y) <= 1e-8 &&
        Math.abs(vertex.z - candidate.z) <= 1e-8
    )
    if (existing >= 0) return existing
    vertices.push(candidate)
    return vertices.length - 1
  })
  const bottomIndices = profile.points.map((_, index) => index)
  const edges: CustomMeshEdge[] = []
  const faces: number[][] = []

  for (let index = 0; index < bottomIndices.length; index += 1) {
    const next = (index + 1) % bottomIndices.length
    addMeshEdge(edges, bottomIndices[index], bottomIndices[next])
    addMeshEdge(edges, topIndices[index], topIndices[next])
    addMeshEdge(edges, bottomIndices[index], topIndices[index])
    const side = cleanFaceLoop([
      bottomIndices[index],
      bottomIndices[next],
      topIndices[next],
      topIndices[index]
    ])
    if (side.length >= 3) faces.push(side)
  }

  faces.unshift([...bottomIndices].reverse())
  const topFace = cleanFaceLoop(topIndices)
  if (topFace.length >= 3) faces.push(topFace)
  for (const face of faces) {
    face.forEach((vertexIndex, index) =>
      addMeshEdge(edges, vertexIndex, face[(index + 1) % face.length])
    )
  }
  return { vertices, edges, faces }
}

function migrateCustomObjects(objects: SceneObjectData[]): SceneObjectData[] {
  return objects.map((object) => {
    if (object.kind !== 'custom' || object.customMesh || !object.customProfile) return object
    const { customProfile, ...rest } = object
    return { ...rest, customMesh: customProfileToMesh(customProfile) }
  })
}

function isMeshCut(value: unknown): value is MeshCutData {
  if (!isRecord(value) || !isVector3(value.normal) || !isFiniteNumber(value.offset)) return false
  const length = Math.hypot(value.normal.x, value.normal.y, value.normal.z)
  return (
    length > 0.99 &&
    length < 1.01 &&
    Math.abs(value.offset) <= 1_000_000 &&
    (value.keep === 'positive' || value.keep === 'negative')
  )
}

function isStoredReport(value: unknown): value is StoredModelReport {
  return (
    isRecord(value) &&
    isFiniteNumber(value.meshCount) &&
    isFiniteNumber(value.triangleCount) &&
    isFiniteNumber(value.materialCount) &&
    isFiniteNumber(value.textureCount) &&
    isFiniteNumber(value.cameraCount) &&
    isFiniteNumber(value.lightCount) &&
    isVector3(value.bounds) &&
    Array.isArray(value.issues) &&
    value.issues.every(
      (issue) =>
        isRecord(issue) &&
        (issue.severity === 'info' || issue.severity === 'warning' || issue.severity === 'error') &&
        typeof issue.message === 'string'
    )
  )
}

function isImportedAsset(value: unknown): value is ImportedModelAsset {
  return (
    isRecord(value) &&
    (value.format === 'glb' || value.format === 'gltf' || value.format === 'obj') &&
    typeof value.sourceName === 'string' &&
    value.sourceName.length > 0 &&
    typeof value.primaryData === 'string' &&
    (value.encoding === 'base64' || value.encoding === 'text') &&
    (value.resources === undefined ||
      (Array.isArray(value.resources) &&
        value.resources.every(
          (resource) =>
            isRecord(resource) &&
            typeof resource.name === 'string' &&
            typeof resource.dataBase64 === 'string' &&
            (resource.mimeType === undefined || typeof resource.mimeType === 'string')
        ))) &&
    isStoredReport(value.report)
  )
}

function isSceneObject(value: unknown, allowLegacyCustom = false): value is SceneObjectData {
  if (!isRecord(value)) return false
  const kind = value.kind
  const commonValid =
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    (kind === 'box' ||
      kind === 'cylinder' ||
      kind === 'sphere' ||
      kind === 'wall' ||
      kind === 'floor' ||
      kind === 'custom' ||
      kind === 'imported' ||
      kind === 'mannequin') &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    isVector3(value.position) &&
    isVector3(value.rotation) &&
    isVector3(value.size) &&
    value.size.x > 0 &&
    value.size.y > 0 &&
    value.size.z > 0 &&
    isColor(value.color) &&
    (value.colorOverride === undefined || isColor(value.colorOverride)) &&
    (value.faceColors === undefined || isFaceColors(value.faceColors)) &&
    (value.displayMode === undefined ||
      value.displayMode === 'solid' ||
      value.displayMode === 'transparent' ||
      value.displayMode === 'wireframe') &&
    typeof value.visible === 'boolean' &&
    typeof value.locked === 'boolean' &&
    (value.groupId === undefined || typeof value.groupId === 'string') &&
    (value.description === undefined ||
      (typeof value.description === 'string' && value.description.length <= 2000)) &&
    (value.cuts === undefined ||
      (Array.isArray(value.cuts) && value.cuts.length <= 12 && value.cuts.every(isMeshCut))) &&
    (value.useImportedLights === undefined || typeof value.useImportedLights === 'boolean') &&
    (value.previewQuality === undefined ||
      value.previewQuality === 'original' ||
      value.previewQuality === 'lightweight') &&
    (value.exportQuality === undefined ||
      value.exportQuality === 'original' ||
      value.exportQuality === 'lightweight')

  if (!commonValid) return false
  if (kind === 'custom') {
    return (
      isCustomMesh(value.customMesh) || (allowLegacyCustom && isCustomProfile(value.customProfile))
    )
  }
  if (kind === 'imported') return isImportedAsset(value.importedAsset)
  if (kind === 'mannequin') {
    const size = value.size as Vector3Value
    return (
      isMannequinData(value.mannequin) &&
      Math.abs(size.x - value.mannequin.heightMeters) < 1e-6 &&
      Math.abs(size.y - value.mannequin.heightMeters) < 1e-6 &&
      Math.abs(size.z - value.mannequin.heightMeters) < 1e-6
    )
  }
  return true
}

function isCamera(value: unknown): value is CameraState {
  return (
    isRecord(value) &&
    isVector3(value.position) &&
    isVector3(value.target) &&
    isFiniteNumber(value.fovDegrees) &&
    value.fovDegrees >= 10 &&
    value.fovDegrees <= 120 &&
    isFiniteNumber(value.aspectWidth) &&
    value.aspectWidth > 0 &&
    value.aspectWidth <= 100 &&
    isFiniteNumber(value.aspectHeight) &&
    value.aspectHeight > 0 &&
    value.aspectHeight <= 100 &&
    /*
     * `targetObjectId` 允许缺省（v13 及更早的工程没有这个字段），
     * 但一旦存在必须是 null 或非空字符串——空字符串会让"是否绑定"
     * 出现第三种状态，与另外两端的归一规则不一致。
     */
    (value.targetObjectId === undefined ||
      value.targetObjectId === null ||
      (typeof value.targetObjectId === 'string' && value.targetObjectId.length > 0)) &&
    // `lookAtEnabled` 允许缺省（v14 及更早的工程没有），存在时必须是布尔。
    (value.lookAtEnabled === undefined || typeof value.lookAtEnabled === 'boolean')
  )
}

function isSceneLight(value: unknown): value is SceneLightData {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.kind === 'point' ||
      value.kind === 'spot' ||
      value.kind === 'area' ||
      value.kind === 'sun') &&
    isVector3(value.position) &&
    isVector3(value.target) &&
    isColor(value.color) &&
    isFiniteNumber(value.intensity) &&
    value.intensity >= 0 &&
    value.intensity <= 20 &&
    isFiniteNumber(value.size) &&
    value.size > 0 &&
    value.size <= 100 &&
    isFiniteNumber(value.angleDegrees) &&
    value.angleDegrees >= 1 &&
    value.angleDegrees <= 180 &&
    typeof value.visible === 'boolean' &&
    typeof value.locked === 'boolean'
  )
}

function isLighting(value: unknown): value is SceneLightingState {
  return (
    isRecord(value) &&
    Array.isArray(value.lights) &&
    value.lights.length <= 32 &&
    value.lights.every(isSceneLight)
  )
}

function isCameraShot(value: unknown): value is CameraShotNode {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    isFiniteNumber(value.timeSeconds) &&
    value.timeSeconds >= 0 &&
    value.timeSeconds <= 3600 &&
    (value.transition === 'smooth' || value.transition === 'cut') &&
    isCamera(value.camera)
  )
}

function isObjectKeyframe(value: unknown): value is ObjectKeyframeNode {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.objectId === 'string' &&
    value.objectId.length > 0 &&
    isFiniteNumber(value.timeSeconds) &&
    value.timeSeconds >= 0 &&
    value.timeSeconds <= 3600 &&
    (value.interpolation === 'smooth' || value.interpolation === 'linear') &&
    isRecord(value.transform) &&
    isVector3(value.transform.position) &&
    isVector3(value.transform.rotation) &&
    isVector3(value.transform.size) &&
    value.transform.size.x > 0 &&
    value.transform.size.y > 0 &&
    value.transform.size.z > 0 &&
    (value.transform.mannequinPose === undefined ||
      isMannequinPose(value.transform.mannequinPose)) &&
    (value.transform.mannequinPresetId === undefined ||
      MANNEQUIN_PRESET_IDS.includes(value.transform.mannequinPresetId as MannequinPresetId)) &&
    (value.transform.mannequinManualJoints === undefined ||
      isMannequinJointList(value.transform.mannequinManualJoints))
  )
}

interface LegacyTimelineState {
  durationSeconds: number
  cameraShots: CameraShotNode[]
  objectKeyframes?: unknown
}

function isLegacyTimeline(value: unknown): value is LegacyTimelineState {
  if (!isRecord(value)) return false
  const durationSeconds = value.durationSeconds
  const cameraShots = value.cameraShots
  if (
    !isFiniteNumber(durationSeconds) ||
    durationSeconds < 1 ||
    durationSeconds > 3600 ||
    !Array.isArray(cameraShots) ||
    cameraShots.length > 200 ||
    !cameraShots.every(isCameraShot)
  ) {
    return false
  }
  const shotIds = new Set(cameraShots.map((shot) => shot.id))
  return (
    shotIds.size === cameraShots.length &&
    cameraShots.every((shot) => shot.timeSeconds <= durationSeconds)
  )
}

function isTimeline(value: unknown): value is TimelineState {
  if (!isLegacyTimeline(value)) return false
  const objectKeyframes = value.objectKeyframes
  if (
    !Array.isArray(objectKeyframes) ||
    objectKeyframes.length > 1000 ||
    !objectKeyframes.every(isObjectKeyframe)
  ) {
    return false
  }
  const keyframeIds = new Set(objectKeyframes.map((keyframe) => keyframe.id))
  const trackTimes = new Set(
    objectKeyframes.map((keyframe) => `${keyframe.objectId}\u0000${keyframe.timeSeconds}`)
  )
  return (
    keyframeIds.size === objectKeyframes.length &&
    trackTimes.size === objectKeyframes.length &&
    objectKeyframes.every((keyframe) => keyframe.timeSeconds <= value.durationSeconds)
  )
}

interface LegacyLighting {
  keyIntensity: number
  keyColor: string
  keyPosition: Vector3Value
}

function isLegacyLighting(value: unknown): value is LegacyLighting {
  return (
    isRecord(value) &&
    isFiniteNumber(value.keyIntensity) &&
    value.keyIntensity >= 0 &&
    value.keyIntensity <= 20 &&
    isColor(value.keyColor) &&
    isVector3(value.keyPosition)
  )
}

function migratedCamera(camera: Record<string, unknown>): CameraState {
  return {
    position: camera.position as Vector3Value,
    target: camera.target as Vector3Value,
    fovDegrees: isFiniteNumber(camera.fovDegrees) ? camera.fovDegrees : DEFAULT_CAMERA.fovDegrees,
    aspectWidth: DEFAULT_CAMERA.aspectWidth,
    aspectHeight: DEFAULT_CAMERA.aspectHeight,
    // schema 14 新增：老工程没有这个字段，一律补 null（= 看向静态 target）。
    targetObjectId: normalizeTargetObjectId(camera.targetObjectId),
    // schema 15 新增：缺省视为启用（老工程"一绑就生效"）。
    lookAtEnabled: camera.lookAtEnabled !== false
  }
}

/**
 * 把 `targetObjectId` 归一成 `string | null`。
 *
 * 空字符串既不是"未绑定"也不是合法 id，统一变成 `null`，
 * 保证"是否绑定"只有两种状态——三端必须用同一条规则。
 */
function normalizeTargetObjectId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

function migratedLighting(lighting: unknown): SceneLightingState {
  if (!isLegacyLighting(lighting)) return structuredClone(DEFAULT_LIGHTING)
  return {
    lights: [
      {
        ...structuredClone(DEFAULT_LIGHTING.lights[0]),
        intensity: lighting.keyIntensity,
        color: lighting.keyColor,
        position: lighting.keyPosition
      }
    ]
  }
}

function migrateLegacyProject(value: Record<string, unknown>): ProjectDocument {
  if (
    typeof value.appVersion !== 'string' ||
    typeof value.savedAt !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.scene) ||
    !Array.isArray(value.scene.objects) ||
    !value.scene.objects.every((object) => isSceneObject(object, true)) ||
    !isRecord(value.scene.camera) ||
    !isVector3(value.scene.camera.position) ||
    !isVector3(value.scene.camera.target)
  ) {
    throw new Error('工程内容不完整或包含无效数据。')
  }

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: value.appVersion,
    savedAt: value.savedAt,
    name: value.name,
    scene: {
      objects: migrateCustomObjects(value.scene.objects),
      camera: migratedCamera(value.scene.camera),
      lighting: migratedLighting(value.scene.lighting),
      timeline: structuredClone(DEFAULT_TIMELINE)
    }
  }
}

function migrateV3Project(value: Record<string, unknown>): ProjectDocument {
  if (
    typeof value.appVersion !== 'string' ||
    typeof value.savedAt !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.scene) ||
    !Array.isArray(value.scene.objects) ||
    !value.scene.objects.every((object) => isSceneObject(object, true)) ||
    !isCamera(value.scene.camera) ||
    !isLighting(value.scene.lighting)
  ) {
    throw new Error('工程内容不完整或包含无效数据。')
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: value.appVersion,
    savedAt: value.savedAt,
    name: value.name,
    scene: {
      objects: migrateCustomObjects(value.scene.objects),
      camera: value.scene.camera,
      lighting: value.scene.lighting,
      timeline: structuredClone(DEFAULT_TIMELINE)
    }
  }
}

function migrateV4OrV5Project(value: Record<string, unknown>): ProjectDocument {
  if (
    typeof value.appVersion !== 'string' ||
    typeof value.savedAt !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.scene) ||
    !Array.isArray(value.scene.objects) ||
    !value.scene.objects.every((object) => isSceneObject(object, true)) ||
    !isCamera(value.scene.camera) ||
    !isLighting(value.scene.lighting) ||
    !isLegacyTimeline(value.scene.timeline)
  ) {
    throw new Error('工程内容不完整或包含无效数据。')
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: value.appVersion,
    savedAt: value.savedAt,
    name: value.name,
    scene: {
      objects: migrateCustomObjects(value.scene.objects),
      camera: value.scene.camera,
      lighting: value.scene.lighting,
      timeline: {
        durationSeconds: value.scene.timeline.durationSeconds,
        cameraShots: value.scene.timeline.cameraShots,
        objectKeyframes: []
      }
    }
  }
}

function migrateV6ToV11Project(value: Record<string, unknown>): ProjectDocument {
  if (
    typeof value.appVersion !== 'string' ||
    typeof value.savedAt !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.scene) ||
    !Array.isArray(value.scene.objects) ||
    !value.scene.objects.every((object) => isSceneObject(object, true)) ||
    !isCamera(value.scene.camera) ||
    !isLighting(value.scene.lighting) ||
    !isTimeline(value.scene.timeline)
  ) {
    throw new Error('工程内容不完整或包含无效数据。')
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: value.appVersion,
    savedAt: value.savedAt,
    name: value.name,
    scene: {
      ...(value.scene as unknown as ProjectDocument['scene']),
      objects: migrateCustomObjects(value.scene.objects)
    }
  }
}

export function parseProjectDocument(source: string): ProjectDocument {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('工程文件无法读取，文件内容可能已经损坏。')
  }

  if (!isRecord(value) || typeof value.schemaVersion !== 'number') {
    throw new Error('工程内容不完整，缺少版本信息。')
  }
  if (value.schemaVersion === 1 || value.schemaVersion === 2) return migrateLegacyProject(value)
  if (value.schemaVersion === 3) return migrateV3Project(value)
  if (value.schemaVersion === 4 || value.schemaVersion === 5) return migrateV4OrV5Project(value)
  if (
    value.schemaVersion === 6 ||
    value.schemaVersion === 7 ||
    value.schemaVersion === 8 ||
    value.schemaVersion === 9 ||
    value.schemaVersion === 10 ||
    value.schemaVersion === 11
  ) {
    return migrateV6ToV11Project(value)
  }
  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new Error(`不支持的工程版本：${String(value.schemaVersion)}。`)
  }
  if (
    typeof value.appVersion !== 'string' ||
    typeof value.savedAt !== 'string' ||
    typeof value.name !== 'string' ||
    !isRecord(value.scene) ||
    !Array.isArray(value.scene.objects) ||
    !value.scene.objects.every((object) => isSceneObject(object)) ||
    !isCamera(value.scene.camera) ||
    !isLighting(value.scene.lighting) ||
    !isTimeline(value.scene.timeline)
  ) {
    throw new Error('工程内容不完整或包含无效数据。')
  }

  const objectIds = new Set(value.scene.objects.map((object) => object.id))
  if (value.scene.timeline.objectKeyframes.some((keyframe) => !objectIds.has(keyframe.objectId))) {
    throw new Error('工程时间轴引用了不存在的对象。')
  }

  return value as unknown as ProjectDocument
}
