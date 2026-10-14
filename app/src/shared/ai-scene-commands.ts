/**
 * AI 场景操作命令：模型以 JSON 返回，渲染进程校验后应用到场景。
 */

import {
  MANNEQUIN_PRESET_IDS,
  type BasicPrimitiveKind,
  type MannequinPresetId,
  type Vector3Value
} from './project-document'

export const AI_SCENE_COMMAND_TYPES = [
  'clear_scene',
  'add_object',
  'add_mannequin',
  'update_object',
  'set_mannequin_pose',
  'set_camera',
  'animate_move'
] as const

export type AiSceneCommandType = (typeof AI_SCENE_COMMAND_TYPES)[number]

const BASIC_KINDS: readonly BasicPrimitiveKind[] = ['box', 'cylinder', 'sphere', 'wall', 'floor']

export interface AiClearSceneCommand {
  type: 'clear_scene'
}

export interface AiAddObjectCommand {
  type: 'add_object'
  kind: BasicPrimitiveKind
  name?: string
  position?: Partial<Vector3Value>
  rotation?: Partial<Vector3Value>
  size?: Partial<Vector3Value>
  color?: string
  description?: string
}

export interface AiAddMannequinCommand {
  type: 'add_mannequin'
  name?: string
  position?: Partial<Vector3Value>
  rotation?: Partial<Vector3Value>
  heightMeters?: number
  presetId?: MannequinPresetId
  description?: string
}

export interface AiUpdateObjectCommand {
  type: 'update_object'
  id?: string
  name?: string
  position?: Partial<Vector3Value>
  rotation?: Partial<Vector3Value>
  size?: Partial<Vector3Value>
  color?: string
  description?: string
}

export interface AiSetMannequinPoseCommand {
  type: 'set_mannequin_pose'
  id?: string
  name?: string
  presetId: MannequinPresetId
}

export interface AiSetCameraCommand {
  type: 'set_camera'
  position?: Partial<Vector3Value>
  target?: Partial<Vector3Value>
  fovDegrees?: number
}

export const AI_CAMERA_FOLLOW_MODES = ['side', 'chase', 'front', 'orbit'] as const
export type AiCameraFollowMode = (typeof AI_CAMERA_FOLLOW_MODES)[number]

export interface AiAnimateMoveCameraFollow {
  /**
   * 跟拍模式：
   * - side：侧面跟拍（默认）
   * - chase：背后跟随
   * - front：前方迎着拍
   * - orbit：环绕人物（可 360 度），同时沿路径跟随
   */
  mode?: AiCameraFollowMode
  /** 侧面偏移（米），side 模式默认 4 */
  sideOffset?: number
  /** 相对前进方向的后方偏移（米），side/chase 默认 1.5 */
  backOffset?: number
  /** 环绕/前后跟拍半径（米），orbit 默认 5，chase/front 也可用 */
  radius?: number
  /** 环绕总角度（度），orbit 默认 360；可写 180/720 等 */
  orbitDegrees?: number
  /** 环绕方向，默认 ccw（逆时针） */
  orbitDirection?: 'cw' | 'ccw'
  /** 环绕起始方位角（度），默认 0 */
  startAngleDegrees?: number
  /** 摄影机高度（米），默认 2.2 */
  height?: number
  /** 看向高度（米），默认 1.2 */
  lookAtHeight?: number
}

/**
 * 在时间轴上让物体沿路径移动；可选侧面/背后/环绕跟拍镜头。
 * 仅设 run/walk 姿势不会产生位移，跑步/走路必须用本命令。
 */
export interface AiAnimateMoveCommand {
  type: 'animate_move'
  id?: string
  name?: string
  /** 路径点（至少 2 个），单位米；缺省 y 时保持物体当前高度 */
  path: Array<Partial<Vector3Value>>
  /** 动画时长（秒），默认 4，范围 1–30 */
  durationSeconds?: number
  /** 是否沿路径朝向前进方向，默认 true */
  faceAlongPath?: boolean
  /** true=默认侧面跟拍；对象可设 mode:"orbit" 做 360 环绕；省略则不跟拍 */
  cameraFollow?: boolean | AiAnimateMoveCameraFollow
}

export type AiSceneCommand =
  | AiClearSceneCommand
  | AiAddObjectCommand
  | AiAddMannequinCommand
  | AiUpdateObjectCommand
  | AiSetMannequinPoseCommand
  | AiSetCameraCommand
  | AiAnimateMoveCommand

