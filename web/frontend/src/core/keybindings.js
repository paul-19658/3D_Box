/**
 * 快捷键注册表：动作定义、绑定值的规范化 / 格式化、预设、冲突检测。
 *
 * 这一层**纯函数、零依赖**，可以直接在 Node 里测——快捷键逻辑最容易出的问题
 * （同一个键绑了两个动作、预设之间串味、按住不放的键在 keyup 时清不掉）
 * 全都能在这里用单测锁住，不必开浏览器。
 *
 * ## 绑定值的表示
 *
 * 统一用一个规范字符串，例如 `'q'`、`'shift'`、`'ctrl+z'`、`'alt+v'`、`'space'`。
 * 好处是既能当 Map 的键做冲突检测，又能直接存进 localStorage。
 *
 * ## 为什么 Shift 有时算修饰键、有时不算
 *
 * 按 Shift+A 时浏览器给的 `event.key` 已经是 `'A'`（大写）——字符本身已经
 * 编码了 Shift。若再记一个 `shift` 修饰键，`'shift+a'` 和 `'a'` 就成了两个
 * 不同的绑定，用户永远猜不到自己绑的是哪个。
 *
 * 所以规则是：**可打印字符不把 Shift 当修饰键**（`Shift+A` → `'a'`），
 * **非可打印键照常记**（`Shift+ArrowUp` → `'shift+arrowup'`，`Shift` 单独
 * 按下 → `'shift'`，正好覆盖"加速键"这种用法）。
 */

/** 动作生效的上下文。互斥的 scope 之间允许绑同一个键。 */
export const SCOPES = {
  /** 任何地方都生效（撤销 / 保存 / 播放），但仍会让位给输入框。 */
  GLOBAL: 'global',
  /** 编辑器普通状态（不在相机视角里）。 */
  EDITOR: 'editor',
  /** 相机视角内的飞行导航（按住不放）。 */
  CAMERA_NAV: 'cameraNav'
}

/**
 * 所有可配置动作。
 *
 * `kind: 'hold'` 表示按住持续生效（飞行键）；`'press'` 表示按一下触发一次。
 * `scope` 决定"什么时候轮到它"，也是冲突检测的依据。
 */
export const KEYBINDING_ACTIONS = [
  // ---- 工具（对标 Maya 的 Q/W/E/R）----
  { id: 'tool.select', label: '选择工具', group: '工具', scope: SCOPES.EDITOR, kind: 'press' },
  { id: 'tool.translate', label: '移动工具', group: '工具', scope: SCOPES.EDITOR, kind: 'press' },
  { id: 'tool.rotate', label: '旋转工具', group: '工具', scope: SCOPES.EDITOR, kind: 'press' },
  { id: 'tool.scale', label: '缩放工具', group: '工具', scope: SCOPES.EDITOR, kind: 'press' },

  // ---- 相机飞行（按住）----
  { id: 'nav.forward', label: '相机：前进', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },
  { id: 'nav.backward', label: '相机：后退', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },
  { id: 'nav.left', label: '相机：左移', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },
  { id: 'nav.right', label: '相机：右移', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },
  { id: 'nav.up', label: '相机：上升', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },
  { id: 'nav.down', label: '相机：下降', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },
  { id: 'nav.boost', label: '相机：加速', group: '相机飞行', scope: SCOPES.CAMERA_NAV, kind: 'hold' },

  // ---- 通用 ----
  { id: 'edit.undo', label: '撤销', group: '通用', scope: SCOPES.GLOBAL, kind: 'press' },
  { id: 'edit.redo', label: '重做', group: '通用', scope: SCOPES.GLOBAL, kind: 'press' },
  { id: 'file.save', label: '保存工程', group: '通用', scope: SCOPES.GLOBAL, kind: 'press' },
  { id: 'timeline.play', label: '播放 / 暂停', group: '通用', scope: SCOPES.GLOBAL, kind: 'press' }
]

/** 动作 id → 动作定义，便于 O(1) 查。 */
export const ACTION_BY_ID = KEYBINDING_ACTIONS.reduce((map, action) => {
  map[action.id] = action
  return map
}, {})

