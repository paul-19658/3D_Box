# 小白盒 Web 版 · AI 协作开发规范

> 本文是**给 AI 助手与人类协作者共同使用的开工文档**。
> 读完这一份就能开始改代码；第 8 节是可以直接复制进新会话的启动提示词。

---

## 1. 项目是什么

「小白盒」是一个**白模草稿工具**，服务对象是想用 AI 生成图片 / 视频、但不会建模的创作者。

工作流：

```
搭白模场景 → 摆机位 → 打光 → 排镜头/关键帧
        ↓
导出白模图 / 深度·法线·分色·遮罩·轮廓 参考图 / PNG 序列帧 / 模型文件 / 场景说明与建议提示词
        ↓
投喂给 AI 视频平台，得到成片
```

关键认知：**这个工具的产物不是最终画面，而是"给 AI 的约束条件"。**
因此凡是影响"AI 能否正确理解场景"的改动，优先级高于纯 UI 观感。

---

## 2. 技术栈与版本（全部精确锁定，不许放宽）

| 层 | 技术 | 版本 |
| --- | --- | --- |
| 前端框架 | Vue | 2.6.14 |
| 模板编译 | vue-template-compiler | 2.6.14 |
| 路由 | vue-router | 3.6.5 |
| 状态 | vuex | 3.6.2 |
| 路由同步 | vuex-router-sync | 5.0.0 |
| 三维 | three.js | 0.185.1 |
| 构建 | webpack | 5.97.1 |
| 单测 | vitest | 4.1.10 |
| 后端 | Python | 3.10.11（3.10.20 不存在） |
| Web 框架 | FastAPI | 0.115.6 |
| ASGI | Uvicorn | 0.34.0 |
| 校验 | Pydantic | 2.10.4 |
| HTTP 客户端 | httpx | 0.28.1 |

**为什么用 webpack 而不是 Vite**：Vue 2.6 的模板编译必须靠 `vue-loader@15` +
`vue-template-compiler@2.6.14`，这套组合与 webpack 5 的集成最成熟。
Vite 需要额外的 `vite-plugin-vue2`，且与模板编译器版本对齐更脆弱。
多人协作场景下，**确定性优先于启动速度**。

---

## 3. 三层架构与硬性边界

```
┌──────────────────────────────────────────────┐
│  views/ + components/   只做「显示 + 发事件」  │
└───────────────────┬──────────────────────────┘
                    │ dispatch / emit
┌───────────────────▼──────────────────────────┐
│  store/index.js  唯一状态源 + 唯一写入口       │
│                   editScene(update)           │
└───────────────────┬──────────────────────────┘
                    │ 纯函数调用
┌───────────────────▼──────────────────────────┐
│  core/           纯逻辑（可单测、无框架依赖）   │
└──────────────────────────────────────────────┘
                    │ HTTP
┌───────────────────▼──────────────────────────┐
│  backend/        FastAPI：落盘、AI 代理、校验  │
└──────────────────────────────────────────────┘
```

### 边界 1：`core/` 必须是纯的

- ✅ 允许：数学、几何、数据结构变换、字符串生成
- ❌ 禁止：`import Vue`、`import ... from 'vuex'`、`document`、`window`、`localStorage`
- ❌ 禁止：直接 `fetch`
- 唯一的例外是 `core/mannequin.js` 与 `core/geometry.js` 会 `import * as THREE`——
  它们需要构造 `BufferGeometry`。这仍然可测（three 在 Node 里能跑），可以接受。

**检验方法**：`npm run test` 能不启动浏览器跑通，就说明边界没破。

### 边界 2：改场景只能走 `editScene`

```js
// ✅ 正确
this.$store.dispatch('editScene', (scene) => ({
  ...scene,
  objects: scene.objects.map((o) => (o.id === id ? { ...o, ...update } : o))
}))

// ❌ 错误：绕过撤销栈与自动保存
this.$store.state.history.present.objects = newObjects
```

`editScene` 做三件事：推入历史栈、清空重做栈、安排自动保存。
绕过它 = 用户按 Ctrl+Z 撤不回来。

