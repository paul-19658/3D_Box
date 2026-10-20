/**
 * 撤销 / 重做历史。
 * 移植自 `app/src/renderer/src/scene-core/history.ts`。
 *
 * 上限 100 步：超过后丢弃最旧记录，避免长时间编辑把内存吃满。
 * 用 Object.is 判断"是否真的变化"，防止重复提交同一状态占满历史。
 */

export const HISTORY_LIMIT = 100

export function createHistory(initialState) {
  return { past: [], present: initialState, future: [] }
}

export function commitHistory(history, nextState) {
  if (Object.is(history.present, nextState)) return history
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: nextState,
    future: []
  }
}

export function undoHistory(history) {
  const previous = history.past[history.past.length - 1]
  if (previous === undefined) return history
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future]
  }
}

export function redoHistory(history) {
  const next = history.future[0]
  if (next === undefined) return history
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: history.future.slice(1)
  }
}