/**
 * 预设。
 *
 * 三套的差异集中在**变换工具**与**播放**上，这与 Maya / Blender 的实际习惯一致：
 *
 * | 动作 | 本应用默认 | Maya | Blender |
 * | --- | --- | --- | --- |
 * | 选择 | Q | Q | W |
 * | 移动 | W | W | G |
 * | 旋转 | E | E | R |
 * | 缩放 | R | R | S |
 * | 播放/暂停 | Space | Alt+V | Space |
 *
 * 相机飞行键三套都是 WASD/QE——这不是偷懒：Maya 的飞行模式与 Blender 的
 * fly 模式用的也是 WASD。真正的差别在"怎么进入飞行"，而那个由导航方案决定
 * （见 core/camera-nav.js），不属于快捷键。
 *
 * 撤销/保存三套都是 Ctrl+Z / Ctrl+S，这也是事实上的通用约定。
 */
export const KEYBINDING_PRESETS = [
  {
    id: 'default',
    label: '本应用默认',
    description: 'Q/W/E/R 切换变换工具，空格播放',
    bindings: {
      'tool.select': 'q',
      'tool.translate': 'w',
      'tool.rotate': 'e',
      'tool.scale': 'r',
      'nav.forward': 'w',
      'nav.backward': 's',
      'nav.left': 'a',
      'nav.right': 'd',
      'nav.up': 'e',
      'nav.down': 'q',
      'nav.boost': 'shift',
      'edit.undo': 'ctrl+z',
      'edit.redo': 'ctrl+shift+z',
      'file.save': 'ctrl+s',
      'timeline.play': 'space'
    }
  },
  {
    id: 'maya',
    label: 'Maya',
    description: 'Q/W/E/R 变换工具，Alt+V 播放',
    bindings: {
      'tool.select': 'q',
      'tool.translate': 'w',
      'tool.rotate': 'e',
      'tool.scale': 'r',
      'nav.forward': 'w',
      'nav.backward': 's',
      'nav.left': 'a',
      'nav.right': 'd',
      'nav.up': 'e',
      'nav.down': 'q',
      'nav.boost': 'shift',
      'edit.undo': 'ctrl+z',
      'edit.redo': 'ctrl+shift+z',
      'file.save': 'ctrl+s',
      'timeline.play': 'alt+v'
    }
  },
  {
    id: 'blender',
    label: 'Blender',
    description: 'G/R/S 移动/旋转/缩放，W 选择，空格播放',
    bindings: {
      'tool.select': 'w',
      'tool.translate': 'g',
      'tool.rotate': 'r',
      'tool.scale': 's',
      'nav.forward': 'w',
      'nav.backward': 's',
      'nav.left': 'a',
      'nav.right': 'd',
      'nav.up': 'e',
      'nav.down': 'q',
      'nav.boost': 'shift',
      'edit.undo': 'ctrl+z',
      'edit.redo': 'ctrl+shift+z',
      'file.save': 'ctrl+s',
      'timeline.play': 'space'
    }
  }
]

export const DEFAULT_PRESET_ID = 'default'

/** 规范顺序的修饰键，保证 `ctrl+shift+z` 不会写成两种形式。 */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift']

/** 某些键在 `event.key` 里有别名，统一成规范名。 */
const KEY_ALIASES = {
  ' ': 'space',
  spacebar: 'space',
  escape: 'escape',
  esc: 'escape',
  arrowup: 'arrowup',
  up: 'arrowup',
  arrowdown: 'arrowdown',
  down: 'arrowdown',
  arrowleft: 'arrowleft',
  left: 'arrowleft',
  arrowright: 'arrowright',
  right: 'arrowright',
  control: 'ctrl',
  meta: 'ctrl',
  os: 'ctrl',
  command: 'ctrl'
}

/** 只按了修饰键本身时，`event.key` 的值 → 规范名。 */
const MODIFIER_KEYS = new Set(['shift', 'control', 'meta', 'alt', 'os'])