**性能注意**：`editScene` 必须是**不可变更新**（返回新对象）。
原地改 `scene.objects[i].position.x` 会让 `Object.is` 判定为"没变化"，
撤销栈不记录，用户会觉得"这个操作撤不回来"。

### 边界 3：three.js 对象不进 Vue 响应式

```js
// ✅ 正确
mounted() { this.renderer = new THREE.WebGLRenderer(...) }

// ❌ 错误：每帧触发深度侦测
data() { return { renderer: null } }
```

判断标准很简单：**这个对象会被每帧读写吗？** 会，就放组件实例字段。

### 边界 4：网络请求只走 `api/client.js`

组件里出现 `fetch(` 就是 bug。加鉴权、加重试、改 baseURL 时，
你只需要改一个文件。

### 边界 5：浏览器独占 API 只放 `src/media/`

`VideoEncoder` / `VideoFrame` / `OffscreenCanvas` 这类 API 在 Node 里不存在。
它们被限定在 `src/media/`，并且 ESLint 只在 `src/media/**/*.js` 作用域里
把对应的全局设成可读（见 `eslint.config.mjs`）。

这么做的理由：一旦把 `VideoEncoder` 加到全局 globals，`core/` 里也能随手
`new VideoEncoder(...)`——而 `core/` 的硬约定是"能在 Node 里直接单测"，
迟早会有人在纯逻辑层写一行浏览器 API，然后所有单测一起炸。

**判断标准**：这段代码在 Node 里会抛 `ReferenceError` 吗？会，就放 `media/`；
不会（纯换算、纯数据结构），就放 `core/`。

---

## 4. 三端数据契约（最容易出错的地方）

工程文档 schema 有**三份实现**，必须保持完全一致：

| 位置 | 文件 | 状态 |
| --- | --- | --- |
| TypeScript 原版 | `app/src/shared/project-document.ts` | 历史基线，只读参考 |
| JS 前端 | `web/frontend/src/core/project-document.js` | 读写 |
| Python 后端 | `web/backend/app/models/project.py` | 落盘与迁移 |

双端镜像的还有：

| 逻辑 | 前端 | 后端 | 一致性要求 |
| --- | --- | --- | --- |
| 光照描述 | `core/lighting-description.js` | `services/scene_output.py` | **措辞逐字一致** |
| AI 系统提示词 | `core/ai-defaults.js` | `services/ai_service.py` | 后端是权威，前端仅占位 |

**当前版本：schema 13**（12 → 13 只是新增 `kind: "path"` 的导航线对象与
`pathNodes` / `pathBinding` 字段，旧工程原样保留即可，无需改写）。

### 修改 schema 的标准流程

1. 先改 `web/backend/app/models/project.py`（服务端是落盘方，先保证能读）；
2. 同步 `web/frontend/src/core/project-document.js`；
3. 在 `web/backend/tests/test_core.py` 加一条**旧版迁移测试**；
4. 在 `web/frontend/src/core/project-document.test.js` 加对称的一条；
5. 提升 `PROJECT_SCHEMA_VERSION`；
6. 在 PR 描述里写清楚「旧工程会怎样」——是补默认值，还是丢弃字段。

### 不允许做的事

- ❌ 只改前端不改后端：用户保存后刷新会丢字段
- ❌ 只改后端不改前端：前端读到新字段不认识，`migrateProjectDocument` 会静默丢掉
- ❌ 改字段名但不加迁移：所有历史工程打不开

---

## 5. 编码约定

### 5.1 JavaScript / Vue

- 无分号、单引号、2 空格缩进、行宽 110（见 `.prettierrc.json`）
- 组件一律 **Options API**（Vue 2.6 不推荐 `@vue/composition-api`，团队一致性优先）
- 组件名用 PascalCase，文件名与组件名一致
- `props` 必须写 `type` 与 `default`；对象/数组的 `default` 必须是工厂函数
- 事件名用 kebab-case（`@update-camera`），且**动词开头**
- 每个对外方法写一句中文注释说明「为什么」，而不是「做了什么」

```js
// ✅ 好注释：解释取舍
/**
 * 数值输入统一用 `change` 而不是 `input`：
 * 连续输入时不会每敲一个字符就往撤销栈压一帧。
 */
```

### 5.2 Python

