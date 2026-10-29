"""工程元数据仓储：归属过滤、最近打开、管理员全量查询。"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload

from app.db.models import Project, User
from app.models.project import PROJECT_SCHEMA_VERSION

RECENT_LIMIT = 20


def _now() -> datetime:
    return datetime.now(timezone.utc)


def get_owned(db: Session, owner_id: str, project_id: str) -> Optional[Project]:
    return db.scalar(
        select(Project).where(Project.id == project_id, Project.owner_id == owner_id)
    )


def get_any(db: Session, project_id: str) -> Optional[Project]:
    return db.scalar(
        select(Project).options(joinedload(Project.owner)).where(Project.id == project_id)
    )


def upsert_after_save(
    db: Session,
    *,
    project_id: str,
    owner_id: str,
    name: str,
    schema_version: int,
    file_size_bytes: int,
) -> Project:
    now = _now()
    row = get_owned(db, owner_id, project_id)
    if row is None:
        row = Project(
            id=project_id,
            owner_id=owner_id,
            name=name or project_id,
            schema_version=schema_version or PROJECT_SCHEMA_VERSION,
            file_size_bytes=file_size_bytes,
            created_at=now,
            updated_at=now,
            last_opened_at=now,
        )
        db.add(row)
    else:
        row.name = name or row.name
        row.schema_version = schema_version or row.schema_version
        row.file_size_bytes = file_size_bytes
        row.updated_at = now
        row.last_opened_at = now
    db.commit()
    db.refresh(row)
    return row


def mark_opened(db: Session, owner_id: str, project_id: str) -> Optional[Project]:
    row = get_owned(db, owner_id, project_id)
    if row is None:
        return None
    row.last_opened_at = _now()
    db.commit()
    db.refresh(row)
    return row


def delete_owned(db: Session, owner_id: str, project_id: str) -> bool:
    row = get_owned(db, owner_id, project_id)
    if row is None:
        return False
    db.delete(row)
    db.commit()
    return True


def delete_any(db: Session, project_id: str) -> Optional[Project]:
    row = get_any(db, project_id)
    if row is None:
        return None
    db.delete(row)
    db.commit()
    return row


def list_owned(db: Session, owner_id: str) -> list[Project]:
    return list(
        db.scalars(
            select(Project)
            .where(Project.owner_id == owner_id)
            .order_by(Project.updated_at.desc())
        ).all()
    )


def list_recent(db: Session, owner_id: str, limit: int = RECENT_LIMIT) -> list[Project]:
    return list(
        db.scalars(
            select(Project)
            .where(Project.owner_id == owner_id, Project.last_opened_at.is_not(None))
            .order_by(Project.last_opened_at.desc())
            .limit(limit)
        ).all()
    )


def forget_recent(db: Session, owner_id: str, project_id: str) -> list[Project]:
    row = get_owned(db, owner_id, project_id)
    if row is not None:
        row.last_opened_at = None
        db.commit()
    return list_recent(db, owner_id)


def list_all(db: Session, owner_id: Optional[str] = None) -> list[Project]:
    stmt = select(Project).options(joinedload(Project.owner)).order_by(Project.updated_at.desc())
    if owner_id:
        stmt = stmt.where(Project.owner_id == owner_id)
    return list(db.scalars(stmt).unique().all())


def project_to_list_entry(row: Project) -> dict:
    return {
        "projectId": row.id,
        "displayName": f"{row.id}.block3d",
        "name": row.name,
        "fileSizeBytes": row.file_size_bytes,
        "modifiedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


def project_to_recent_entry(row: Project) -> dict:
    return {
        "projectId": row.id,
        "name": row.name,
        "lastOpenedAt": row.last_opened_at.isoformat() if row.last_opened_at else None,
    }


def project_to_admin_entry(row: Project) -> dict:
    entry = project_to_list_entry(row)
    entry["ownerId"] = row.owner_id
    entry["ownerUsername"] = row.owner.username if row.owner else ""
    return entry


def count_projects(db: Session, owner_id: str) -> int:
    return int(
        db.scalar(select(func.count()).select_from(Project).where(Project.owner_id == owner_id)) or 0
    )


def count_active_admins(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.role == "admin", User.is_active.is_(True))
        )
        or 0
    )
