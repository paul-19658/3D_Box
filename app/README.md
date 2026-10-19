# 小白盒桌面应用

本目录包含 Windows 桌面应用源码。当前版本已覆盖基础/画布建模、积木式编排、人台姿势、摄影机、灯光、对象与相机时间轴、本地工程恢复，以及 PNG、六通道控制图、逐帧 PNG、MP4/H.264、GLB、GLTF、OBJ 导出。

## 开发命令

```powershell
npm install
npm run legal:generate
npm run verify
npm run test:e2e
npm run build:unpack
npm run build:win
npm run release:checksums
```

## 二进制下载镜像

Electron 运行时与 electron-builder 辅助工具（winCodeSign、nsis、7zip）默认从 GitHub 下载，在网络受限环境下会失败。本项目把下载源统一指向 npmmirror，通过 `package.json` 的 `config` 字段声明（不改变任何依赖版本，只改变下载来源）：

```json
"config": {
  "electron_mirror": "https://npmmirror.com/mirrors/electron/",
  "electron_custom_dir": "{{ version }}",
  "electron_builder_binaries_mirror": "https://npmmirror.com/mirrors/electron-builder-binaries/"
}
```

选择 `config` 而非 `.npmrc` 的原因：npm 会把 `config` 中的键注入为 `npm_package_config_*` 环境变量，这是官方支持的机制；而 `.npmrc` 中的未知键在 npm 12 下会持续输出告警，并提示未来大版本将不再生效。两个消费方都能读取这两种形式：

- `electron_*`：`@electron/get` 的 `mirrorVar`（同时支持 `npm_package_config_electron_*`）。
- `electron_builder_binaries_mirror`：`app-builder-lib` 的 `getBinariesMirrorUrl`（同样支持 `npm_package_config_*`）。

Electron 43 起 `electron` 包不再声明安装期脚本，二进制改为首次 `require('electron')` 时惰性下载；而打包只读取 `electron-builder.yml` 里的 `electronDist` 路径，不会触发该惰性逻辑，`dist` 会一直缺失。因此 `postinstall` 显式调用 `node scripts/install-electron.mjs`，该脚本设置镜像后调用 electron 包自带的幂等安装脚本（`dist/version` 与 `path.txt` 匹配时直接跳过）。

`scripts/build-release.mjs` 同样在调用 electron-builder 前设置 `ELECTRON_BUILDER_BINARIES_MIRROR`，使打包不依赖 npm 的环境变量注入。

如需临时改用其它镜像，直接覆盖对应环境变量（`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`）即可，环境变量优先级最高。

`verify` 包含许可证清单一致性、格式、Lint、TypeScript、Vitest 和生产构建。`test:e2e` 启动隔离的 Electron 实例并实际操作文件、三维画布和导出流程。

## 架构边界

- `src/main`：窗口、系统文件对话框、原子写入、恢复状态和受控流式导出。
- `src/preload`：类型化 IPC 白名单；渲染进程不直接访问 Node.js。
- `src/renderer/src/scene-core`：场景对象、几何、组合、排列、快速墙体/地面和历史。
- `src/renderer/src/components/SceneViewport.tsx`：Three.js 画布与直接操作适配层。
- `src/renderer/src/optimizer`：风险预算与可替换轻量预览策略。
- `src/renderer/src/timeline`、`video`：统一帧状态、逐帧计划和 MP4 编码接口。
- `src/shared`：工程 schema、桌面 API、平台规则和版本元数据。

公开仓库只保留运行、构建、测试和继续开发所需的源码与说明。内部访谈记录、开发流程、阶段状态和验证草稿不作为公开源码的一部分。