- 全部加 `from __future__ import annotations`
- 类型标注必须写（`dict[str, Any]`，不用裸 `dict`）
- 纯函数优先；有副作用的地方集中在 `services/`
- 文件编码 utf-8，但 **`requirements.txt` 的注释必须是纯 ASCII**
  （pip 21 在 Windows 上按系统代码页解码，中文注释会抛 `UnicodeDecodeError`）

### 5.3 CSS

- 颜色 / 圆角 / 阴影**只能**通过 `styles/index.css` 里的 CSS 变量引用
- 组件私有样式写 `<style scoped>`，不要往全局文件里塞
- 不用 `!important`；不用内联 style 做主题（动态定位除外）

---

## 6. 测试要求

### 什么必须写测试

| 层 | 要求 | 理由 |
| --- | --- | --- |
| `core/` 纯函数 | **必须** | 逻辑回归成本最低的地方 |
| `store/` actions | 关键路径必须（保存/打开/撤销/AI 命令） | 状态机容易错 |
| 后端 `services/` | **必须** | 落盘与迁移出错会丢用户数据 |
| 后端路由 | 每个端点至少一条 | 契约验证 |
| 组件 / 三维渲染 | 不强制 | 依赖 WebGL，手工验证更划算 |

### 写测试的三条准则

1. **测行为，不测实现**。断言「对齐后两个物体 x 相同」，而不是「调用了 alignObjects」。
2. **每个断言配一句中文说明它是哪条业务规则**。
3. **反向用例必须存在**：非法输入被拒绝、找不到目标时跳过而不是崩。

```js
it('找不到目标时跳过并记录原因，不静默失败', () => {
  const result = applyAiSceneCommands(emptyScene(), [
    { type: 'update_object', name: '不存在的物体', position: { x: 1 } }
  ])
  expect(result.applied).toBe(0)
  expect(result.skipped).toHaveLength(1)
})
```

### 提交前必须全绿

```powershell
cd web\frontend
npm run lint
npm run test
npm run build

cd ..\backend
py -3.10 -m pytest -q
py -3.10 -m app.smoke http://127.0.0.1:8000   # 需要后端已启动
```

---

## 7. 常见陷阱清单（都是踩过的）

