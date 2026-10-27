/**
 * AI Agent 本地工具：JSON Schema（发给模型）+ 执行器（在浏览器跑）。
 *
 * 截图类工具依赖 SceneViewport；改场景走 applyAiSceneCommands（可撤销）。
 */

import { applyAiSceneCommands } from './apply-ai-scene-commands'
import { describeCommand, parseCommandList } from './ai-commands'
import { getObjectDetail, listAssets } from './scene'
import { evaluateTimelineAtTime } from './timeline'

export const AI_AGENT_MAX_STEPS = 12
export const AI_AGENT_MAX_CAPTURES = 12
export const AI_CAPTURE_MAX_DIMENSION = 768

export const AI_TOOL_DEFINITIONS = [
  {
    name: 'list_assets',
    description: '列出当前项目全部场景资产（id、名称、类型、可见性、颜色）。可分页。',
    parameters: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: '起始下标，默认 0' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '返回条数，默认 100' }
      }
    }
  },
  {
    name: 'get_object',
    description: '查询单个物体详情：坐标、旋转、尺寸、颜色、人台姿势等。用 id 或 name 定位。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '物体 id' },
        name: { type: 'string', description: '物体名称' }
      }
    }
  },
  {
    name: 'capture_target_camera',
    description:
      '截取目标/成片摄影机当前（或指定时间轴时刻）画面。用于检查构图、挡镜、拍空。省着用。',
    parameters: {
      type: 'object',
      properties: {
        timeSeconds: {
          type: 'number',
          minimum: 0,
          description: '可选。时间轴秒数；省略则用场景当前相机位姿'
        }
      }
    }
  },
  {
    name: 'capture_overview_camera',
    description: '截取主视角总览（临时框住全场物体）。用于看整场站位与重复分身。省着用。',
    parameters: {
      type: 'object',
      properties: {
        timeSeconds: {
          type: 'number',
          minimum: 0,
          description: '可选。时间轴秒数；会先摆到该时刻再取景'
        }
      }
    }
  },
  {
    name: 'capture_timeline_pair',
    description:
      '指定时刻同时截「目标摄影机 + 主视角总览」两张。适合检查动画中途挡镜/穿模。每调用计 2 张截图额度。',
    parameters: {
      type: 'object',
      properties: {
        timeSeconds: { type: 'number', minimum: 0, description: '时间轴秒数' }
      },
      required: ['timeSeconds']
    }
  },
  {
    name: 'apply_scene_commands',
    description:
      '批量执行场景命令（clear_scene / add_* / update_object / remove_object / set_camera / animate_move 等）。搭建类请求第一条通常是 clear_scene。',
    parameters: {
      type: 'object',
      properties: {
        commands: {
          type: 'array',
          description: '命令对象数组',
          items: { type: 'object' }
        }
      },
      required: ['commands']
    }
  },
  {
    name: 'done',
    description: '任务完成时调用。可附带给用户看的简短中文总结。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一两句结果说明' }
      }
    }
  }
]

/**
 * @param {object} ctx
 * @param {() => object} ctx.getScene
 * @param {(scene) => void} [ctx.commitScene]
 * @param {object} [ctx.viewport] SceneViewport 实例
 * @param {{ capturesUsed: number }} [ctx.budget]
 */
export function executeAiTool(name, args, ctx) {
  const input = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'list_assets':
      return executeListAssets(ctx, input)
    case 'get_object':
      return executeGetObject(ctx, input)
    case 'capture_target_camera':
      return executeCaptureTarget(ctx, input)
    case 'capture_overview_camera':
      return executeCaptureOverview(ctx, input)
    case 'capture_timeline_pair':
      return executeCaptureTimelinePair(ctx, input)
    case 'apply_scene_commands':
      return executeApplyCommands(ctx, input)
    case 'done':
      return {
        ok: true,
        done: true,
        summary: typeof input.summary === 'string' ? input.summary : '',
        display: input.summary ? `完成：${input.summary}` : '完成'
      }
    default:
      return { ok: false, error: `未知工具：${name}`, display: `未知工具 ${name}` }
  }
}