export const AI_SCENE_COMMAND_SCHEMA_HINT = [
  '输出格式（必须遵守）：',
  '1. 先用一两句简体中文说明将要搭建什么。',
  '2. 然后输出一个 JSON 代码块（```json ... ```），内容是命令数组。',
  '3. JSON 必须是严格合法 JSON：数字写 50 不要写 fifty；布尔写 true/false；字符串与键名一律双引号；不要尾随逗号；不要注释。',
  '4. 用户说“生成/搭建/布置…场景”时，第一条命令必须是 {"type":"clear_scene"}。',
  '5. 坐标单位是米，旋转单位是度。人台围坐用 presetId:"sit"，沿圆布置并朝向中心。',
  '6. 避免穿模：人台勿插入地面/墙/桌，物体之间留空隙；坐姿与桌面分开。',
  '7. 跑步/走路/移动：仅 presetId "run"/"walk" 只是原地姿势，必须再用 animate_move 写路径位移；跟拍用 cameraFollow。',
  '8. cameraFollow 可为 true（侧面），或 {"mode":"orbit","orbitDegrees":360,"radius":5}（360 环绕跟随）、{"mode":"chase"}（背后）、{"mode":"front"}（迎面）。',
  '9. 只允许下列命令类型，不要输出其他字段或伪代码。',
  '',
  '命令类型：',
  '- {"type":"clear_scene"}',
  '- {"type":"add_object","kind":"box|cylinder|sphere|wall|floor","name?","position?","rotation?","size?","color?","description?"}',
  '- {"type":"add_mannequin","name?","position?","rotation?","heightMeters?","presetId":"stand|sit|raise-hand|walk|run","description?"}',
  '- {"type":"update_object","id?","name?","position?","rotation?","size?","color?","description?"}',
  '- {"type":"set_mannequin_pose","id?","name?","presetId":"stand|sit|raise-hand|walk|run"}',
  '- {"type":"set_camera","position?","target?","fovDegrees?"}',
  '- {"type":"animate_move","name?","id?","path":[{"x":0,"z":0},{"x":8,"z":0}],"durationSeconds":4,"faceAlongPath":true,"cameraFollow":true}',
  '- cameraFollow 示例：true | {"mode":"side"} | {"mode":"chase","radius":4} | {"mode":"orbit","orbitDegrees":360,"radius":5,"height":2.5}',
  '',
  '示例（侧面跟拍跑步）：',
  '```json',
  '[',
  '  {"type":"clear_scene"},',
  '  {"type":"add_object","kind":"floor","name":"跑道","size":{"x":16,"y":0.08,"z":4},"position":{"x":4,"y":0.04,"z":0},"color":"#c9c4b8"},',
  '  {"type":"add_mannequin","name":"跑者","presetId":"run","position":{"x":-4,"z":0},"rotation":{"y":90}},',
  '  {"type":"animate_move","name":"跑者","path":[{"x":-4,"z":0},{"x":0,"z":0},{"x":8,"z":0}],"durationSeconds":4,"faceAlongPath":true,"cameraFollow":true}',
  ']',
  '```',
  '',
  '示例（360 度环绕跟随）：',
  '```json',
  '[',
  '  {"type":"clear_scene"},',
  '  {"type":"add_mannequin","name":"主角","presetId":"walk","position":{"x":0,"z":0}},',
  '  {"type":"animate_move","name":"主角","path":[{"x":0,"z":0},{"x":6,"z":0}],"durationSeconds":6,"cameraFollow":{"mode":"orbit","orbitDegrees":360,"radius":5,"height":2.4,"lookAtHeight":1.2}}',
  ']',
  '```',
  '',
  '示例（5 人围坐讨论）：',
  '```json',
  '[',
  '  {"type":"clear_scene"},',
  '  {"type":"add_object","kind":"box","name":"圆桌","size":{"x":2.2,"y":0.08,"z":2.2},"position":{"x":0,"y":0.04,"z":0},"color":"#d8d4cc"},',
  '  {"type":"add_mannequin","name":"人台 01","presetId":"sit","position":{"x":0,"z":1.5},"rotation":{"y":180}},',
  '  {"type":"add_mannequin","name":"人台 02","presetId":"sit","position":{"x":1.43,"z":0.46},"rotation":{"y":252}},',
  '  {"type":"add_mannequin","name":"人台 03","presetId":"sit","position":{"x":0.88,"z":-1.21},"rotation":{"y":324}},',
  '  {"type":"add_mannequin","name":"人台 04","presetId":"sit","position":{"x":-0.88,"z":-1.21},"rotation":{"y":36}},',
  '  {"type":"add_mannequin","name":"人台 05","presetId":"sit","position":{"x":-1.43,"z":0.46},"rotation":{"y":108}},',
  '  {"type":"set_camera","position":{"x":4.5,"y":3.2,"z":5.5},"target":{"x":0,"y":1,"z":0},"fovDegrees":42}',
  ']',
  '```'
].join('\n')