| 陷阱 | 症状 | 正确做法 |
| --- | --- | --- |
| **用 `template:` 字符串定义组件** | 组件完全空白、`$refs` 是 `undefined`、整页黑屏但无报错 | **必须写 `.vue` 单文件组件**。见下方说明 |
| `RectAreaLight` 未初始化 LTC | 场景一片漆黑，控制台无报错 | `RectAreaLightUniformsLib.init()`，只调用一次 |
| 用虚拟平面承接阴影 | 阴影出现在没有实体的地方 | 只让真实几何 `receiveShadow` |
| 面光计入阴影名额 | 描述说"投射阴影"但画面里没有 | 面光跳过，`resolveShadowCasterIds` 统一判定 |
| 用 HSL 饱和度判色温 | `#fff1d6` 被说成"暖橙色" | 用色度比 `(max-min)/max` |
| 数值输入用 `input` 事件 | Ctrl+Z 要按几十次才回到上一个状态 | 用 `change`，`input` 只做本地预览 |
| three.js 对象放 `data()` | 掉帧到个位数 | 放组件实例字段 |
| 迁移时整份拒绝 | 用户工程打不开 | 逐对象容错，坏的跳过好的保留 |
| 修改 `.npmrc` 加 electron 镜像 | npm 12 报 `Unknown project config` | 用 `package.json` 的 `config` 字段 |
| `requirements.txt` 写中文注释 | pip 抛 GBK 解码错误 | 纯 ASCII |
| 拾取对象时忽略控制柄 | gizmo 拖不动，选中还会被清空 | 命中前先看 `transformControls.axis` / `.dragging` |
| 重建 helper 前不 `detach` | 控制台刷 `must be a part of the scene graph` | 先 `detach()`，重建后再 `attach()` |
| 合成 PointerEvent 的 `button` 写成 0 | 拖动在库内部被静默丢弃 | `pointermove` 的 `button` 必须是 `-1` |
| `<canvas>` 没写 CSS 宽高 | 画面只有 300×150 一小块 | 显式设置 `width/height: 100%` |
| 内联 `<svg>` 没写宽高 | 图标按 300×150 撑开，按钮点不到 | `.rail-btn__glyph svg { width: 19px; height: 19px }` |
| **用相机视线方向做拾取射线** | 只能点中画面正中的物体 | 必须用 `raycaster.setFromCamera(鼠标, camera)` |
| **`Group.lookAt()` 当成 `Camera.lookAt()` 用** | 视锥背对物体、监视器却有画面；平移还会把朝向带歪 | `Camera` 是 -Z 朝目标，**普通 Object3D 是 +Z 朝目标**；Group 要再 `rotateY(Math.PI)` 才是相机语义 |
| 子节点位置塞了世界坐标偏移 | 目标点标记跑到别处 | 子节点用**本地坐标**；helper 翻转后目标点就是 `(0, 0, -distance)` |
| **人台加载出来了但动作不生效** | `applyMannequinPose` 静默跳过外观分支 | 必须把 `mannequinJoints` / `mannequinHandles` 挂到对象根上，它们才是驱动骨骼的锚点 |
| **`.glb` 走 import 打包** | vitest 报 `invalid JS syntax`，纯逻辑测试全崩 | 放 `public/`，用 `CopyWebpackPlugin` 复制，代码里只引用 URL 字符串 |
| 异步加载的材质提前 `dispose()` | 外观克隆到已释放的材质 | 异步分支自己新建材质，生命周期自己管 |
| 按**片段名**查 `actionClips` | 时长恒为 `null` | 该 Map 的键是**预设 id**（`stand`/`sit`…），不是 `Idle_Loop` 这类片段名 |
| **时间轴预览把求值结果写进编辑相机** | 点播放/点帧后视角突然飞到奇怪角度 | 预览只改 `displayedCamera`，编辑相机归 OrbitControls |
| 标尺只监听 `click` | 按住拖动播放头没反应 | `pointerdown` + 全局 `pointermove` 连续 scrub |
| 第二块 WebGL 画布读像素全黑 | 截图/断言拿到黑图 | `new WebGLRenderer({ canvas, preserveDrawingBuffer: true })` |
| 相机位姿每帧变化时全量重建 helper | 播放掉到个位数帧率 | 按"造型签名"判断，只有位姿变就走快速路径 |
| **H.264 codec 字符串写死** | 换台机器就报"没有可用的编码器" | 按 `MP4_CODEC_CANDIDATES` 运行时逐个 `isConfigSupported` 探测（实测有的机器只有 High profile 可用） |
| **`VideoEncoder` 的 timestamp 用毫秒** | 5 秒视频变成 5 毫秒 | 单位是**微秒**，用 `mp4TimestampUs()` 统一换算 |
| **`VideoFrame` 忘记 `close()`** | 编几十帧后浏览器 OOM 崩掉 | 句柄必须释放，放在 `encode()` 之后的 `finally` 里 |
| **不等编码队列** | 内存飙升、进度条不重绘 | 每帧检查 `encodeQueueSize` 并 `setTimeout(0)` 让出主线程 |
| moov 写到文件末尾 | 文件合法但播放器/平台判定损坏 | muxer 开 `fastStart: 'in-memory'` |
| **导出时只改渲染器尺寸** | 画面横向拉伸（文件结构却完全合法） | 必须同时 `camera.aspect = w/h` + `updateProjectionMatrix()`；见 `withOutputSize()` |
| 临时改的 aspect 不还原 | 导完视频视口画面一直变形 | `finally` 里同时还原 aspect / pixelRatio / 尺寸 |
| 把 `VideoEncoder` 等浏览器全局直接加到全局 globals | `core/` 里也能随手引用，Node 单测直接炸 | 只在 `eslint.config.mjs` 的 `src/media/**/*.js` 作用域里开放 |
| **时间轴出现贯穿面板的黑条** | 播放头写成 `bottom: -100px`，且轨道区没有 `overflow: hidden` | 播放头高度锁进标尺（`top/bottom: 0`）；标尺与轨道各自裁剪 |
| **有导航线时第三条轨道看不见** | 时间轴最小高度 132px 装不下三条轨道 | 最小高度提到 176px（6 + 38 + 26 + 三条 24px 轨道） |
| **拖完导航线节点，折线还留在原地** | `rebuildPaths` 没挂在 `objects` 上，store 提交后没重建 | 把 `rebuildPaths()` 放到 `rebuildObjects()` 末尾 |
| 导航线节点"跳"到路径另一头 | 拖拽时在全路径上做射线投影 | 只允许在**相邻两段**滑动（`adjacentSegmentsFor`） |
| 把导航线节点做成自由三轴平移 | 破坏"节点沿路径走"的语义 | 用自定义射线投影拖拽，节点只能沿折线滑动 |
| 给导航线也建 `rootMap` 根节点 | 选区框围着一个零尺寸盒子，看起来像误选中 | 导航线不建根节点，可视化全交给 `pathGroup` |
| 导航线出现在导出模型里 | 导出只取 `objectGroup`，但辅助线也进了画面 | 路径单独放 `pathGroup`；`renderToSize` 期间隐藏它 |
| **导出的视频只有静态画面** | `evaluateTimelineAtTime()` 的 `objectTransforms` 算完就丢，只应用了 `camera` | 三条产物路径统一走 `renderFrameAt()`：`applyCameraState()` + `applyTimelineFrame()` |
| **导完视频场景停在最后一帧** | 逐帧改写了物体根节点的变换，导出后没复位 | `finally` 里 `restoreObjectTransforms()` 按 store 数据复位（**不能**用 0 时刻，那时自己也有键值） |
| **标尺与轨道的 0 点错开** | `.timeline__track` 加了 `padding-left: label-width+12`，而每条 `.lane` 内**又**有一个 `label-width` 宽的行首标签，等于算两遍 | 抽 `--lane-gutter`（label-width + gap），轨道只留 12px 内边距，标尺复用同一 gutter |
| **拖拽造物时镜头跟着转** | quick-build 分支排在拾取**之后**，且从没关过 OrbitControls，同一次左键既铺墙又转镜头 | quick-build 提到拾取之前，并 `beginExclusiveGesture()` 关掉 controls |
| **松手后镜头再也转不动** | 指针拖出 canvas 后 `pointerup` 落在别处，解锁代码没跑到 | `setPointerCapture` 把事件路由回 canvas；`handlePointerUp` 各分支用 `endExclusiveGesture()` 兜底 |
| **用合成 PointerEvent 验证"镜头没转"** | 合成事件没有真实 pointer 关联，OrbitControls 内部 `setPointerCapture` 抛错中断，于是"没转"既可能是隔离生效也可能是事件被打断 | 改用 CDP `Input.dispatchMouseEvent` 发真实输入；并加反向对照——选择工具下同样拖拽必须**能**转镜头 |
| **导出的成片里有橙色选中框和箭头** | 控制柄 helper 与 `selectionBox` 直接挂在 `scene` 上，不在 `guideGroup` 里；导出只隐藏了 `guideGroup` | 收成 `editorOverlays()` 清单，导出 / 六通道图 / 预演共用同一份 |
| **进了预演，控制柄又冒出来** | 预演会改 `cameraState` → 重建摄影机模型 → `rebuildCameraHelper()` 末尾又 `attachTransformControls()` | 在 `attachTransformControls()` 的**入口**判断预演并 return，别只在 watch 里 detach |
| **预演帧率掉到个位数** | 渲染路径每帧调 `applyTheme()`，它内部会 `dispose` 网格再重建 | 每帧只推 `renderer.setClearColor()`；网格重建只在主题真变时做 |
| **预演退出后镜头转不动** | 进预演禁用了 controls，退出时忘了解锁 | `previewActive` 的 watch 两侧对称：进则 detach + 禁用，出则 attach + 解锁 |
| 预演退出后停在某一帧 | 预演是循环播放，退出时播放头还在跑 | 退出时 `stopPlayback()`，并把 `timelineTime` 归 0 |
| **在 `data()` 里存"当前面板"** | 顶栏自己记 `panel`，别的组件读不到，也就无法被"按 Esc 退出"这类外部动作驱动 | "是否在预演"放 store；顶栏改成受控 prop + `select-panel` 事件 |

