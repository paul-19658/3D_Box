"""服务端 MP4 编码（ffmpeg）。

浏览器 WebCodecs 不可用时，前端把逐帧画面上传到这里，
由 ffmpeg 合成 H.264 MP4。本机有 WebCodecs 时仍走前端编码，不经过此模块。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

# 允许部署时通过环境变量指定绝对路径（Windows 服务、容器镜像常见）。
FFMPEG_BIN = os.environ.get("FFMPEG_PATH", "ffmpeg")

# 防止异常大请求打满磁盘 / CPU。24fps × 25s = 600 帧。
MAX_FRAMES = 600
MAX_FRAME_BYTES = 8 * 1024 * 1024
ALLOWED_FRAME_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def ffmpeg_available() -> bool:
    """探测本机能否调用 ffmpeg（供 /meta 与接口前置校验）。"""
    try:
        result = subprocess.run(
            [FFMPEG_BIN, "-version"],
            capture_output=True,
            timeout=5,
            check=False,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def frame_extension_for_upload(filename: Optional[str], content_type: Optional[str]) -> str:
    suffix = Path(filename or "").suffix.lower()
    if suffix in ALLOWED_FRAME_EXTENSIONS:
        # jpeg → jpg，统一序列扩展名，方便 ffmpeg 通配符。
        return ".jpg" if suffix == ".jpeg" else suffix
    if content_type:
        lowered = content_type.lower()
        if "jpeg" in lowered or "jpg" in lowered:
            return ".jpg"
        if "png" in lowered:
            return ".png"
        if "webp" in lowered:
            return ".webp"
    return ".jpg"


def encode_image_sequence_to_mp4(
    frame_paths: list[Path],
    frame_rate: int,
    output_path: Path,
    bitrate: str = "8M",
) -> None:
    """把按时间顺序排列的图片序列编成 H.264 MP4。

    要求：所有帧同一扩展名、尺寸一致（由前端保证偶数宽高）。
    """
    if not frame_paths:
        raise ValueError("没有可编码的帧。")
    if not isinstance(frame_rate, int) or frame_rate < 1 or frame_rate > 120:
        raise ValueError("视频帧率无效。")

    ext = frame_paths[0].suffix.lower()
    if ext not in ALLOWED_FRAME_EXTENSIONS:
        raise ValueError(f"不支持的帧格式：{ext}")
    if any(path.suffix.lower() != ext for path in frame_paths):
        raise ValueError("全部帧必须是同一种图片格式。")

    work_dir = Path(tempfile.mkdtemp(prefix="xiaobaihe-encode-"))
    try:
        pattern_name = f"frame_%04d{ext}"
        for index, source in enumerate(frame_paths):
            target = work_dir / f"frame_{index:04d}{ext}"
            shutil.copyfile(source, target)

        # -pix_fmt yuv420p：几乎所有播放器都能播；
        # +faststart：把 moov 挪到文件头，网页与 AI 平台上传更友好。
        command = [
            FFMPEG_BIN,
            "-y",
            "-framerate",
            str(frame_rate),
            "-i",
            str(work_dir / pattern_name),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            bitrate,
            "-movflags",
            "+faststart",
            str(output_path),
        ]
        result = subprocess.run(
            command,
            capture_output=True,
            timeout=300,
            check=False,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")[-2000:]
            raise RuntimeError(f"ffmpeg 编码失败：{stderr or '未知错误'}")
        if not output_path.exists() or output_path.stat().st_size == 0:
            raise RuntimeError("ffmpeg 未生成有效的 MP4。")
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