function executeListAssets(ctx, input) {
  const scene = ctx.getScene()
  const result = listAssets(scene, input)
  return {
    ok: true,
    ...result,
    display: `查询资产 ${result.items.length}/${result.total}`
  }
}

function executeGetObject(ctx, input) {
  const scene = ctx.getScene()
  const result = getObjectDetail(scene, input)
  return {
    ok: result.found,
    ...result,
    display: result.found ? `查看「${result.name}」` : result.message
  }
}

function ensureCaptureBudget(ctx, need) {
  if (!ctx.budget) ctx.budget = { capturesUsed: 0 }
  if (ctx.budget.capturesUsed + need > AI_AGENT_MAX_CAPTURES) {
    return {
      ok: false,
      error: `截图额度已用尽（最多 ${AI_AGENT_MAX_CAPTURES} 张），请根据已有画面修正或调用 done。`,
      display: '截图额度已用尽'
    }
  }
  return null
}

function withTimelinePose(ctx, timeSeconds, run) {
  const viewport = ctx.viewport
  const scene = ctx.getScene()
  const timeline = scene.timeline
  const hasTime = typeof timeSeconds === 'number' && Number.isFinite(timeSeconds)
  if (!hasTime || !viewport || typeof viewport.applyTimelineFrame !== 'function') {
    return run(null)
  }
  try {
    viewport.applyTimelineFrame(timeline, timeSeconds)
    const frame = evaluateTimelineAtTime(timeline, scene.camera, timeSeconds)
    return run(frame.camera)
  } finally {
    if (typeof viewport.restoreObjectTransforms === 'function') {
      viewport.restoreObjectTransforms()
    }
  }
}

function executeCaptureTarget(ctx, input) {
  const blocked = ensureCaptureBudget(ctx, 1)
  if (blocked) return blocked
  const viewport = ctx.viewport
  if (!viewport || typeof viewport.captureFromCameraState !== 'function') {
    return { ok: false, error: '视口未就绪，无法截图', display: '截图失败' }
  }
  const scene = ctx.getScene()
  return withTimelinePose(ctx, input.timeSeconds, (frameCamera) => {
    const cameraState = frameCamera || scene.camera
    const base64Data = viewport.captureFromCameraState(cameraState, AI_CAPTURE_MAX_DIMENSION)
    if (!base64Data) {
      return { ok: false, error: '目标机截图失败', display: '目标机截图失败' }
    }
    ctx.budget.capturesUsed += 1
    const timeLabel =
      typeof input.timeSeconds === 'number' ? ` t=${input.timeSeconds.toFixed(1)}s` : ''
    const label = `目标摄影机${timeLabel}`
    return {
      ok: true,
      display: `截取${label}`,
      images: [{ mimeType: 'image/png', base64Data, role: 'target', label }]
    }
  })
}

function executeCaptureOverview(ctx, input) {
  const blocked = ensureCaptureBudget(ctx, 1)
  if (blocked) return blocked
  const viewport = ctx.viewport
  if (!viewport || typeof viewport.captureImageBase64 !== 'function') {
    return { ok: false, error: '视口未就绪，无法截图', display: '截图失败' }
  }
  const scene = ctx.getScene()
  const saved =
    viewport.camera && viewport.controls
      ? {
          position: viewport.camera.position.clone(),
          target: viewport.controls.target.clone(),
          fov: viewport.camera.fov
        }
      : null

  return withTimelinePose(ctx, input.timeSeconds, () => {
    try {
      const allIds = (scene.objects || []).map((object) => object.id).filter(Boolean)
      if (typeof viewport.focusView === 'function') {
        viewport.focusView(allIds.length > 0 ? allIds : undefined)
      }
      const base64Data = viewport.captureImageBase64(AI_CAPTURE_MAX_DIMENSION)
      if (!base64Data) {
        return { ok: false, error: '总览截图失败', display: '总览截图失败' }
      }
      ctx.budget.capturesUsed += 1
      const timeLabel =
        typeof input.timeSeconds === 'number' ? ` t=${input.timeSeconds.toFixed(1)}s` : ''
      const label = `主视角总览${timeLabel}`
      return {
        ok: true,
        display: `截取${label}`,
        images: [{ mimeType: 'image/png', base64Data, role: 'overview', label }]
      }
    } finally {
      if (saved && viewport.camera && viewport.controls) {
        viewport.camera.position.copy(saved.position)
        viewport.controls.target.copy(saved.target)
        viewport.camera.fov = saved.fov
        viewport.camera.updateProjectionMatrix()
        viewport.controls.update()
        viewport.camera.updateMatrixWorld(true)
      }
    }
  })
}

