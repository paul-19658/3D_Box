import { useCallback, useRef, useState } from 'react'
import { commitHistory, createHistory, redoHistory, undoHistory } from './history'
import { createInitialScene, type SceneState } from './scene'

export interface SceneHistoryController {
  scene: SceneState
  canUndo: boolean
  canRedo: boolean
  /** 同步读取当前场景（不受 React 异步渲染 / 回调闭包影响）。 */
  getScene: () => SceneState
  commit: (update: (scene: SceneState) => SceneState) => void
  undo: () => void
  redo: () => void
  reset: (scene?: SceneState) => void
}

export function useSceneHistory(): SceneHistoryController {
  const [history, setHistory] = useState(() => createHistory(createInitialScene()))
  const presentRef = useRef(history.present)
  presentRef.current = history.present

  const getScene = useCallback((): SceneState => presentRef.current, [])

  const commit = useCallback((update: (scene: SceneState) => SceneState): void => {
    setHistory((current) => {
      const next = commitHistory(current, update(current.present))
      presentRef.current = next.present
      return next
    })
  }, [])

  const undo = useCallback((): void => {
    setHistory((current) => {
      const next = undoHistory(current)
      presentRef.current = next.present
      return next
    })
  }, [])

  const redo = useCallback((): void => {
    setHistory((current) => {
      const next = redoHistory(current)
      presentRef.current = next.present
      return next
    })
  }, [])

  const reset = useCallback((scene: SceneState = createInitialScene()): void => {
    const next = createHistory(scene)
    presentRef.current = next.present
    setHistory(next)
  }, [])

  return {
    scene: history.present,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    getScene,
    commit,
    undo,
    redo,
    reset
  }
}
