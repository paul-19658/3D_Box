/**
 * 工程文档的数据结构与默认值。
 *
 * 本文件是 `app/src/shared/project-document.ts` 的等价实现。
 * 后端 `web/backend/app/models/project.py` 必须有相同字段与校验规则。
 * 修改任意一端都必须同步另外两端，并在 docs/AI_DEV_GUIDE.md 登记。
 */

/**
 * schema 19：场景新增 `poseLibrary`（姿势库）。
 *
 * 语义：用户把人台的整套关节角度命名保存下来，随时一键切回。
 *
 * ```json
 * "poseLibrary": [
 *   {
 *     "id": "…",
 *     "name": "抱臂",
 *     "pose": { "head": { "x": 0, "y": 0, "z": 0 }, "…": {} },
 *     "createdAt": "2026-11-11T08:00:00.000Z"
 *   }
 * ]
 * ```
 *
 * 为什么放在**工程里**而不是浏览器本地存储：姿势是创作内容的一部分，
 * 换台机器打开同一个工程必须还在；放 localStorage 会随缓存清理一起丢。
 *
 * `pose` 存的是**完整**关节表（10 个关节 × 3 轴），缺关节的条目在迁移时补齐，
 * 因为应用姿势时 `presetId` 会被置 null、全部关节都由这份 pose 驱动，
 * 缺一个关节就会让它掉回中立角度。
 *
 * 缺省（v18 及更早）没有这个字段 → 空数组，行为完全不变。
 *
 * schema 18：导入模型新增 `importedAsset.files`（文件引用）。
 *
 * 语义：导入的 glTF / OBJ 不再"只在内存里活着"。主文件与全部依赖资源
 * （`.gltf` 的 `.bin` / 纹理、`.obj` 的 `.mtl` / 纹理）先走
 * `POST /api/exports/upload` 落到用户目录，工程里只记**文件名引用**：
 *
 * ```json
 * "files": {
 *   "main": { "name": "椅子.gltf", "fileName": "椅子.gltf" },
 *   "resources": [{ "name": "scene.bin", "fileName": "scene-1.bin" }]
 * }
 * ```
 *
 * - `name` 是模型**内部引用的原始名**（`.gltf` 的 `buffer.uri` / 纹理 `uri`、
 *   `.obj` 的 `mtllib` 行）——重新解析时要按这个名字交回依赖；
 * - `fileName` 是上传后的服务端文件名。服务端会去重重命名（同名加 `-1` / `-2`），
 *   所以两者可能不同，取文件必须用 `fileName`。
 *
 * 为什么只存引用：模型动辄几十 MB，存 base64 会让**每次保存都重传一遍**、
 * 撤销栈里也各留一份。缺省（v17 及更早）没有这个字段，
 * 老工程照常打开，只是模型恢复不出来（当初也没存文件）。
 *
 * schema 17：修正人台比例。
 *
 * 两处修正（不新增字段，改的是既有字段的取值约定）：
 * 1. 人台 `size` 三个分量统一为身高。以前存 `{ x: 1, y: 身高, z: 1 }`，
 *    而视口按三个分量为根节点缩放 → 人物被竖直拉伸 1.75 倍（又细又长）。
 * 2. 控制骨架的人体比例与包围盒基准修正为"脚底 -0.5、头顶 +0.5、总高 1"，
 *    外观模型按同一基准归一化；以前两套基准不一致，髋关节比画出来的髋部
 *    低了 13% 身高（≈24cm），脚底还陷进地面 8cm。
 * 迁移时把老工程的人台 size 统一即可，其余字段不变。
 *
 * schema 16：场景新增 `background`（全景图背景）。
 *
 * 语义：把等距圆柱全景图当天空盒贴到场景四周，任何机位都像"站在那张图里"。
 * 只存图片的**文件名引用**，图片本身走 `exports/upload` 落到用户目录。
 * 缺省（v15 及更早）为"没有背景"，老工程行为不变。
 *
 * schema 15：相机新增 `lookAtEnabled`（看向绑定是否启用）。
 *
 * 语义：`targetObjectId` 只记着"绑的是谁"，`lookAtEnabled` 决定这一刻用不用它。
 * 关掉后相机改用静态 `target` 坐标，但绑定关系保留，勾回来即可恢复。
 * 缺省（v14 及更早）视为 `true`，老工程行为不变。
 *
 * schema 14：相机新增 `targetObjectId`（把看向点绑定到某个物体并跟随）。
 * schema 13：新增 `kind: 'path'` 的导航线对象。
 *
 * 一路上都是**只加字段、不改语义**，所以老工程永远能原样打开。
 */
