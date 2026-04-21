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
        db = await get_db()
        now = datetime.now(timezone.utc)
        due = await db.fetch(
            """
            SELECT sp.id, sp.cron_expr, sp.created_by, sp.workspace_id,
                   pt.prompt, pt.id AS template_id
            FROM scheduled_pipelines sp
            JOIN pipeline_templates pt ON pt.id = sp.template_id
            WHERE sp.enabled = true AND sp.next_run_at <= $1
            """,
            now,
        )

        for row in due:
            schedule_id = str(row["id"])
            # Distributed lock via Redis would go here; for now use DB row update as lock
            next_run = croniter(row["cron_expr"], now).get_next(datetime)
            updated = await db.execute(
                """
                UPDATE scheduled_pipelines
                SET next_run_at = $1
                WHERE id = $2 AND next_run_at <= $3
                """,
                next_run, schedule_id, now,
            )
            if updated != "UPDATE 1":
                # Another instance already processed this row
                continue

            pipeline_id = str(uuid.uuid4())
            logger.info(
                "scheduler_firing",
                schedule_id=schedule_id,
                pipeline_id=pipeline_id,
                next_run=next_run.isoformat(),
            )
            await create_pipeline_fn(
                pipeline_id=pipeline_id,
                user_id=str(row["created_by"]),
                input_text=row["prompt"],
                workspace_id=str(row["workspace_id"]) if row["workspace_id"] else None,
                template_id=str(row["template_id"]),
            )

    except Exception as exc:
        logger.error("scheduler_tick_error", error=str(exc))


async def _loop(create_pipeline_fn) -> None:
    while True:
        await asyncio.sleep(60)
        await _tick(create_pipeline_fn)


def start(create_pipeline_fn) -> None:
    global _scheduler_task
    _scheduler_task = asyncio.create_task(_loop(create_pipeline_fn))
    logger.info("scheduler_started")


def stop() -> None:
    global _scheduler_task
    if _scheduler_task and not _scheduler_task.done():
        _scheduler_task.cancel()
    _scheduler_task = None
