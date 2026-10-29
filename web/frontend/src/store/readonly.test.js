/**
 * 只读模式下场景 mutation 必须被拦住（含 AI 绕过 editScene 的路径）。
 */
import { describe, expect, it } from 'vitest'
import store from '@/store'
import { createInitialScene } from '@/core/scene'

describe('read-only project guards', () => {
  it('blocks commitScene / undo / redo when readOnlyProject is set', () => {
    const scene = createInitialScene()
    store.commit('setReadOnlyProject', null)
    store.commit('resetScene', scene)
    store.commit('commitScene', {
      ...scene,
      objects: [...scene.objects, { ...scene.objects[0], id: 'extra', name: '额外' }]
    })
    expect(store.state.history.present.objects.some((item) => item.id === 'extra')).toBe(true)

    store.commit('setReadOnlyProject', { projectId: 'p1', ownerUsername: 'bob' })
    const before = store.state.history.present
    store.commit('commitScene', createInitialScene())
    store.commit('undoScene')
    store.commit('redoScene')
    expect(store.state.history.present).toBe(before)

    store.commit('setReadOnlyProject', null)
  })
})
