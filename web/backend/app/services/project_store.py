"""工程文件的落盘、读取、自动恢复与最近工程记录。

对应原 Electron 版 `src/main/project-file-service.ts` 与
`src/main/workspace-state-service.ts` 的职责。Web 版把这些能力放到后端，
原因是：
1. 浏览器无法自由写用户磁盘，需要服务端代劳；
2. 工程文件可能很大（内嵌导入模型），需要原子写入避免半截文件；
3. 最近工程与恢复快照是跨会话状态，放在服务端更稳定。
"""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from app.models.project import migrate_document

# 默认工程目录：环境变量优先，便于容器化部署与多用户隔离。
DEFAULT_WORKSPACE = Path(os.environ.get("WHITEBOX_WORKSPACE", "workspace"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_text(path: Path, data: str) -> None:
    """原子写入：先写同目录临时文件，再 rename 覆盖。

    这样即使进程中途崩溃，也不会留下半截的工程文件。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


@dataclass
class ProjectFileService:
    """工程文件读写与工作区状态管理。"""

    workspace: Path = DEFAULT_WORKSPACE
    app_version: str = "0.22.0"

    @property
    def projects_dir(self) -> Path:
        return self.workspace / "projects"

    @property
    def recovery_file(self) -> Path:
        return self.workspace / "workspace-state" / "recovery.json"

    @property
    def recent_file(self) -> Path:
        return self.workspace / "workspace-state" / "recent-projects.json"

    @property
    def exports_dir(self) -> Path:
        return self.workspace / "exports"

    def ensure_dirs(self) -> None:
        for directory in (
            self.projects_dir,
            self.recovery_file.parent,
            self.exports_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # 工程读写
    # ------------------------------------------------------------------

    def safe_name(self, name: str) -> str:
        """把用户输入的工程名转换成安全的文件名。

        只保留中英文、数字、连字符和下划线，避免路径穿越与非法字符。
        """
        cleaned = "".join(
            character
            for character in (name or "").strip()
            if character.isalnum() or character in "-_"
        )
        return cleaned[:64] or "未命名场景"

    def path_for(self, project_id: str) -> Path:
        return self.projects_dir / f"{project_id}.block3d"

    def save(self, document: dict[str, Any], project_id: Optional[str] = None) -> dict[str, Any]:
        """保存工程，返回 {projectId, filePath, savedAt}。"""
        self.ensure_dirs()
        resolved_id = project_id or f"{self.safe_name(document.get('name', ''))}-{uuid.uuid4().hex[:8]}"
        document = dict(document)
        document["savedAt"] = _now()
        document.setdefault("appVersion", self.app_version)
        path = self.path_for(resolved_id)
        _atomic_write_text(path, json.dumps(document, ensure_ascii=False, indent=2))
        self.record_recent(resolved_id, document.get("name") or resolved_id)
        return {
            "projectId": resolved_id,
            "filePath": str(path),
            "displayName": path.name,
            "savedAt": document["savedAt"],
        }

    def open(self, project_id: str) -> dict[str, Any]:
        """读取工程并按当前 schema 迁移。"""
        path = self.path_for(project_id)
        if not path.exists():
            raise FileNotFoundError(f"找不到工程：{project_id}")
        raw = json.loads(path.read_text(encoding="utf-8"))
        document = migrate_document(raw, self.app_version, raw.get("savedAt") or _now())
        self.record_recent(project_id, document.get("name") or project_id)
        return {"projectId": project_id, "document": document}

    def list_projects(self) -> list[dict[str, Any]]:
        self.ensure_dirs()
        entries: list[dict[str, Any]] = []
        for path in sorted(self.projects_dir.glob("*.block3d")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                name = raw.get("name") or path.stem
            except Exception:
                name = path.stem
            stat = path.stat()
            entries.append(
                {
                    "projectId": path.stem,
                    "displayName": path.name,
                    "name": name,
                    "fileSizeBytes": stat.st_size,
                    "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                }
            )
        entries.sort(key=lambda item: item["modifiedAt"], reverse=True)
        return entries

    def delete(self, project_id: str) -> None:
        path = self.path_for(project_id)
        path.unlink(missing_ok=True)
        self.remove_recent(project_id)

    # ------------------------------------------------------------------
    # 自动恢复
    # ------------------------------------------------------------------

    def save_recovery(self, document: dict[str, Any], project_id: Optional[str]) -> None:
        """保存一份恢复快照。只保留最近一份，不按时间无限堆积。"""
        payload = {"document": document, "projectId": project_id, "capturedAt": _now()}
        _atomic_write_text(self.recovery_file, json.dumps(payload, ensure_ascii=False))

    def load_recovery(self) -> Optional[dict[str, Any]]:
        if not self.recovery_file.exists():
            return None
        try:
            return json.loads(self.recovery_file.read_text(encoding="utf-8"))
        except Exception:
            return None

    def clear_recovery(self) -> None:
        self.recovery_file.unlink(missing_ok=True)

    # ------------------------------------------------------------------
    # 最近工程
    # ------------------------------------------------------------------

    def _read_recent(self) -> list[dict[str, Any]]:
        if not self.recent_file.exists():
            return []
        try:
            data = json.loads(self.recent_file.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
        except Exception:
            return []

    def record_recent(self, project_id: str, name: str) -> None:
        entries = [entry for entry in self._read_recent() if entry.get("projectId") != project_id]
        entries.insert(
            0,
            {
                "projectId": project_id,
                "name": name,
                "lastOpenedAt": _now(),
            },
        )
        # 最多保留 20 条，避免记录无限增长。
        _atomic_write_text(self.recent_file, json.dumps(entries[:20], ensure_ascii=False))

    def list_recent(self) -> list[dict[str, Any]]:
        return self._read_recent()

    def remove_recent(self, project_id: str) -> None:
        entries = [entry for entry in self._read_recent() if entry.get("projectId") != project_id]
        _atomic_write_text(self.recent_file, json.dumps(entries, ensure_ascii=False))

    # ------------------------------------------------------------------
    # 导出落盘
    # ------------------------------------------------------------------

    def write_export(self, filename: str, data: bytes) -> dict[str, Any]:
        """写入一个导出产物（图片 / 视频 / 模型 / 文本），返回可下载路径。"""
        self.ensure_dirs()
        safe = self.safe_name(Path(filename).stem) + (Path(filename).suffix or "")
        target = self.exports_dir / safe
        counter = 1
        while target.exists():
            target = self.exports_dir / f"{Path(safe).stem}-{counter}{Path(safe).suffix}"
            counter += 1
        target.write_bytes(data)
        return {
            "fileName": target.name,
            "relativePath": f"exports/{target.name}",
            "byteLength": len(data),
        }

    def resolve_export(self, relative_path: str) -> Path:
        """把前端传来的相对路径解析为真实路径，并阻止路径穿越。"""
        candidate = (self.workspace / relative_path).resolve()
        root = self.workspace.resolve()
        if not str(candidate).startswith(str(root)):
            raise PermissionError("导出路径越界。")
        if not candidate.exists():
            raise FileNotFoundError("导出文件不存在。")
        return candidate
