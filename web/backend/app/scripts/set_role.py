"""设置用户角色。

用法（在 web/backend 目录下）：
    py -3.10 -m app.scripts.set_role --username 张三 --role admin
"""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.models import User
from app.db.session import SessionLocal, init_db
from app.services.auth import ROLE_ADMIN, ROLE_USER, normalize_username_key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="设置小白盒 Web 用户角色")
    parser.add_argument("--username", required=True)
    parser.add_argument("--role", required=True, choices=[ROLE_USER, ROLE_ADMIN])
    args = parser.parse_args(argv)

    init_db()
    key = normalize_username_key(args.username)
    if not key:
        print("账号名不能为空", file=sys.stderr)
        return 1

    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username_key == key))
        if user is None:
            user = User(
                id=str(uuid.uuid4()),
                username=args.username.strip(),
                username_key=key,
                password_hash=None,
                role=args.role,
                is_active=True,
                created_at=datetime.now(timezone.utc),
            )
            db.add(user)
            print(f"已创建用户 {user.username}，角色={args.role}")
        else:
            user.role = args.role
            print(f"已更新用户 {user.username}，角色={args.role}")
        db.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
