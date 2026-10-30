# 初始化

后端

# 可选但推荐：安装 ffmpeg，并确保在 PATH 中（或设置 FFMPEG_PATH）。
# 浏览器 WebCodecs 不可用时，导出 MP4 会走「上传帧 → 后端 ffmpeg」兜底。

cd web\backend  
python  -m venv .venv  
.venv\Scripts\Activate.ps1  
python -m pip install -r requirements.txt

前端

cd ..\frontend
npm install

# 启动

# 后端

cd web\backend
.venv\Scripts\Activate.ps1
python  -m uvicorn app.main:app --reload --port 8000

# 前端

cd web\frontend
$env:DEV_SERVER_PORT = "3003"
npm run dev

# 后端日志

# 固定目录（相对后端工作目录）：workspace/logs/
# 按日一个文件：workspace/logs/YYYY-MM-DD.log（JSONL）
# 含：启动/关闭、HTTP access、登录登出、AI chat 完整调用（messages/上游/响应/toolCalls）
# 图片 base64 与 API Key 已脱敏。
# AI 默认 maxTokens=8192；若配置仍为旧默认 2048，请求时会自动抬到 8192，避免 tool 参数截断。