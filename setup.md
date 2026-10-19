cd app

# 首次安装。app/.npmrc 已配置 npmmirror 二进制镜像，
# postinstall 会自动把 Electron 运行时下载到 node_modules/electron/dist。
npm install

npm run verify
npm run build:win
