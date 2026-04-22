"""Background scheduler: fires due scheduled pipelines every 60 seconds."""
from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone

import structlog

from db import get_db

logger = structlog.get_logger()

_scheduler_task: asyncio.Task | None = None


async def _tick(create_pipeline_fn) -> None:
    """Find due schedules and fire a pipeline for each one."""
    try:
        from croniter import croniter  # type: ignore
    except ImportError:
        logger.warning("croniter_not_installed", msg="pip install croniter to enable scheduling")
        return

    try:
        pool = await get_db()
        now = datetime.now(timezone.utc)
        async with pool.acquire() as conn:
            pipelines_to_start = []

            async with conn.transaction():
                due = await conn.fetch(
                    """
                    SELECT sp.id, sp.cron_expr, sp.created_by, sp.workspace_id,
                           pt.prompt, pt.id AS template_id
                    FROM scheduled_pipelines sp
                    JOIN pipeline_templates pt ON pt.id = sp.template_id
                    WHERE sp.enabled = true AND sp.next_run_at <= $1
                    ORDER BY sp.next_run_at ASC
                    FOR UPDATE OF sp SKIP LOCKED
                    """,
                    now,
                )

                for row in due:
                    schedule_id = str(row["id"])
                    pipeline_id = str(uuid.uuid4())
                    user_id = str(row["created_by"])
                    workspace_id = str(row["workspace_id"]) if row["workspace_id"] else None
                    template_id = str(row["template_id"])
                    next_run = croniter(row["cron_expr"], now).get_next(datetime)
                    updated = await conn.execute(
                        """
                        UPDATE scheduled_pipelines
                        SET next_run_at = $1
                        WHERE id = $2
                        """,
                        next_run, schedule_id,
                    )
                    if updated != "UPDATE 1":
                        continue
                    await conn.execute(
                        """
                        INSERT INTO pipelines (id, user_id, input_text, status, workspace_id, template_id)
                        VALUES ($1, $2, $3, $4, $5, $6)
                        ON CONFLICT (id) DO NOTHING
                        """,
                        pipeline_id, user_id, row["prompt"], "pending", workspace_id, template_id,
                    )
                    pipelines_to_start.append({
                        "schedule_id": schedule_id,
                        "pipeline_id": pipeline_id,
                        "user_id": user_id,
                        "input_text": row["prompt"],
                        "workspace_id": workspace_id,
                        "template_id": template_id,
                        "next_run": next_run,
                    })

            for item in pipelines_to_start:
                logger.info(
                    "scheduler_firing",
                    schedule_id=item["schedule_id"],
                    pipeline_id=item["pipeline_id"],
                    next_run=item["next_run"].isoformat(),
                )
                await create_pipeline_fn(
                    pipeline_id=item["pipeline_id"],
                    user_id=item["user_id"],
                    input_text=item["input_text"],
                    workspace_id=item["workspace_id"],
                    template_id=item["template_id"],
                    pipeline_record_exists=True,
                )

    except Exception as exc:
        logger.error("scheduler_tick_error", error=str(exc))


async def _loop(create_pipeline_fn) -> None:
    interval_seconds = 60
    next_tick = asyncio.get_running_loop().time()
    while True:
        await _tick(create_pipeline_fn)
        next_tick += interval_seconds
        await asyncio.sleep(max(0, next_tick - asyncio.get_running_loop().time()))


def start(create_pipeline_fn) -> None:
    global _scheduler_task
    _scheduler_task = asyncio.create_task(_loop(create_pipeline_fn))
    logger.info("scheduler_started")


def stop() -> None:
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
    _scheduler_task = None