const MAX_COMMANDS = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBasicKind(value: unknown): value is BasicPrimitiveKind {
  return typeof value === 'string' && (BASIC_KINDS as readonly string[]).includes(value)
}

function isPresetId(value: unknown): value is MannequinPresetId {
  return typeof value === 'string' && (MANNEQUIN_PRESET_IDS as readonly string[]).includes(value)
}

function trimString(value: unknown, max = 120): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, max)
}

function parsePartialVector(value: unknown): Partial<Vector3Value> | undefined {
  if (!isRecord(value)) return undefined
  const result: Partial<Vector3Value> = {}
  for (const axis of ['x', 'y', 'z'] as const) {
    const n = value[axis]
    if (typeof n === 'number' && Number.isFinite(n)) {
      result[axis] = Math.min(Math.max(n, -1000), 1000)
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parsePositiveSize(value: unknown): Partial<Vector3Value> | undefined {
  const partial = parsePartialVector(value)
  if (!partial) return undefined
  const result: Partial<Vector3Value> = {}
  for (const axis of ['x', 'y', 'z'] as const) {
    const n = partial[axis]
    if (n === undefined) continue
    result[axis] = Math.min(Math.max(Math.abs(n), 0.01), 200)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function parseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmed)) return undefined
  return trimmed.toLowerCase()
}

const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  hundred: 100
}

/**
 * 修复模型常犯的“近似 JSON”错误，便于兜底解析。
 * 例如：英文数字词、尾随逗号、True/False、智能引号。
 */
export function repairAiJsonText(source: string): string {
  let text = source.trim()
  // 去掉可能误带的语言标签
  text = text.replace(/^json\s*/i, '')
  // 智能引号 → 标准引号
  text = text.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"').replace(/[\u2018\u2019]/g, "'")
  // Python / JS 风格布尔与 null
  text = text.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null')
  // 尾随逗号：{... ,} 或 [... ,]
  text = text.replace(/,\s*([\]}])/g, '$1')
  // "fovDegrees": fifty → 50（仅替换 JSON 值位置上的英文数字词）
  text = text.replace(
    /(:\s*)([A-Za-z]+)(\s*[,}\]])/g,
    (match, prefix: string, word: string, suffix: string) => {
      const mapped = ENGLISH_NUMBER_WORDS[word.toLowerCase()]
      if (mapped === undefined) return match
      return `${prefix}${mapped}${suffix}`
    }
  )
  // 单引号键/字符串（粗略）：'key': 'value'
  text = text.replace(/'([^'\\]*)'/g, '"$1"')
  return text
}

function tryParseJsonValue(source: string): unknown | null {
  const candidates = [source, repairAiJsonText(source)]
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // continue
    }
  }
  return null
}

/**
 * 按花括号平衡截取对象片段（支持嵌套 position/size 等），再逐条解析。
 */
export function extractCommandObjectsLenient(source: string): unknown[] {
  const repaired = repairAiJsonText(source)
  const objects: unknown[] = []
  for (let index = 0; index < repaired.length; index += 1) {
    if (repaired[index] !== '{') continue
    let depth = 0
    let end = -1
    let inString = false
    let escaped = false
    for (let cursor = index; cursor < repaired.length; cursor += 1) {
      const ch = repaired[cursor]
      if (inString) {
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === '"') inString = false
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = cursor
          break
        }
      }
    }
    if (end < 0) continue
    const slice = repaired.slice(index, end + 1)
    if (!/"type"\s*:\s*"[a-z_]+"/i.test(slice)) continue
    const parsed = tryParseJsonValue(slice)
    if (parsed && isRecord(parsed) && typeof parsed.type === 'string') {
      objects.push(parsed)
    }
    index = end
  }
  return objects
}