function executeCaptureTimelinePair(ctx, input) {
  const blocked = ensureCaptureBudget(ctx, 2)
  if (blocked) return blocked
  const targetResult = executeCaptureTarget(ctx, input)
  if (!targetResult.ok) return targetResult
  const overviewResult = executeCaptureOverview(ctx, input)
  if (!overviewResult.ok) {
    return { ...overviewResult, images: targetResult.images || [] }
  }
  return {
    ok: true,
    display: `截取 t=${Number(input.timeSeconds || 0).toFixed(1)}s 双视角`,
    images: [...(targetResult.images || []), ...(overviewResult.images || [])]
  }
}

/**
 * 兼容模型常见的 tool 参数形态：
 * - { commands: [...] }
 * - { commands: "[{...}]" }（字符串化数组）
 * - 直接传命令数组
 * - { command: {...} } / 单条命令对象
 */
function normalizeCommandsArg(input) {
  if (Array.isArray(input)) return input
  if (!input || typeof input !== 'object') return []
  let raw = input.commands
  if (raw === undefined && input.command !== undefined) raw = input.command
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') return [raw]
  // 有的模型把 type/kind 直接放在 arguments 根上。
  if (typeof input.type === 'string') return [input]
  return []
}

function executeApplyCommands(ctx, input) {
  const raw = normalizeCommandsArg(input)
  if (typeof console !== 'undefined' && console.debug) {
    console.debug('[ai-tools] apply_scene_commands raw:', raw)
  }
  const { commands, rejected } = parseCommandList(raw)
  if (commands.length === 0) {
    const hint =
      rejected.length > 0
        ? `没有通过校验的合法命令（拒绝 ${rejected.slice(0, 8).join(', ')}）。请只用 clear_scene/add_object(box|cylinder|sphere|wall|floor)/add_mannequin/update_object/remove_object/set_camera/animate_move；树用 cylinder，人物用 add_mannequin，360 环绕用 animate_move + cameraFollow:{mode:"orbit",orbitDegrees:360}。`
        : 'commands 不能为空'
    return {
      ok: false,
      error: hint,
      rejected,
      display: rejected.length > 0 ? `没有合法命令（${rejected.slice(0, 3).join(', ')}）` : '没有合法命令'
    }
  }
  const scene = ctx.getScene()
  const result = applyAiSceneCommands(scene, commands)
  if (typeof ctx.commitScene === 'function') {
    ctx.commitScene(result.scene)
  }
  const summary = commands
    .slice(0, 8)
    .map((command) => describeCommand(command))
    .join('；')
  return {
    ok: true,
    applied: result.applied,
    skipped: result.skipped,
    rejected: rejected.length > 0 ? rejected : undefined,
    hasTimelineAnimation: result.hasTimelineAnimation,
    display:
      result.skipped.length > 0
        ? `已执行 ${result.applied} 条，跳过 ${result.skipped.length}：${result.skipped[0]}`
        : `已执行 ${result.applied} 条：${summary}`
  }
}

/** 给对话面板用的短摘要（避免刷 base64）。 */
export function summarizeToolResult(name, result) {
  if (result?.display) return result.display
  return name
}
