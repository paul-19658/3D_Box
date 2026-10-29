import { describe, expect, it, vi } from 'vitest'

import { AI_TOOL_DEFINITIONS, executeAiTool, summarizeToolResult } from '@/core/ai-tools'
import { createInitialScene } from '@/core/scene'

function makeCtx(scene, extras = {}) {
  let current = scene
  return {
    getScene: () => current,
    commitScene: (next) => {
      current = next
    },
    budget: { capturesUsed: 0 },
    ...extras,
    _getCommitted: () => current
  }
}

describe('AI tool definitions', () => {
  it('包含首批 agent 工具', () => {
    const names = AI_TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(names).toEqual([
      'list_assets',
      'get_object',
      'capture_target_camera',
      'capture_overview_camera',
      'capture_timeline_pair',
      'apply_scene_commands',
      'done'
    ])
  })
})

describe('executeAiTool', () => {
  it('list_assets 返回分页资产（含 color）', () => {
    const scene = createInitialScene()
    scene.objects.push({
      ...scene.objects[0],
      id: 'obj-2',
      name: '墙 01',
      kind: 'wall',
      color: '#aabbcc'
    })
    const ctx = makeCtx(scene)
    const result = executeAiTool('list_assets', { offset: 0, limit: 10 }, ctx)
    expect(result.ok).toBe(true)
    expect(result.total).toBe(2)
    expect(result.items[0].color).toBeTruthy()
    expect(result.items[1].name).toBe('墙 01')
    expect(summarizeToolResult('list_assets', result)).toContain('查询资产')
  })

  it('get_object 按名称返回完整变换与颜色', () => {
    const scene = createInitialScene()
    const ctx = makeCtx(scene)
    const result = executeAiTool('get_object', { name: '方块 01' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.found).toBe(true)
    expect(result.position).toEqual(scene.objects[0].position)
    expect(result.size).toEqual(scene.objects[0].size)
    expect(result.color).toBe(scene.objects[0].color)
  })

  it('get_object 找不到时返回失败', () => {
    const result = executeAiTool('get_object', { name: '不存在' }, makeCtx(createInitialScene()))
    expect(result.ok).toBe(false)
    expect(result.found).toBe(false)
  })

  it('apply_scene_commands 可 clear / add / remove', () => {
    const scene = createInitialScene()
    const ctx = makeCtx(scene)

    const clear = executeAiTool(
      'apply_scene_commands',
      { commands: [{ type: 'clear_scene' }] },
      ctx
    )
    expect(clear.ok).toBe(true)
    expect(ctx._getCommitted().objects).toHaveLength(0)

    const add = executeAiTool(
      'apply_scene_commands',
      {
        commands: [
          { type: 'add_mannequin', name: '跳舞女孩' },
          { type: 'add_mannequin', name: '跳舞女孩_补齐' }
        ]
      },
      ctx
    )
    expect(add.ok).toBe(true)
    expect(ctx._getCommitted().objects).toHaveLength(2)

    const remove = executeAiTool(
      'apply_scene_commands',
      { commands: [{ type: 'remove_object', name: '跳舞女孩_补齐' }] },
      ctx
    )
    expect(remove.ok).toBe(true)
    expect(ctx._getCommitted().objects.map((o) => o.name)).toEqual(['跳舞女孩'])
  })

  it('apply_scene_commands 拒绝空或非法命令', () => {
    const empty = executeAiTool('apply_scene_commands', { commands: [] }, makeCtx(createInitialScene()))
    expect(empty.ok).toBe(false)

    const invalid = executeAiTool(
      'apply_scene_commands',
      { commands: [{ type: 'add_object', kind: 'dragon' }] },
      makeCtx(createInitialScene())
    )
    expect(invalid.ok).toBe(false)
    expect(invalid.error).toContain('add_object/dragon')
  })

  it('apply_scene_commands 对截断的 raw JSON 给出明确错误', () => {
    const result = executeAiTool(
      'apply_scene_commands',
      {
        raw: '{"commands":[{"type":"clear_scene"},{"type":"add_object","kind":"cylinder","position":{"x":'
      },
      makeCtx(createInitialScene())
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('截断')
    expect(result.display).toContain('maxTokens')
  })

  it('apply_scene_commands 兼容别名、字符串数字与字符串化 commands', () => {
    const ctx = makeCtx(createInitialScene())
    const aliased = executeAiTool(
      'apply_scene_commands',
      {
        commands: [
          { type: 'clear_scene' },
          { type: 'add_object', kind: 'tree', name: '树1', position: { x: '2', y: '0', z: '-1' } },
          { type: 'add_object', kind: 'person', name: '舞者', position: { x: 0, y: 0, z: 0 } },
          {
            type: 'animate_move',
            name: '舞者',
            path: [
              { x: 0, z: 0 },
              { x: 0.01, z: 0.01 }
            ],
            cameraFollow: { mode: 'orbit', orbitDegrees: '360', radius: '8' }
          }
        ]
      },
      ctx
    )
    expect(aliased.ok).toBe(true)
    expect(aliased.applied).toBeGreaterThanOrEqual(3)
    expect(ctx._getCommitted().objects.some((o) => o.kind === 'cylinder')).toBe(true)
    expect(ctx._getCommitted().objects.some((o) => o.kind === 'mannequin')).toBe(true)

    const asString = executeAiTool(
      'apply_scene_commands',
      { commands: JSON.stringify([{ type: 'clear_scene' }, { type: 'add_mannequin', name: 'A' }]) },
      makeCtx(createInitialScene())
    )
    expect(asString.ok).toBe(true)
  })

  it('done 标记完成并可附 summary', () => {
    const result = executeAiTool('done', { summary: '已搭好房间' }, makeCtx(createInitialScene()))
    expect(result.ok).toBe(true)
    expect(result.done).toBe(true)
    expect(result.summary).toBe('已搭好房间')
  })

  it('截图工具用 mock viewport，并计入额度', () => {
    const viewport = {
      captureFromCameraState: vi.fn(() => 'target-b64'),
      captureImageBase64: vi.fn(() => 'overview-b64'),
      focusView: vi.fn(),
      camera: {
        position: { clone: () => ({ x: 1, y: 2, z: 3 }), copy: vi.fn(), fov: 42, updateProjectionMatrix: vi.fn(), updateMatrixWorld: vi.fn() },
        fov: 42,
        updateProjectionMatrix: vi.fn(),
        updateMatrixWorld: vi.fn()
      },
      controls: {
        target: { clone: () => ({ x: 0, y: 1, z: 0 }), copy: vi.fn() },
        update: vi.fn()
      }
    }
    const ctx = makeCtx(createInitialScene(), { viewport })

    const target = executeAiTool('capture_target_camera', {}, ctx)
    expect(target.ok).toBe(true)
    expect(target.images[0].base64Data).toBe('target-b64')
    expect(ctx.budget.capturesUsed).toBe(1)

    const overview = executeAiTool('capture_overview_camera', {}, ctx)
    expect(overview.ok).toBe(true)
    expect(overview.images[0].base64Data).toBe('overview-b64')
    expect(ctx.budget.capturesUsed).toBe(2)
    expect(viewport.focusView).toHaveBeenCalled()

    const pair = executeAiTool('capture_timeline_pair', { timeSeconds: 1.5 }, ctx)
    expect(pair.ok).toBe(true)
    expect(pair.images).toHaveLength(2)
    expect(ctx.budget.capturesUsed).toBe(4)
  })

  it('截图额度用尽后拒绝继续截', () => {
    const viewport = {
      captureFromCameraState: vi.fn(() => 'x'),
      captureImageBase64: vi.fn(() => 'y'),
      focusView: vi.fn(),
      camera: null,
      controls: null
    }
    const ctx = makeCtx(createInitialScene(), {
      viewport,
      budget: { capturesUsed: 12 }
    })
    const result = executeAiTool('capture_target_camera', {}, ctx)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('额度')
  })

  it('未知工具返回错误', () => {
    const result = executeAiTool('fly_to_moon', {}, makeCtx(createInitialScene()))
    expect(result.ok).toBe(false)
  })
})