export const PROJECT_SCHEMA_VERSION = 19
export const PROJECT_EXTENSION = 'block3d'

/** 场景里可作为"物体"存在的类型。导航线也是物体，因此也在这里。 */
export const OBJECT_KINDS = [
  'box',
  'cylinder',
  'sphere',
  'wall',
  'floor',
  'custom',
  'imported',
  'mannequin',
  'path'
]

/** 导航线节点的坐标系：相对路径对象自身位置的局部坐标。 */
export const PATH_KIND = 'path'

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
]

export const MANNEQUIN_PRESET_IDS = ['stand', 'sit', 'raise-hand', 'walk', 'run']

/**
 * 默认摄影机。
 *
 * 刻意与视口的编辑相机（`SceneViewport.init` 里的 7.5 / 5.5 / 8.5）错开：
 * 如果两者位置完全相同，摄影机模型正好落在观察者眼睛上，
 * 既看不见也点不中，"选择摄影机"功能会像是坏的。
 *
 * 放在左前方而不是紧贴编辑相机，是因为太近时机身会占满画面下半部分，
 * 看起来像遮挡物而不是"场景里的一台相机"。
 */
export const DEFAULT_CAMERA = {
  position: { x: -5.6, y: 3.4, z: 6.4 },
  target: { x: 0, y: 1, z: 0 },
  fovDegrees: 42,
  aspectWidth: 16,
  aspectHeight: 9,
  /**
   * 绑定的目标物体 id；null 表示看向点就是上面的静态 `target`。
   *
   * 必须是 nullable 而不是省略：省略会让"三端字段集合"随工程不同而变化，
   * 后端校验和指纹比较都要处理"字段存不存在"两种分支，很容易漏。
   */
  targetObjectId: null,
  /**
   * 看向绑定是否启用。
   *
   * 与 `targetObjectId` 分开：那个记"绑的是谁"，这个决定"用不用"。
   * 关掉后相机回到静态 `target`，但绑定关系保留，随时可以勾回来。
   */
  lookAtEnabled: true
}

