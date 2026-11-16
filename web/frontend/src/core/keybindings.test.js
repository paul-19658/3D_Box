import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  KEYBINDING_PRESETS,
  SCOPES,
  bindingFromEvent,
  findConflicts,
  formatBinding,
  groupedActions,
  matchAction,
  matchesPreset,
  normalizeBinding,
  presetBindings,
  sanitizeBindings,
  scopesOverlap
} from './keybindings'

/** 造一个最小的键盘事件。 */
const ev = (key, mods = {}) => ({
  key,
  ctrlKey: Boolean(mods.ctrl),
  metaKey: Boolean(mods.meta),
  altKey: Boolean(mods.alt),
  shiftKey: Boolean(mods.shift)
})

describe('bindingFromEvent', () => {
  it('普通字符键规范化成小写', () => {
    expect(bindingFromEvent(ev('q'))).toBe('q')
    expect(bindingFromEvent(ev('Q'))).toBe('q')
  })

  it('空格与方向键用规范名', () => {
    expect(bindingFromEvent(ev(' '))).toBe('space')
    expect(bindingFromEvent(ev('ArrowUp'))).toBe('arrowup')
    expect(bindingFromEvent(ev('ArrowLeft'))).toBe('arrowleft')
  })

  it('Ctrl 与 Cmd 合并成 ctrl（跨平台同一套配置）', () => {
    expect(bindingFromEvent(ev('z', { ctrl: true }))).toBe('ctrl+z')
    expect(bindingFromEvent(ev('z', { meta: true }))).toBe('ctrl+z')
  })

  it('修饰键顺序固定，不因按下顺序变化', () => {
    expect(bindingFromEvent(ev('z', { ctrl: true, shift: true }))).toBe('ctrl+shift+z')
    expect(bindingFromEvent(ev('v', { alt: true }))).toBe('alt+v')
  })

  it('可打印字符不把 Shift 当修饰键（Shift+A 就是 a）', () => {
    expect(bindingFromEvent(ev('A', { shift: true }))).toBe('a')
  })

  it('非可打印键保留 Shift（Shift+ArrowUp）', () => {
    expect(bindingFromEvent(ev('ArrowUp', { shift: true }))).toBe('shift+arrowup')
  })

  it('单独按 Shift 得到加速键', () => {
    expect(bindingFromEvent(ev('Shift', { shift: true }))).toBe('shift')
  })

  it('只按 Ctrl / Alt 这类修饰键不构成绑定', () => {
    expect(bindingFromEvent(ev('Control', { ctrl: true }))).toBeNull()
    expect(bindingFromEvent(ev('Alt', { alt: true }))).toBeNull()
  })

  it('非法输入返回 null', () => {
    expect(bindingFromEvent(null)).toBeNull()
    expect(bindingFromEvent({})).toBeNull()
  })
})

describe('normalizeBinding', () => {
  it('容忍空格与大小写', () => {
    expect(normalizeBinding('Ctrl + Shift + Z')).toBe('ctrl+shift+z')
    expect(normalizeBinding('CTRL+Z')).toBe('ctrl+z')
    expect(normalizeBinding(' Q ')).toBe('q')
  })

  it('把 Space / Esc 等别名归一', () => {
    expect(normalizeBinding('Space')).toBe('space')
    expect(normalizeBinding('Esc')).toBe('escape')
  })

  it('未知修饰键与非法值返回 null', () => {
    expect(normalizeBinding('hyper+z')).toBeNull()
    expect(normalizeBinding('')).toBeNull()
    expect(normalizeBinding(null)).toBeNull()
    expect(normalizeBinding(42)).toBeNull()
  })

  it('规范化结果是幂等的', () => {
    for (const preset of KEYBINDING_PRESETS) {
      for (const value of Object.values(preset.bindings)) {
        const once = normalizeBinding(value)
        expect(normalizeBinding(once)).toBe(once)
      }
    }
  })
})