function isPrintableKey(key) {
  return typeof key === 'string' && key.length === 1
}

/**
 * 把键盘事件规范化成绑定的规范字符串。
 *
 * @param {{key:string, ctrlKey?:boolean, metaKey?:boolean, altKey?:boolean, shiftKey?:boolean}} event
 * @returns {string|null} 无法识别（例如单按 F5 以外的功能键被忽略）时返回 null
 */
export function bindingFromEvent(event) {
  if (!event || typeof event.key !== 'string') return null
  const rawKey = event.key
  const lower = rawKey.toLowerCase()

  // Ctrl/Cmd 合并成 ctrl：同一套配置在 Windows 与 macOS 上都能用。
  const mods = []
  if (event.ctrlKey || event.metaKey) mods.push('ctrl')
  if (event.altKey) mods.push('alt')
  /*
   * Shift 什么时候算修饰键？这里有个必须处理好的两难：
   *
   * - `Shift+A` 的 `event.key` 已经是 `'A'`，字符本身编码了 Shift。
   *   若再记 `shift`，`'shift+a'` 与 `'a'` 就成了两个绑定，用户猜不到自己绑了哪个。
   * - 但 `Ctrl+Shift+Z`（重做）**必须**与 `Ctrl+Z`（撤销）区分开。
   *
   * 真实软件的做法是分情况：**已经有 Ctrl/Alt 时 Shift 算修饰键；
   * Shift 是唯一修饰键且键可打印时，折叠进字符本身。**
   * 非可打印键（方向键、单独按 Shift）照常记。
   */
  if (event.shiftKey && (!isPrintableKey(rawKey) || mods.length > 0)) mods.push('shift')

  const key = KEY_ALIASES[lower] ?? lower
  if (!key) return null
  // 只按了 Ctrl / Alt 这类修饰键本身：不构成一个绑定。
  if (MODIFIER_KEYS.has(lower) && mods.length > 0) {
    // 例外：单独按 Shift 就是要绑"加速"，把它当作 key='shift' 且无修饰。
    if (lower === 'shift' && mods.length === 1 && mods[0] === 'shift') return 'shift'
    return null
  }
  return [...MODIFIER_ORDER.filter((mod) => mods.includes(mod)), key].join('+')
}

/**
 * 规范化一个手写的绑定字符串。
 * 接受 `'Ctrl + Shift + Z'`、`'CTRL+Z'`、`'Q'` 这类写法。
 */
export function normalizeBinding(value) {
  if (typeof value !== 'string') return null
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const key = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  for (const mod of mods) if (!MODIFIER_ORDER.includes(mod)) return null
  const normalizedKey = KEY_ALIASES[key] ?? key
  if (!normalizedKey) return null
  return [...MODIFIER_ORDER.filter((mod) => mods.has(mod)), normalizedKey].join('+')
}

const KEY_LABELS = {
  space: '空格',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  escape: 'Esc',
  enter: '回车',
  backspace: '退格',
  delete: 'Delete',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
}

const MODIFIER_LABELS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }

/**
 * 把绑定格式化成界面文字。
 *
 * macOS 上把 ctrl 显示成 ⌘ —— 内部存储仍然是 `ctrl+z`（与平台无关），
 * 只有显示层做区分。
 */
export function formatBinding(binding, platform = 'other') {
  const normalized = normalizeBinding(binding)
  if (!normalized) return ''
  const parts = normalized.split('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  const isMac = platform === 'mac'
  const modLabels = mods.map((mod) => {
    if (mod === 'ctrl') return isMac ? '⌘' : 'Ctrl'
    if (mod === 'alt') return isMac ? '⌥' : 'Alt'
    if (mod === 'shift') return isMac ? '⇧' : 'Shift'
    return MODIFIER_LABELS[mod] ?? mod
  })
  /*
   * 键名本身可能就是修饰键（单独把 Shift 绑成"加速"），
   * 那种情况下它要显示成 `Shift` 而不是小写的 `shift`。
   */
  const keyLabel =
    MODIFIER_LABELS[key] ?? KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...modLabels, keyLabel].join('+')
}