export const DEFAULT_LIGHTING = {
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

export const DEFAULT_TIMELINE = {
  durationSeconds: 5,
  cameraShots: [],
  objectKeyframes: []
}

/**
 * 全景图背景（等距圆柱 / equirectangular）。
 *
 * 语义是"站在全景图里面"：把它当作天空盒贴到场景四周，任何机位都能看到，
 * 成片预演与导出也一样。
 *
 * **只存引用，不存图本身**。全景图动辄几 MB，塞进工程 JSON 会：
 * 每次保存都重传一遍、撤销栈里各留一份、AI 场景概况也跟着变肥。
 * 所以图片走 `POST /api/exports/upload` 落到用户目录，
 * 这里只记 `fileName`（取图地址是 `/api/exports/<fileName>`）。
 *
 * 字段全是原始类型（字符串 / 数字 / 布尔），三端校验都能写成一行。
 */
export const DEFAULT_BACKGROUND = {
  /** 全景图文件名；空串表示没有背景。 */
  panoramaFileName: '',
  /** 上传时的原始文件名，只用于界面显示与"从哪来"的提示。 */
  panoramaSourceName: '',
  /** 水平旋转（度）：把全景图的"正前方"转到想要的方向。 */
  rotateDegrees: 0,
  /** 背景亮度，1 = 原始亮度。 */
  intensity: 1,
  /**
   * 是否同时当环境光照（IBL）用。
   *
   * 默认关：全景图常常是"随便拍的参考环境"，直接拿来打光会把场景染成
   * 图里的色调，用户往往只是想有个背景。要真实感再手动打开。
   */
  affectsLighting: false
}

/** 与固定场景光保持单一来源：视口渲染与光照描述都引用这里。 */
export const FIXED_HEMISPHERE_LIGHT = {
  skyColor: '#ffffff',
  groundColor: '#a9b0b1',
  intensity: 1.15
}

export const FIXED_FILL_LIGHT = {
  color: '#e5f4f1',
  intensity: 0.42,
  position: { x: -5, y: 4, z: -3 },
  target: { x: 0, y: 0, z: 0 }
}

/** 基础体的默认尺寸，单位米。 */
export const BASIC_KIND_SIZES = {
  box: { x: 2.2, y: 2.2, z: 2.2 },
  cylinder: { x: 1.8, y: 2.4, z: 1.8 },
  sphere: { x: 2, y: 2, z: 2 },
  wall: { x: 4, y: 2.8, z: 0.18 },
  floor: { x: 4, y: 0.12, z: 4 }
}

export const BASIC_KIND_NAMES = {
  box: '方块',
  cylinder: '圆柱',
  sphere: '球体',
  wall: '墙体',
  floor: '地面'
}

export const LIGHT_KIND_LABELS = {
  point: '点光源',
  spot: '聚光灯',
  area: '面光',
  sun: '日光'
}

export const LIGHT_PRESETS = {
  area: {
    name: '柔和面光',
    position: { x: 5, y: 8, z: 4 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff4df',
    intensity: 2.5,
    size: 4,
    angleDegrees: 45
  },
  point: {
    name: '点光源',
    position: { x: 3, y: 5, z: 3 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff1d6',
    intensity: 3.2,
    size: 0.35,
    angleDegrees: 45
  },
  spot: {
    name: '聚光灯',
    position: { x: 4, y: 7, z: 5 },
    target: { x: 0, y: 1, z: 0 },
    color: '#fff8ee',
    intensity: 4,
    size: 0.3,
    angleDegrees: 38
  },
  sun: {
    name: '日光',
    position: { x: 6, y: 10, z: 4 },
    target: { x: 0, y: 0, z: 0 },
    color: '#fff5dc',
    intensity: 1.8,
    size: 1,
    angleDegrees: 5
  }
}

/**
 * 相机画幅预设。
 *
 * 顺序按"从宽到窄"排：宽银幕 → 超宽 → 横屏 → 摄影 → 方 → 竖屏。
 * `width/height` 用整数比，界面显示 `label`；实际画幅比取 `width / height`。
 *
 * 注意 2.39:1 用 239:100 表达（变形宽银幕的标准比），不能用 239:100 之外的
 * 近似值，否则和影视行业的通行标注对不上。
 */
export const ASPECT_PRESETS = [
  { label: '2.39:1', width: 239, height: 100, hint: '变形宽银幕' },
  { label: '21:9', width: 21, height: 9, hint: '超宽银幕' },
  { label: '16:9', width: 16, height: 9, hint: '横屏（默认）' },
  { label: '3:2', width: 3, height: 2, hint: '摄影' },
  { label: '4:3', width: 4, height: 3, hint: '经典' },
  { label: '1:1', width: 1, height: 1, hint: '方形' },
  { label: '9:16', width: 9, height: 16, hint: '竖屏短视频' },
  { label: '4:5', width: 4, height: 5, hint: '竖版图文' }
]

export function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function cloneVector(value) {
  return { x: value.x, y: value.y, z: value.z }
}

export function createProjectDocument({
  name,
  objects,
  camera,
  lighting,
  timeline,
  background,
  poseLibrary,
  appVersion
}) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: appVersion || '0.22.0',
    savedAt: new Date().toISOString(),
    name: (name || '').trim() || '未命名场景',
    scene: {
      objects,
      camera,
      lighting,
      timeline,
      background: normalizeBackground(background),
      poseLibrary: normalizePoseLibrary(poseLibrary)
    }
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVector3(value) {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z)
}

function isSceneLight(value) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    ['point', 'spot', 'area', 'sun'].includes(value.kind) &&
    isVector3(value.position) &&
    isVector3(value.target) &&
    isFiniteNumber(value.intensity) &&
    value.intensity >= 0 &&
    value.intensity <= 20 &&
    isFiniteNumber(value.size) &&
    value.size > 0 &&
    value.size <= 100 &&
    isFiniteNumber(value.angleDegrees) &&
    typeof value.visible === 'boolean' &&
    typeof value.locked === 'boolean'
  )
}

