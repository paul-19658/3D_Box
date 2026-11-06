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
| ORM | SQLAlchemy | 2.0.36 |
| 迁移 | Alembic | 1.14.0 |
| 密码哈希 | bcrypt | 4.2.1（登录暂不校验，脚本写库用） |

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
| AI 系统提示词 | `core/ai-defaults.js` | `services/ai_service.py` | 后端是权威，前端仅占位；**必须逐字一致**（含内嵌的命令 schema） |
| AI 命令 schema 提示 | `core/ai-defaults.js` → `AI_SCENE_COMMAND_SCHEMA_HINT` | `services/ai_service.py` 同名常量 | 默认 prompt 内嵌；旧版自定义 prompt 缺 `animate_move` 时后端仍会补全 |

### AI 场景控制链路（Agent Loop + Tools）

```
AiComposer（文字 + 参考图）
  → store.sendAiMessage（前端 Agent Loop，maxSteps≈12）
  → POST /api/ai/chat（messages + tools；密钥不出浏览器）
  → 若有 toolCalls：本地执行 list_assets / get_object / capture_* / apply_scene_commands / done
  → 结果回灌 messages（截图作多模态附件）→ 下一轮，直到 done 或无 tool
```

| 能力 | 状态 | 关键文件 |
| --- | --- | --- |
| Agent 工具定义与执行 | ✅ | `core/ai-tools.js` |
| 资产列表 / 物体详情 | ✅ | `scene.js` → `listAssets` / `getObjectDetail` |
| 场景命令解析/应用（含 remove_object） | ✅ | `ai-commands.js` / `apply-ai-scene-commands.js` |
| 目标机 / 总览 / 时间轴双视角截图 | ✅ | `SceneViewport` + capture_* tools |
| 后端 tools 协议（OpenAI + Anthropic） | ✅ | `ai_service.py` |
| Composer 展开收起 + 服务商切换 | ✅ | `AiComposer.vue` |

**当前版本：schema 15**（14 → 15 只是给相机新增 `lookAtEnabled`，
用于临时关闭"看向物体"绑定而保留绑定关系；旧工程迁移时补 `true`）。

历史：
- 12 → 13：新增 `kind: "path"` 的导航线对象与 `pathNodes` / `pathBinding` 字段，
  旧工程原样保留即可。
- 13 → 14：相机新增 `targetObjectId`（可空）。
- 14 → 15：相机新增 `lookAtEnabled`（布尔，缺省 true）。

⚠️ **三端版本号必须一致**。此前 `app/src/shared/project-document.ts` 停在 12，
而 JS 与 Python 已是 13，属于长期未发现的漂移——同一份工程在不同端的校验结果
会分叉。改 schema 时务必三处一起核对。

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

**但"不强制"不等于"可以不验"**：三维相关的改动必须做一次真机验证，
因为这里存在一整类"数据对、画面错"的 bug——store 里值变了，用户看到的却没变。
典型例子就是相机视角下 `OrbitControls.update()` 把朝向覆盖回去：
只读 store 会判定通过，实际画面完全没转。
这类验证用 CDP 驱动真实浏览器（`Input.dispatchMouseEvent` / `dispatchKeyEvent`），
并且**读出口要用只读探针**（`window.__XBH_DIAGNOSE__` 的 `editorCamera()` / `scene()`），
不要用自己刚写的那条代码路径去验证自己。

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

### 数据库迁移流程

- 模型定义在 `app/db/models.py`；迁移脚本在 `alembic/versions/`。
- 应用启动时 `main.py` lifespan 会自动执行 `alembic upgrade head`，`start.cmd` 无需额外步骤。
- 新增迁移（在 `web/backend` 下）：

```powershell
py -3.10 -m alembic revision -m "描述" --autogenerate
# 检查生成的 versions/*.py 后：
py -3.10 -m alembic upgrade head
```

