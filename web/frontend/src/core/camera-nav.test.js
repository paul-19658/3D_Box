/**
 * 相机导航纯逻辑测试。
 *
 * 重点守三件事：
 * 1. 输入框判定不能漏（漏了会导致用户在框里打字时相机乱飞）；
 * 2. 帧率无关性（同样的按键时长在不同帧率下位移一致）；
 * 3. 朝向与机位的正反算必须互逆（否则进出相机视角时画面会跳）。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMERA_NAV_SCHEME,
  NAV_SCHEME_HANDLERS,
  WASD_DEFAULTS,
  applyLookDelta,
  cameraTargetFromOrientation,
  clampDelta,
  computeFlyOffset,
  isEditableTarget,
  movementIntentFromKeys,
  navSchemeHandler,
  orientationFromCameraTarget,
  rotateByQuaternion,
  shouldRunOrbitControls
} from './camera-nav'

describe('isEditableTarget', () => {
  it('输入框 / 文本域 / 下拉框都算"正在输入"，必须拦截', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'input' })).toBe(true)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true)
  })

  it('contenteditable 也算输入态——富文本区域同样会吞掉 wasd', () => {
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })

  it('canvas / body 不算输入态，否则相机永远动不了', () => {
    expect(isEditableTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(isEditableTarget({ tagName: 'BODY' })).toBe(false)
  })

  it('空目标不崩，按"非输入态"处理', () => {
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(undefined)).toBe(false)
    expect(isEditableTarget({})).toBe(false)
  })
})

describe('movementIntentFromKeys', () => {
  it('单键给单位意图：W 是本地 -Z（相机前方）', () => {
    expect(movementIntentFromKeys({ forward: true })).toEqual({ x: 0, y: 0, z: -1 })
    expect(movementIntentFromKeys({ backward: true })).toEqual({ x: 0, y: 0, z: 1 })
    expect(movementIntentFromKeys({ right: true })).toEqual({ x: 1, y: 0, z: 0 })
    expect(movementIntentFromKeys({ left: true })).toEqual({ x: -1, y: 0, z: 0 })
    expect(movementIntentFromKeys({ up: true })).toEqual({ x: 0, y: 1, z: 0 })
    expect(movementIntentFromKeys({ down: true })).toEqual({ x: 0, y: -1, z: 0 })
  })

  it('相反方向同时按下互相抵消，而不是叠加', () => {
    expect(movementIntentFromKeys({ forward: true, backward: true })).toEqual({ x: 0, y: 0, z: 0 })
    expect(movementIntentFromKeys({ left: true, right: true })).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('斜向同时按两个键，两个轴各自有效', () => {
    expect(movementIntentFromKeys({ forward: true, right: true })).toEqual({ x: 1, y: 0, z: -1 })
  })

  it('没有按键时返回零意图', () => {
    expect(movementIntentFromKeys({})).toEqual({ x: 0, y: 0, z: 0 })
    expect(movementIntentFromKeys(undefined)).toEqual({ x: 0, y: 0, z: 0 })
  })
})

describe('clampDelta', () => {
  it('切走标签页再回来时的大间隔被截断，避免相机瞬移', () => {
    expect(clampDelta(3)).toBe(0.1)
  })

  it('非法与负值按 0 处理', () => {
    expect(clampDelta(0)).toBe(0)
    expect(clampDelta(-1)).toBe(0)
    expect(clampDelta(NaN)).toBe(0)
    expect(clampDelta(undefined)).toBe(0)
  })

  it('正常帧间隔原样通过', () => {
    expect(clampDelta(0.016)).toBeCloseTo(0.016, 6)
  })
})

describe('rotateByQuaternion', () => {
  it('单位四元数不改变向量', () => {
    const result = rotateByQuaternion({ x: 1, y: 2, z: 3 }, [0, 0, 0, 1])
    expect(result.x).toBeCloseTo(1, 6)
    expect(result.y).toBeCloseTo(2, 6)
    expect(result.z).toBeCloseTo(3, 6)
  })

  it('绕 Y 轴 90° 时，本地 -Z（前方）转到世界 -X', () => {
    // yaw = +90° → q = (0, sin45, 0, cos45)
    const half = Math.PI / 4
    const q = [0, Math.sin(half), 0, Math.cos(half)]
    const result = rotateByQuaternion({ x: 0, y: 0, z: -1 }, q)
    expect(result.x).toBeCloseTo(-1, 6)
    expect(result.y).toBeCloseTo(0, 6)
    expect(result.z).toBeCloseTo(0, 6)
  })

  it('四元数非法时原样返回，不抛错也不返回 NaN', () => {
    const result = rotateByQuaternion({ x: 1, y: 2, z: 3 }, null)
    expect(result).toEqual({ x: 1, y: 2, z: 3 })
  })
})

describe('computeFlyOffset', () => {
  const identity = [0, 0, 0, 1]

  it('按秒给位移：同样的按键时长在不同帧率下总位移一致', () => {
    // 60fps：60 帧 × 1/60 秒
    let total60 = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < 60; i += 1) {
      const step = computeFlyOffset({
        deltaSeconds: 1 / 60,
        intent: { x: 0, y: 0, z: -1 },
        quaternion: identity
      })
      total60 = { x: total60.x + step.x, y: total60.y + step.y, z: total60.z + step.z }
    }
    // 30fps：30 帧 × 1/30 秒
    let total30 = { x: 0, y: 0, z: 0 }
    for (let i = 0; i < 30; i += 1) {
      const step = computeFlyOffset({
        deltaSeconds: 1 / 30,
        intent: { x: 0, y: 0, z: -1 },
        quaternion: identity
      })
      total30 = { x: total30.x + step.x, y: total30.y + step.y, z: total30.z + step.z }
    }
    expect(total60.z).toBeCloseTo(total30.z, 6)
    expect(total60.z).toBeCloseTo(-WASD_DEFAULTS.moveSpeed, 6)
  })

  it('零意图不产生位移', () => {
    const step = computeFlyOffset({
      deltaSeconds: 0.016,
      intent: { x: 0, y: 0, z: 0 },
      quaternion: identity
    })
    expect(step).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('Shift 加速确实更快', () => {
    const normal = computeFlyOffset({
      deltaSeconds: 0.1,
      intent: { x: 0, y: 0, z: -1 },
      quaternion: identity
    })
    const boosted = computeFlyOffset({
      deltaSeconds: 0.1,
      intent: { x: 0, y: 0, z: -1 },
      quaternion: identity,
      boost: true
    })
    expect(Math.abs(boosted.z)).toBeGreaterThan(Math.abs(normal.z))
  })

  it('升降用独立速度：俯仰飞行时不会跟着水平速度一起放大', () => {
    // 用 0.1 秒（clampDelta 的上限）才能得到"1 秒的十分之一"这段可预期位移。
    const step = computeFlyOffset({
      deltaSeconds: 0.1,
      intent: { x: 0, y: 1, z: 0 },
      quaternion: identity
    })
    expect(step.y).toBeCloseTo(WASD_DEFAULTS.verticalSpeed * 0.1, 6)
  })
})

describe('applyLookDelta', () => {
  it('鼠标右移使 yaw 减小，画面向右转', () => {
    const result = applyLookDelta({ yaw: 0, pitch: 0, deltaX: 100, deltaY: 0 })
    expect(result.yaw).toBeLessThan(0)
  })

  it('鼠标下移使 pitch 减小（低头）', () => {
    const result = applyLookDelta({ yaw: 0, pitch: 0, deltaX: 0, deltaY: 100 })
    expect(result.pitch).toBeLessThan(0)
  })

  it('俯仰被夹住，怎么拖都不会翻过头', () => {
    const up = applyLookDelta({ yaw: 0, pitch: 0, deltaX: 0, deltaY: -100000 })
    const down = applyLookDelta({ yaw: 0, pitch: 0, deltaX: 0, deltaY: 100000 })
    expect(Math.abs(up.pitch)).toBeLessThanOrEqual(WASD_DEFAULTS.maxPitch)
    expect(Math.abs(down.pitch)).toBeLessThanOrEqual(WASD_DEFAULTS.maxPitch)
  })

  it('yaw 不设限（水平可以无限转）', () => {
    const result = applyLookDelta({ yaw: 0, pitch: 0, deltaX: -100000, deltaY: 0 })
    expect(Number.isFinite(result.yaw)).toBe(true)
    expect(result.yaw).toBeGreaterThan(Math.PI * 2)
  })

  it('当前角度非法时按 0 处理，不产生 NaN', () => {
    const result = applyLookDelta({ yaw: NaN, pitch: undefined, deltaX: 10, deltaY: 10 })
    expect(Number.isFinite(result.yaw)).toBe(true)
    expect(Number.isFinite(result.pitch)).toBe(true)
  })
})

describe('朝向与机位的正反算互逆', () => {
  it('给定机位与注视点，反算再正算应回到同一注视点', () => {
    // 刻意不含"机位与注视点重合"的退化用例：那种输入下距离为 0，
    // 正算会用安全距离兜底，因此不可能往返（见下面单独的退化测试）。
    const cases = [
      { position: { x: 0, y: 0, z: 0 }, target: { x: 0, y: 0, z: -5 } },
      { position: { x: 3, y: 2, z: 4 }, target: { x: -1, y: 1, z: 0 } },
      { position: { x: -5, y: 8, z: 2 }, target: { x: 5, y: 0, z: -2 } }
    ]
    for (const camera of cases) {
      const orientation = orientationFromCameraTarget(camera)
      const rebuilt = cameraTargetFromOrientation({
        position: camera.position,
        yaw: orientation.yaw,
        pitch: orientation.pitch,
        distance: orientation.distance
      })
      expect(rebuilt.target.x).toBeCloseTo(camera.target.x, 6)
      expect(rebuilt.target.y).toBeCloseTo(camera.target.y, 6)
      expect(rebuilt.target.z).toBeCloseTo(camera.target.z, 6)
    }
  })

  it('相机语义是 -Z 朝目标：正前方应落在 -Z 方向', () => {
    const result = cameraTargetFromOrientation({
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      distance: 5
    })
    expect(result.target.z).toBeCloseTo(-5, 6)
    expect(result.target.x).toBeCloseTo(0, 6)
  })

  it('机位与注视点重合时退化处理，不产生 NaN', () => {
    const orientation = orientationFromCameraTarget({
      position: { x: 1, y: 1, z: 1 },
      target: { x: 1, y: 1, z: 1 }
    })
    expect(orientation.distance).toBe(0)
    expect(Number.isFinite(orientation.yaw)).toBe(true)
    expect(Number.isFinite(orientation.pitch)).toBe(true)
  })

  it('距离非法时正算用安全值兜底，避免 target 与机位重合导致画面失控', () => {
    const result = cameraTargetFromOrientation({
      position: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      distance: 0
    })
    expect(result.target.z).toBeCloseTo(-1, 6)
  })
})

describe('导航方案可插拔', () => {
  it('默认方案是 wasd，但 orbit 已登记可用', () => {
    expect(DEFAULT_CAMERA_NAV_SCHEME).toBe('wasd')
    expect(NAV_SCHEME_HANDLERS.orbit).toBeTruthy()
  })

  it('wasd 消费键盘与指针；orbit 都不消费（交给 OrbitControls）', () => {
    expect(navSchemeHandler('wasd').consumesKeyboard).toBe(true)
    expect(navSchemeHandler('orbit').consumesKeyboard).toBe(false)
    expect(navSchemeHandler('orbit').consumesPointerLook).toBe(false)
  })

  it('未知方案回退到默认，不返回 undefined 导致调用方崩', () => {
    expect(navSchemeHandler('不存在的方案')).toEqual(NAV_SCHEME_HANDLERS.wasd)
    expect(navSchemeHandler(null)).toEqual(NAV_SCHEME_HANDLERS.wasd)
  })

  it('wasd 独占相机，orbit 交给 OrbitControls', () => {
    expect(navSchemeHandler('wasd').ownsCamera).toBe(true)
    expect(navSchemeHandler('orbit').ownsCamera).toBe(false)
  })
})

describe('shouldRunOrbitControls', () => {
  it('不在相机视角时始终运行（编辑视角本来就归 OrbitControls）', () => {
    expect(shouldRunOrbitControls(false, 'wasd')).toBe(true)
    expect(shouldRunOrbitControls(false, 'orbit')).toBe(true)
  })

  /*
   * 这条是最重要的回归护栏：
   * wasd 方案下若还让 OrbitControls.update() 跑，它会每帧
   * `camera.lookAt(target)` 并按 position-target 重算位置，
   * 于是相机飞近注视点时会塌陷、卡死在 target 上。
   */
  it('wasd 方案下必须停掉 OrbitControls（否则相机被拽回/塌陷）', () => {
    expect(shouldRunOrbitControls(true, 'wasd')).toBe(false)
  })

  it('orbit 方案下相机视角仍然运行 OrbitControls', () => {
    expect(shouldRunOrbitControls(true, 'orbit')).toBe(true)
  })

  it('未知方案按默认 wasd 处理，不误开 OrbitControls', () => {
    expect(shouldRunOrbitControls(true, '未知')).toBe(false)
  })
})
