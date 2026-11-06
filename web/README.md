# 小白盒 Web 版

把原本的 Electron 桌面版「小白盒」重写为浏览器可用的 Web 应用，**功能集合保持不变**。
定位依旧是：面向零基础创作者的「白模场景 + 镜头 + 动画」草稿工具，
产出的白模图、控制参考图与场景说明，用于投喂给 AI 图生视频 / 文生视频平台。

- 前端：Vue 2 + Vuex + Vue Router + Three.js（webpack 5 构建）
- 后端：Python 3.10 + FastAPI + Uvicorn
- 工程文件：`.block3d`（JSON，`schemaVersion = 12`）

---

## 一、快速开始

### 最快路径：双击 `start.cmd`

在 `web` 目录下**双击 `start.cmd`**，浏览器会自动打开应用。

首次运行会自动完成：检查 Python 3.10.11 → 安装后端依赖 → 安装前端依赖 → 构建前端 → 启动服务。
之后每次启动只需几秒（源码没变时跳过重建；源码有改动会自动重新构建）。

默认是**生产模式**：单个进程同时提供 API 与前端页面，只有一个地址
`http://127.0.0.1:8000`，不需要开两个窗口。

```powershell
.\start.cmd                  # 生产模式（默认，一键）
.\start.cmd -Dev             # 开发模式：前端热更新（改 UI 时用）
.\start.cmd -Port 8081       # 换端口
.\start.cmd -Rebuild         # 强制重新构建前端
.\start.cmd -NoBrowser       # 不自动开浏览器
```

> 停止：在窗口里按 `Ctrl+C`。
> 若提示端口被占用，通常说明应用已经在跑了，直接打开提示里的地址即可。

### 0. 前置要求

| 组件 | 要求版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 24.0.0 | 实测 v24.18.0 |
| npm | ≥ 10 | 实测 12.2.0（见下方「版本说明」） |
| Python | **3.10.x** | 实测 3.10.11 |

> **版本说明（与最初设想有出入，这里如实记录）**
>
> 1. **Python 3.10.20 不存在**。CPython 3.10 系列的最后一个版本是 **3.10.11**
>    （2023-04-05 发布，此后 3.10 只发安全补丁源码，不再提供 Windows 安装包）。
>    另外请注意：`3.10.0a7` 这类 alpha 版本缺少 `types.UnionType`，
>    直接跑 Uvicorn 会报 `AttributeError: module 'types' has no attribute 'UnionType'`，
>    因此必须使用 3.10.11 正式版。
> 2. **npm 实测为 12.2.0**，而非最初设想的 11.61.0。npm 12 引入了
>    `allowScripts` 机制，会让部分依赖的 postinstall 不再自动执行——
>    本项目已通过显式脚本规避（见「三、构建与部署」）。

### 1. 安装依赖

```powershell
# 后端
cd web\backend
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

# 前端
cd ..\frontend
npm install
```

`requirements.txt` 与 `package.json` 里所有依赖都锁定了精确版本，
**不要用 `^` / `~` 放宽**：三端（TS 原版 / JS 前端 / Python 后端）需要可复现的构建结果。

### 2. 手动启动（不使用一键脚本时）

#### 开发模式（前后端分离，支持热更新）

```powershell
# 终端 A：后端
cd web\backend
py -3.10 -m uvicorn app.main:app --reload --port 8000

# 终端 B：前端
cd web\frontend
npm run dev        # http://localhost:8080
```

前端 dev-server 会把 `/api/*` 代理到 `http://127.0.0.1:8000`，
因此浏览器里只需要访问 `http://localhost:8080`。

#### 生产模式（单进程部署）

```powershell
cd web\frontend
npm run build      # 产出 web/frontend/dist

cd ..\backend
py -3.10 -m uvicorn app.main:app --port 8000
# 打开 http://127.0.0.1:8000
```

`app/main.py` 会检测 `web/frontend/dist` 是否存在：
存在则托管静态资源，并把未命中的路径回落到 `index.html`（交给 vue-router）。
**这样只需要部署一个进程**，不必再架一个静态服务器。

---

## 二、目录结构与职责边界

```
web/
├─ start.cmd                  一键启动（双击）
├─ start.ps1                  启动器实现（-Dev / -Port / -Rebuild / -NoBrowser）
├─ dev-backend.ps1            只启动后端（调试后端时用）
├─ dev-frontend.ps1           只启动前端 dev-server
├─ verify.ps1                 一键全量验证（lint + 单测 + 构建 + 冒烟）
├─ tools/
│  └─ verify-camera-autokey.mjs  浏览器级回归：相机视角 + 自动关键帧（CDP 发真实键鼠）
├─ backend/
│  ├─ app/
│  │  ├─ main.py                  FastAPI 入口：CORS、鉴权路由、SPA 回落、自动迁移
│  │  ├─ smoke.py                 端到端冒烟脚本（打真实 HTTP）
│  │  ├─ api/routes.py            用户侧 REST 路由
│  │  ├─ api/admin_routes.py      管理员：用户 / 跨用户工程
│  │  ├─ db/                      SQLAlchemy 模型与会话
│  │  ├─ models/project.py        工程文档的 Pydantic 模型与迁移
│  │  ├─ scripts/                 set_role / set_password / import_legacy
│  │  ├─ data/platform-profiles.json  平台预设（帧率 / 码率 / 时长 / 画幅）
│  │  └─ services/
│  │     ├─ auth.py               Cookie 会话、登录、管理员依赖
│  │     ├─ project_repo.py       工程元数据与最近打开
│  │     ├─ project_store.py      按用户目录的工程 / 恢复 / 导出落盘
│  │     ├─ ai_service.py         AI 服务商配置与对话（密钥不出服务端）
│  │     ├─ platform_profiles.py  平台规则校验
│  │     └─ scene_output.py       场景说明 + 建议提示词
│  ├─ alembic/                    数据库迁移
│  ├─ tests/test_core.py          单元 / 接口测试（含鉴权与隔离）
│  ├─ requirements.txt
│  └─ workspace/                  运行时数据（app.db、用户目录、AI 配置）
│
└─ frontend/
   ├─ public/
   │  ├─ index.html
   │  └─ mannequin/              人台外观资源（不走打包器，由 CopyWebpackPlugin 复制进 dist）
   │     ├─ quaternius-ual1-standard.glb   Quaternius UAL1 蒙皮模型（约 7.3 MB）
   │     └─ LICENSE.txt                   授权说明：CC0 1.0 Universal（可自由商用）
   ├─ src/
   │  ├─ main.js                  挂载 Vue、同步 router 到 store
   │  ├─ App.vue                  外壳：主题、通知、忙碌遮罩、全局快捷键
   │  ├─ api/client.js            唯一网络出口，组件不直接 fetch
   │  ├─ router/index.js          /login /editor /projects /admin
   │  ├─ store/index.js           Vuex：唯一状态源 + editScene 唯一写入口
   │  ├─ core/                    纯逻辑层（无 DOM、无 Vue 依赖，可单测）
   │  ├─ components/              面板与对话框（只发事件，不改状态）
   │  ├─ views/                   Login / Editor / Projects / Admin
   │  └─ styles/index.css         设计令牌与原子类
   ├─ webpack.config.js
   ├─ vitest.config.js
   └─ eslint.config.mjs
```

### 人台外观资源

网页版人台的外观层与 Electron 原版一致：GLB 蒙皮模型 + 骨骼绑定 + 预设动作采样。

