"""Workspace and membership endpoints."""
from __future__ import annotations

from typing import Annotated

import structlog
from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, StringConstraints

from db import get_db

logger = structlog.get_logger()
router = APIRouter(prefix="/workspaces", tags=["workspaces"])


# ── Request models ─────────────────────────────────────────────────────────────

WorkspaceName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class WorkspaceCreate(BaseModel):
    name: WorkspaceName


class InviteMember(BaseModel):
    email: str


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_user(x_user_id: str | None) -> str:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="authentication required")
    return x_user_id


async def _assert_member(db, workspace_id: str, user_id: str) -> None:
    row = await db.fetchrow(
        "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
        workspace_id, user_id,
    )
    if not row:
        raise HTTPException(status_code=403, detail="not a workspace member")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("", status_code=201)
async def create_workspace(
    body: WorkspaceCreate,
    x_user_id: str | None = Header(None),
):
    user_id = _require_user(x_user_id)
    pool = await get_db()
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "INSERT INTO workspaces (name, owner_id) VALUES ($1, $2) RETURNING id, name, created_at",
            body.name, user_id,
        )
        ws_id = str(row["id"])
        # Auto-add owner as member
        await conn.execute(
            "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
            ws_id, user_id,
        )
    ws_id = str(row["id"])
    return {"id": ws_id, "name": row["name"], "created_at": row["created_at"].isoformat()}


@router.get("")
async def list_workspaces(x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    rows = await db.fetch(
        """
        SELECT w.id, w.name, w.created_at, wm.role
        FROM workspaces w
        JOIN workspace_members wm ON wm.workspace_id = w.id
        WHERE wm.user_id = $1
        ORDER BY w.created_at DESC
        """,
        user_id,
    )
    return {
        "workspaces": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "role": r["role"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/{workspace_id}")
async def get_workspace(workspace_id: str, x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    await _assert_member(db, workspace_id, user_id)
    row = await db.fetchrow("SELECT id, name, owner_id, created_at FROM workspaces WHERE id=$1", workspace_id)
    if not row:
        raise HTTPException(status_code=404, detail="workspace not found")
    members = await db.fetch(
        """
        SELECT u.id, u.email, wm.role, wm.joined_at
        FROM workspace_members wm
        JOIN users u ON u.id = wm.user_id
        WHERE wm.workspace_id = $1
        """,
        workspace_id,
    )
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "owner_id": str(row["owner_id"]),
        "created_at": row["created_at"].isoformat(),
        "members": [
            {"id": str(m["id"]), "email": m["email"], "role": m["role"], "joined_at": m["joined_at"].isoformat()}
            for m in members
        ],
    }


@router.post("/{workspace_id}/members", status_code=201)
async def invite_member(
    workspace_id: str,
    body: InviteMember,
    x_user_id: str | None = Header(None),
):
    user_id = _require_user(x_user_id)
    db = await get_db()
    # Only owner can invite
    owner = await db.fetchrow(
        "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role='owner'",
        workspace_id, user_id,
    )
    if not owner:
        raise HTTPException(status_code=403, detail="only workspace owner can invite members")
    invitee = await db.fetchrow("SELECT id FROM users WHERE email=$1", body.email)
    if not invitee:
        raise HTTPException(status_code=404, detail="user not found")
    await db.execute(
        """
        INSERT INTO workspace_members (workspace_id, user_id, role)
        VALUES ($1, $2, 'member')
        ON CONFLICT (workspace_id, user_id) DO NOTHING
        """,
        workspace_id, str(invitee["id"]),
    )
    return {"status": "ok", "email": body.email}


@router.get("/{workspace_id}/pipelines")
async def list_workspace_pipelines(
    workspace_id: str,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    x_user_id: str | None = Header(None),
):
    user_id = _require_user(x_user_id)
    db = await get_db()
    await _assert_member(db, workspace_id, user_id)
    rows = await db.fetch(
        """
        SELECT id, user_id, status, intent_type, created_at, completed_at, input_text, parent_pipeline_id
        FROM pipelines
        WHERE workspace_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        """,
        workspace_id, limit,
    )
    return {
        "pipelines": [
            {
                "id": str(r["id"]),
                "user_id": r["user_id"],
                "status": r["status"],
                "intent_type": r["intent_type"],
                "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
                "input_text": r["input_text"],
                "parent_pipeline_id": str(r["parent_pipeline_id"]) if r["parent_pipeline_id"] else None,
            }
            for r in rows
        ]
    }