- 连接串只用 `WHITEBOX_DATABASE_URL`（默认 SQLite）。切 Postgres 时改 URL 并安装 `psycopg`，再启动即可；类型只用可移植的 `String` / `Integer` / `Boolean` / `DateTime(timezone=True)`，并保持 Alembic `render_as_batch=True`。
- 用户角色靠 `users.role`（`user` / `admin`）；`password_hash` 已存在但登录路径暂不校验。

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
| **本机 WebCodecs 不可用就只能出 PNG** | 局域网 IP / 无硬件加速环境导不出 MP4 | 探测失败时走 `POST /api/exports/encode-mp4`（上传 JPEG 帧 → 后端 ffmpeg）；`/api/meta.serverMp4Encode` 告知前端能否兜底 |
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
| **SPA 回落路由直接拼请求路径** | 任意文件读取：可读到 `ai-environment.json` 的明文 API Key、`app.db`、`secret.key` 乃至系统 `win.ini` | 静态文件路径必须 `resolve()` 后按**真实归属**校验（`Path.is_relative_to`），越界回落 `index.html`。Starlette 会先解码 `%2e%2e%2f`，所以编码穿越同样要防；也不要用字符串 `startswith` 判前缀 |
| **相机视角下中键拖拽"转了但画面没转"** | `OrbitControls.update()` 每帧 `camera.lookAt(target)`，把导航算出的 yaw/pitch 指回旧 target。**只查 store 会误判成成功**（store 的 target 确实变了），必须查画面 | `wasd` 方案下用 `shouldRunOrbitControls()` 停掉 `controls.update()`，每次导航改动后调 `applyNavOrientation()` 同步 `camera.lookAt` 与 `controls.target` |
| **相机往前飞几米后突然不动** | 同上的另一半：`update()` 按 `position - target` 反推球坐标，相机飞近注视点时半径趋近 0、球坐标退化，位置被写回 target 后卡死 | 同上；注视距离恒为 `navState.distance`，target 跟着机位走。回归断言："连续前飞每一段都有效" |
| 在输入框里打 wasd，镜头却飞了 | 全局 `keydown` 没排除输入态 | 键盘导航一律先过 `isEditableTarget(event.target)`（含 `contentEditable`） |
| **自动关键帧不报错但把数据弄坏** | 同一时刻追加多个关键帧：求值取后一个、静默丢弃前一个；堆到 30 帧时中间时刻插值跳变（实测 x 从 0 跳到 64.5） | `upsertObjectKeyframe()` / `upsertCameraShot()` **同刻覆盖**且沿用原 id（换 id 会让时间轴选中态消失） |
| 自动关键帧开了以后，撤销一次只退回半个操作 | 属性修改与打帧分成两次 `editScene`，产生两条历史 | 在 `editScene` 里把打帧结果与变更**合并为同一个新场景**再 commit 一次 |
| 改个颜色也冒出一堆关键帧 | 对比用了整个物体对象 | 只比"会进关键帧"的字段；`objectTransformChanged()` 与 `buildObjectTransform()` 的字段集合必须**同步改**，一边加一边漏会静默少打帧 |
| 自动关键帧在播放时把帧写到"路过"的时刻 | 播放中播放头在跑，拖物体就会写到非用户预期的时刻 | `shouldAutoKey()` 在 `playing` 时返回 false；UI 必须显示「播放中暂停记录」，否则用户以为是 bug |
| **CDP 验证脚本莫名失败，功能其实是好的** | 上次测试的自动保存留下恢复快照 → 产品弹「发现未保存的内容」并铺 `.dialog-veil`，盖住视口、吃掉所有指针事件 | 脚本开头先关掉该对话框。另外禁用态按钮**仍在 DOM 里**，要断言 `disabled` 而不是"条目不存在" |
| 用 PowerShell 改带中文的文件后变成非法 UTF-8 | 本机是 PowerShell 5.1，`Get-Content`/`Set-Content` 默认按 ANSI(GBK) 读写，UTF-8 内容被当 GBK 解码再编码，中文全糊、`read` 报 invalid UTF-8 | 源码/文档一律用编辑器工具改，**不要用 PowerShell 做文本往返**；必须用命令行时显式 `-Encoding UTF8` |
| **父组件 commit 后同步调用子组件方法去"应用新配置"** | 组件读到的 prop 还是旧值（Vue 的 props 是异步更新的），于是按旧配置初始化。实例：切换相机导航方案时 `controls.enabled` 按旧方案设置，orbit 被误设成禁用，环绕整个失效 | 让子组件自己 `watch` 那个 prop 并重建内部状态；父组件只负责改 store |
| **以为"把相机模型设成 `visible = false`"就不会被点到** | three.js 的 `Raycaster` **不检查 `visible`**（只查 layers），隐藏的机身照样被射线打中；相机视角下编辑相机就在相机原点，点一下就命中相机模型并挂上控制柄 | 拾取函数入口显式排除该状态（`pickSceneCamera()` 判 `cameraViewActive`）；`attachTransformControls()` 同样在入口拦 |
| **依赖节流计时器提交"操作结束"** | 目标对象带阻尼时会持续触发 `change`，不断重置计时器，提交迟迟不发生（"转了但数据没动"）。实例：OrbitControls 环绕 | 用库提供的明确结束事件（OrbitControls 的 `end`）立刻提交；节流只用于过程中的显示更新 |
| **物体一旦有关键帧就"拖不动、松手弹回"** | 时间轴求值在**每个**时刻覆盖物体变换，用户拖完立刻被求值盖掉。注意：store 数据其实已经改对了，只查数据会误判成功能正常——典型的"数据对、画面错" | 在唯一写入口 `editScene` 记下本次变更动过的物体，显示层对这些物体改用真实值；**播放头一变就清空**（Maya/Blender 约定），播放中/只读不记，绑定导航线的物体不参与 |
| **同一时刻堆了两个关键帧** | 求值只取后一个、静默丢弃前一个；堆到 30 帧时中间时刻插值异常跳变（实测 x 从 0 跳到 64.5）。不报错，只在成片里看得出 | 记录走 `upsertObjectKeyframe()` / `upsertCameraShot()`（同刻覆盖、沿用原 id）；复制走 `findAvailableTimelineTime()` 避开已占用时刻 |
| **把引用烘成坐标** | 相机绑定物体时若把物体位置写进 `camera.target`：播放时每帧都在改相机 → 撤销栈与脏标记被动画刷爆；导出逐帧求值基于已烘值再算，误差累积 | 存引用（`targetObjectId`）在求值时解析；解除绑定后静态 `target` 原样还在 |
| **绑定只在播放时生效** | `displayedCamera` 停在 0 秒时提前 `return this.camera`，跳过绑定解算 | 0 秒也要解算绑定 |
| **物体显示在 A、相机看向 B** | 求值函数用"关键帧求值结果"算 target，画面显示用 `displayedObjects`（带手动编辑覆盖），两条路径的物体列表不一致 | 视口在求值后再用 `displayedObjects` 解算一次；导出/播放时覆盖为空，两次一致 |
| **打了镜头轨后物体绑定失效** | 相机是从 shot 数据重建的，不自带 `targetObjectId` | 绑定以**基准相机**为准，求值后补回再解算 |
| **关掉的开关在导出时又自己打开** | 求值时只补了 `targetObjectId`，漏了 `lookAtEnabled` | 一行 `?? / !== false` 的默认值也要一起补；新增字段时检查所有"从基准相机搬运"的地方 |
| **"是否绑定"与"是否启用"混成一个状态** | 取消勾选时顺手清掉 id，重新勾选就找不到对象；或者反过来，关掉了却还在生效 | 拆成 `targetObjectId`（记是谁）+ `lookAtEnabled`（用不用）；UI 置灰而不是消失 |
| **验证脚本用 store 位置去比对相机朝向** | 物体在 t=0 有关键帧时，显示位置是求值结果而非 store 值，断言会把正确行为判成 bug | 比对对象要选"画面里显示的那一个"（`displayedObjects`），不是 store 原值 |
| **三端 schema 版本号悄悄分叉** | TS 基线停在 12，JS/Python 已是 13；同一份工程在不同端校验结果不同，且只有测试才会发现 | 改 schema 时三处一起核对；`/api/meta` 里的版本号**必须引用常量**而不是写死数字（曾硬编码 13，升版时漏改） |
| **同一约束的魔法数字写在多处** | 视场角上下限在 InspectorPanel 与 AI 命令里各写了一遍 `10/120`，加焦距时才发现它把镜头卡在约 5.7~112mm，135mm 设不出来 | 抽成单一常量来源（`MIN_FOV_DEGREES` / `MAX_FOV_DEGREES`）并从所有调用点引用 |
| **切换方案时父组件 commit 后同步调子组件方法** | 子组件读到的 prop 还是旧值（Vue props 异步更新），按旧配置初始化。实例：切到 orbit 时 `controls.enabled` 按旧方案设成禁用，环绕整个失效 | 让子组件 `watch` 那个 prop 自己重建状态 |
| **只改 `controls.target` 想让相机跟随物体平移** | `OrbitControls.update()` 按 `position - target` 反推球坐标再写回位置，target 一动反而把相机**按在原地**（轴心跟上了、机位没动） | 要**平移跟随**必须机位与轴心一起平移；只要"原地瞄准"就**只改 target**。（本项目现状是后者：环绕只看不跟） |
| **拖拽绑定物体时镜头松手才"跳"一下** | 拖拽期间 `handleObjectTransform(commit:false)` 只改视口节点、不写 store，所以父组件解算的 `cameraState` 看向点是旧的；瞄准逻辑读它就等于读旧值 | 视口从**正在被拖的节点**读实时位置来解算（`liveBoundTarget()`）；其余时刻仍用父组件解算值，保证三条路径口径一致 |
| **每帧同步的朝向被写在"移动时"分支里** | 拖物体时用户没按 WASD，`stepCameraView()` 在 intent 全零时提前 return，朝向同步被跳过 → 视线不更新 | 朝向同步移到 intent 判断**之前**，每帧都做（一次 lookAt 的开销可忽略） |
| **验证脚本断言"相机每步位移均匀"** | 那测的是 TransformControls 对合成鼠标输入的响应曲线，不是相机行为，会误报 | 断言"轴心 == 物体实时位置"；且必须在**松手前**采样才能区分"实时更新"与"松手才更新" |
| **工具条同时高亮两个按钮** | "选择"只看 `tool === 'select'`，而变换按钮也把 `tool` 设成 `select`，于是移动模式下"选择"和"移动"一起亮 | 给 `transformMode` 加第四态 `'select'`（无操纵器）；选择按钮要求 `transformMode === 'select'` |
| **给 `TransformControls.setMode()` 传了非法值** | 它只接受 translate/rotate/scale；传 `'select'` 会报警并把控制柄留在原地 | 挂载前先判 `TRANSFORM_MODES.includes(mode)`，否则 `controls.detach()` |
| **把"清操纵器"塞进通用的 `setTool('select')`** | 内部多处用 `setTool('select')` 收尾（快速建造/切割完成），顺带清操纵器会让用户建完墙体就没法直接拖 | 只有工具条选择按钮与 Q 键走单独的 `activateSelectTool()` |
| **`quaternion.copy(start).slerp(target, k)` 把旋转锁死** | `slerp()` 原地修改，`copy` 之后 `target` 已是 `start`，等于"和自己插值" → 转角恒为 0°，拖旋转完全没反应 | 先把原始朝向 `clone()` 出来：`copy(start).slerp(raw, k)` |
| **减速改成"在上一帧结果上累乘"** | 结果会随帧率漂移：拖得慢和拖得快，同样鼠标位移得到不同距离 | 每帧从**按下时的快照**换算（TransformControls 本来就是按指针绝对位移算值的） |
| **测量拖拽灵敏度时用了斜视角** | 轴向透视缩短会混进比值（斜视角下 1px 可能对应 1.6 倍世界单位），测出的"比值"不是减速系数，会误判成减速失效 | 受控布置：相机正对物体、被拖轴水平投影不被缩短；并用几何公式 `2·tan(fov/2)·距离/画布高度` 做基准 |
| **canvas 被浏览器拉伸（"画面扁扁的"）** | canvas 的 CSS 是 `width:100%` 撑满容器，绘制缓冲由 `setSize(w,h,false)` 决定（**不改样式**）；而 `resize()` 只挂在 `window.resize` 上——**布局变了但窗口没变就没人通知渲染器**。预演隐藏工具栏/侧栏，容器 1244→1600，缓冲停在 1244 → 横向拉伸 1.2862× | 用 **ResizeObserver** 盯住视口容器；进出预演再在 `$nextTick` 显式补一次（观察器是异步回调，可能晚于第一帧）。`handleResize()` 加"尺寸没变就返回" |
| **换画幅后画面变扁/变窄，焦距却还显示原值** | `fovDegrees` 是**垂直**视场角，画幅一变它的含义就变；只改 `aspectWidth/aspectHeight` 等于同一颗镜头换了焦段（25.64mm 选 21:9 变 19.54mm） | 换画幅时按"长边定视野"重算视场角（`aspectChangePatch()`），焦距与长边视野保持不变 |
| **把"保持镜头"的换算写在按钮的点击处理里** | 只有点那个按钮的路径是对的；AI 命令、撤销重做、工程载入都会绕过它 | 放在 `Editor.updateCamera`——相机的唯一写入口；且规则是"只给画幅、没给视场角时才重算" |
| **镜头轨换算用了新画幅当基准** | 等于拿"已换算过的结果"再算一次，结果原地不动（实测 fov 42→42，看起来像没执行） | 换算基准必须是**旧画幅**（`previousCamera`）；镜头自带画幅就用它自己的 |
| **TransformControls 松手时写死 `controls.enabled = true`** | `wasd` 相机视角下相机归导航独占，拖过一次物体后 OrbitControls 被悄悄打开，表现为"拖完物体后 WASD 不灵 / 视角自己转" | 解锁时按 `shouldRunOrbitControls(cameraViewActive, scheme)` 判断 |
| **相机在中间关键帧停顿** | 逐段 smoothstep 缓动，每段两端速度归零；位置还是分段直线 | 时间参数化的向心 Catmull-Rom：穿过关键帧、速度连续、支持弧线（`core/camera-path.js`） |
| **同刻关键帧让整条轨迹变 NaN** | 两个同刻关键帧 → 段时长 `dt = 0` → 切线公式除零 → 位置 NaN → 相机消失 | 关键帧进求值前必须过 `normalizeKnots()`：排序、丢弃非法项、**合并同刻** |
| **焦距在两个端各算一套** | 前端按 A 口径、后端按 B 口径，导出的提示词描述的镜头与实际画面不一致 | 口径统一为 three.js `filmGauge`（长边定视野）；后端与前端公式逐字等价并用测试交叉验证 |

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
- [ ] **相机视角下是否停掉了 `OrbitControls.update()`？**（`shouldRunOrbitControls()`；否则朝向被覆盖、飞近注视点会塌陷卡死）
- [ ] 手动驱动相机后，是否同时同步了 `controls.target`，让退出时不跳？
- [ ] 相机/HUD 相关的"生效"是否验证了**画面**，而不只是 store 值？

### 时间轴与关键帧

- [ ] 打帧是否走 `editScene`，且与属性变更**合并成一次** commit（一次操作 = 一次撤销）？
- [ ] 同一时刻是**覆盖**而非追加？覆盖时是否沿用原 id？
- [ ] 手动记录与自动记录是否共用同一个构造函数（`buildObjectTransform`）与同一个 upsert？
- [ ] 可动画字段的对比范围与写入范围是否**一一对应**？（只改颜色/名称不该打帧）
- [ ] 新增可动画字段时，`buildObjectTransform()` 与 `objectTransformChanged()` 是否同时改？
- [ ] 播放中是否暂停打帧，并且 UI 有明确提示？
- [ ] **在有动画的物体上拖拽，画面是否立刻跟随（不被关键帧拽回）？** 换播放头后是否重新由关键帧求值？
- [ ] 复制关键帧/镜头是否避开了已占用的时刻？

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
