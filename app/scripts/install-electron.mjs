/**
 * 安装期补齐 Electron 运行时二进制。
 *
 * 背景：
 * 1. Electron 43 的 electron 包已不再声明安装期脚本，二进制改为首次 require('electron')
 *    时惰性下载；而打包只读取 electron-builder.yml 里的 electronDist 路径（见 index.js
 *    与 electron-builder 的 ElectronFramework.prepareApplicationStageDirectory），
 *    因此惰性下载永远不会被触发，dist 会一直缺失。
 * 2. npm 12 对 .npmrc 中的未知键只做兼容性注入，并提示未来版本将停止生效。
 *
 * 因此这里显式设置镜像环境变量，再调用 electron 包自带的幂等安装脚本：
 * 若 dist/version 与 path.txt 已匹配当前版本则直接跳过，不会重复下载。
 */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installScript = join(appRoot, 'node_modules', 'electron', 'install.js')

// 仅在用户未显式覆盖时设置默认镜像，保证可通过环境变量切换。
process.env.ELECTRON_MIRROR ||= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_CUSTOM_DIR ||= '{{ version }}'

const child = spawn(process.execPath, [installScript], {
  cwd: appRoot,
  stdio: 'inherit',
  env: process.env
})

const exitCode = await new Promise((resolveExit) => child.on('close', resolveExit))
if (exitCode !== 0) process.exitCode = Number(exitCode ?? 1)
