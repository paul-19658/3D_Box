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
├─ backend/
│  ├─ app/
│  │  ├─ main.py                  FastAPI 入口：CORS、路由挂载、SPA 回落
│  │  ├─ smoke.py                 端到端冒烟脚本（打真实 HTTP）
│  │  ├─ api/routes.py            所有 REST 路由
│  │  ├─ models/project.py        工程文档的 Pydantic 模型与迁移
│  │  ├─ data/platform-profiles.json  平台预设（帧率 / 码率 / 时长 / 画幅）
│  │  └─ services/
│  │     ├─ project_store.py      工程 / 恢复快照 / 最近工程 / 导出落盘
│  │     ├─ ai_service.py         AI 服务商配置与对话（密钥不出服务端）
│  │     ├─ platform_profiles.py  平台规则校验
│  │     └─ scene_output.py       场景说明 + 建议提示词
│  ├─ tests/test_core.py          21 个单元 / 接口测试
│  ├─ requirements.txt
│  └─ workspace/                  运行时数据（工程、导出、AI 配置）
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
   │  ├─ router/index.js          /editor 与 /projects
   │  ├─ store/index.js           Vuex：唯一状态源 + editScene 唯一写入口
   │  ├─ core/                    纯逻辑层（无 DOM、无 Vue 依赖，可单测）
   │  ├─ components/              面板与对话框（只发事件，不改状态）
   │  ├─ views/                   Editor / Projects
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

**数据契约（schema 13）**

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

### 前端

```powershell
npm run dev            # 开发服务器（8080，含 /api 代理）
npm run build          # 生产构建 -> dist/
npm run lint           # ESLint 9 扁平配置
npm run lint:fix
npm run format         # Prettier
npm run test           # Vitest（71 个用例）
```

### 后端

```powershell
py -3.10 -m pytest -q                          # 21 个用例
py -3.10 -m app.smoke http://127.0.0.1:8000    # 端到端冒烟，21 项检查
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

| 路径 | 内容 | 是否可删 |
| --- | --- | --- |
| `projects/*.block3d` | 用户保存的工程 | 删了工程就没了 |
| `recovery.json` | 最近一份自动恢复快照（只留一份） | 可删 |
| `recent.json` | 最近打开记录（最多 20 条） | 可删 |
| `exports/` | 导出的图片 / MP4 视频 / 序列帧 / 模型 / 文本 | 可删 |
| `ai-environment.json` | AI 服务商配置（**含 API Key 明文**） | 可删，删后需重配 |

> `ai-environment.json` 含密钥，**不要提交到版本库，也不要随工程文件分发**。
> 接口层只回传 `hasApiKey` 布尔值，密钥永远不出服务端。

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
| AI 系统提示词 | `core/ai-defaults.js`（仅占位） | `services/ai_service.py`（权威） |

**为什么必须一致**：导出的场景说明由后端生成，画布里的提示由前端生成。
两边措辞不一致，用户会怀疑"软件说的和做的不一样"。

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
| **预演时控制柄又出现了** | 进预演改变了 `cameraState` → 重建摄影机模型 → `rebuildCameraHelper()` 末尾又调 `attachTransformControls()` 挂回去 | 在 `attachTransformControls()` **入口**判断预演并直接返回，而不是只在 watch 里 detach 一次 |
| **预演掉到个位数帧率** | 渲染路径里每帧调 `applyTheme()`，而它会 `remove + dispose` 网格再重建 | 只推 `renderer.setClearColor()`；网格重建只在主题真正变化时做 |
| 预演退出后镜头转不动 | 进预演时禁用了 controls，退出时没解锁 | `previewActive` watch 的两条分支对称处理：进则 `detach`，出则 `attachTransformControls()` + `controls.enabled = true` |
| 预演退出后场景停在某一帧 | 预演是循环播放，退出时播放头还在跑 | 退出时 `stopPlayback()` 并把 `timelineTime` 归 0 |
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
