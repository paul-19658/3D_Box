/**
 * 手动编辑覆盖（`timelineEditOverrides`）的 store 行为测试。
 *
 * 守的是"在有动画的物体上拖拽"这条链路：物体一旦有关键帧，
 * 时间轴求值就会在每个时刻覆盖它的变换；如果没人记下"这个物体刚被手动改过"，
 * 用户拖完会立刻被拽回原处，看起来像"位置被锁死、拖不动"。
 *
 * 覆盖必须放在唯一写入口 `editScene`，否则任何绕过它的写入路径都会漏。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import store from '@/store'
import { createInitialScene } from '@/core/scene'

/*
 * vitest 跑在 node 环境（没有 jsdom），而 `editScene` 末尾的自动保存节流
 * 会用到 `window.setTimeout`。注入一个最小替身：
 * 计时器**故意不真正触发**——这里测的是覆盖记账，不是自动保存；
 * 让它触发会顺带发起网络请求，把测试变成依赖环境的。
 */
globalThis.window ??= {
  setTimeout: () => 0,
  clearTimeout: () => {},
  localStorage: { getItem: () => null, setItem: () => {} }
}

function objectId() {
  return store.state.history.present.objects[0].id
}

function moveObject(id, x) {
  store.dispatch('editScene', (scene) => ({
    ...scene,
    objects: scene.objects.map((item) =>
      item.id === id ? { ...item, position: { ...item.position, x } } : item
    )
  }))
}

describe('timelineEditOverrides', () => {
  beforeEach(() => {
    store.commit('setReadOnlyProject', null)
    store.commit('setAutoKeyEnabled', false)
    store.commit('setTimelinePlaying', false)
    store.commit('setTimelineTime', 0)
    store.commit('resetScene', createInitialScene())
  })

  it('拖动物体后记下它的 id（供显示层压过求值）', () => {
    const id = objectId()
    moveObject(id, 5)
    expect(store.state.timelineEditOverrides).toContain(id)
  })

  it('只改颜色不算"可动画属性"变化，不该产生覆盖', () => {
    const id = objectId()
    store.dispatch('editScene', (scene) => ({
      ...scene,
      objects: scene.objects.map((item) => (item.id === id ? { ...item, color: '#123456' } : item))
    }))
    expect(store.state.timelineEditOverrides).toEqual([])
  })

  it('播放头一变，覆盖立刻失效（重新由关键帧求值说话）', () => {
    moveObject(objectId(), 5)
    expect(store.state.timelineEditOverrides).not.toEqual([])
    store.commit('setTimelineTime', 2)
    expect(store.state.timelineEditOverrides).toEqual([])
  })

  it('开始播放时覆盖清空（播放必须严格按关键帧走）', () => {
    moveObject(objectId(), 5)
    expect(store.state.timelineEditOverrides).not.toEqual([])
    store.commit('setTimelinePlaying', true)
    expect(store.state.timelineEditOverrides).toEqual([])
    store.commit('setTimelinePlaying', false)
  })

  it('播放中拖拽不产生覆盖', () => {
    store.commit('setTimelinePlaying', true)
    moveObject(objectId(), 5)
    expect(store.state.timelineEditOverrides).toEqual([])
    store.commit('setTimelinePlaying', false)
  })

  it('只读工程不产生覆盖', () => {
    store.commit('setReadOnlyProject', { projectId: 'p1', ownerUsername: 'bob' })
    moveObject(objectId(), 5)
    expect(store.state.timelineEditOverrides).toEqual([])
    store.commit('setReadOnlyProject', null)
  })

  it('多个物体被改时逐个记下，且不重复累积', () => {
    const first = store.state.history.present.objects[0].id
    store.commit('resetScene', {
      ...createInitialScene(),
      objects: [
        { ...createInitialScene().objects[0], id: 'a' },
        { ...createInitialScene().objects[0], id: 'b' }
      ]
    })
    moveObject('a', 1)
    moveObject('a', 2)
    moveObject('b', 3)
    expect([...store.state.timelineEditOverrides].sort()).toEqual(['a', 'b'])
    expect(first).toBeTruthy()
  })
})