function isCamera(value) {
  return (
    isRecord(value) &&
    isVector3(value.position) &&
    isVector3(value.target) &&
    isFiniteNumber(value.fovDegrees) &&
    isFiniteNumber(value.aspectWidth) &&
    isFiniteNumber(value.aspectHeight) &&
    /*
     * `targetObjectId` 允许缺省（v13 及更早的工程没有这个字段），
     * 但一旦存在就必须是 null 或非空字符串。空字符串要拒绝：
     * 它既不是"未绑定"也不是合法 id，留着会让"是否绑定"的判断出现第三种状态。
     */
    (value.targetObjectId === undefined ||
      value.targetObjectId === null ||
      (typeof value.targetObjectId === 'string' && value.targetObjectId.length > 0)) &&
    // `lookAtEnabled` 允许缺省（v14 及更早的工程没有），但存在时必须是布尔。
    (value.lookAtEnabled === undefined || typeof value.lookAtEnabled === 'boolean')
  )
}

/** 导航线节点：只需 x / z 有效，y 允许缺省（缺省按 0 处理）。 */
function isPathNode(value) {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.z)
}

function isPathBinding(value) {
  return isRecord(value) && typeof value.pathId === 'string' && value.pathId.length > 0
}

/**
 * 单个文件引用：`name`（模型内部引用的原始名）+ `fileName`（上传后的服务端文件名）。
 *
 * `fileName` 缺失就整条丢掉——没有文件名就没有可下载的东西，
 * 留着只会在恢复时得到一次必然失败的请求。
 * `name` 缺失时退回 `fileName`：至少 `.obj` 的 mtl 还能按文件名找回去。
 */
function normalizeImportedFileEntry(value) {
  if (!isRecord(value)) return null
  const fileName = typeof value.fileName === 'string' ? value.fileName.trim() : ''
  if (!fileName) return null
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : fileName
  return { name, fileName }
}

/**
 * 导入模型的文件引用净化（schema 18）。
 *
 * 主文件缺失即视为"没有文件引用"（返回 null）：
 * 老工程（v17 及更早）本来就没有这个字段，半损坏的引用也该落到同一条路径上——
 * 模型恢复不出来，但工程必须照常打开。
 */
export function normalizeImportedFiles(value) {
  if (!isRecord(value)) return null
  const main = normalizeImportedFileEntry(value.main)
  if (!main) return null
  return {
    main,
    resources: Array.isArray(value.resources)
      ? value.resources.map(normalizeImportedFileEntry).filter(Boolean)
      : []
  }
}

/**
 * 导入模型记录的净化。
 *
 * 关键取舍：**引用坏了只丢 `files`，不丢整个 `importedAsset`**。
 * 整个丢掉会让物体退化成"未知方块"——检查器里连"这是个导入模型、
 * 原文件叫什么、多少面"都没了，用户更不知道自己丢了什么。
 */
function normalizeImportedAsset(value) {
  if (!isRecord(value)) return null
  const asset = { ...value }
  const files = normalizeImportedFiles(asset.files)
  if (files) asset.files = files
  else delete asset.files
  return asset
}

/**
 * 补齐单个物体的可选字段。
 *
 * 关键点：**path 对象的节点必须过一遍净化**。
 * 手改文件、或旧版本写出的坐标里可能混进 NaN，直接进渲染层会让
 * 整条路径消失（NaN 会污染矩阵），而且很难排查。
 */
function normalizeObject(object) {
  const next = { ...object }
  if (next.kind === PATH_KIND) {
    next.pathNodes = Array.isArray(next.pathNodes)
      ? next.pathNodes
          .filter(isPathNode)
          .map((node) => ({ x: node.x, y: isFiniteNumber(node.y) ? node.y : 0, z: node.z }))
      : []
  } else if (next.pathNodes !== undefined) {
    // 非路径对象不该带节点，去掉以免渲染层误判。
    delete next.pathNodes
  }
  if (next.pathBinding !== undefined && !isPathBinding(next.pathBinding)) {
    delete next.pathBinding
  }
  /*
   * 导入模型的文件引用（schema 18）。
   *
   * 老工程（v17 及更早）的 `importedAsset` 只有 format / sourceName / report，
   * 必须原样保留——模型恢复不出来是预期的，当初也没存文件。
   */
  if (next.importedAsset !== undefined) {
    const asset = normalizeImportedAsset(next.importedAsset)
    if (asset) next.importedAsset = asset
    else delete next.importedAsset
  }
  /*
   * 人台的 `size` 三个分量必须相等。
   *
   * schema 16 及更早的工程存的是 `{ x: 1, y: 身高, z: 1 }`，而视口按三个分量为
   * 根节点缩放，等于把人物竖直拉伸 1.75 倍（看起来又细又长）。
   * 这里按 `mannequin.heightMeters`（缺省用 size.y）统一，老工程一打开就修好。
   */
  if (next.kind === 'mannequin') {
    const height = isFiniteNumber(next.mannequin?.heightMeters)
      ? next.mannequin.heightMeters
      : isFiniteNumber(next.size?.y)
        ? next.size.y
        : 1.75
    next.size = { x: height, y: height, z: height }
  }
  return next
}

