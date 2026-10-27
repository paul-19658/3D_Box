/**
 * AI 场景命令：解析与校验。移植自 `app/src/shared/ai-scene-commands.ts`。
 *
 * 安全原则：模型输出的 JSON 一律视为不可信输入。
 * 所有字段都要经过类型与范围校验，非法命令被丢弃而不是"尽力执行"。
 */

import { BASIC_KIND_NAMES, MANNEQUIN_PRESET_IDS } from './project-document'

export const AI_SCENE_COMMAND_TYPES = [
  'clear_scene',
  'add_object',
  'add_mannequin',
  'update_object',
  'remove_object',
  'set_mannequin_pose',
  'set_camera',
  'animate_move'
]

const BASIC_KINDS = ['box', 'cylinder', 'sphere', 'wall', 'floor']
const MAX_COMMANDS = 80
const MAX_PATH_POINTS = 32

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 模型常把数字写成字符串，这里尽量收成 number。 */
function coerceNumber(value) {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function optionalVector(value, limits = 500) {
  if (!isRecord(value)) return undefined
  const result = {}
  for (const axis of ['x', 'y', 'z']) {
    const number = coerceNumber(value[axis])
    if (number === undefined) continue
    if (Math.abs(number) > limits) continue
    result[axis] = number
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const KIND_ALIASES = {
  tree: 'cylinder',
  trunk: 'cylinder',
  pillar: 'cylinder',
  column: 'cylinder',
  rock: 'sphere',
  stone: 'sphere',
  ground: 'floor',
  grass: 'floor',
  terrain: 'floor',
  cube: 'box',
  block: 'box',
  wall_panel: 'wall',
  backdrop: 'wall'
}

const TYPE_ALIASES = {
  create_object: 'add_object',
  add: 'add_object',
  create_mannequin: 'add_mannequin',
  add_person: 'add_mannequin',
  add_character: 'add_mannequin',
  add_human: 'add_mannequin',
  delete_object: 'remove_object',
  delete: 'remove_object',
  remove: 'remove_object',
  update: 'update_object',
  move_camera: 'set_camera',
  camera: 'set_camera',
  animate: 'animate_move',
  move: 'animate_move',
  orbit_camera: 'animate_move'
}

const PERSON_KINDS = new Set(['person', 'human', 'character', 'dancer', 'mannequin', 'actor', 'girl', 'boy'])

/**
 * 把模型常见的松散写法收成可校验命令（仍可能因缺字段被丢掉）。
 */
export function normalizeRawCommand(raw) {
  if (!isRecord(raw)) return raw
  const next = { ...raw }
  if (typeof next.type === 'string') {
    const lowered = next.type.trim()
    next.type = TYPE_ALIASES[lowered] || TYPE_ALIASES[lowered.toLowerCase()] || lowered
  }
  if (next.type === 'add_object' && typeof next.kind === 'string') {
    const kind = next.kind.trim().toLowerCase()
    if (PERSON_KINDS.has(kind)) {
      next.type = 'add_mannequin'
      delete next.kind
    } else if (KIND_ALIASES[kind]) {
      next.kind = KIND_ALIASES[kind]
    } else {
      next.kind = kind
    }
  }
  if (next.type === 'add_mannequin' && typeof next.presetId === 'string') {
    const preset = next.presetId.trim().toLowerCase()
    if (preset === 'dance' || preset === 'dancing') next.presetId = 'raise-hand'
    else if (preset === 'idle') next.presetId = 'stand'
  }
  // 有些模型把 360 环绕写成顶层字段而不是 cameraFollow 对象。
  if (next.type === 'animate_move' && next.cameraFollow === undefined) {
    if (next.orbit === true || next.orbitDegrees || next.mode === 'orbit') {
      next.cameraFollow = {
        mode: 'orbit',
        orbitDegrees: coerceNumber(next.orbitDegrees) ?? 360,
        orbitDirection: next.orbitDirection === 'cw' ? 'cw' : 'ccw',
        radius: coerceNumber(next.radius),
        height: coerceNumber(next.height)
      }
    }
  }
  return next
}

function isHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}

function optionalString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, maxLength) : undefined
}