### 关于第一条：为什么 `template:` 字符串会静默失败

`webpack.config.js` 里有：

```js
alias: { vue$: 'vue/dist/vue.runtime.esm.js' }
```

这是 **runtime-only** 构建，**不含模板编译器**。给它一个字符串模板，Vue 不会报错，
只会渲染成空节点。于是 `mounted()` 里 `this.$refs.canvas` 是 `undefined`，
`canvas.addEventListener` 抛 `TypeError`，整个视口初始化中断——
表现就是"场景全黑 + 工具栏点不动"。

`npm run lint`、`vitest`、`npm run build` **都发现不了**这个问题：它们不挂载真实 DOM。
唯一可靠的发现方式是用 CDP 连真实浏览器（见 README 第六节）。

反过来讲，如果确实想用字符串模板，就必须把 alias 换成 `vue/dist/vue.esm.js`
（含编译器，体积 +30KB）。本项目选择 `.vue` SFC，保持 runtime-only。

---

## 8. AI 开发启动提示词（直接复制使用）

> 下文整段复制给 AI 助手，作为新会话的开场。

```text
你正在参与「小白盒 Web 版」的开发。请先完整阅读 web/README.md 与 docs/AI_DEV_GUIDE.md，
再按下面的约束工作。

【项目定位】
这是一个白模草稿工具：用户搭白模场景、摆机位、打光、排关键帧，
导出「白模图 / 深度·法线·分色·遮罩·轮廓参考图 / PNG 序列帧 / 模型 / 场景说明」，
喂给 AI 视频平台生成成片。产物是约束条件，不是最终画面。

【技术栈（精确锁定，禁止升级或放宽）】
前端：Vue 2.6.14 / vue-template-compiler 2.6.14 / vue-router 3.6.5 /
      vuex 3.6.2 / vuex-router-sync 5.0.0 / three.js 0.185.1 / webpack 5.97.1 / vitest 4.1.10
后端：Python 3.10.11 / FastAPI 0.115.6 / Uvicorn 0.34.0 / Pydantic 2.10.4 / httpx 0.28.1
注意：Python 3.10.20 不存在；npm 实测为 12.2.0。

【四条不可违反的边界】
1. src/core/ 必须是纯逻辑：不 import Vue / Vuex，不用 document / window / localStorage，
   不直接 fetch。唯一的例外是 geometry.js 与 mannequin.js 可以 import three。
2. 改场景只能走 dispatch('editScene', update)，且 update 必须返回新对象（不可变更新）。
   原地修改会导致撤销栈失效。
3. three.js 对象放在组件实例字段（this.scene / this.renderer），
   绝不放进 data()，否则每帧深度侦测会拖垮性能。
4. 网络请求只走 src/api/client.js，组件里出现 fetch( 即为 bug。

【三端数据契约】
工程 schema 同时存在于三处，改一处必须同步另外两处：
  app/src/shared/project-document.ts（TS 基线，只读参考）
  web/frontend/src/core/project-document.js
  web/backend/app/models/project.py
光照描述也有双端镜像，必须措辞逐字一致：
  web/frontend/src/core/lighting-description.js
  web/backend/app/services/scene_output.py

【编码约定】
- JS：无分号、单引号、2 空格、行宽 110；组件用 Options API；props 必须写 type 与 default。
- Python：全部 from __future__ import annotations；类型标注写全；
  requirements.txt 的注释必须是纯 ASCII（否则 Windows 上 pip 报 GBK 解码错误）。
- CSS：颜色/圆角/阴影只通过 styles/index.css 的变量引用；组件样式写 scoped。
- 注释解释「为什么」，不解释「做了什么」。

【测试要求】
- core/ 纯函数与后端 services/ 必须写测试；每条断言配一句中文业务规则说明；
  必须包含反向用例（非法输入被拒绝、找不到目标时跳过而非崩溃）。
- 提交前四件事全绿：
    cd web/frontend ; npm run lint ; npm run test ; npm run build
    cd web/backend  ; py -3.10 -m pytest -q ; py -3.10 -m app.smoke http://127.0.0.1:8000

【工作方式】
- 一次只改一个关注点；改动前先读相关文件，不要凭记忆写代码。
- 引入新依赖前必须先说明理由；能自己写 30 行解决的就不要加依赖。
- 发现规格与实现冲突时，先如实指出冲突，再给出方案，不要静默选择对自己方便的那条。
- 交付时说明：改了什么、为什么这么改、哪些地方没改、如何验证。
```