/**
 * 把任意历史版本工程迁移到当前 schema。
 *
 * 策略与后端 `migrate_document` 一致：字段缺失或非法时回退默认值，
 * 而不是直接拒绝——用户工程打不开的代价远高于静默补全。
 */
export function migrateProjectDocument(raw) {
  const sceneRaw = (raw && raw.scene) || {}
  const camera = normalizeCamera(isCamera(sceneRaw.camera) ? sceneRaw.camera : DEFAULT_CAMERA)
  const lighting =
    isRecord(sceneRaw.lighting) &&
    Array.isArray(sceneRaw.lighting.lights) &&
    sceneRaw.lighting.lights.length > 0 &&
    sceneRaw.lighting.lights.every(isSceneLight)
      ? sceneRaw.lighting
      : JSON.parse(JSON.stringify(DEFAULT_LIGHTING))
  const timeline = isRecord(sceneRaw.timeline)
    ? {
        durationSeconds: isFiniteNumber(sceneRaw.timeline.durationSeconds)
          ? sceneRaw.timeline.durationSeconds
          : DEFAULT_TIMELINE.durationSeconds,
        cameraShots: Array.isArray(sceneRaw.timeline.cameraShots) ? sceneRaw.timeline.cameraShots : [],
        objectKeyframes: Array.isArray(sceneRaw.timeline.objectKeyframes)
          ? sceneRaw.timeline.objectKeyframes
          : []
      }
    : JSON.parse(JSON.stringify(DEFAULT_TIMELINE))

  const objects = Array.isArray(sceneRaw.objects)
    ? sceneRaw.objects
        .filter((object) => isRecord(object) && typeof object.id === 'string')
        .filter((object) => OBJECT_KINDS.includes(object.kind))
        .map(normalizeObject)
    : []

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    appVersion: (raw && raw.appVersion) || '0.22.0',
    savedAt: (raw && raw.savedAt) || new Date().toISOString(),
    name: (raw && raw.name) || '未命名场景',
    scene: {
      objects,
      camera,
      lighting,
      timeline,
      background: normalizeBackground(sceneRaw.background),
      poseLibrary: normalizePoseLibrary(sceneRaw.poseLibrary)
    }
  }
}

/**
 * 关节限位表的 **文档侧副本**。
 *
 * 权威定义在 `core/mannequin.js`（那里的 `MANNEQUIN_JOINTS` 还带 label / group）。
 * 这里刻意复制一份而不是 import：`mannequin.js` 已经 import 了本文件
 * （`MANNEQUIN_JOINT_IDS` / `createId`），反向 import 会形成循环依赖，
 * 在 webpack 与 vitest 里谁先初始化成了不确定的事。
 * 两边的数字由 `project-document.test.js` 里的断言锁死。
 */
const MANNEQUIN_JOINT_LIMITS = {
  head: { x: [-45, 45], y: [-70, 70], z: [-30, 30] },
  spine: { x: [-35, 35], y: [-50, 50], z: [-30, 30] },
  leftShoulder: { x: [-120, 120], y: [-80, 80], z: [-175, 70] },
  rightShoulder: { x: [-120, 120], y: [-80, 80], z: [-70, 175] },
  leftElbow: { x: [0, 145], y: [-20, 20], z: [-15, 15] },
  rightElbow: { x: [0, 145], y: [-20, 20], z: [-15, 15] },
  leftHip: { x: [-110, 65], y: [-45, 45], z: [-45, 35] },
  rightHip: { x: [-110, 65], y: [-45, 45], z: [-35, 45] },
  leftKnee: { x: [0, 150], y: [0, 0], z: [0, 0] },
  rightKnee: { x: [0, 150], y: [0, 0], z: [0, 0] }
}

