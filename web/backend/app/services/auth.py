"""用户登录与 Cookie 会话。

一期只凭账号名进入：不存在则自动创建普通用户；password_hash 字段已预留，
登录路径暂不校验。Cookie 用 HMAC 签名，供前端 <a href> 下载也能带上凭证。
"""

from __future__ import annotations

import hmac
import os
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import bcrypt
from fastapi import Cookie, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User
from app.db.session import get_db
from app.services.project_store import DEFAULT_WORKSPACE

SESSION_COOKIE = "wb_session"
ROLE_USER = "user"
ROLE_ADMIN = "admin"


def normalize_username_key(username: str) -> str:
    return (username or "").strip().lower()


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, password_hash: Optional[str]) -> bool:
    """预留给日后启用密码校验；当前登录路径不调用。"""
    if not password_hash:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def _secret_key_path() -> Path:
    return DEFAULT_WORKSPACE / "secret.key"


def get_secret_key() -> str:
    env = os.environ.get("WHITEBOX_SECRET_KEY")
    if env:
        return env
    path = _secret_key_path()
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    path.parent.mkdir(parents=True, exist_ok=True)
    key = secrets.token_hex(32)
    path.write_text(key, encoding="utf-8")
    return key


def sign_session(user_id: str) -> str:
    digest = hmac.new(get_secret_key().encode("utf-8"), user_id.encode("utf-8"), "sha256").hexdigest()
    return f"{user_id}.{digest}"


def parse_session(token: Optional[str]) -> Optional[str]:
    if not token or "." not in token:
        return None
    user_id, signature = token.rsplit(".", 1)
    expected = hmac.new(get_secret_key().encode("utf-8"), user_id.encode("utf-8"), "sha256").hexdigest()
    if not hmac.compare_digest(signature, expected):
        return None
    return user_id


def set_session_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(
        key=SESSION_COOKIE,
        value=sign_session(user_id),
        httponly=True,
        samesite="lax",
        path="/",
        max_age=60 * 60 * 24 * 30,
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(key=SESSION_COOKIE, path="/")


def user_public(user: User) -> dict:
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
    }


def login_or_create(db: Session, username: str) -> User:
    """按账号名查找或创建用户。不接收、不校验密码。"""
    key = normalize_username_key(username)
    if not key:
        raise HTTPException(status_code=400, detail="请输入账号名。")
    if len(username.strip()) > 64:
        raise HTTPException(status_code=400, detail="账号名过长。")

    user = db.scalar(select(User).where(User.username_key == key))
    if user is None:
        user = User(
            id=str(uuid.uuid4()),
            username=username.strip(),
            username_key=key,
            password_hash=None,
            role=ROLE_USER,
            is_active=True,
            created_at=datetime.now(timezone.utc),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    elif not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被停用。")

    user.last_login_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)
    return user


def current_user(
    wb_session: Optional[str] = Cookie(default=None, alias=SESSION_COOKIE),
    db: Session = Depends(get_db),
) -> User:
    user_id = parse_session(wb_session)
    if not user_id:
        raise HTTPException(status_code=401, detail="未登录。")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="未登录。")
    if not user.is_active:
        raise HTTPException(status_code=401, detail="账号已被停用。")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != ROLE_ADMIN:
        raise HTTPException(status_code=403, detail="需要管理员权限。")
    return user