- 来源：[Quaternius Universal Base Characters](https://quaternius.com/) 的 `Superhero_Male_FullBody`，
  授权 **CC0 1.0 Universal**（见 `frontend/public/mannequin/LICENSE.txt`），可自由商用、无需署名。
- 放置位置：`frontend/public/mannequin/quaternius-ual1-standard.glb`（约 7.3 MB）。
- **不能用 `import` 打包**：vitest 基于 Vite 内核，会把 `.glb` 当 JS 模块解析并抛 `invalid JS syntax`，
  导致纯逻辑单测全崩。因此走 `public/` + `CopyWebpackPlugin` 复制进 `dist`，代码里只引用 URL 字符串
  （见 `src/core/mannequin-visual.js` 的 `MANNEQUIN_ASSET_URL`）。
- `webpack.config.js` 里把 `performance.maxAssetSize` 提到 8 MB，否则会为这个 7.3 MB 的资源刷无意义告警。
- 动作时间不使用独立时钟，而是由时间轴的 `timelineTime` 驱动，与原版数据契约保持一致
  （只持久化 `presetId` / `pose` / `manualJoints`）。

### 导航线（路径运动）

让物体（人台 / 方块 / 导入模型）沿一条地面引导线运动，用于走位预演。

**怎么用**

1. 左侧工具栏点「导航线绘制」，场景里会落一条空路径并进入绘制模式。
2. 在网格上**按住左键拖动**，每 0.6 米自动落一个节点，松手即完成。
3. 在右侧属性面板选中任意物体 → 「沿导航线运动」→ 选一条线即可绑定。
4. 拖播放头 / 点播放，物体就会沿路径走，朝向默认跟随路径前进方向。

**设计约定（改动前先读）**

- **节点时刻是算出来的，不存。** 第 i 个节点的时刻 =（前 i 段累计弧长 / 总弧长）× 总时长。
  好处是"沿路径拖节点 → 时间轴标记跟着走"天然成立；
  若额外存一份 `timeSeconds`，就必然出现"位置和标记对不上"的脏数据。
- **节点用局部坐标**（相对路径对象自身的 `position`）。旋转 / 缩放不参与运算：
  路径是地面引导线，允许旋转会让朝向计算无法解释，也会让手工输入的坐标失真。
- **时间轴标记是派生的**，不写进 `timeline.objectKeyframes`（`buildPathKeyframes` 现算）。
  存两份就一定会有"路径改了、时间轴没跟上"的错位。
- **绑定优先级最高**：先算关键帧，再让绑定物体覆盖为路径上的位置与朝向
  （见 `applyTimelinePreview`）。用户明确指定"沿导航线走"，就不该被遗留关键帧拽回原地。
- **拖拽节点只能在相邻两段上滑动**（`adjacentSegmentsFor`）。
  放开全路径投影的话，指针扫过远处时节点会"跳"到线另一头。
- **朝向约定物体本地 +Z 为正面**（与 `Object3D.lookAt` 一致），
  和相机的 -Z 语义刻意区分开——这两套约定混用正是之前摄影机视锥朝向出错的根因。

**数据契约（schema 13 的导航线部分；schema 14 只给相机加了 `targetObjectId`）**

```jsonc
{
  "kind": "path",
  "pathNodes": [{ "x": 0, "y": 0, "z": 0 }],   // 局部坐标，米
  // 任意物体都可带：
  "pathBinding": {
    "pathId": "…",
    "followRotation": true,   // 朝向是否跟随路径
    "offsetSeconds": 0,       // 相对路径起点的时间偏移
    "heightOffset": 1.1       // 离地高度，绑定时按物体当前高度记下
  }
}
```

### 视频导出（MP4）

主产物是 **MP4**：浏览器内用 WebCodecs 编码 H.264，再用 mp4-muxer 封装成容器。
首帧 / 尾帧单图保留为附加产物（很多平台需要首尾帧成对上传）。

**为什么不再默认导出序列帧**：5 秒 24fps 就是 120 张 PNG，落盘、下载、
再交给剪辑软件转码，链路又长又占空间。WebCodecs 在 Chrome/Edge 111+ 是原生能力，
直接编成 MP4 只需一次上传。但**仍然保留**序列帧选项——H.264 的可用性依赖硬件，
有些环境确实没有可用的编码器，那时序列帧是唯一退路。

**分层**（这决定了代码放在哪）：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 纯逻辑 | `src/core/video.js` | codec 候选表、微秒换算、关键帧间隔、文件名、能力文案 |
| 浏览器封装 | `src/media/mp4-encoder.js` | WebCodecs + muxer，含运行时能力探测 |
| 取帧 | `SceneViewport.withOutputSize()` / `captureFrameToCanvas()` | 按导出尺寸渲染一帧到可复用 2D 画布 |

`media/` 是专为"必须依赖浏览器 API"的代码开的目录。ESLint 里
`VideoEncoder` / `VideoFrame` 这些全局**只对 `src/media/**` 开放**，
这样 `core/` 那条"不许依赖 DOM / 浏览器全局"的边界才能被 lint 真正守住。

**六条必须踩对的坑**（都已在代码注释里说明原因）：

1. **codec 必须运行时探测**。H.264 的 profile 支持是硬件相关的，实测本机
   `avc1.42E01E`（Baseline）与 `avc1.4D401F`（Main）都不可用，只有
   `avc1.640028` / `avc1.640032`（High）能用。写死任何一个字符串都必然在别的机器上失败。
2. **`timestamp` 单位是微秒**。写成毫秒的话 5 秒视频会变成 5 毫秒。
3. **`VideoFrame` 必须 `close()`**。它是 GPU/系统内存句柄，漏掉会稳定 OOM，
   而且崩得毫无征兆。放在 `encode()` 之后的 `finally` 里。
4. **要等编码队列**。`encode()` 是入队即返回，每帧后检查 `encodeQueueSize`
   并让出主线程，否则内存曲线直接起飞，进度条也不会重绘。
5. **`fastStart: 'in-memory'`**。默认把 moov 写到末尾，文件合法但很多播放器
   与平台会判定"损坏"。代价是多留一份内存，短视频完全可接受。
6. **导出时改渲染尺寸必须同时改 `camera.aspect`**。导出画幅（16:9 / 9:16 / 1:1）
   几乎从不等于视口宽高比，只改渲染器会把画面横向拉伸——而文件结构完全合法，
   只验容器是发现不了的。

**逐帧必须同时应用相机与物体**

`evaluateTimelineAtTime()` 返回的是 `{ camera, objectTransforms }`。
只把 `camera` 推给视口、把 `objectTransforms` 丢掉，产出就是
**一张静止画面加轻微运镜**——文件合法、能播放、时长也对，唯独物体不动。
这个错误曾在三条产物路径（MP4 / 序列帧 / 首尾帧）里同时存在，
所以现在统一收口到一个 `renderFrameAt()`：

```js
const renderFrameAt = async (time) => {
  const frame = evaluateTimelineAtTime(timeline, camera, time)
  viewport.applyCameraState(frame.camera)     // 相机
  viewport.applyTimelineFrame(timeline, time) // 物体（含人台姿势）
}
```

`applyTimelineFrame()` 内部重新调 `applyTimelinePreview()`，把
position / rotation / scale 写进 three.js 根节点，再 `scene.updateMatrixWorld(true)`。
导出结束必须 `restoreObjectTransforms()`——**不能**用"时间轴 0 时刻"复位，
因为 0 时刻自己也有键值，未必等于用户编辑时的状态。

### 成片预演

顶栏中间的 **「成片预演」** 把视口切成"看成片"模式：画面按相机画幅等比缩放后居中，
四周补黑边，内容由**时间轴求值**的相机渲染，时间轴自动循环播放。按 `Esc` 或顶栏按钮退出。

**为什么要跟导出共用一套逻辑**：预演的价值就是"导出前先看一眼"。如果它自己另写一套
渲染路径，用户看到的和最终拿到的迟早会分叉，而这个差异只能在成片里才发现，反馈链路太长。
所以三样东西是共享的：

| 共享项 | 来源 |
| --- | --- |
| 相机位姿 | `evaluateTimelineAtTime()`（与导出逐帧同一个函数） |
| 画幅比 | `cameraState.aspectWidth : aspectHeight`（与 `outputSize()` 同源） |
| 哪些对象算"辅助" | `editorOverlays()` 一份清单 |

`editorOverlays()` 收的是**只属于编辑器、不属于成片**的对象：
`guideGroup`（摄影机模型/灯光示意）、`grid`、`pathGroup`（导航线）、
控制柄 helper、选中框。后两个没有挂在 `guideGroup` 下，而是直接 `add` 到 scene——
这正是之前"选中物体后导出的成片里带着橙色线框和箭头"的根因。
收成一份清单后，导出、六通道参考图、预演共用，不会再各自漏一个。

**渲染用 scissor，不改相机 aspect**。视口的物理宽高比由窗口决定，
要显示 16:9 的成片只能在视口里框一块 16:9 的区域，其余留黑边——
这就是所有剪辑软件预览窗的做法。

**预演专用相机**：单开一台 `previewCamera`，不复用 `this.camera`。
编辑相机归 OrbitControls 管，复用的话每帧都要写它的位姿，
退出后视角就回不去了（还得存快照、还原、处理阻尼残量）。
单开一台成本极低，也让"预演不许动编辑视角"成为结构性事实。

### 相机视角（对标 Maya 的 look through camera）

顶部 **菜单栏 → 相机 → 进入相机视角**（或视口 HUD 上的提示按钮）。
进入后编辑视角会**对齐场景摄影机**，导航手势实时写回相机属性；
按 `Esc` 或菜单里的「退出相机视角」离开。

| 操作 | 作用 |
| --- | --- |
| `W` / `A` / `S` / `D` | 沿视线前后、左右平移（米/秒，与帧率无关） |
| `Q` / `E` | 下降 / 上升 |
| `Shift` | 加速 2.5 倍 |
| **左键拖拽** | 转向（与中键等价，笔记本没有中键也能用） |
| **左键点按** | 选中指针下的物体（拖动不超过 4px 才算点按） |
| 中键拖拽 | 转向（偏航 + 俯仰，俯仰有上下限） |
| `Esc` | 退出 |

**左键为什么要区分拖动与点按**：按下时先只记起点，移动超过 4px 才认定为拖拽；
松手时如果几乎没动，才执行拾取。不能在按下时直接拾取——那样每次想转视角
都会顺手改掉选中项（用户看到的是"一转镜头选中的东西就变了"）；
也不能因为手抖 1~2px 就放弃选中。

`orbit` 方案（Maya 环绕）下左键归 OrbitControls，用于绕轴心环绕。

**指针事件优先级（相机视角下同样生效）**，从上到下先命中先处理：

| 优先级 | 命中条件 | 行为 |
| --- | --- | --- |
| 1 | 预演中 | 一律不接受编辑手势 |
| 2 | **指针落在控制柄（gizmo）某根轴上** | 移动 / 旋转该物体（或灯光） |
| 3 | 相机视角 + 中键 / 左键 | 转视角 / 点选物体 |
| 4 | 右键 | 交给 OrbitControls 平移 |
| 5 | 其他 | 常规拾取与造物手势 |

第 2 条**必须排在相机视角分支之前**，否则取景时拖 gizmo 会被当成"转视角"。
而"相机视角下不挂控制柄"的旧限制已收窄为**只不挂场景相机自身**的——
物体和灯光的控制柄照常挂载，这样取景时也能直接摆物体。

**环绕模式下的联动：只看不跟。**

绑定物体移动时，环绕相机**机位保持不动，只持续把视线落到目标上**。
不跟着走，所以环绕半径会随物体距离变化——这是该模式的固有语义，不是 bug。

> 这里曾经有一套"机位与轴心一起刚性平移"的跟随，外加一个「环绕时跟随目标移动」
> 开关。后来按要求**整体移除**了：用户要的是"镜头单纯的看向 target"。
> 如果以后要加回来，务必记住踩过的坑：只改 `controls.target` 是不够的——
> `OrbitControls.update()` 会按 `position - target` 反推球坐标再写回位置，
> target 一动它反而把相机**按在原地**；必须**机位与轴心一起平移**才行。

**拖拽时视线必须逐帧更新**，而不是松手才跳一下。

这里有个很隐蔽的坑：拖 gizmo 时 `handleObjectTransform(commit: false)`
**只改视口里的 three.js 根节点、不写 store**（否则每帧写历史会灌满撤销栈）。
于是父组件解算出来的 `cameraState` 里，看向点仍是**拖拽开始前**的旧值——
瞄准逻辑去读它，镜头就会全程不重新对准、松手那一刻才"跳"过去。

解法是视口自己从**正在被拖的那个节点**读实时位置来解算看向点
（`liveBoundTarget()`），只在"被拖的正是绑定物体"时生效；其余时刻仍回退到
父组件解算好的值，保证编辑、预览、导出三条路径口径一致。

配套还改了一处：`stepCameraView()` 里朝向同步**从"移动时才同步"改成"每帧都同步"**。
因为拖物体时用户并没有按 WASD，但镜头必须跟着物体实时重新瞄准——
放在 `moving` 分支里就会漏掉这种情况。

**飞行模式（`wasd`）下同样只重新对准**：机位自由移动，镜头始终盯着被绑定物体
（相当于一条 aim 约束）。此时中键/左键转向不会改变朝向，转不开是预期行为。

**这个开关只影响编辑时的视口导航**，不影响导出/预览：导出时相机始终看向
被绑定物体，与界面偏好无关——否则同一份工程会因为一个界面开关而导出不同结果。

**环绕轴心**：`orbit` 方案的轴心默认是**世界原点 (0,0,0)**，进入环绕时
视线立即对准原点。这是 Maya tumble pivot 的默认语义。
不用"相机当前看向点"做轴心，是因为那个点会随上一次运镜漂到任意位置，
用户根本无法预期自己会绕着哪儿转。若相机绑定了物体（见下），轴心改为该物体位置。

**为什么要跟"取景"分开**：`cameraViewMode` 是"临时切到某台摄影机看一眼"（只读），
本功能是"接管相机"（会改数据）。两者语义相反，混成一个状态必然出现
"以为在看，结果改了相机"。因此状态是独立的 `cameraViewActive`。

**导航方案是可插拔的**，实现集中在 `src/core/camera-nav.js`：

- `wasd`（默认）：WASD 飞行 + 中键转向，相机由导航**独占驱动**；
- `orbit`：交给 OrbitControls 环绕（左键拖拽），松手把结果写回场景相机。

菜单里的两个勾选项就是这两个方案，选择会记在 `localStorage`。
**要换成别的键位或别的导航方式，只改 `core/camera-nav.js` 里的表与映射，组件不用动。**

两种方案的语义差别（改代码前必须搞清楚）：

| | `wasd` | `orbit` |
| --- | --- | --- |
| 谁驱动相机 | 本组件（`navState.yaw/pitch`） | OrbitControls |
| `controls.update()` | **必须停掉** | 必须运行 |
| 写回的 `target` | 由 yaw/pitch 反算 | 取 `controls.target`（环绕轴心） |
| 提交时机 | 停手 260ms 节流 | 松手（`end` 事件）立刻 |

**必须记住的坑（都实测踩过）**：

1. **`wasd` 方案下必须停掉 `OrbitControls.update()`**（见 `shouldRunOrbitControls()`）。
   它的 `update()` 每帧会 `camera.lookAt(target)` 并按 `position - target` 反推球坐标
   再写回位置，于是：朝向被强制指回旧 target（中键转向"store 变了但画面不转"），
   相机飞近注视点时半径趋近 0、球坐标退化，**相机被钉死在 target 上**
   （"往前飞了几米后突然不动"）。
2. **隐藏的相机模型依然会被射线打中。** three.js 的 `Raycaster` 不检查 `visible`，
   而相机视角下编辑相机就在相机原点、机身镜头视锥全罩在观察者身上，
   于是点一下就 `camera-select` → 控制柄挂到相机模型上并顺手关掉 OrbitControls，
   表现成"环绕只能转动镜头本身的旋转属性"。所以 `pickSceneCamera()` 与
   `attachTransformControls()` 都在**入口**判断 `cameraViewActive` 并直接返回。
3. **切换方案不能在父组件里同步调用重置。** Vue 的 props 是异步更新的，
   `commit` 之后立刻调用 `resetCameraNavState()` 时组件读到的还是旧方案，
   `controls.enabled` 会按旧方案设置（从 wasd 切到 orbit 时被误设成禁用，
   环绕直接失效）。方案切换必须由视口 `watch: cameraNavScheme` 自己响应。
4. **环绕不能只靠节流计时器提交。** 环绕默认开阻尼，松手后相机继续缓动，
   `change` 持续触发、不断重置计时器，提交迟迟不发生（"环绕了但场景相机没动"）。
   要用 OrbitControls 的 `end` 事件（松手）作为明确的操作结束信号。

**写回与撤销**：飞行期间只更新视口显示，停手 260ms 后才提交一次；
环绕在松手时提交一次。因此**一次操作 = 一次撤销**，不会一帧一条历史。

### 相机锁定物体（target 绑定）

把左侧物体列表里的物体**拖到属性面板摄影机的「看向」行上**，相机的看向点就
绑定到该物体：物体移动（含走导航线、播关键帧动画）时相机自动跟随。
点「解除」回到固定坐标。

数据上是相机多了一个可空字段 `camera.targetObjectId`（schema 14）：

| 值 | 含义 |
| --- | --- |
| `null` / 缺省 | 看向点就是静态的 `camera.target` 坐标（v13 及更早的行为） |
| 物体 id | 看向点 = 该物体在当前时刻的位置 |

**为什么存引用而不是把坐标烘进 `target`**：烘坐标的话物体一动就要改相机数据，
播放时每帧都在改 → 撤销栈与"有未保存修改"会被动画自己刷爆；导出逐帧求值时
还会基于已烘过的值再算、误差累积。存引用、在求值时解析，语义干净且可逆。

**三处必须保持一致，改一处就要同步**：

1. `evaluateTimelineAtTime()` —— 导出 / 预览 / 六通道图 / AI 截图走的路径。
   它内部**先算物体、再解算相机**，顺序不能反；绑定还必须从**基准相机**带到
   求值结果上，因为打了镜头轨之后相机是从 shot 数据重建的、不自带绑定。
2. `Editor.displayedCamera` —— 视口显示。它在求值之后再解算一次，
   用的是 `displayedObjects`（画面里真正显示的那份），
   这样"物体显示在 A、相机却看向 B"这种不一致不会发生。
3. `InspectorPanel` 的「看向」行 —— 绑定生效时整行换成"物体名 + 解除"，
   因为此时数字输入改了也没用；留着输入框会让人以为改数字能改朝向。

**坐标原点不一致的坑**：物体 `position` 的语义**按类型不同**——
基本体创建时 `position.y = size.y / 2`（position 就是几何中心），
人台与导入模型 `position.y = 0`（position 在底部）。所以"看向一个物体"不能
一律用 `position`，否则对着人台就是对着脚看。`objectFocusPoint()` 负责抹平，
**新增物体类型时必须在这里登记**。

**绑定失效的处理**：物体被删掉时退回静态 `target`（而不是跳到原点），
并在属性面板给出「绑定的物体已不存在」+ 清除按钮——不提示的话用户只会看到
数字在跳，联想不到是绑定。

**「看向物体」启用开关**：面板上有一个 checkbox，用来临时关掉绑定而不丢掉它。
两者语义不同，别混：

| 操作 | `targetObjectId` | 效果 |
| --- | --- | --- |
| 取消勾选 | **保留** | 相机改用静态 `target` 坐标；随时勾回来即可恢复，无需重新拖拽 |
| 点「解除」 | **清空** | 绑定关系真的没了，要重新把物体拖上去 |

关掉时绑定条会置灰，并出现「固定坐标」输入行（此时相机用的就是那组坐标）。
未绑定时不显示这个开关——"是否启用"没有意义。

**这个开关写进工程文件**（schema 15 的 `lookAtEnabled`），导出/预览都按它求值。
理由：它改变的是相机的**实际朝向**，属于创作意图；若只做界面开关，
就会出现"编辑时看到的画面与导出的不一致"。
缺省视为启用，所以 v14 及更早的工程行为不变（那时绑定就是"一绑就生效"）。

⚠️ **求值链路必须一起带上这个字段**。`evaluateCameraShots()` 在有镜头轨时是从
shot 数据重建相机的，不会带 `targetObjectId` / `lookAtEnabled`；两者都要从
**基准相机**补回来，否则会出现"关掉的开关在导出时又自己打开了"。

### 焦距（镜头）

摄影机属性面板新增 **焦距（mm）** 输入与常用焦段预设（14/24/35/50/85/135），
视口左下角浮层与导出说明也会写出焦距。

**焦距不是独立存储的参数**：它和视场角是同一个量的两种表达，项目里仍然只存
`fovDegrees`（唯一真值），焦距只是界面上更符合摄影直觉的输入方式。
存两份必然出现"改了视场角、焦距显示不同步"的漂移。

**口径与 three.js 完全一致**（`PerspectiveCamera.filmGauge` 默认 35mm）：
画幅的**长边永远占满整个 filmGauge**，`camera.fov` 是垂直视场角。于是横屏时
横向视野固定、竖屏时纵向视野固定——换画幅不会让镜头"突然变成另一个焦段"。
换算集中在 `core/focal-length.js`，单测里用 three.js 的公式逐字交叉验证过。

⚠️ **视场角范围已从 10°~120° 放宽到 5°~140°**。旧范围换算成焦距只有约
5.7~112mm，135mm 长焦根本设不出来。这组上下限现在**只有一个来源**
（`MIN_FOV_DEGREES` / `MAX_FOV_DEGREES`），之前 InspectorPanel 与 AI 命令里
各写了一遍魔法数字 `10/120`，升焦距时才暴露出问题。

**后端必须同步**：`services/scene_output.py` 里的 `focal_length_mm()` /
`describe_camera_lens()` 与前端逐字等价，否则会出现"画面按 50mm 构图、
导出的提示词却描述了另一个镜头"。说明文字里写焦距比写角度更有效——
AI 图像/视频平台对"50mm 镜头""长焦压缩感"反应很直接。

### 相机轨迹插值（向心 Catmull-Rom）

相机在多个镜头之间**穿过每个关键帧、速度连续、支持弧线**，实现见
`core/camera-path.js`。

**为什么换掉旧算法**：旧实现是"逐段线性插值 + smoothstep 缓动"，实测有两个缺陷：

| 时刻 | 位置 x | 速度(米/秒) | 问题 |
| --- | --- | --- | --- |
| 0 | 0 | **0** | 起步停顿 |
| 1 | 2.5 | 3.748 | 正常 |
| 1.958 | 4.994 | 0.454 | 快到中间镜头时减速 |
| **2** | 5 | **0.154** | **每个中间关键帧速度归零 → 相机"停一下"再走** |
| 4 | 10 | **0.154** | — |

另外位置是分段直线（逐分量线性），永远拍不出弧线运镜。

**采用的方案**：三次 Hermite + **非均匀 Catmull-Rom 切线**，且**用真实时间做
节点间距**。这一点是关键——three.js 的 `CatmullRomCurve3` 用弧长/几何参数，
适合"沿轨道匀速跑"；而相机轨迹要求"第 3 秒必须到第 3 个机位"，必须按时间参数化。
时间做节点间距后，节点处的导数就是真实速度，天然速度连续。

由此得到一个很有用的性质：**只有两个关键帧时，两端切线都等于该割线，
三次 Hermite 精确退化为匀速直线运动**——既穿过两端，又没有缓动停顿。
端点用单侧割线，中间节点用相邻割线斜率的加权平均。

**过冲防护**：Catmull-Rom 在急折角处会甩出去，因此把切线幅值限制在相邻弦长的
2 倍以内。只在病态输入时生效，正常运镜不受影响。

**其它约束**：

- **位置和看向点都走样条**。只对位置做样条、看向点线性插值的话，
  镜头会在弧线中段"斜着看"，主体忽左忽右漂。
- **`transition: 'cut'` 不参与插值**——硬切是剪辑语义，给它做平滑
  等于把硬切改成运镜。
- **fov 仍按线性插值**。焦距是 fov 的另一种表达，两者单调对应；
  实测 35°→42° 段与"按焦距线性"的差异只有 0.3°，肉眼不可见，
  而给标量做样条会过冲（"变焦到头又弹回来"），反而更糟。
- **同刻重复关键帧必须在 `normalizeKnots()` 里合并**：`dt = 0` 会让切线公式除零，
  整条轨迹变 NaN、相机直接消失。

⚠️ **行为变更**：老工程里的相机运镜会变——中间镜头不再停顿、路径变成弧线。
这是本次需求的目标，但如果要保留"每个机位都稳一下"的记录式手感，
可以后续给每个镜头加 `ease` 开关。

### 左侧工具栏（对标 Maya 的 Tool Box）

三组：**交互/变换工具** → **快速添加几何体** → **导入模型**。

**图标造型照 Maya 的语义走**：移动=四向箭头、旋转=环形箭头、缩放=方框+斜向箭头、
选择=箭头光标；几何体用"三面可见"的立体画法（立方体三个面、球体受光斑+暗面、
圆柱顶面椭圆+侧面）。

整体仍是**单色**：用 `currentColor` 的 3 档透明度（`1` / `.62` / `.32`）分别表示
受光面、侧面、背光面。这样既接近 Maya 实心图标的体量感，又能自动跟随主题色与
hover / active 态——做成彩色硬编码就会和深色界面打架。

不引入图标库：几个图标不值得多一个依赖，内联 SVG 才能用 `currentColor` 适配主题。

**Q / W / E / R 快捷键**（与 Maya 一致）：选择 / 移动 / 旋转 / 缩放。
右下角有角标提示，tooltip 里也写明。

- **相机视角下整体让位**：那里 W 是"向前飞"。用 `cameraViewActive` 判断而不是
  导航方案——两种方案下 W 都归导航占用。
- **带修饰键不拦截**：Ctrl/Cmd/Alt + R 必须留给浏览器（刷新等）。
- **输入框里不拦截**：否则在数值框里打字会切工具。

**Q 是"纯选择"**：进入选择模式并**摘掉操纵器**（Maya 的 Q 就是这样）。
实现上给 `transformMode` 增加了第四个取值 `'select'` 表示"无操纵器"。
注意它必须被 `TransformControls.setMode()` 挡掉——那个方法只接受
translate/rotate/scale，传别的值会报警并把控制柄留在原地。

**为什么选择按钮走单独的 `select-only` 事件**：`setTool('select')` 内部被多处
用于"收尾回到选择"（快速建造完成、切割完成等），那些场景**必须保留操纵器**，
否则用户建完墙体就没办法直接拖了。所以只有"工具条上的选择按钮"和 Q 键
才清操纵器。

**顺带修掉一个视觉缺陷**：改之前"选择"永远高亮（它只看 `tool === 'select'`），
于是处于移动模式时"选择"和"移动"**同时高亮**，工具条上出现两个激活项。
现在选择按钮额外要求 `transformMode === 'select'`，任何时刻只有一个激活项。

### gizmo 拖拽减速

拖拽手感**刻意不是 1:1**：鼠标移动 60px，物体只走 1:1 时的 **50%**。
常量 `TRANSFORM_DRAG_SENSITIVITY = 0.5` 一处可调（必须落在 `(0, 1]`）。

**先说清楚这不是 bug**：实测未减速时是**精确 1:1** —— 60px 鼠标位移对应
0.6142 世界单位，与几何期望 `2·tan(fov/2)·距离 / 画布高度` **完全一致（1.00×）**，
X 轴手柄和屏幕平面 XYZ 手柄都一样。所以"太灵敏"是主观手感，不是放大缺陷，
只能主动加一个减速系数。

**实现要点**：

- 每帧都从**按下时的快照**重新换算（`start + (raw - start) × k`），
  不在上一帧结果上累乘。TransformControls 本身是按"指针相对按下点的位移"
  算绝对值的，所以从快照换算既不会漂移，也不受帧率影响。
- 旋转用 **slerp** 沿最短弧把转角按比例缩小，不要对欧拉角插值（会走偏、
  甚至万向锁跳变）。
- **只对场景物体减速**。摄影机模型仍 1:1 —— 它的位姿直接变成机位，
  减速会让取景变迟钝，那不是"更精细"。

⚠️ **踩过的坑**：`quaternion.copy(start).slerp(target, k)` 是错的 ——
`slerp()` 原地修改，此时 `target` 已经被覆盖成 `start`，等于"和自己插值"，
结果**旋转彻底转不动**（实测转角恒为 0°）。必须先把原始朝向 `clone()` 出来。

⚠️ **测量这个系数必须在受控布置下做**：相机正对物体、X 轴水平投影不被透视缩短。
斜视角下沿 X 轴拖 1px 可能对应 1.6 倍世界单位，"比值"就和减速系数不是一回事了
（我第一次就测出 0.836×，误判成减速失效）。

### 画幅与成片比例

摄影机面板提供 8 种画幅预设：**2.39:1 / 21:9 / 16:9 / 3:2 / 4:3 / 1:1 / 9:16 / 4:5**。
画幅是**全局输出设置**（导出、预演、镜头轨都用它）。

**换画幅 ≠ 换镜头**。本项目沿用 three.js 的 `filmGauge` 模型——**长边永远占满 35mm**，
所以换画幅等价于摄影里"换传感器尺寸、镜头不换"：长边视野固定，短边视野随比例变化，
**焦距不变**。

因此切换画幅时必须**同时重算垂直视场角**（`fovDegrees` 是垂直角，画幅一变它的含义就变）。
实测同一颗 25.64mm 的镜头：

| 画幅 | 只改画幅（错误做法） | 保持镜头（现在的做法） |
|---|---|---|
| 16:9 | fov 42°，焦距 25.64mm | fov 42°，焦距 25.64mm |
| 21:9 | fov 42°，焦距 **19.54mm**（无端变广角） | fov **32.61°**，焦距 25.64mm |
| 9:16 | fov 42°，焦距 **45.59mm**（无端变长焦） | fov **68.62°**，焦距 25.64mm |

只改画幅不动视场角，画面就会"选个宽画幅就变扁、选个竖画幅就变窄"，
而面板上显示的焦距还是原来那个数——两边对不上。换算集中在
`core/focal-length.js` 的 `aspectChangePatch()`。

**这个不变量放在 `Editor.updateCamera` 里**，而不是按钮的点击处理里：
那是相机的唯一写入口，AI 命令、撤销重做、工程载入都自动受益。
规则是"补丁里只给画幅、没给视场角时才重算"——显式给了 `fovDegrees` 就以它为准。

**镜头轨（关键帧）也会一起换算**：每个镜头存着自己的 `fovDegrees`，那是"当时那个
画幅下的垂直视场角"。只改主相机不管镜头轨，就会出现"面板写着 25mm、一按播放却
变成另一个焦段"，编辑与成片不一致。换算基准必须是**旧画幅**——用新画幅当基准
等于拿已换算过的结果再算一次，结果原地不动（这个坑实测踩过）。

#### 预演画面尺寸（曾经"扁扁的"）

预演会隐藏工具栏与侧边栏，视口容器从 1244 变宽到 1600。但 `resize()` 原来只挂在
`window.resize` 上——**布局变了、窗口没变，就没人通知渲染器**。

而 canvas 的 CSS 是 `width/height: 100%`（撑满容器），绘制缓冲却由
`renderer.setSize(w, h, false)` 决定（第三参数 `false` = **不改样式**）。
于是缓冲停在 1244×750、CSS 盒子变成 1600×750，**浏览器把画面横向拉伸 1.2862×**——
实测就是这么个数字，这就是"画面扁扁的"。

修法是两层保险：

- **`ResizeObserver` 盯住视口容器**，任何布局变化（进出预演、开关侧栏、开监视器）
  都能补上；
- 进出预演时在 `$nextTick` 里**显式补一次**——`ResizeObserver` 是异步回调，
  预演的第一帧可能赶在它之前画出来。

配套给 `handleResize()` 加了"尺寸没变就直接返回"，避免观察器在无关重排里
反复重建投影矩阵。

### 自动关键帧（对标 Maya 的 Auto Key）

时间轴中间的红点开关。开启后，对**可动画属性**的任何修改都会自动在
**当前播放头时刻**记录关键帧，省掉反复点「记录关键帧」。

覆盖范围：

| 覆盖 | 不覆盖 |
| --- | --- |
| 物体位置 / 旋转 / 缩放 | 颜色、名称、描述、显隐、锁定、显示模式 |
| 人台姿势、预设、手动关节列表 | 画幅（`aspectWidth/Height`，全局输出设置） |
| 相机机位 / 注视点 / 视场角 | 灯光（**后续需求**，见下） |

**为什么挂在 `editScene` 而不是每个改变换的入口**：改变换的入口有 gizmo、
属性面板、多选拖拽、相机浮层、人台预设、AI 命令等六七处，逐个埋点必然漏，
以后新增入口还要记得补。在唯一写入口对比前后场景，天然全覆盖。

**两条硬约束**（都在 `src/core/auto-key.js` 里被单测钉住）：

1. **同一时刻重复打帧必须覆盖，不能追加。** 实测同一时刻存在两个关键帧时求值会取
   后一个、静默丢弃前一个；堆到 30 帧时中间时刻的插值会出现异常跳变
   （x 从 0 直接跳到 64.5）。这类问题不会崩，只会让数据悄悄劣化。
2. **打帧结果与属性修改必须合并成同一个新场景再 commit 一次。** 分两次
   `editScene` 的话，用户要按两次 `Ctrl+Z` 才能撤回一次拖动。

**播放中不打帧**：播放时播放头在跑，此时拖动物体会把关键帧写到"正好路过"的时刻上，
产生用户完全没预期的数据。开启开关时若正在播放，时间轴上会显示「播放中暂停记录」——
必须写出来，否则用户会以为是 bug。

**已知未覆盖：灯光**。灯光变化目前不会自动打帧。原因是灯光的关键帧轨道
（`lightKeyframes`）在数据契约里还不存在，要加就得同步改三端
（`app/src/shared/project-document.ts`、`core/project-document.js`、
`backend/app/models/project.py`）并把 `PROJECT_SCHEMA_VERSION` 从 13 升到 14。
已登记为后续需求。

### 手动记录关键帧与"当前帧手动覆盖"

时间轴的 **「记录关键帧」**（物体）与 **「记录镜头」**（相机）是显式打帧。
两条规则：

1. **同一时刻重复记录是覆盖，不是追加。** 追加会在同一时刻留下两个关键帧，
   求值只取后一个、静默丢弃前一个，数据悄悄劣化。覆盖时沿用原 id，
   这样时间轴上的选中态不会突然消失。手动与自动打帧共用
   `core/auto-key.js` 的 `upsertObjectKeyframe()` / `upsertCameraShot()`，
   保证两条路径规则一致、数据形状一致。
2. **复制关键帧/镜头会用 `findAvailableTimelineTime()` 避开已占用的时刻**，
   而不是简单的 `+0.5`——`+0.5` 可能正好压在另一个标记上，制造同刻重复。

#### 为什么需要"当前帧手动覆盖"

物体一旦有关键帧，时间轴求值就会在**每个**时刻覆盖它的变换。于是：

```
t=0 记录关键帧（x=0） → 播放头挪到 t=2 → 把物体拖到 x=10 → 松手
```

松手后 `displayedObjects` 立刻用求值结果覆盖显示，物体**弹回 x=0**。
用户看到的是"位置被锁死、拖不动"，但实际上场景数据已经是 x=10 了
（只查 store 会判定"功能正常"，这就是典型的"数据对、画面错"）。

所以 `store.editScene` 会记下这次变更动了哪些物体的**可动画属性**
（复用 `collectAutoKeyTargets()`，与"什么该进关键帧"严格同源），
`displayedObjects` 对这些物体改用场景里的真实值。规则：

- **只影响显示，不写进场景数据**；
- **播放头一变就清空**（`setTimelineTime` 里清）——这是 Maya / Blender 的约定：
  拖过的属性只在当前帧保持用户给的值，一改时间就重新由动画曲线说话；
- **播放中不记**（播放必须严格按关键帧走）；
- **绑定了导航线的物体不参与覆盖**：既有设计是"绑定优先"；
- 因此正常用法是：**改位置 → 点「记录关键帧」→ 值落到当前时刻**。

### 三条不可违反的边界

1. **`src/core/` 不许依赖 Vue、Vuex、DOM。**
   它是纯函数层（几何、切割、建模、时间轴、人台、面涂色、AI 命令解析），
   这样 Vitest 才能在 Node 里直接跑，也才能保证逻辑可被复用与验证。

2. **组件不许直接改 store，也不许直接 `fetch`。**
   所有状态变更走 `dispatch('editScene', update)` 或明确的 mutation；
   所有网络请求走 `src/api/client.js`。
   原因是撤销栈与自动保存都挂在 `editScene` 上，绕过它就会产生"改了但撤不回"的 bug。

3. **`three.js` 对象不许进入 Vue 响应式系统。**
   它们放在组件实例字段（`this.scene`、`this.renderer`…）而不是 `data()`，
   否则每帧的深度侦测会带来数量级级别的开销。

---

## 三、构建与部署

### 一键验证

```powershell
cd web
.\verify.ps1              # lint + 单测 + 构建 + 端到端冒烟
.\verify.ps1 -SkipSmoke   # 只跑静态检查与单测
```

> `verify.ps1` 未签名。若被 ExecutionPolicy 拦住，用
> `powershell -ExecutionPolicy Bypass -File .\verify.ps1`，
> 或按下面几节逐条手动执行。

### 浏览器级回归（三维相关改动必跑）

单元测试看不见一类**"数据对、画面错"**的 bug：store 里的值变了，
用户看到的却没变。相机视角就踩过两次（`OrbitControls.update()` 覆盖朝向、
相机飞近注视点后塌陷卡死），都是"读 store 判定通过、实际画面没动"。

所以三维/相机/时间轴改动除了单测，还要跑一次真实浏览器验证：

```powershell
# 前置：后端已启动（dev-backend.ps1），且 workspace/app.db 里有 smoke-user
#      （跑过一次 `py -3.10 -m app.smoke` 就会有）
cd web
node tools/verify-camera-autokey.mjs
```

可用环境变量覆盖：`BASE_URL`、`CDP_PORT`、`BROWSER_PATH`、`SMOKE_USER`、
`HEADLESS=0`（想看着它跑的时候）。脚本会自己拉起 Edge/Chrome 无头实例，
用 CDP 发**真实**键鼠事件，读出口走只读探针 `window.__XBH_DIAGNOSE__`。

它覆盖各功能的关键行为，共 154 项断言，其中这几条是专门的回归护栏：

| 断言 | 防的是什么 |
| --- | --- |
| 按 W 后【场景相机】跟着移动 | 需求本身 |
| 连续前飞每一段都有效 | 相机在注视点附近塌陷卡死 |
| 中键拖拽让**编辑视角画面**真的转向 | 朝向被 OrbitControls 覆盖（"store 变了但画面没转"） |
| 环绕方案下 OrbitControls 处于启用状态 | 父组件同步调用导致按旧方案初始化 |
| 环绕后 store 的 target 等于环绕轴心（世界原点） | 轴心用了会漂移的"当前看向点" |
| LMB 拖拽让相机绕轴心环绕 + 控制柄没挂到相机模型上 | 隐藏的相机模型被拾取（"只能转动镜头本身"） |
| 把物体拖到「看向」行即可绑定相机目标 | 绑定交互链路 |
| 相机看向点等于被绑定物体的位置 | `position` 语义按类型不同（人台在脚底） |
| 物体移动后相机看向点跟随 | "锁定并跟随"的核心 |
| 时间轴求值时相机跟随物体动画位置 | 打了镜头轨后绑定失效 / 只在静止时生效 |
| 关闭「看向物体」后绑定关系保留、看向点停在固定坐标 | 把"是否绑定"和"是否启用"混成一个状态 |
| 关闭后时间轴求值不再看向物体 | 求值链路漏传 `lookAtEnabled`（"关掉的开关导出时又打开"） |
| 重新勾选后恢复跟随（看向显示中的物体位置） | 勾选后画面不更新 |
| 相机视角下物体控制柄已挂载 | 取景时摆不动物体 |
| 拖控制柄移动的是物体 | 指针优先级被导航抢走 |
| 拖动物体时相机**不平移**（只看不跟） | 跟随已移除，防止被"顺手加回来" |
| 拖拽中轴心逐帧跟到物体实时位置 | 拖拽期间 store 不更新，瞄准读到旧看向点 → 松手才跳一下 |
| 拖拽全程轴心都没有滞后于物体 | 逐帧无滞后（不要断言"每步位移均匀"，那测的是鼠标响应曲线） |
| 松手瞬间不再跳变 | "跳一下"这个具体症状 |
| 环绕半径随物体距离变化 | "只看不跟"的固有语义 |
| 视线精确对准物体（方向点积≈1） | 只看 ≠ 不看 |
| 相机菜单已移除"跟随目标移动"开关 | 功能真的删干净了 |
| 工具条任何时刻只有一个激活项 | "选择"和"移动"同时高亮的视觉缺陷 |
| Q 后高亮的是"选择"而不是"旋转" | 同上，从快捷键路径再验一遍 |
| Q/W/E/R 角标与 tooltip 文案 | 快捷键可发现性 |
| R/W/E 切到对应变换、Q 切到纯选择（无操纵器） | 快捷键真的生效 |
| Ctrl+R 不触发工具切换 | 让给浏览器刷新 |
| 在输入框里按 R 不会切换工具 | 打字时工具乱切 |
| gizmo 拖拽减速到约 0.5×（受控布置下测） | 手感回归 1:1；也防止把"透视缩短"误判成减速失效 |
| 旋转在减速后仍然转得动 | `copy().slerp(self)` 把旋转锁死为 0° 的坑 |
| 松手提交的位置与拖拽中一致 | 减速导致松手回弹 |
| 预演模式下 canvas 不再被拉伸 | 布局变了但窗口没变 → 绘制缓冲脱节（"画面扁扁的"） |
| 预演时容器确实变宽了 | 防止修复靠"尺寸恰好没变"侥幸通过 |
| 预演视口比例等于工程画幅 | 黑边计算与画幅一致 |
| 换画幅时焦距保持不变 | 同一颗镜头换画幅不该变成别的焦段 |
| 换画幅时长边视野保持不变 | 长边定视野模型 |
| 宽画幅让垂直视场角变小 / 竖画幅变大 | 画面更宽，而不是被拉扁 |
| 换画幅时镜头轨视场角同步换算 | 编辑与成片不一致 |
| 画幅预设提供 21:9 / 16:9 / 9:16 | 预设清单 |
| 拖控制柄后 OrbitControls 仍启用 | 松手时写死 `enabled = true` 破坏导航独占 |
| 空白处拖拽仍然转镜头 | 优先级改动把导航挤掉 |
| 左键拖拽转动视角 + 不误改选中项 | 按下即拾取的历史行为 |
| 左键点按不转视角（只做拾取） | 拖拽/点按的 4px 阈值判定 |
| 平滑轨迹穿过中间关键帧 | 关键帧必须精确到达 |
| 中间关键帧之后立刻继续移动 | smoothstep 导致每个镜头停顿 |
| 轨迹离开首尾连线（有弧线） | 分段直线拍不出弧线运镜 |
| 相机面板有焦距输入 / 50mm 预设 / 135mm 长焦可用 | 焦距口径与视野范围 |
| 视口浮层显示焦距 | 用户要能一眼看到当前焦段 |
| 焦点在输入框时按 W 不会移动相机 | 打字时相机乱飞 |
| 环绕方案下 WASD 不移动相机 | 导航方案可插拔真的生效 |
| 同刻连续修改是覆盖而非追加 | 关键帧数据被静默劣化 |
| 手动记录关键帧：拖动后画面立刻跟随 | 有动画的物体"拖不动、松手弹回" |
| 同一时刻再次记录是覆盖而不是追加 | 同刻重复关键帧 |
| 换播放头后手动覆盖失效 | 临时姿态残留在别的帧上 |
| 一次操作 = 一次撤销 | 属性与关键帧分成两条历史 |
| 播放中暂停自动打帧 | 把帧写到"路过"的时刻 |

### 前端

```powershell
npm run dev            # 开发服务器（8080，含 /api 代理）
npm run build          # 生产构建 -> dist/
npm run lint           # ESLint 9 扁平配置
npm run lint:fix
npm run format         # Prettier
npm run test           # Vitest（274 个用例）
```

### 后端

```powershell
py -3.10 -m pytest -q                          # 后端单元 / 接口测试（46 passed, 1 skipped）
py -3.10 -m app.smoke http://127.0.0.1:8000    # 端到端冒烟，23 项检查
py -3.10 -m uvicorn app.main:app --port 8000
```

### 关于 npm 12 的 `allowScripts`

npm 12 默认不再执行依赖的 install 脚本。如果 `npm install` 之后
发现某个原生依赖没有编译产物，执行：

```powershell
npm rebuild <package-name>
```

本项目当前依赖树里没有必须跑 install 脚本的原生模块
（`three`、`vue`、`webpack` 全家桶都是纯 JS），因此不需要额外配置。

---

## 四、运行时数据（`backend/workspace/`）

Web 版已引入**用户账号**与 **SQLite 数据库**（可切换 Postgres）。工程正文仍是文件；
归属、最近打开、角色在数据库里。

| 路径 | 内容 | 是否可删 |
| --- | --- | --- |
| `app.db` | SQLite 库（用户 / 工程元数据） | 删了账号与工程索引就没了 |
| `secret.key` | Cookie 签名密钥（无 `WHITEBOX_SECRET_KEY` 时自动生成） | 可删，删后所有会话失效 |
| `users/{userId}/projects/*.block3d` | 该用户保存的工程 | 删了工程就没了 |
| `users/{userId}/workspace-state/recovery.json` | 该用户最近一份自动恢复快照 | 可删 |
| `users/{userId}/exports/` | 该用户导出的图片 / 视频 / 模型 / 文本 | 可删 |
| `ai-environment.json` | 全局 AI 服务商配置（**含 API Key 明文**，仅管理员可改） | 可删，删后需重配 |
| `projects/*.block3d`（旧布局） | 升级前的全局工程；可用导入脚本迁到某用户下 | 导入后可空 |

> `ai-environment.json` 含密钥，**不要提交到版本库，也不要随工程文件分发**。
> 接口层只回传 `hasApiKey` 布尔值，密钥永远不出服务端。

### 账号与角色

- 登录页只输入**账号名**即可进入；账号不存在时自动创建为普通用户。
- `users.password_hash` 字段已预留，可用脚本写入；**当前登录不校验密码**（内网可信环境）。
- 角色：`user`（普通）/ `admin`（管理员）。管理员可：改全局 AI 配置、管理用户、只读查看 / 删除任意工程。
- 指定第一个管理员（在 `web/backend` 下）：

```powershell
py -3.10 -m app.scripts.set_role --username 张三 --role admin
py -3.10 -m app.scripts.set_password --username 张三 --password '可选预埋'
py -3.10 -m app.scripts.import_legacy --username 张三   # 导入旧 workspace/projects
```

### 环境变量

| 变量 | 含义 | 默认 |
| --- | --- | --- |
| `WHITEBOX_WORKSPACE` | 工作区根目录 | `workspace` |
| `WHITEBOX_DATABASE_URL` | SQLAlchemy 连接串 | `sqlite:///workspace/app.db` |
| `WHITEBOX_SECRET_KEY` | Cookie HMAC 密钥 | 自动写到 `workspace/secret.key` |

切换到 Postgres：安装驱动后改 URL，再启动服务（启动时会自动 `alembic upgrade head`）：

```powershell
# 例：postgresql+psycopg://user:pass@localhost/xiaobaihe
$env:WHITEBOX_DATABASE_URL = "postgresql+psycopg://..."
```

---

## 五、数据契约（三端一致）

工程文档 schema 同时存在于三处，**任何一处改动都必须同步另外两处**：

| 位置 | 文件 | 角色 |
| --- | --- | --- |
| TS 原版 | `app/src/shared/project-document.ts` | 桌面版（历史基线） |
| JS 前端 | `web/frontend/src/core/project-document.js` | Web 前端读写 |
| Python 后端 | `web/backend/app/models/project.py` | 服务端落盘与迁移 |

同理，以下两组逻辑也存在双端镜像，改动需成对进行：

| 逻辑 | 前端 | 后端 |
| --- | --- | --- |
| 光照描述 | `core/lighting-description.js` | `services/scene_output.py` |
| AI 系统提示词（含命令 schema） | `core/ai-defaults.js`（仅占位） | `services/ai_service.py`（权威） |

**为什么必须一致**：导出的场景说明由后端生成，画布里的提示由前端生成。
两边措辞不一致，用户会怀疑"软件说的和做的不一样"。
AI 控制链路（对话 → 命令 → 应用 → 截图复核）见
[`docs/AI_DEV_GUIDE.md`](docs/AI_DEV_GUIDE.md)「AI 场景控制链路」。

详细的协作规范、评审清单与 AI 启动提示词见
[`docs/AI_DEV_GUIDE.md`](docs/AI_DEV_GUIDE.md)。

---

## 六、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| **视口全黑、左侧工具栏点了没反应** | 组件用 `template: \`...\`` 字符串写模板，但 webpack 别名指向 **runtime-only** 版 Vue，它不支持 `template` 选项 | 必须写成 `.vue` 单文件组件（由 vue-loader 预编译），见下方排查命令 |
| **gizmo 拖不动物体** | 拾取只遍历 `objectGroup`，控制柄不在其中，射线"打空"被当成点了空白 → 清空选中 → 中途 `detach()` | 命中判定前先看 `transformControls.axis` / `.dragging`（`isPointerOnGizmo()`） |
| **画面里点不中摄影机** | `pickSceneCamera()` 拿 `camera.getWorldDirection()` 当射线，那永远是屏幕中心那条线 | 必须用鼠标射线（`this.raycaster.ray`），再按"离镜头远近"与物体仲裁 |
| **点播放/点帧后镜头突然飞到怪角度** | 时间轴把求值结果直接写进了编辑视角相机 | 预览只改 `displayedCamera`；编辑相机归 OrbitControls，时间轴不许碰 |
| **Timeline 帧拖不动** | 标尺只监听 `click`，按住移动时中途完全无反馈 | `pointerdown` + 全局 `pointermove` 连续 scrub |
| 监视器窗口黑屏但实际在渲染 | 第二块 WebGL 画布默认 `preserveDrawingBuffer: false`，离屏读像素只能拿到黑帧 | 监视器渲染器显式开 `preserveDrawingBuffer: true` |
| **视锥背对物体，监视器里却有画面** | 摄影机模型是 `Group`，`Group.lookAt()` 让 **+Z** 朝目标，而镜头/视锥画在 -Z 一侧 | `Camera` 是 -Z 朝目标、普通 `Object3D` 是 +Z 朝目标。Group 需 `lookAt()` 后再 `rotateY(Math.PI)` |
| **平移摄影机后朝向也变了** | 模型朝向约定（+Z）与 `emitTransform` 反算 target 的约定（-Z）互相矛盾 | 统一成相机语义（-Z 朝目标），模型、视锥、target 反算共用一套约定 |
| **人台只显示白模，动作也不动** | 缺 `mannequinJoints`/`mannequinHandles`，`applyMannequinPose` 静默跳过外观分支 | 把这两个字段挂到对象根上；它们才是驱动外观骨骼的锚点 |
| 构建报 `invalid JS syntax`（vitest） | `.glb` 被当成 JS 模块解析 | 放 `public/mannequin/`，用 `CopyWebpackPlugin` 复制，代码里引用 URL 字符串 |
| 控制台刷 `TransformControls: The attached 3D object must be a part of the scene graph.` | 重建 helper 时先 `remove` 后 `add`，中间一帧父节点为 `null` | 重建前 `detach()`，重建后按需 `attach()` |
| 诊断按钮上的错误数一直涨 | 同上，每改一次相机位姿就攒一条 | 同上；修好后 `dump-diagnostics.cjs error` 应为 0 条 |
| `module 'types' has no attribute 'UnionType'` | 用了 3.10 alpha 版 Python | 换 3.10.11 正式版 |
| `UnicodeDecodeError: 'gbk' codec can't decode ...` | pip 在 Windows 上按系统代码页读 `requirements.txt` | 该文件注释必须是纯 ASCII |
| 前端页面 404 / 白屏 | 后端启动时 `dist` 还不存在 | 先 `npm run build` 再启动后端 |
| `/api/*` 请求 404（开发模式） | dev-server 代理没生效或后端没起 | 确认后端在 8000 端口 |
| 场景一片漆黑 | 面光的 LTC 查找表未初始化 | 视口已内置 `ensureRectAreaLightSupport()`，若仍出现请检查是否绕过了视口 |
| **Timeline 出现莫名黑条、标记盖到侧栏上** | 播放头写成 `bottom: -100px` 的绝对定位细线，且轨道区没有 `overflow: hidden` | 播放头高度锁进标尺（`top/bottom: 0`），标尺与轨道各自 `overflow: hidden` |
| **有导航线时时间轴第三条轨道看不到** | 时间轴最小高度 132px 放不下三条轨道，多出来的被滚动区吞掉 | 最小高度提到 176px（抓取带 6 + 工具条 38 + 标尺 26 + 三条 24px 轨道） |
| **拖动导航线节点后，线还留在原地** | `rebuildPaths` 只挂在 `pathDraft`/`selectedPathNode` 上，store 提交新坐标后没重建 | 把 `rebuildPaths()` 放进 `rebuildObjects()` 末尾，让可视化跟着 `objects` 一起更新 |
| 导航线节点"滑"到路径另一头 | 拖拽时在全路径上做射线投影 | 只允许在**相邻两段**上滑动（`adjacentSegmentsFor`） |
| 页面停在 300×150 的一小块画面 | `<canvas>` 是替换元素，没写 CSS 宽高就退回默认内联尺寸 | 给 `.viewport-canvas` 显式 `width/height: 100%` |
| **导出视频报"没有可用的 H.264 编码器"** | H.264 的 profile 支持依赖硬件与系统，不同机器不同 | 代码按 `MP4_CODEC_CANDIDATES` 逐个运行时探测（实测有的机器只有 High 可用）；全不可用时勾选 PNG 序列帧 |
| **导出的视频时长只有几毫秒** | WebCodecs 的 `timestamp` 单位是**微秒**，写成毫秒就差 1000 倍 | `mp4TimestampUs()` 统一换算，单测里明确守住这个单位 |
| **导出几十帧后浏览器崩掉** | `VideoFrame` 是 GPU/系统内存句柄，不 `close()` 会 OOM | `encode()` 之后立刻 `frame.close()`（放在 `finally` 里） |
| **导出的视频体积是 0 或打不开** | moov 索引表被写到文件末尾，部分播放器/平台判定为损坏 | muxer 开 `fastStart: 'in-memory'`，让 moov 在 mdat 之前 |
| **导出画面被横向拉伸** | 只改了渲染器尺寸，没改 `camera.aspect` | 导出画幅几乎从不等于视口宽高比，必须同时 `camera.updateProjectionMatrix()`；见 `withOutputSize()` |
| **导完视频后视口画面变形** | 临时改的 `camera.aspect` 没在 `finally` 里还原 | `withOutputSize()` 的 `finally` 同时还原 aspect / pixelRatio / 尺寸 |
| **导出的视频只有静态画面，物体不动** | `evaluateTimelineAtTime()` 的 `objectTransforms` 算完就丢了，只应用了 `camera` | 三条产物路径统一走 `renderFrameAt()`：`applyCameraState()` + `applyTimelineFrame()` |
| **导完视频场景停在最后一帧** | 逐帧改写了物体根节点的 position/rotation/scale，导出后没复位 | `finally` 里调 `restoreObjectTransforms()` 按 store 数据复位（不是用 0 时刻） |
| **时间轴标尺和下方轨道的 0 点错开一截** | `.timeline__track` 加了 `padding-left: label-width+12`，而每条 `.lane` 里**又**有一个 `label-width` 宽的行首标签，等于算了两遍 | 抽 `--lane-gutter`（= label-width + gap），轨道只留 12px 内边距，标尺复用同一个 gutter |
| **拖拽造物时镜头跟着一起转** | quick-build 分支排在相机/物体拾取**之后**，且从没关过 OrbitControls，同一次左键拖拽既铺墙又转镜头 | 把 quick-build 提前到拾取之前，并用 `beginExclusiveGesture()` 关掉 controls |
| **松手后镜头再也转不动** | 拖拽中指针移出 canvas，`pointerup` 落在别处，解锁代码没跑到 | `setPointerCapture` 把后续事件路由回 canvas；再加 `endExclusiveGesture()` 在 `handlePointerUp` 各分支兜底 |
| 验证脚本说"拖拽时镜头没转"，其实是假通过 | 合成 `new PointerEvent()` 没有真实 pointer 关联，OrbitControls 内部 `setPointerCapture` 直接抛错中断处理 | 改用 CDP `Input.dispatchMouseEvent` 发真实输入，并加**反向对照**：选择工具下同样拖拽必须能转镜头 |
| **导出的成片里带着橙色选中框和箭头** | 控制柄 helper 与 `selectionBox` 是直接 `add` 到 scene 的，不在 `guideGroup` 里，导出只隐藏了 `guideGroup` | 收成 `editorOverlays()` 一份清单，导出 / 六通道图 / 预演共用 |
| **任意文件读取：能读到 `ai-environment.json` 里的明文 API Key** | SPA 回落路由 `serve_spa` 直接用 `FRONTEND_DIST / full_path` 做 `is_file()`；Starlette 会先把 `%2e%2e%2f` 解码成 `../` 再传进来，于是 `/../../backend/workspace/ai-environment.json`、`/../../../../Windows/win.ini` 全都能读 | 路径解析统一走 `resolve_dist_file()`：`resolve()` 后用 `Path.is_relative_to` 校验归属，越界回落 `index.html`。**不要用字符串 `startswith`**，它会把 `dist-backup/` 误判成在 `dist` 内 |
| **预演时控制柄又出现了** | 进预演改变了 `cameraState` → 重建摄影机模型 → `rebuildCameraHelper()` 末尾又调 `attachTransformControls()` 挂回去 | 在 `attachTransformControls()` **入口**判断预演并直接返回，而不是只在 watch 里 detach 一次 |
| **预演掉到个位数帧率** | 渲染路径里每帧调 `applyTheme()`，而它会 `remove + dispose` 网格再重建 | 只推 `renderer.setClearColor()`；网格重建只在主题真正变化时做 |
| 预演退出后镜头转不动 | 进预演时禁用了 controls，退出时没解锁 | `previewActive` watch 的两条分支对称处理：进则 `detach`，出则 `attachTransformControls()` + `controls.enabled = true` |
| 预演退出后场景停在某一帧 | 预演是循环播放，退出时播放头还在跑 | 退出时 `stopPlayback()` 并把 `timelineTime` 归 0 |
| **相机视角里中键拖拽"转了但画面没转"** | 相机视角下仍在跑 `OrbitControls.update()`，它每帧 `camera.lookAt(target)`，把导航算出的 yaw/pitch 又指回旧 target；只改 store 的话看 store 一切正常，看画面却毫无变化 | `wasd` 方案下用 `shouldRunOrbitControls()` 停掉 `controls.update()`，并在导航每次改动后调 `applyNavOrientation()` 同步 `camera.lookAt` 与 `controls.target` |
| **往前飞几米后相机突然不动了** | 同上：`OrbitControls.update()` 按 `position - target` 反推球坐标，相机飞近注视点时半径趋近 0、球坐标退化，位置被写回 target 后卡死 | 同上；另外注视距离恒定为 `navState.distance`，target 跟着机位一起走，结构上不会塌陷。回归断言见"连续前飞每一段都有效" |
| 在属性/名称输入框里打 wasd，镜头却飞走了 | 全局 `keydown` 监听没有排除输入态，`isEditableTarget()` 判定缺失 | 所有键盘导航先过 `isEditableTarget(event.target)`（`input`/`textarea`/`select`/`contentEditable` 全部拦掉） |
| **自动关键帧把数据悄悄弄坏，但不报错** | 同一时刻追加了多个关键帧：求值取后一个、静默丢弃前一个；堆到 30 帧时中间时刻插值异常跳变（实测 x 从 0 跳到 64.5） | `upsertObjectKeyframe()` / `upsertCameraShot()` **同刻覆盖**并沿用原 id（不换 id，否则时间轴选中态会丢） |
| 自动关键帧一开，撤销一次只退回半个操作 | 属性修改与打帧分成两次 `editScene`，等于两次历史 | 在 `editScene` 里把打帧结果与变更**合并成同一个新场景**再 `commitScene` 一次 |
| 改个颜色也冒出一堆关键帧 | 对比范围用了整个物体对象 | `objectTransformChanged()` 只比"会进关键帧"的字段（位置/旋转/缩放/人台），与 `buildObjectTransform()` 严格一一对应——两处字段集合必须同步改 |
| **CDP 验证脚本莫名失败，指向的功能其实好的** | 上次测试的自动保存在 `workspace/` 留下恢复快照，进编辑器时产品弹出「发现未保存的内容」并铺一层 `.dialog-veil`，把视口盖住、吃掉所有指针事件 | 验证脚本开头先关掉该对话框；另外禁用态按钮**仍在 DOM 里**，要断言 `disabled` 而不是"条目不存在" |
| 用 `Set-Content` 改带中文的文件后，文件变成非法 UTF-8 | 本机 PowerShell 是 5.1，`Get-Content`/`Set-Content` 默认按 ANSI(GBK) 读写，UTF-8 内容被当成 GBK 解码再编码，字全糊了 | 改带中文的源码/文档一律用编辑器工具（`edit`/`write`），**不要用 PowerShell 做文本往返**；确需命令行处理要显式 `-Encoding UTF8` |
| **环绕（Maya 环绕）只能转动镜头本身的旋转属性** | 两个原因叠加：① 父组件在 `commit` 后**同步**调用重置，而 Vue 的 props 是异步更新的，组件读到的还是旧方案 `wasd`，于是把 OrbitControls 禁用了；② 相机视角下 LMB 仍会拾取**隐藏的**相机模型（three.js 的 `Raycaster` 不检查 `visible`），`camera-select` 把控制柄挂到相机模型上并顶掉导航 | 方案切换改由视口 `watch: cameraNavScheme` 响应；`pickSceneCamera()` 与 `attachTransformControls()` 入口判断 `cameraViewActive` 直接返回；进入相机视角时清掉 `cameraSelected` |
| **环绕转完，场景相机没动** | 环绕默认开阻尼，松手后相机继续缓动、`change` 持续触发，不断重置 260ms 节流计时器，提交迟迟不发生 | 用 OrbitControls 的 `end` 事件（松手）作为操作结束信号，立刻提交一次；`target` 取 `controls.target`（环绕轴心），不能用 `navState` 里过期的 yaw/pitch 反算 |
| **物体有关键帧后"拖不动"，一松手就弹回去** | 时间轴求值在**每个**时刻覆盖物体变换；用户拖完立刻被求值结果盖掉，看起来像位置被锁死（实际 store 已经改对了——只查数据会误判成正常） | `store.editScene` 记下本次变更动过的物体（`timelineEditOverrides`），`displayedObjects` 对这些物体改用真实值；**播放头一变就清空**（Maya/Blender 约定）；播放中与只读不记；绑定导航线的物体不参与 |
| **同一时刻出现两个关键帧/两个镜头** | 「记录关键帧」「记录镜头」「复制」都是往数组里 push，同刻重复不会报错，只会让求值取后一个、静默丢弃前一个，插值出现异常跳变 | 记录走 `upsertObjectKeyframe()` / `upsertCameraShot()`（同刻覆盖、沿用原 id）；复制走 `findAvailableTimelineTime()` 避开已占用时刻 |
| **相机绑定物体后"跟随只在播放时生效"** | `displayedCamera` 停在 0 秒时直接 `return this.camera`，跳过绑定解算，于是 0 秒时看向静态 target、一按播放才跳到物体上 | 0 秒时也要走 `resolveCameraTarget(camera, displayedObjects)` |
| **关了"看向物体"开关，导出时又自己生效** | 求值函数只把 `targetObjectId` 从基准相机补过去，漏了 `lookAtEnabled`；打镜头轨后相机是从 shot 重建的，不自带这两个字段 | 两项都从**基准相机**补回来，再解算 |
| **勾选/取消"看向物体"后画面不更新** | 把"是否生效"和"绑的是谁"混成一个状态，取消勾选时把 id 也清了，重新勾选就找不到对象 | 分成 `targetObjectId`（记是谁）与 `lookAtEnabled`（用不用）两个字段；绑定条置灰而不是消失 |
| **物体显示在 A，相机却看向 B** | 求值函数内部用"关键帧求值结果"算相机 target，而画面显示的是 `displayedObjects`（带手动编辑覆盖）。两条路径用了不同的物体列表 | `displayedCamera` 在求值之后**再解算一次**，用 `displayedObjects`；导出/播放时覆盖列表为空，两次结果相同 |
| **打了镜头轨之后物体绑定失效** | `evaluateCameraShots()` 是从 shot 数据重建相机的，不会自带 `targetObjectId` | 绑定一律以**基准相机**为准，求值后显式补回 `targetObjectId` 再解算 |
| **对着人台绑定时镜头对着脚看** | 物体 `position` 语义按类型不同：基本体是几何中心，人台/导入模型在底部 | 用 `objectFocusPoint()` 抬升半个高度；**新增物体类型必须在这里登记** |
| **左键拖拽转视角时顺手改掉了选中项** | 在 `pointerdown` 就做拾取；或者反过来，手抖 1~2px 就放弃选中 | 按下只记起点，移动超过 4px 才认定为拖拽；松手时几乎没动才拾取 |
| **Maya 环绕"只能转动镜头本身"** | ① 方案切换在父组件 commit 后**同步**调用重置，Vue props 异步更新，组件按旧方案把 OrbitControls 禁用了；② 隐藏的相机模型仍被 `Raycaster` 打中（它不检查 `visible`），`camera-select` 把控制柄挂到相机模型上顶掉导航 | 方案切换由视口 `watch: cameraNavScheme` 响应；`pickSceneCamera()` / `attachTransformControls()` 入口判 `cameraViewActive` 直接返回；进入相机视角清掉 `cameraSelected` |
| **相机视角下拖 gizmo 变成"转视角"** | `isPointerOnGizmo()` 排在相机视角分支之后；且 `attachTransformControls()` 在相机视角下整体 return，物体 gizmo 根本没挂 | 指针优先级改为 `gizmo > 相机视角导航 > 拾取`；"不挂 gizmo"收窄为**只不挂场景相机自身**，物体/灯光照常 |
| **拖动物体时环绕相机不跟随（轴心跟上了、机位没动）** | 只改了 `controls.target`：`OrbitControls.update()` 会按 `position - target` 反推球坐标再写回位置，target 一动反而把相机**按在原地** | 轴心移动 Δ 时**机位同步平移 Δ**（刚性平移），保持球坐标偏移不变 |
| **拖过一次物体后 WASD 不灵 / 视角自己转** | TransformControls 的 `dragging-changed` 里写死 `controls.enabled = !dragging`，松手就把 OrbitControls 打开了，而 `wasd` 相机视角下它本该一直关闭 | 解锁时按 `shouldRunOrbitControls(cameraViewActive, scheme)` 判断 |
| **相机在中间关键帧"停一下"再走** | 用 smoothstep 逐段缓动，每段两端速度归零 | 换成时间参数化的向心 Catmull-Rom（`core/camera-path.js`）：穿过关键帧且速度连续 |
| **相机只能拍直线推移，拍不出弧线** | 逐分量线性插值，每段是直线 | 位置与看向点都走样条；只有两帧时自然退化为匀速直线 |
| **焦距设不出 135mm 长焦** | 视场角上限硬编码 120°（对应约 112mm），且写在两处 | 上下限收敛到 `MIN_FOV_DEGREES` / `MAX_FOV_DEGREES` 单一来源，放宽到 5°~140° |
| **画面按 50mm 构图，导出的提示词却描述了另一个镜头** | 前后端各算一套焦距 | 后端 `focal_length_mm()` / `describe_camera_lens()` 与前端 `core/focal-length.js` 逐字等价，并用测试交叉验证 |
| 导出的视频没有声音 | 本工具只产出画面，不处理音频 | 音频在剪辑环节叠加 |

### 6.1 用户侧：一键导出日志（不需要开 devtools）

顶栏右侧有一个 **「诊断」** 按钮。点一下就会下载一个
`xiaobaihe-diagnose-<时间戳>.txt`，里面包含：

- 运行环境：UA、屏幕、DPR、构建时间、WebGL 版本 / 渲染器 / 最大纹理尺寸
- 关键 DOM 尺寸：`stage` / `viewport` / `canvas` 的布局尺寸与绘制缓冲尺寸
- 场景探针快照：物体数、各物体位置、当前选中、控制柄是否挂载 / 正在拖动 / 命中哪个轴
- 日志：`console.error` / `console.warn`、未捕获异常、未处理的 Promise 拒绝、
  Vue 的 `errorHandler` / `warnHandler`

按钮上的数字是**错误条数**，大于 0 时会变黄提醒。这个报告不含任何密钥与工程内容，
可以直接贴给别人排查。

代码在 [`web/frontend/src/core/diagnostics.js`](frontend/src/core/diagnostics.js)，
在 `new Vue(...)` **之前**安装（见 `main.js`），
否则捕获不到组件挂载阶段抛出的异常——而那正是黑屏的高发位置。

### 6.2 开发侧：用 CDP 拿真实报错，不要靠猜

`lint` / `vitest` / `webpack build` 都不挂载真实 DOM，
**发现不了"组件没渲染出来"这类问题**。这类问题必须让浏览器自己说话：

```powershell
# 1. 起服务（生产模式单进程即可）
cd web
.\start.ps1 -Port 8181 -NoBrowser

# 2. 起一个带调试端口的无头浏览器
$edge = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
Start-Process $edge -ArgumentList @(
  '--headless=new','--remote-debugging-port=9232',
  "--user-data-dir=$env:TEMP\xbh-profile",
  '--window-size=1400,900','--use-angle=swiftshader',
  'http://127.0.0.1:8181/editor'
)

# 3. 抓当前页面已记录的日志（含页面加载期的错误）
cd frontend
$env:DEBUG_PORT='9232'
node scripts\dump-diagnostics.cjs          # 全部
node scripts\dump-diagnostics.cjs error    # 只看错误

# 4. 实时抓 console / 异常 / DOM 尺寸 / 截图
$env:SHOT_PATH="$env:TEMP\shot.png"
node scripts\diagnose.cjs http://127.0.0.1:8181/editor
```

| 脚本 | 回答什么问题 |
| --- | --- |
| `dump-diagnostics.cjs` | 页面**已经**记录了什么错误（含加载期、Vue 回调） |
| `diagnose.cjs` | 从现在起控制台输出什么、`.viewport`/`canvas` 真实尺寸多少 |
| `interact.cjs` | 按钮"画出来了"和"真的能点"是不是一回事 |
| `verify-interaction.cjs` | 摄影机是否在层级里、能否选中、拖拽会不会误清空选中 |
| `verify-gizmo.cjs` | **拖动 gizmo 后坐标真的变了吗**（读场景探针，不靠猜像素） |
| `verify-camera-timeline.cjs` | 画面里能否点中摄影机、监视器是否出画面、时间轴预览会不会把镜头带跑 |
| `verify-mannequin.cjs` | 人台 GLB 外观是否真的加载（网格/骨骼数）、切换动作是否换片段、动作是否跟时间轴走 |
| `verify-nav-path.cjs` | 时间轴是否还溢出、能不能拖高度、画出的导航线是否进时间轴、绑定物体是否沿路径走 |
| `verify-mp4-export.cjs` | **导出的 MP4 是不是合法容器**（ftyp/moov/mdat、moov 在 mdat 前、stsd 里的真实宽高）、首尾帧是否还在 |
| `verify-export-fixes.cjs` | **导出到底有没有动画**（比首尾帧 PNG 字节）、标尺与轨道是否同一起点、真实输入拖拽造物时镜头会不会跟着转 |
| `verify-preview.cjs` | 成片预演：相机是否走时间轴、画幅比对不对、退出后编辑视角有没有被污染、辅助对象是否清干净 |
| `probe-codecs.cjs` | 本机浏览器到底支持哪些 H.264 profile（写死 codec 前先跑这个） |

`verify-gizmo.cjs` 是这两个需求的最终判据：它从
`window.__XBH_DIAGNOSE__.scene()` 读出控制柄各轴的屏幕坐标，
用真实 `PointerEvent` 沿轴拖动，再比对 Inspector 里的位置数值。
成功输出形如：

```text
PASS  gizmo 拖动改变了方块坐标
PASS  gizmo 拖动改变了场景相机机位
8/8 passed
```

> 注意：给无头浏览器合成 `pointermove` 时，`button` 必须是 `-1`。
> 写成 `0` 的话，TransformControls 内部会直接 `return`，拖动被静默丢弃，
> 表现和"功能坏了"一模一样。

> 另外：跑完一次验证会触发自动保存，下次打开必然弹"发现未保存的内容"。
> `verify-gizmo.cjs` 会自动点「放弃」，让每次验证都从干净场景开始。