/** 从模型回复中提取 JSON（优先 ```json 代码块，其次整段数组/对象；失败则修复与逐条兜底）。 */
export function extractAiSceneCommands(content: string): unknown | null {
  const fenced =
    /```(?:json)?\s*([\s\S]*?)```/i.exec(content) ?? /```\s*([\s\S]*?)```/.exec(content)
  const candidates: string[] = []
  if (fenced?.[1]) candidates.push(fenced[1].trim())
  const trimmed = content.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) candidates.push(trimmed)
  const arrayMatch = /\[[\s\S]*\]/.exec(content)
  if (arrayMatch) candidates.push(arrayMatch[0])

  for (const candidate of candidates) {
    const parsed = tryParseJsonValue(candidate)
    if (parsed !== null) return parsed
    const lenient = extractCommandObjectsLenient(candidate)
    if (lenient.length > 0) return lenient
  }
  // 全文兜底：即使没有完整数组括号，也尝试捞命令对象
  const loose = extractCommandObjectsLenient(content)
  return loose.length > 0 ? loose : null
}

/** 去掉失败的 JSON 代码块后，留下给人看的说明文字。 */
export function stripAiSceneCommandBlock(content: string): string {
  const withoutFence = content.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim()
  if (withoutFence.length > 0) return withoutFence
  const withoutArray = content.replace(/\[[\s\S]*\]/, '').trim()
  return withoutArray
}

function parseOneCommand(value: unknown): AiSceneCommand | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  switch (value.type) {
    case 'clear_scene':
      return { type: 'clear_scene' }
    case 'add_object': {
      if (!isBasicKind(value.kind)) return null
      return {
        type: 'add_object',
        kind: value.kind,
        name: trimString(value.name),
        position: parsePartialVector(value.position),
        rotation: parsePartialVector(value.rotation),
        size: parsePositiveSize(value.size),
        color: parseColor(value.color),
        description: trimString(value.description, 500)
      }
    }
    case 'add_mannequin': {
      const height =
        typeof value.heightMeters === 'number' && Number.isFinite(value.heightMeters)
          ? Math.min(Math.max(value.heightMeters, 0.8), 2.5)
          : undefined
      return {
        type: 'add_mannequin',
        name: trimString(value.name),
        position: parsePartialVector(value.position),
        rotation: parsePartialVector(value.rotation),
        heightMeters: height,
        presetId: isPresetId(value.presetId) ? value.presetId : undefined,
        description: trimString(value.description, 500)
      }
    }
    case 'update_object': {
      const id = trimString(value.id, 80)
      const name = trimString(value.name)
      if (!id && !name) return null
      return {
        type: 'update_object',
        id,
        name,
        position: parsePartialVector(value.position),
        rotation: parsePartialVector(value.rotation),
        size: parsePositiveSize(value.size),
        color: parseColor(value.color),
        description: trimString(value.description, 500)
      }
    }
    case 'set_mannequin_pose': {
      if (!isPresetId(value.presetId)) return null
      const id = trimString(value.id, 80)
      const name = trimString(value.name)
      if (!id && !name) return null
      return { type: 'set_mannequin_pose', id, name, presetId: value.presetId }
    }
    case 'set_camera': {
      const fov =
        typeof value.fovDegrees === 'number' && Number.isFinite(value.fovDegrees)
          ? Math.min(Math.max(value.fovDegrees, 10), 120)
          : undefined
      return {
        type: 'set_camera',
        position: parsePartialVector(value.position),
        target: parsePartialVector(value.target),
        fovDegrees: fov
      }
    }
    case 'animate_move': {
      const id = trimString(value.id, 80)
      const name = trimString(value.name)
      if (!id && !name) return null
      if (!Array.isArray(value.path)) return null
      const path = value.path
        .map((point) => parsePartialVector(point))
        .filter((point): point is Partial<Vector3Value> => point !== undefined)
        .slice(0, 24)
      if (path.length < 2) return null
      const durationSeconds =
        typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds)
          ? Math.min(Math.max(value.durationSeconds, 1), 30)
          : undefined
      let cameraFollow: boolean | AiAnimateMoveCameraFollow | undefined
      if (value.cameraFollow === true) cameraFollow = true
      else if (value.cameraFollow === false) cameraFollow = false
      else if (isRecord(value.cameraFollow)) {
        const follow: AiAnimateMoveCameraFollow = {}
        const mode = value.cameraFollow.mode
        if (
          typeof mode === 'string' &&
          (AI_CAMERA_FOLLOW_MODES as readonly string[]).includes(mode)
        ) {
          follow.mode = mode as AiCameraFollowMode
        }
        for (const key of [
          'sideOffset',
          'backOffset',
          'radius',
          'orbitDegrees',
          'startAngleDegrees',
          'height',
          'lookAtHeight'
        ] as const) {
          const n = value.cameraFollow[key]
          if (typeof n === 'number' && Number.isFinite(n)) {
            const max = key === 'orbitDegrees' ? 1440 : 50
            const min = key === 'orbitDegrees' ? -1440 : -50
            follow[key] = Math.min(Math.max(n, min), max)
          }
        }
        const dir = value.cameraFollow.orbitDirection
        if (dir === 'cw' || dir === 'ccw') follow.orbitDirection = dir
        cameraFollow = follow
      }
      return {
        type: 'animate_move',
        id,
        name,
        path,
        durationSeconds,
        faceAlongPath: value.faceAlongPath === false ? false : true,
        cameraFollow
      }
    }
    default:
      return null
  }
}

