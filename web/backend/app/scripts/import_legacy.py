"""把旧版全局 workspace/projects/*.block3d 导入到指定用户目录。

用法（在 web/backend 目录下）：
    py -3.10 -m app.scripts.import_legacy --username 张三
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.models import User
from app.db.session import SessionLocal, init_db
from app.services import project_repo
from app.services.auth import ROLE_USER, normalize_username_key
from app.services.project_store import DEFAULT_WORKSPACE, ProjectFileService, user_workspace


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="导入旧版全局工程到指定用户")
    parser.add_argument("--username", required=True)
    args = parser.parse_args(argv)

    init_db()
    key = normalize_username_key(args.username)
    if not key:
        print("账号名不能为空", file=sys.stderr)
        return 1

    legacy_dir = DEFAULT_WORKSPACE / "projects"
    if not legacy_dir.exists():
        print(f"没有找到旧工程目录：{legacy_dir}")
        return 0

    files = sorted(legacy_dir.glob("*.block3d"))
    if not files:
        print("旧工程目录为空，无需导入。")
        return 0

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username_key == key))
        if user is None:
            user = User(
                id=str(uuid.uuid4()),
                username=args.username.strip(),
                username_key=key,
                password_hash=None,
                role=ROLE_USER,
                is_active=True,
                created_at=datetime.now(timezone.utc),
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            print(f"已创建用户 {user.username}")

        target = ProjectFileService(workspace=user_workspace(user.id))
        target.ensure_dirs()
        imported = 0
        for path in files:
            project_id = path.stem
            dest = target.path_for(project_id)
            if dest.exists():
                print(f"跳过（目标已存在）：{project_id}")
                continue
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                name = str(raw.get("name") or project_id)
                schema_version = int(raw.get("schemaVersion") or 13)
            except Exception:
                name = project_id
                schema_version = 13
            shutil.move(str(path), str(dest))
            project_repo.upsert_after_save(
                db,
                project_id=project_id,
                owner_id=user.id,
                name=name,
                schema_version=schema_version,
                file_size_bytes=dest.stat().st_size,
            )
            imported += 1
            print(f"已导入：{project_id}")

        # 若旧目录空了，保留目录本身。
        print(f"完成，共导入 {imported} 个工程到用户 {user.username}。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
