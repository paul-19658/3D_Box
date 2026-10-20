import { describe, expect, it } from 'vitest'

import { alignObjects, distributeObjects, placeNewObject, placeOnGround } from '@/core/layout'

const object = (id, x, y, z, size = 2) => ({
  id,
  kind: 'box',
  name: id,
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  size: { x: size, y: size, z: size },
  color: '#c9cdd0',
  visible: true,
  locked: false
})

describe('layout', () => {
  it('对齐只影响选中且未锁定的物体', () => {
    const objects = [object('a', 0, 1, 0), object('b', 5, 1, 0), object('c', 9, 1, 0)]
    const result = alignObjects(objects, new Set(['a', 'b']), 'x', 'center')
    expect(result[0].position.x).toBe(result[1].position.x)
    expect(result[2].position.x).toBe(9)
  })

  it('锁定的物体不会被对齐', () => {
    const objects = [{ ...object('a', 0, 1, 0), locked: true }, object('b', 5, 1, 0)]
    const result = alignObjects(objects, new Set(['a', 'b']), 'x', 'center')
    expect(result[0].position.x).toBe(0)
  })

  it('等距排列保持首尾不动，中间均分', () => {
    const objects = [object('a', 0, 1, 0), object('b', 1, 1, 0), object('c', 10, 1, 0)]
    const result = distributeObjects(objects, new Set(['a', 'b', 'c']), 'x')
    expect(result[0].position.x).toBe(0)
    expect(result[2].position.x).toBe(10)
    expect(result[1].position.x).toBeCloseTo(5, 6)
  })

  it('少于三个物体时等距不做任何事', () => {
    const objects = [object('a', 0, 1, 0), object('b', 1, 1, 0)]
    const result = distributeObjects(objects, new Set(['a', 'b']), 'x')
    expect(result).toEqual(objects)
  })

  it('落地把物体底面贴到 y = 0', () => {
    const objects = [object('a', 0, 5, 0, 2)]
    const result = placeOnGround(objects, new Set(['a']))
    expect(result[0].position.y).toBeCloseTo(1, 6)
  })

  it('新物体放在空场景原点上方', () => {
    const placed = placeNewObject(object('a', 0, 1, 0), [])
    expect(placed.position).toEqual({ x: 0, y: 1, z: 0 })
  })

  it('新物体避开已有物体，不会叠在一起', () => {
    const existing = [object('a', 0, 1, 0)]
    const placed = placeNewObject(object('b', 0, 1, 0), existing)
    const overlaps = placed.position.x === 0 && placed.position.z === 0
    expect(overlaps).toBe(false)
  })
})
