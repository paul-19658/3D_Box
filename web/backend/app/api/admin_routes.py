"""管理员接口：用户管理、跨用户工程只读打开与删除。"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import User
from app.db.session import get_db
from app.services import project_repo
from app.services.auth import ROLE_ADMIN, ROLE_USER, require_admin
from app.services.project_store import ProjectFileService, user_workspace

router = APIRouter(prefix="/api/admin", tags=["admin"])


class PatchUserRequest(BaseModel):
    role: Optional[str] = None
    isActive: Optional[bool] = None


def _user_entry(db: Session, user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "role": user.role,
        "isActive": user.is_active,
        "hasPassword": bool(user.password_hash),
        "createdAt": user.created_at.isoformat() if user.created_at else None,
        "lastLoginAt": user.last_login_at.isoformat() if user.last_login_at else None,
        "projectCount": project_repo.count_projects(db, user.id),
    }


@router.get("/users")
def list_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _ = admin
    users = list(db.scalars(select(User).order_by(User.created_at.asc())).all())
    return {"users": [_user_entry(db, user) for user in users]}


@router.patch("/users/{user_id}")
def patch_user(
    user_id: str,
    request: PatchUserRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    target = db.get(User, user_id)
    if target is None:
        raise HTTPException(status_code=404, detail="找不到该用户。")

    new_role = request.role if request.role is not None else target.role
    new_active = request.isActive if request.isActive is not None else target.is_active

    if new_role not in (ROLE_USER, ROLE_ADMIN):
        raise HTTPException(status_code=400, detail="无效的角色。")

    if target.id == admin.id:
        if new_role != ROLE_ADMIN:
            raise HTTPException(status_code=409, detail="不能取消自己的管理员身份。")
        if not new_active:
            raise HTTPException(status_code=409, detail="不能禁用自己的账号。")

    demoting_or_disabling_admin = target.role == ROLE_ADMIN and target.is_active and (
        new_role != ROLE_ADMIN or not new_active
    )
    if demoting_or_disabling_admin and project_repo.count_active_admins(db) <= 1:
        raise HTTPException(status_code=409, detail="不能取消或禁用最后一个管理员。")

    target.role = new_role
    target.is_active = new_active
    db.commit()
    db.refresh(target)
    return {"user": _user_entry(db, target)}


@router.get("/projects")
def list_all_projects(
    ownerId: Optional[str] = None,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _ = admin
    rows = project_repo.list_all(db, owner_id=ownerId)
    return {"projects": [project_repo.project_to_admin_entry(row) for row in rows]}


@router.get("/projects/{project_id}")
def open_project_readonly(
    project_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _ = admin
    row = project_repo.get_any(db, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"找不到工程：{project_id}")
    store = ProjectFileService(workspace=user_workspace(row.owner_id))
    try:
        result = store.open(project_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=f"工程文件损坏：{error}") from error
    # 只读打开不更新 last_opened_at。
    return {
        "projectId": project_id,
        "document": result["document"],
        "ownerUsername": row.owner.username if row.owner else "",
        "readOnly": True,
    }


@router.delete("/projects/{project_id}")
def delete_any_project(
    project_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    _ = admin
    row = project_repo.get_any(db, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"找不到工程：{project_id}")
    ProjectFileService(workspace=user_workspace(row.owner_id)).delete(project_id)
    project_repo.delete_any(db, project_id)
    return {"status": "deleted"}
