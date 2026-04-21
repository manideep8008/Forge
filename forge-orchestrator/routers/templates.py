"""Pipeline template and scheduling endpoints."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import structlog
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

from db import get_db

logger = structlog.get_logger()
router = APIRouter(tags=["templates"])


# ── Models ────────────────────────────────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    prompt: str = Field(..., min_length=1)
    description: str | None = None
    workspace_id: str | None = None
    is_public: bool = False


class ScheduleCreate(BaseModel):
    template_id: str
    cron_expr: str = Field(..., description="5-field cron: min hour day month weekday")
    workspace_id: str | None = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _require_user(x_user_id: str | None) -> str:
    if not x_user_id:
        raise HTTPException(status_code=401, detail="authentication required")
    return x_user_id


def _next_run(cron_expr: str) -> datetime:
    """Compute the next run time from a 5-field cron expression using croniter."""
    try:
        from croniter import croniter  # type: ignore
        return croniter(cron_expr, datetime.now(timezone.utc)).get_next(datetime)
    except Exception:
        raise HTTPException(status_code=400, detail=f"invalid cron expression: {cron_expr}")


# ── Template endpoints ────────────────────────────────────────────────────────

@router.post("/templates", status_code=201)
async def create_template(body: TemplateCreate, x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    row = await db.fetchrow(
        """
        INSERT INTO pipeline_templates (workspace_id, user_id, name, description, prompt, is_public)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, created_at
        """,
        body.workspace_id, user_id, body.name, body.description, body.prompt, body.is_public,
    )
    return {
        "id": str(row["id"]),
        "name": body.name,
        "description": body.description,
        "prompt": body.prompt,
        "is_public": body.is_public,
        "workspace_id": body.workspace_id,
        "user_id": user_id,
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/templates")
async def list_templates(workspace_id: str | None = None, x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    if workspace_id:
        rows = await db.fetch(
            """
            SELECT id, name, description, prompt, is_public, workspace_id, user_id, created_at
            FROM pipeline_templates
            WHERE workspace_id = $1
            ORDER BY created_at DESC
            """,
            workspace_id,
        )
    else:
        rows = await db.fetch(
            """
            SELECT id, name, description, prompt, is_public, workspace_id, user_id, created_at
            FROM pipeline_templates
            WHERE user_id = $1 OR is_public = true
            ORDER BY created_at DESC
            LIMIT 50
            """,
            user_id,
        )
    return {
        "templates": [
            {
                "id": str(r["id"]),
                "name": r["name"],
                "description": r["description"],
                "prompt": r["prompt"],
                "is_public": r["is_public"],
                "workspace_id": str(r["workspace_id"]) if r["workspace_id"] else None,
                "user_id": str(r["user_id"]),
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    }


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(template_id: str, x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    result = await db.execute(
        "DELETE FROM pipeline_templates WHERE id=$1 AND user_id=$2",
        template_id, user_id,
    )
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="template not found or not owned by you")


# ── Schedule endpoints ────────────────────────────────────────────────────────

@router.post("/schedules", status_code=201)
async def create_schedule(body: ScheduleCreate, x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    next_run = _next_run(body.cron_expr)
    db = await get_db()
    # Verify template exists
    tmpl = await db.fetchrow("SELECT id FROM pipeline_templates WHERE id=$1", body.template_id)
    if not tmpl:
        raise HTTPException(status_code=404, detail="template not found")
    row = await db.fetchrow(
        """
        INSERT INTO scheduled_pipelines (template_id, workspace_id, created_by, cron_expr, next_run_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
        """,
        body.template_id, body.workspace_id, user_id, body.cron_expr, next_run,
    )
    return {
        "id": str(row["id"]),
        "template_id": body.template_id,
        "cron_expr": body.cron_expr,
        "next_run_at": next_run.isoformat(),
        "enabled": True,
        "created_at": row["created_at"].isoformat(),
    }


@router.get("/schedules")
async def list_schedules(x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    rows = await db.fetch(
        """
        SELECT sp.id, sp.cron_expr, sp.next_run_at, sp.enabled, sp.created_at,
               pt.name AS template_name, pt.prompt AS template_prompt
        FROM scheduled_pipelines sp
        JOIN pipeline_templates pt ON pt.id = sp.template_id
        WHERE sp.created_by = $1
        ORDER BY sp.created_at DESC
        """,
        user_id,
    )
    return {
        "schedules": [
            {
                "id": str(r["id"]),
                "cron_expr": r["cron_expr"],
                "next_run_at": r["next_run_at"].isoformat() if r["next_run_at"] else None,
                "enabled": r["enabled"],
                "template_name": r["template_name"],
                "template_prompt": r["template_prompt"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
    }


@router.patch("/schedules/{schedule_id}")
async def toggle_schedule(
    schedule_id: str,
    enabled: bool,
    x_user_id: str | None = Header(None),
):
    user_id = _require_user(x_user_id)
    db = await get_db()
    result = await db.execute(
        "UPDATE scheduled_pipelines SET enabled=$1 WHERE id=$2 AND created_by=$3",
        enabled, schedule_id, user_id,
    )
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="schedule not found")
    return {"id": schedule_id, "enabled": enabled}


@router.delete("/schedules/{schedule_id}", status_code=204)
async def delete_schedule(schedule_id: str, x_user_id: str | None = Header(None)):
    user_id = _require_user(x_user_id)
    db = await get_db()
    await db.execute(
        "DELETE FROM scheduled_pipelines WHERE id=$1 AND created_by=$2",
        schedule_id, user_id,
    )