/**
 * 解析一条命令。返回规范化后的命令，非法时返回 null。
 * 刻意不做静默补全——例如 kind 非法就直接丢弃，避免建出奇怪物体。
 */
function parseCommand(rawInput) {
  const raw = normalizeRawCommand(rawInput)
  if (!isRecord(raw) || typeof raw.type !== 'string') return null
  if (!AI_SCENE_COMMAND_TYPES.includes(raw.type)) return null

  if (raw.type === 'clear_scene') return { type: 'clear_scene' }

  if (raw.type === 'add_object') {
    if (!BASIC_KINDS.includes(raw.kind)) return null
    return {
      type: 'add_object',
      kind: raw.kind,
      name: optionalString(raw.name, 60),
      position: optionalVector(raw.position),
      rotation: optionalVector(raw.rotation, 3600),
      size: optionalVector(raw.size, 500),
      color: isHexColor(raw.color) ? raw.color.toLowerCase() : undefined,
      description: optionalString(raw.description, 300)
    }
  }

  if (raw.type === 'add_mannequin') {
    const preset = MANNEQUIN_PRESET_IDS.includes(raw.presetId) ? raw.presetId : undefined
    const heightValue = coerceNumber(raw.heightMeters)
    const height =
      heightValue !== undefined ? Math.min(Math.max(heightValue, 1.2), 2.2) : undefined
    return {
      type: 'add_mannequin',
      name: optionalString(raw.name, 60),
      position: optionalVector(raw.position),
      rotation: optionalVector(raw.rotation, 3600),
      heightMeters: height,
      presetId: preset,
      description: optionalString(raw.description, 300)
    }
  }

  if (raw.type === 'update_object') {
    const id = optionalString(raw.id, 80)
    const name = optionalString(raw.name, 60)
    if (!id && !name) return null
    return {
      type: 'update_object',
      id,
      name,
      position: optionalVector(raw.position),
      rotation: optionalVector(raw.rotation, 3600),
      size: optionalVector(raw.size, 500),
      color: isHexColor(raw.color) ? raw.color.toLowerCase() : undefined,
      description: optionalString(raw.description, 300)
    }
  }

  if (raw.type === 'remove_object') {
    const id = optionalString(raw.id, 80)
    const name = optionalString(raw.name, 60)
    if (!id && !name) return null
    return { type: 'remove_object', id, name }
  }

  if (raw.type === 'set_mannequin_pose') {
    if (!MANNEQUIN_PRESET_IDS.includes(raw.presetId)) return null
    const id = optionalString(raw.id, 80)
    const name = optionalString(raw.name, 60)
    if (!id && !name) return null
    return { type: 'set_mannequin_pose', id, name, presetId: raw.presetId }
  }

  if (raw.type === 'set_camera') {
    const fov = coerceNumber(raw.fovDegrees)
    return {
      type: 'set_camera',
      position: optionalVector(raw.position),
      target: optionalVector(raw.target),
      fovDegrees: fov !== undefined ? Math.min(Math.max(fov, 10), 120) : undefined
    }
  }

  if (raw.type === 'animate_move') {
    const id = optionalString(raw.id, 80)
    const name = optionalString(raw.name, 60)
    if (!id && !name) return null
    const path = Array.isArray(raw.path)
      ? raw.path
          .slice(0, MAX_PATH_POINTS)
          .map((point) => optionalVector(point))
          .filter(Boolean)
      : []
    if (path.length < 2) return null
    const duration = coerceNumber(raw.durationSeconds)
    return {
      type: 'animate_move',
      id,
      name,
      path,
      durationSeconds:
        duration !== undefined ? Math.min(Math.max(duration, 1), 30) : 4,
      faceAlongPath: raw.faceAlongPath !== false,
      cameraFollow: parseCameraFollow(raw.cameraFollow)
    }
  }

  return null
}

/** 直接校验命令数组（给 tool 参数用，不必再 JSON.stringify 绕一圈）。 */
export function parseCommandList(rawCommands) {
  if (!Array.isArray(rawCommands)) return { commands: [], rejected: ['commands 不是数组'] }
  const commands = []
  const rejected = []
  for (const [index, item] of rawCommands.slice(0, MAX_COMMANDS).entries()) {
    const parsed = parseCommand(item)
    if (parsed) {
      commands.push(parsed)
      continue
    }
    if (!isRecord(item)) {
      rejected.push(`#${index}:${typeof item}`)
      continue
    }
    const label = item.kind ? `${item.type || '?'}/${item.kind}` : item.type || '?'
    rejected.push(`#${index}:${label}`)
  }
  return { commands, rejected }
}