describe('formatBinding', () => {
  it('Windows / Linux 用 Ctrl', () => {
    expect(formatBinding('ctrl+shift+z')).toBe('Ctrl+Shift+Z')
  })

  it('macOS 用符号', () => {
    expect(formatBinding('ctrl+shift+z', 'mac')).toBe('⌘+⇧+Z')
  })

  it('特殊键用中文/符号文案', () => {
    expect(formatBinding('space')).toBe('空格')
    expect(formatBinding('arrowup')).toBe('↑')
    expect(formatBinding('shift')).toBe('Shift')
  })

  it('非法绑定返回空字符串', () => {
    expect(formatBinding('hyper+z')).toBe('')
  })
})

describe('预设', () => {
  it('至少提供 默认 / Maya / Blender 三套', () => {
    const ids = KEYBINDING_PRESETS.map((preset) => preset.id)
    expect(ids).toEqual(expect.arrayContaining(['default', 'maya', 'blender']))
  })

  it('每套预设都覆盖全部动作，且绑定合法', () => {
    for (const preset of KEYBINDING_PRESETS) {
      for (const action of KEYBINDING_ACTIONS) {
        const value = preset.bindings[action.id]
        expect(`${preset.id}.${action.id}`).toBeTruthy()
        expect(normalizeBinding(value)).not.toBeNull()
      }
    }
  })

  it('每套预设自身没有冲突', () => {
    for (const preset of KEYBINDING_PRESETS) {
      expect(`${preset.id}: ${JSON.stringify(findConflicts(preset.bindings).map((c) => c.binding))}`).toBe(
        `${preset.id}: []`
      )
    }
  })

  it('Maya 用 Q/W/E/R，Blender 用 W/G/R/S', () => {
    const maya = presetBindings('maya')
    expect([maya['tool.select'], maya['tool.translate'], maya['tool.rotate'], maya['tool.scale']]).toEqual([
      'q',
      'w',
      'e',
      'r'
    ])
    const blender = presetBindings('blender')
    expect([
      blender['tool.select'],
      blender['tool.translate'],
      blender['tool.rotate'],
      blender['tool.scale']
    ]).toEqual(['w', 'g', 'r', 's'])
  })

  it('播放键：Maya 是 Alt+V，Blender 是空格', () => {
    expect(presetBindings('maya')['timeline.play']).toBe('alt+v')
    expect(presetBindings('blender')['timeline.play']).toBe('space')
  })

  it('presetBindings 返回拷贝，改动不会污染预设', () => {
    const bindings = presetBindings('maya')
    bindings['tool.select'] = 'x'
    expect(presetBindings('maya')['tool.select']).toBe('q')
  })

  it('matchesPreset 能识别当前用的是哪套', () => {
    expect(matchesPreset(presetBindings('maya'), 'maya')).toBe(true)
    expect(matchesPreset(presetBindings('blender'), 'maya')).toBe(false)
  })
})

describe('scopesOverlap / findConflicts', () => {
  it('global 与任何 scope 都可能撞车', () => {
    expect(scopesOverlap(SCOPES.GLOBAL, SCOPES.EDITOR)).toBe(true)
    expect(scopesOverlap(SCOPES.GLOBAL, SCOPES.CAMERA_NAV)).toBe(true)
  })

  it('editor 与 cameraNav 互斥（不进相机视角就不飞）', () => {
    expect(scopesOverlap(SCOPES.EDITOR, SCOPES.CAMERA_NAV)).toBe(false)
  })

  it('同 scope 内重复绑同一键算冲突', () => {
    const bindings = { ...DEFAULT_KEYBINDINGS, 'tool.select': 'w' }
    const conflicts = findConflicts(bindings)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0].binding).toBe('w')
    // W 同时被"选择工具"和"移动工具"占用（两个都在 editor scope）
    expect(conflicts[0].actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(['tool.select', 'tool.translate'])
    )
  })

  it('不同 scope 用同一个键不算冲突（W 既是前进又是移动工具）', () => {
    expect(findConflicts(DEFAULT_KEYBINDINGS)).toEqual([])
  })

  it('全局动作与工具动作撞车会被发现', () => {
    const bindings = { ...DEFAULT_KEYBINDINGS, 'timeline.play': 'q' }
    const conflicts = findConflicts(bindings)
    expect(conflicts.some((c) => c.binding === 'q')).toBe(true)
  })

  it('未绑定的动作不参与冲突检查', () => {
    const bindings = { ...DEFAULT_KEYBINDINGS, 'tool.scale': null }
    expect(findConflicts(bindings)).toEqual([])
  })
})

