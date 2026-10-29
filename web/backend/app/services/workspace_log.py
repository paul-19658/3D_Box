"""工作区日志：所有必要日志写入固定目录 `{workspace}/logs/`。

默认文件：`{workspace}/logs/YYYY-MM-DD.log`（按日一条文件，JSONL）。
每行一个 JSON 对象，含 `ts` / `level` / `logger` / `kind` 等字段。

约定：
- 永不写入 API Key / Authorization / password；
- 图片 base64 只保留 mime / 长度；
- 写盘失败不影响主流程。
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# 相对 DEFAULT_WORKSPACE 的固定目录。
LOGS_SUBDIR = Path("logs")

_SENSITIVE_KEYS = frozenset(
    {
        "apikey",
        "api_key",
        "authorization",
        "x-api-key",
        "secret",
        "token",
        "password",
    }
)
_BINARYISH_KEYS = frozenset(
    {
        "base64data",
        "base64_data",
        "data",
        "image_url",
    }
)

_configured = False


def logs_dir(workspace: Path) -> Path:
    return Path(workspace) / LOGS_SUBDIR


def ensure_logs_dir(workspace: Path) -> Path:
    path = logs_dir(workspace)
    path.mkdir(parents=True, exist_ok=True)
    return path


def daily_log_path(log_dir: Path, when: Optional[datetime] = None) -> Path:
    moment = when or datetime.now(timezone.utc)
    return Path(log_dir) / f"{moment.strftime('%Y-%m-%d')}.log"


def redact_for_log(value: Any, *, _key: str = "") -> Any:
    """递归脱敏：密钥清空，超长 base64 / data-url 改成长度摘要。"""
    key_l = (_key or "").lower().replace("-", "_")

    if key_l in _SENSITIVE_KEYS:
        return "<redacted>"

    if isinstance(value, dict):
        if key_l == "image_url" and isinstance(value.get("url"), str):
            return {**value, "url": _summarize_long_string(value["url"])}
        return {str(k): redact_for_log(v, _key=str(k)) for k, v in value.items()}

    if isinstance(value, list):
        return [redact_for_log(item) for item in value]

    if isinstance(value, str):
        if key_l in _BINARYISH_KEYS or value.startswith("data:image"):
            return _summarize_long_string(value)
        if len(value) > 4000 and _looks_like_base64(value):
            return _summarize_long_string(value)
        return value

    return value


def summarize_images(images: Any) -> list[dict[str, Any]]:
    if not isinstance(images, list):
        return []
    out: list[dict[str, Any]] = []
    for image in images:
        if not isinstance(image, dict):
            continue
        data = str(image.get("base64Data") or image.get("base64_data") or "")
        out.append(
            {
                "mimeType": str(image.get("mimeType") or image.get("mime_type") or "")[:64],
                "byteLength": len(data),
                "label": str(image.get("label") or image.get("role") or "")[:120] or None,
            }
        )
    return out


def write_log_event(
    log_dir: Path,
    kind: str,
    payload: Optional[dict[str, Any]] = None,
    *,
    level: str = "INFO",
    logger_name: str = "xiaobaihe",
    message: str = "",
) -> Path | None:
    """追加一条 JSONL 到当日 `.log`；失败返回 None。"""
    try:
        log_dir = Path(log_dir)
        log_dir.mkdir(parents=True, exist_ok=True)
        path = daily_log_path(log_dir)
        entry: dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level,
            "logger": logger_name,
            "kind": kind,
            "message": message or kind,
        }
        if payload:
            entry.update(payload)
        line = json.dumps(redact_for_log(entry), ensure_ascii=False, default=str)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        return path
    except Exception:
        return None


def write_agent_call_log(log_dir: Path, entry: dict[str, Any]) -> Path | None:
    """兼容旧调用：AI chat 完整记录写入同一日志文件。"""
    payload = dict(entry)
    payload.pop("ts", None)
    return write_log_event(
        log_dir,
        kind="ai.chat",
        payload=payload,
        level="ERROR" if (entry.get("result") or {}).get("status") == "error" else "INFO",
        logger_name="ai.chat",
        message="ai.chat",
    )


class WorkspaceJsonLogHandler(logging.Handler):
    """把标准 logging 记录写成与业务事件同一份 JSONL。"""

    def __init__(self, log_dir: Path) -> None:
        super().__init__()
        self.log_dir = Path(log_dir)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            payload: dict[str, Any] = {}
            event = getattr(record, "event", None)
            if isinstance(event, dict):
                payload.update(event)
            write_log_event(
                self.log_dir,
                kind=str(payload.pop("kind", record.name)),
                payload=payload or None,
                level=record.levelname,
                logger_name=record.name,
                message=record.getMessage(),
            )
        except Exception:
            self.handleError(record)


def configure_workspace_logging(workspace: Path) -> Path:
    """初始化根日志与 uvicorn 日志，全部落到 workspace/logs。"""
    global _configured
    path = ensure_logs_dir(workspace)
    if _configured:
        return path

    handler = WorkspaceJsonLogHandler(path)
    handler.setLevel(logging.INFO)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # 避免重复 handler（reload 场景）。
    if not any(isinstance(item, WorkspaceJsonLogHandler) for item in root.handlers):
        root.addHandler(handler)

    # 控制台仍保留一份可读输出，方便开发。
    if not any(isinstance(item, logging.StreamHandler) and not isinstance(item, WorkspaceJsonLogHandler) for item in root.handlers):
        stream = logging.StreamHandler(sys.stderr)
        stream.setLevel(logging.INFO)
        stream.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
        )
        root.addHandler(stream)

    # access 由 FastAPI middleware 写一份即可，避免与 uvicorn.access 重复。
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False
    for name in ("uvicorn", "uvicorn.error", "fastapi"):
        logging.getLogger(name).setLevel(logging.INFO)

    _configured = True
    write_log_event(path, kind="app.startup", message="workspace logging ready")
    return path


def _summarize_long_string(value: str) -> str:
    if len(value) <= 96:
        return value
    prefix = value[:48]
    return f"<omitted len={len(value)} prefix={prefix!r}>"


def _looks_like_base64(value: str) -> bool:
    sample = value[:200].replace("\n", "").replace(" ", "")
    if len(sample) < 64:
        return False
    allowed = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
    return all(ch in allowed for ch in sample)


# ---------- 兼容旧模块名 ----------
def agent_log_dir(workspace: Path) -> Path:
    return logs_dir(workspace)


def ensure_agent_log_dir(workspace: Path) -> Path:
    return ensure_logs_dir(workspace)
