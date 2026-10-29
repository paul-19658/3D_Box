"""写入 password_hash（bcrypt）。写入后登录仍不校验，只是把数据备好。

用法（在 web/backend 目录下）：
    py -3.10 -m app.scripts.set_password --username 张三 --password 'secret'
"""

from __future__ import annotations

import argparse
import sys
import uuid
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.models import User
from app.db.session import SessionLocal, init_db
from app.services.auth import ROLE_USER, hash_password, normalize_username_key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="设置小白盒 Web 用户密码哈希")
    parser.add_argument("--username", required=True)
    parser.add_argument("--password", required=True)
    args = parser.parse_args(argv)

    if not args.password:
        print("密码不能为空", file=sys.stderr)
        return 1

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
                password_hash=hash_password(args.password),
                role=ROLE_USER,
                is_active=True,
                created_at=datetime.now(timezone.utc),
            )
            db.add(user)
            print(f"已创建用户 {user.username} 并写入 password_hash（登录暂不校验）")
        else:
            user.password_hash = hash_password(args.password)
            print(f"已更新用户 {user.username} 的 password_hash（登录暂不校验）")
        db.commit()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
