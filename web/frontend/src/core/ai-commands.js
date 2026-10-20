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

function optionalVector(value, limits = 500) {
  if (!isRecord(value)) return undefined
  const result = {}
  for (const axis of ['x', 'y', 'z']) {
    if (!isFiniteNumber(value[axis])) continue
    if (Math.abs(value[axis]) > limits) continue
    result[axis] = value[axis]
  }
  return Object.keys(result).length > 0 ? result : undefined
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
function parseCommand(raw) {
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
    const height = isFiniteNumber(raw.heightMeters)
      ? Math.min(Math.max(raw.heightMeters, 1.2), 2.2)
      : undefined
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

  if (raw.type === 'set_mannequin_pose') {
    if (!MANNEQUIN_PRESET_IDS.includes(raw.presetId)) return null
    const id = optionalString(raw.id, 80)
    const name = optionalString(raw.name, 60)
    if (!id && !name) return null
    return { type: 'set_mannequin_pose', id, name, presetId: raw.presetId }
  }

  if (raw.type === 'set_camera') {
    return {
      type: 'set_camera',
      position: optionalVector(raw.position),
      target: optionalVector(raw.target),
      fovDegrees: isFiniteNumber(raw.fovDegrees) ? Math.min(Math.max(raw.fovDegrees, 10), 120) : undefined
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
    return {
      type: 'animate_move',
      id,
      name,
      path,
      durationSeconds: isFiniteNumber(raw.durationSeconds)
        ? Math.min(Math.max(raw.durationSeconds, 1), 30)
        : 4,
      faceAlongPath: raw.faceAlongPath !== false,
      cameraFollow: parseCameraFollow(raw.cameraFollow)
    }
  }

  return null
}

function parseCameraFollow(value) {
  if (value === true) return { mode: 'side' }
  if (!isRecord(value)) return undefined
  const mode = ['side', 'chase', 'front', 'orbit'].includes(value.mode) ? value.mode : 'side'
  const result = { mode }
  for (const key of ['sideOffset', 'backOffset', 'radius', 'height', 'lookAtHeight']) {
    if (isFiniteNumber(value[key])) result[key] = Math.min(Math.max(value[key], 0.1), 60)
  }
  if (isFiniteNumber(value.orbitDegrees)) {
    result.orbitDegrees = Math.min(Math.max(value.orbitDegrees, -1440), 1440)
  }
  if (value.orbitDirection === 'cw' || value.orbitDirection === 'ccw') {
    result.orbitDirection = value.orbitDirection
  }
  if (isFiniteNumber(value.startAngleDegrees)) {
    result.startAngleDegrees = value.startAngleDegrees
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
      const commands = parsed.slice(0, MAX_COMMANDS).map(parseCommand).filter(Boolean)
      if (commands.length > 0) return commands
    } catch {
      // 继续尝试下一个候选片段。
    }
  }
  return []
}

/** 判断模型是否在复核阶段回复了"合格"。 */
export function isVerificationPass(reply) {
  const normalized = (reply || '')
    .trim()
    .toLowerCase()
    .replace(/[。.!！\s]/g, '')
  return normalized === 'ok' || normalized === '通过' || normalized === '合格'
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
  if (command.type === 'set_mannequin_pose') return `设置人台动作：${command.presetId}`
  if (command.type === 'set_camera') return '调整摄影机'
  if (command.type === 'animate_move') {
    return `让${command.name || '物体'}沿路径移动 ${command.durationSeconds} 秒`
  }
  return command.type
}