---

## 9. 评审清单（合并前逐条确认）

### 数据安全

- [ ] schema 改动是否同步了三端？是否加了旧版迁移测试？
- [ ] 是否有路径穿越风险？（导出文件名、工程 id 一律走 `safe_name`）
- [ ] 密钥是否只留在服务端？接口是否只回传 `hasApiKey`？

### 状态正确性

- [ ] 所有场景修改是否都经过 `editScene`？
- [ ] 是否是**不可变**更新（没有原地改 `scene.xxx`）？
- [ ] 撤销 → 重做 一轮后，画面与数据是否完全一致？

### 渲染正确性

- [ ] 新增的 three.js 对象是否放进了正确的组（`objectGroup` / `userLightGroup` / `guideGroup`）？
- [ ] 导出时辅助图形（网格、灯光标记、坐标轴、草稿、切割平面）是否都被隐藏？
- [ ] 临时替换材质的地方是否有 `finally` 恢复？

### 用户可理解性

- [ ] 报错文案是否告诉用户「发生了什么 + 怎么办」？
- [ ] 是否会静默失败？（不允许：失败必须有通知或状态标记）
- [ ] 导出产物的提示词是否仍然锁定了光照方向与"不新增光源"？

### 工程卫生

- [ ] lint / test / build 全绿？
- [ ] 没有 `console.log` 残留？
- [ ] 没有新增未使用的 import？
- [ ] 新增文件是否放在正确的层（core / components / views / services）？