/**
 * 两个 scope 是否会**同时生效**。
 *
 * `global` 与任何 scope 都可能撞车；`editor` 与 `cameraNav` 互斥
 * （进相机视角时工具键让位给飞行键，这正是 W 既能"前进"又能"移动工具"的原因）。
 */
export function scopesOverlap(a, b) {
  if (a === b) return true
  if (a === SCOPES.GLOBAL || b === SCOPES.GLOBAL) return true
  return false
}

/**
 * 找出所有冲突：同一个绑定被两个**会同时生效**的动作占用。
 *
 * @returns {Array<{binding:string, actions:Array<object>}>}
 */
export function findConflicts(bindings) {
  const byBinding = new Map()
  for (const action of KEYBINDING_ACTIONS) {
    const binding = normalizeBinding(bindings?.[action.id])
    if (!binding) continue
    if (!byBinding.has(binding)) byBinding.set(binding, [])
    byBinding.get(binding).push(action)
  }
  const conflicts = []
  for (const [binding, actions] of byBinding) {
    if (actions.length < 2) continue
    const clashing = actions.some((a, i) =>
      actions.slice(i + 1).some((b) => scopesOverlap(a.scope, b.scope))
    )
    if (clashing) conflicts.push({ binding, actions })
  }
  return conflicts
}

/**
 * 用某个动作的绑定去匹配一次键盘事件。
 *
 * @param {object} bindings 动作 id → 绑定
 * @param {object} event 键盘事件
 * @param {{ actions?: Array<object>, scopes?: string[] }} options
 *        `actions`：只在这些动作里找（调用方各自负责自己那批）；
 *        `scopes`：只在这些 scope 里找。
 * @returns {object|null} 命中的动作定义
 */
export function matchAction(bindings, event, options = {}) {
  const binding = bindingFromEvent(event)
  if (!binding) return null
  const scopes = options.scopes ? new Set(options.scopes) : null
  const candidates = options.actions ?? KEYBINDING_ACTIONS
  for (const action of candidates) {
    if (scopes && !scopes.has(action.scope)) continue
    if (normalizeBinding(bindings?.[action.id]) !== binding) continue
    return action
  }
  return null
}

/** 取某个预设的绑定表（深拷贝，调用方随便改）。 */
export function presetBindings(presetId) {
  const preset = KEYBINDING_PRESETS.find((item) => item.id === presetId)
  const source = preset ?? KEYBINDING_PRESETS[0]
  return { ...source.bindings }
}

export const DEFAULT_KEYBINDINGS = presetBindings(DEFAULT_PRESET_ID)

/**
 * 把任意来源的绑定表清洗成"只含已知动作、且都合法"的表。
 *
 * 用于载入 localStorage：用户可能手改过存储、也可能升级后动作被删了。
 * 缺的动作一律回落到默认绑定，避免出现"某个快捷键突然没了"。
 */
export function sanitizeBindings(input) {
  const result = {}
  for (const action of KEYBINDING_ACTIONS) {
    const normalized = normalizeBinding(input?.[action.id])
    result[action.id] = normalized ?? DEFAULT_KEYBINDINGS[action.id] ?? null
  }
  return result
}

/** 判断给定绑定表是否与某个预设完全一致（用于界面高亮预设）。 */
export function matchesPreset(bindings, presetId) {
  const preset = presetBindings(presetId)
  return KEYBINDING_ACTIONS.every(
    (action) => normalizeBinding(bindings?.[action.id]) === normalizeBinding(preset[action.id])
  )
}

/** 动作按 group 分组，保持 KEYBINDING_ACTIONS 里的顺序。 */
export function groupedActions() {
  const groups = []
  for (const action of KEYBINDING_ACTIONS) {
    let group = groups.find((item) => item.label === action.group)
    if (!group) {
      group = { label: action.group, actions: [] }
      groups.push(group)
    }
    group.actions.push(action)
  }
  return groups
}