function parseCameraFollow(value) {
  if (value === true) return { mode: 'side' }
  if (value === 'orbit') return { mode: 'orbit', orbitDegrees: 360 }
  if (!isRecord(value)) return undefined
  const mode = ['side', 'chase', 'front', 'orbit'].includes(value.mode) ? value.mode : 'side'
  const result = { mode }
  for (const key of ['sideOffset', 'backOffset', 'radius', 'height', 'lookAtHeight']) {
    const number = coerceNumber(value[key])
    if (number !== undefined) result[key] = Math.min(Math.max(number, 0.1), 60)
  }
  const orbitDegrees = coerceNumber(value.orbitDegrees)
  if (orbitDegrees !== undefined) {
    result.orbitDegrees = Math.min(Math.max(orbitDegrees, -1440), 1440)
  }
  if (value.orbitDirection === 'cw' || value.orbitDirection === 'ccw') {
    result.orbitDirection = value.orbitDirection
  }
  const startAngle = coerceNumber(value.startAngleDegrees)
  if (startAngle !== undefined) {
    result.startAngleDegrees = startAngle
  }
  return result
}

/**
 * 从模型回复中提取命令数组。
 *
 * 兼容三种常见形态：纯 JSON、```json 代码块、以及夹在说明文字中的 JSON 数组。
 * 按"最后一个合法 JSON 数组"优先，因为模型常先解释再给命令。
 */
export function extractCommandsFromReply(reply) {
  if (typeof reply !== 'string') return []
  const fenced = [...reply.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((match) => match[1])
  const candidates = [...fenced, reply]
  for (const candidate of candidates.reverse()) {
    const parsed = tryParseCommandArray(candidate)
    if (parsed.length > 0) return parsed
  }
  return []
}

function tryParseCommandArray(text) {
  const trimmed = (text || '').trim()
  if (!trimmed) return []
  const attempts = [trimmed]
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1))

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt)
      if (!Array.isArray(parsed)) continue
      const { commands } = parseCommandList(parsed)
      if (commands.length > 0) return commands
    } catch {
      // 继续尝试下一个候选片段。
    }
  }
  return []
}

/**
 * 判断复核回复是否表示通过（无修正命令时）。
 * 接受 ok / okay / pass / 通过 / 没问题 等简短确认。
 */
export function isVerificationPass(reply) {
  const stripped = String(reply || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>-]/g, ' ')
    .trim()
  if (!stripped) return false
  const normalized = stripped.toLowerCase().replace(/[。.!！？?\s]+$/g, '').trim()
  if (/^(ok|okay|pass|lgtm)$/i.test(normalized)) return true
  if (/^(通过|合格|没问题|可以|完成|确认|符合要求|看起来没问题)$/.test(normalized)) return true
  if (/^ok[\s，,：:].{0,20}$/i.test(normalized)) return true
  return false
}

/** 给用户看的命令摘要，用于确认面板。 */
export function describeCommand(command) {
  if (command.type === 'clear_scene') return '清空场景'
  if (command.type === 'add_object') {
    return `添加${BASIC_KIND_NAMES[command.kind] || command.kind}${command.name ? `「${command.name}」` : ''}`
  }
  if (command.type === 'add_mannequin') {
    return `添加人台${command.name ? `「${command.name}」` : ''}`
  }
  if (command.type === 'update_object') {
    return `调整${command.name ? `「${command.name}」` : '物体'}`
  }
  if (command.type === 'remove_object') {
    return `删除${command.name ? `「${command.name}」` : '物体'}`
  }
  if (command.type === 'set_mannequin_pose') return `设置人台动作：${command.presetId}`
  if (command.type === 'set_camera') return '调整摄影机'
  if (command.type === 'animate_move') {
    return `让${command.name || '物体'}沿路径移动 ${command.durationSeconds} 秒`
  }
  return command.type
}