describe('matchAction', () => {
  it('能匹配到对应动作', () => {
    const action = matchAction(DEFAULT_KEYBINDINGS, ev('w'), { scopes: [SCOPES.EDITOR] })
    expect(action?.id).toBe('tool.translate')
  })

  it('同一个键在不同 scope 解析成不同动作', () => {
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('w'), { scopes: [SCOPES.EDITOR] })?.id).toBe('tool.translate')
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('w'), { scopes: [SCOPES.CAMERA_NAV] })?.id).toBe('nav.forward')
  })

  it('只在自己这批动作里找', () => {
    const own = KEYBINDING_ACTIONS.filter((a) => a.id === 'nav.forward')
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('w'), { actions: own })?.id).toBe('nav.forward')
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('w'), { actions: own, scopes: [SCOPES.EDITOR] })).toBeNull()
  })

  it('没命中返回 null', () => {
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('k'))).toBeNull()
  })

  it('修饰键组合能命中', () => {
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('z', { ctrl: true }))?.id).toBe('edit.undo')
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('z', { ctrl: true, shift: true }))?.id).toBe('edit.redo')
    expect(matchAction(DEFAULT_KEYBINDINGS, ev('s', { ctrl: true }))?.id).toBe('file.save')
  })

  it('Blender 预设下 G 是移动、W 是选择', () => {
    const blender = presetBindings('blender')
    expect(matchAction(blender, ev('g'), { scopes: [SCOPES.EDITOR] })?.id).toBe('tool.translate')
    expect(matchAction(blender, ev('w'), { scopes: [SCOPES.EDITOR] })?.id).toBe('tool.select')
  })
})

describe('sanitizeBindings', () => {
  it('补齐缺失动作，保留合法自定义值', () => {
    const result = sanitizeBindings({ 'tool.select': 'x' })
    expect(result['tool.select']).toBe('x')
    expect(result['tool.translate']).toBe(DEFAULT_KEYBINDINGS['tool.translate'])
    expect(Object.keys(result).sort()).toEqual(KEYBINDING_ACTIONS.map((a) => a.id).sort())
  })

  it('丢弃未知动作与非法值', () => {
    const result = sanitizeBindings({ 'tool.select': 'hyper+z', 'bogus.action': 'q' })
    expect(result['tool.select']).toBe(DEFAULT_KEYBINDINGS['tool.select'])
    expect('bogus.action' in result).toBe(false)
  })

  it('容忍 null / 非对象输入', () => {
    expect(sanitizeBindings(null)['tool.select']).toBe(DEFAULT_KEYBINDINGS['tool.select'])
    expect(sanitizeBindings('nope')['tool.translate']).toBe(DEFAULT_KEYBINDINGS['tool.translate'])
  })
})

describe('groupedActions', () => {
  it('按 group 分组且保持定义顺序', () => {
    const groups = groupedActions()
    expect(groups.map((g) => g.label)).toEqual(['工具', '相机飞行', '通用'])
    expect(groups[0].actions.map((a) => a.id)).toEqual([
      'tool.select',
      'tool.translate',
      'tool.rotate',
      'tool.scale'
    ])
  })

  it('分组后动作总数不变', () => {
    const total = groupedActions().reduce((sum, group) => sum + group.actions.length, 0)
    expect(total).toBe(KEYBINDING_ACTIONS.length)
  })
})