/**
 * 校验并规范化命令列表。接受数组，或 `{ "commands": [...] }`。
 * 非法项会被跳过。
 */
export function parseAiSceneCommands(value: unknown): AiSceneCommand[] {
  let list: unknown[] | null = null
  if (Array.isArray(value)) list = value
  else if (isRecord(value) && Array.isArray(value.commands)) list = value.commands
  if (!list) return []
  const commands: AiSceneCommand[] = []
  for (const item of list.slice(0, MAX_COMMANDS)) {
    const command = parseOneCommand(item)
    if (command) commands.push(command)
  }
  return commands
}

/** 从完整模型回复中解析命令与说明文字。 */
export function resolveAiSceneCommandsFromReply(content: string): {
  commands: AiSceneCommand[]
  prose: string
  rawFound: boolean
} {
  const raw = extractAiSceneCommands(content)
  if (raw === null) {
    return { commands: [], prose: content.trim(), rawFound: false }
  }
  return {
    commands: parseAiSceneCommands(raw),
    prose: stripAiSceneCommandBlock(content),
    rawFound: true
  }
}

/** 相机画面复核时追加给模型的说明。 */
export const AI_SCENE_VERIFY_USER_PROMPT = [
  '上面附上了当前摄影机画面截图，以及最新场景概况。请只做一次复核，优先查穿模：',
  '【最高优先级·穿模】仔细看截图：人台/物体是否插进地面、墙体、桌子、树木或其他人台？肢体是否穿进家具或彼此重叠？',
  '- 若有穿模：必须修正。用 update_object 调整 position/rotation/size，或微调 animate_move 的 path；人台 y 通常约为身高/2，坐姿不要紧贴桌面下沿；物体之间至少留出可见空隙。',
  '- 不要用多个重叠人台“假装”动画。',
  '【其次】构图、站位、姿势、镜头是否符合用户意图；跑步是否真有位移（应有 animate_move）；跟拍是否合理。',
  '回复规则：',
  '1. 若无明显穿模且整体合格，请只回复：ok',
  '2. 若有问题，先用一两句中文点明（尤其穿模位置），再输出修正 JSON（不要 clear_scene，除非必须重建）；可用 update_object、set_mannequin_pose、set_camera、add_object、add_mannequin、animate_move。',
  '3. 修正已有物体时优先用 name，不要用可能过期的 id。',
  '4. 不要闲聊，不要重复搭建整套场景。'
].join('\n')

/**
 * 判断复核回复是否表示通过（无修正命令时）。
 * 接受 ok / OK / 通过 等简短确认。
 */
export function isAiVerificationAccepted(content: string): boolean {
  const prose = stripAiSceneCommandBlock(content)
    .replace(/[*_`#>-]/g, ' ')
    .trim()
  if (!prose) return false
  const normalized = prose.toLowerCase().replace(/[。.!！？?\s]+$/g, '').trim()
  if (/^(ok|okay|pass|lgtm)$/i.test(normalized)) return true
  if (/^(通过|没问题|可以|完成|确认|符合要求|看起来没问题)$/.test(normalized)) return true
  if (/^ok[\s，,：:].{0,20}$/i.test(normalized)) return true
  return false
}