/**
 * 姿势库净化（schema 19）。
 *
 * 取舍与 `background` 一致：**坏的条目单独丢掉，不拖累整份工程**。
 * 但比 background 严格一点——条目少了 `id` 或 `pose` 就没法被"应用/更新/删除"，
 * 留着只是列表里的死行，所以直接过滤。
 *
 * 关节表按 `MANNEQUIN_JOINT_IDS` 重建：未知关节丢掉（渲染层根本不认识），
 * 缺失关节补 0、非数字补 0、越界夹回限位。应用姿势时 `presetId` 会置 null、
 * 全部关节都由这份 pose 驱动，所以**缺一个关节就会让那个部位掉回中立角度**，
 * 补齐比"原样保留缺项"安全。
 */
export function normalizePoseLibrary(value) {
  if (!Array.isArray(value)) return []
  const entries = []
  const usedIds = new Set()
  for (const raw of value) {
    if (!isRecord(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (!id || usedIds.has(id)) continue
    const pose = normalizePoseRecord(raw.pose)
    if (!pose) continue
    usedIds.add(id)
    const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : ''
    entries.push({
      id,
      // 名字**不编造**：空名原样留着，由界面显示「未命名姿势」。
      // 这里补一个默认名会让"存盘 → 重新打开"后的数据与存盘时不一致，
      // 后端也会开始出现两种写法（空串 / 未命名姿势）。
      name: name.slice(0, 24),
      pose,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : ''
    })
  }
  return entries
}

/** 单个姿势的关节表净化：只保留已知关节，数值必须是有限数并落在限位内。 */
function normalizePoseRecord(pose) {
  if (!isRecord(pose)) return null
  const result = {}
  for (const jointId of MANNEQUIN_JOINT_IDS) {
    const definition = MANNEQUIN_JOINT_LIMITS[jointId]
    const value = pose[jointId]
    const source = isRecord(value) ? value : {}
    const clamp = (number, limits) =>
      Number.isFinite(number) ? Math.min(Math.max(number, limits[0]), limits[1]) : 0
    result[jointId] = {
      x: clamp(toFinite(source.x), definition.x),
      y: clamp(toFinite(source.y), definition.y),
      z: clamp(toFinite(source.z), definition.z)
    }
  }
  return result
}

function toFinite(value) {
  if (value === null || value === undefined || value === '') return Number.NaN
  return Number(value)
}

/**
 * 全景图背景字段净化。
 *
 * 老工程（v15 及更早）完全没有这个字段，所以 `undefined` 必须能走通并落到
 * "没有背景"。同时把非法值归一，避免出现"文件名是 0 / 旋转是 NaN"这种
 * 三端判断分叉的状态。
 */
export function normalizeBackground(background) {
  const source = isRecord(background) ? background : {}
  const fileName = typeof source.panoramaFileName === 'string' ? source.panoramaFileName.trim() : ''
  /*
   * 注意不能直接用 `Number(x)`：`Number(null)` 是 0、`Number('')` 也是 0，
   * 会把"字段缺失"当成"用户填了 0"（亮度会变成全黑）。先挡掉空值。
   */
  const toNumber = (value) => {
    if (value === null || value === undefined || value === '') return Number.NaN
    return Number(value)
  }
  const rotate = toNumber(source.rotateDegrees)
  const intensity = toNumber(source.intensity)
  return {
    panoramaFileName: fileName,
    panoramaSourceName:
      typeof source.panoramaSourceName === 'string' ? source.panoramaSourceName.trim() : '',
    // 旋转归一到 [0, 360)，免得出现 -720 / 1080 这类等价但不一致的写法。
    rotateDegrees: Number.isFinite(rotate) ? ((rotate % 360) + 360) % 360 : DEFAULT_BACKGROUND.rotateDegrees,
    // 亮度限制在 0~4：再高只会把背景烧成白块，没有实际意义。
    intensity: Number.isFinite(intensity)
      ? Math.min(Math.max(intensity, 0), 4)
      : DEFAULT_BACKGROUND.intensity,
    affectsLighting: source.affectsLighting === true
  }
}

/**
 * 相机字段净化。
 *
 * 主要目的是补齐新增的可选字段：老工程里根本没有它们，
 * 不补的话前端到处都要判 `undefined`。
 * 同时把非法值归一，保证"是否绑定""是否启用"都只有两种状态，
 * 不会出现第三种让两端判断分叉。
 */
function normalizeCamera(camera) {
  const source = isRecord(camera) ? camera : DEFAULT_CAMERA
  const bound = source.targetObjectId
  return {
    position: cloneVectorOrDefault(source.position, DEFAULT_CAMERA.position),
    target: cloneVectorOrDefault(source.target, DEFAULT_CAMERA.target),
    fovDegrees: isFiniteNumber(source.fovDegrees) ? source.fovDegrees : DEFAULT_CAMERA.fovDegrees,
    aspectWidth: isFiniteNumber(source.aspectWidth) ? source.aspectWidth : DEFAULT_CAMERA.aspectWidth,
    aspectHeight: isFiniteNumber(source.aspectHeight) ? source.aspectHeight : DEFAULT_CAMERA.aspectHeight,
    targetObjectId: typeof bound === 'string' && bound.length > 0 ? bound : null,
    // 缺省视为启用：v14 及更早的工程没有这个字段，那时绑定就是"一绑就生效"。
    lookAtEnabled: source.lookAtEnabled !== false
  }
}

function cloneVectorOrDefault(value, fallback) {
  if (!isVector3(value)) return { ...fallback }
  return { x: value.x, y: value.y, z: value.z }
}

/**
 * 生成用于比较"是否有未保存修改"的指纹。
 *
 * 刻意不含 savedAt：否则每次保存都会让指纹变化，脏标记永远为真。
 * 用 JSON 字符串而非哈希，是为了让调试时能直接看出差异。
 *
 * `poseLibrary` 必须一起进指纹：它是**工程内容**，新增/删除/更新库条目
 * 都改变了文件内容。不进来的话用户存了姿势、直接关窗口就丢了，
 * 而且全程没有任何"有未保存修改"的提示。
 */
export function sceneFingerprint(objects, camera, lighting, timeline, background, poseLibrary) {
  const round = (value) => Math.round(value * 1_000_000) / 1_000_000
  return JSON.stringify({
    objects: objects.map((object) => ({
      id: object.id,
      kind: object.kind,
      name: object.name,
      description: object.description ?? '',
      position: [round(object.position.x), round(object.position.y), round(object.position.z)],
      rotation: [round(object.rotation.x), round(object.rotation.y), round(object.rotation.z)],
      size: [round(object.size.x), round(object.size.y), round(object.size.z)],
      color: object.color,
      colorOverride: object.colorOverride ?? '',
      faceColors: object.faceColors ?? null,
      displayMode: object.displayMode ?? 'solid',
      visible: object.visible,
      locked: object.locked,
      groupId: object.groupId ?? '',
      mannequin: object.mannequin
        ? {
            heightMeters: round(object.mannequin.heightMeters),
            presetId: object.mannequin.presetId ?? '',
            pose: object.mannequin.pose
          }
        : null,
      customMesh: object.customMesh ?? null,
      cuts: object.cuts ?? null,
      // 导航线：节点位置与绑定关系都是"会改变画面"的数据，必须进指纹，
      // 否则拖动节点后 Ctrl+S 不会认为工程变脏，改名/存盘都被跳过。
      pathNodes: object.pathNodes
        ? object.pathNodes.map((node) => [round(node.x), round(node.y), round(node.z)])
        : null,
      pathBinding: object.pathBinding
        ? {
            pathId: object.pathBinding.pathId,
            followRotation: object.pathBinding.followRotation !== false,
            offsetSeconds: round(object.pathBinding.offsetSeconds ?? 0),
            heightOffset: round(object.pathBinding.heightOffset ?? 0)
          }
        : null
    })),
    camera: {
      position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
      target: [round(camera.target.x), round(camera.target.y), round(camera.target.z)],
      fovDegrees: round(camera.fovDegrees),
      aspectWidth: camera.aspectWidth,
      aspectHeight: camera.aspectHeight,
      // 绑定关系与启用状态都必须进指纹：否则"只改了绑定/开关"不会被判成
      // "有未保存修改"，用户改完直接关窗口就丢了，而且没有任何提示。
      targetObjectId: camera.targetObjectId ?? null,
      lookAtEnabled: camera.lookAtEnabled !== false
    },
    lighting,
    timeline,
    // 全景图同样"会改变画面"，必须进指纹：否则换了背景不会被认为有未保存修改，
    // 直接关窗口就丢了。
    background: normalizeBackground(background),
    // 姿势库只影响"能不能切回某个姿势"，不影响当前画面，但它确实是工程内容，
    // 所以进指纹（否则存了姿势不算脏，用户以为没保存过）。
    poseLibrary: normalizePoseLibrary(poseLibrary)
  })
}
