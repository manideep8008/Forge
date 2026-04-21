"""Pipeline comment endpoints."""
from __future__ import annotations

import structlog
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from db import get_db

logger = structlog.get_logger()
router = APIRouter(tags=["comments"])


class CommentCreate(BaseModel):
    body: str = Field(..., min_length=1, max_length=2000)
    stage_name: str | None = None


@router.post("/pipeline/{pipeline_id}/comments", status_code=201)
async def add_comment(
    pipeline_id: str,
    body: CommentCreate,
    x_user_id: str | None = Header(None),
):
    if not x_user_id:
        raise HTTPException(status_code=401, detail="authentication required")
    db = await get_db()
    # Verify pipeline exists
    exists = await db.fetchrow("SELECT 1 FROM pipelines WHERE id=$1", pipeline_id)
    if not exists:
        raise HTTPException(status_code=404, detail="pipeline not found")
    row = await db.fetchrow(
        """
        INSERT INTO pipeline_comments (pipeline_id, stage_name, user_id, body)
        VALUES ($1, $2, $3, $4)
        RETURNING id, created_at
        """,
        pipeline_id, body.stage_name, x_user_id, body.body,
    )
    return {
        "id": str(row["id"]),
        "pipeline_id": pipeline_id,
        "stage_name": body.stage_name,
        "user_id": x_user_id,
        "body": body.body,
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/pipeline/{pipeline_id}/comments")
async def list_comments(pipeline_id: str, x_user_id: str | None = Header(None)):
    if not x_user_id:
        raise HTTPException(status_code=401, detail="authentication required")
    db = await get_db()
    rows = await db.fetch(
        """
        SELECT pc.id, pc.stage_name, pc.body, pc.created_at,
               u.email AS author_email
        FROM pipeline_comments pc
        JOIN users u ON u.id = pc.user_id
        WHERE pc.pipeline_id = $1
        ORDER BY pc.created_at ASC
        """,
        pipeline_id,
    )
    return {
        "comments": [
            {
                "id": str(r["id"]),
                "stage_name": r["stage_name"],
                "body": r["body"],
                "author_email": r["author_email"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    }