---

## 10. 分工建议（多人协作）

按**层**切分，而不是按页面切分——页面之间共享状态，按页面切必然冲突。

| 角色 | 负责范围 | 主要文件 |
| --- | --- | --- |
| A · 三维与交互 | 视口、变换控件、拾取、渲染管线 | `components/SceneViewport.js`、`core/geometry.js`、`core/mesh-cut.js`、`core/canvas-modeling.js` |
| B · 面板与工作流 | 顶栏、资产栏、属性面板、时间轴、对话框 | `components/*.vue`（除视口）、`views/*`、`styles/index.css` |
| C · 数据与后端 | schema、store、API、落盘、AI 代理 | `store/index.js`、`api/client.js`、`core/project-document.js`、`backend/**` |
| D · 导出与 AI 链路 | 参考图、序列帧、模型、场景说明与提示词 | `core/video.js`、`core/model-io.js`、`core/ai-commands.js`、`services/scene_output.py` |

### 协作规则

1. **契约先行**：涉及 schema / API 的改动，先提交契约（并同步三端），再各自实现。
2. **一个 PR 只做一件事**：重构与功能分离，否则评审无法判断行为是否变了。
3. **冲突高发文件**：`store/index.js`、`core/project-document.js`、`styles/index.css`。
   改这些文件前先在群里说一声，或提前拆小提交。
4. **共享文案与常量**：光照措辞、AI 提示词、平台预设，改动必须成对提交并附测试。

---

## 11. 术语表

| 术语 | 含义 |
| --- | --- |
| 白模 / 白膜 | 不带贴图的素模，用于表达空间关系与体积 |
| 人台 | 可摆姿势的人体骨架模型，用于表达人物动作与站位 |
| 机位 / 镜头 | 时间轴上的一个相机关键帧（含切换方式 smooth / cut） |
| 关键帧 | 物体在某一时刻的位置、旋转、尺寸、人台姿势 |
| 参考图六通道 | 白模 / 深度 / 法线 / 物体分色 / 遮罩 / 轮廓 |
| 承接面 | 用来接收阴影的平面。**本项目禁止使用虚拟承接面**，阴影只能落在真实几何上 |
| 阴影名额 | 同时投射阴影的灯光上限，当前为 2（面光不计入） |
| 场景说明 | 结构化的场景描述（schemaVersion 2，含 `lighting` 段） |
| 建议提示词 | 由场景自动生成的、可直接粘贴给 AI 平台的提示词 |
