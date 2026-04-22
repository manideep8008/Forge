import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import structlog
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request

from pydantic import BaseModel

from db import get_db, init_pool, close_pool
from internal_auth import internal_api_headers, require_internal_api_key
from models.schemas import (
    PipelineCreateRequest,
    PipelineCreateResponse,
    PipelineStatusResponse,
    PipelineStatus,
    HITLRequest,
)
from graph.pipeline import pipeline
from graph.state import PipelineState
from services.context_manager import context_manager
from services.ollama_client import ollama_client
from routers import workspaces, comments, templates
from routers import scheduler as sched

logger = structlog.get_logger()

# Track running pipeline tasks so we can cancel them and enforce user limits.
_running_tasks: dict[str, asyncio.Task] = {}
_task_users: dict[str, str] = {}
_starting_pipelines: set[str] = set()
_tasks_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("forge_orchestrator_starting")
    try:
        await init_pool()
        logger.info("postgres_connected")
    except Exception as e:
        logger.warning("postgres_unavailable", error=str(e))
    sched.start(_create_pipeline_from_schedule)
    yield
    sched.stop()
    await context_manager.close()
    await close_pool()
    logger.info("forge_orchestrator_stopped")


app = FastAPI(
    title="Forge Orchestrator",
    version="1.0.0",
    description="AI-Powered SDLC Automation Platform",
    lifespan=lifespan,
)

app.middleware("http")(require_internal_api_key)

app.include_router(workspaces)
app.include_router(comments)
app.include_router(templates)

MAX_PIPELINES_PER_USER = int(os.getenv("MAX_PIPELINES_PER_USER", "10"))
MAX_LIST_LIMIT = 100

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
}


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    for header, value in SECURITY_HEADERS.items():
        response.headers.setdefault(header, value)
    return response


def _active_tasks_for_user_locked(user_id: str) -> int:
    running = sum(
        1
        for pipeline_id, task in _running_tasks.items()
        if _task_users.get(pipeline_id) == user_id and not task.done()
    )
    starting = sum(1 for pipeline_id in _starting_pipelines if _task_users.get(pipeline_id) == user_id)
    return running + starting


async def _reserve_pipeline_slot(pipeline_id: str, user_id: str) -> None:
    async with _tasks_lock:
        if _active_tasks_for_user_locked(user_id) >= MAX_PIPELINES_PER_USER:
            raise HTTPException(
                status_code=429,
                detail=(
                    "Too many active pipelines. "
                    f"Maximum {MAX_PIPELINES_PER_USER} concurrent pipelines allowed."
                ),
            )

        _starting_pipelines.add(pipeline_id)
        _task_users[pipeline_id] = user_id


async def _release_pipeline_slot(pipeline_id: str) -> asyncio.Task | None:
    async with _tasks_lock:
        task = _running_tasks.pop(pipeline_id, None)
        _starting_pipelines.discard(pipeline_id)
        _task_users.pop(pipeline_id, None)
        return task


def _pipeline_task_done(pipeline_id: str, task: asyncio.Task) -> None:
    asyncio.create_task(_release_pipeline_slot(pipeline_id))

    if task.cancelled():
        logger.warning("pipeline_task_cancelled", pipeline_id=pipeline_id)
        return

    exc = task.exception()
    if exc is not None:
        logger.error(
            "pipeline_task_exception",
            pipeline_id=pipeline_id,
            error=str(exc),
        )


async def _launch_reserved_pipeline(pipeline_id: str, initial_state: PipelineState) -> None:
    async with _tasks_lock:
        task = asyncio.create_task(_run_pipeline(pipeline_id, initial_state))
        task.add_done_callback(lambda finished_task, pid=pipeline_id: _pipeline_task_done(pid, finished_task))
        _starting_pipelines.discard(pipeline_id)
        _running_tasks[pipeline_id] = task


async def _cancel_tracked_pipeline(pipeline_id: str) -> None:
    task = await _release_pipeline_slot(pipeline_id)
    if task and not task.done():
        task.cancel()


def require_user_id(x_user_id: str | None = Header(default=None, alias="X-User-ID")) -> str:
    """Require the gateway-provided authenticated user id."""
    if not x_user_id or not x_user_id.strip():
        raise HTTPException(status_code=401, detail="authentication required")
    return x_user_id.strip()


async def _create_pipeline_record(
    pipeline_id: str,
    user_id: str,
    input_text: str,
    *,
    status: PipelineStatus = PipelineStatus.PENDING,
    parent_pipeline_id: str | None = None,
    workspace_id: str | None = None,
    template_id: str | None = None,
) -> None:
    pool = await get_db()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            """
            INSERT INTO pipelines (id, user_id, input_text, status, parent_pipeline_id, workspace_id, template_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (id) DO NOTHING
            """,
            pipeline_id, user_id, input_text, status.value,
            parent_pipeline_id, workspace_id, template_id,
        )


async def _mark_pipeline_running(pipeline_id: str, initial_state: PipelineState) -> None:
    pool = await get_db()
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute(
            """
            INSERT INTO pipelines (id, user_id, input_text, status, parent_pipeline_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (id) DO NOTHING
            """,
            pipeline_id, initial_state.user_id, initial_state.input_text,
            PipelineStatus.RUNNING.value, initial_state.parent_pipeline_id,
        )
        await conn.execute(
            "UPDATE pipelines SET status = $1 WHERE id = $2",
            PipelineStatus.RUNNING.value, pipeline_id,
        )


async def _delete_pipeline_record(pipeline_id: str) -> None:
    try:
        pool = await get_db()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("DELETE FROM pipelines WHERE id = $1", pipeline_id)
    except Exception as db_err:
        logger.warning("db_start_cleanup_failed", pipeline_id=pipeline_id, error=str(db_err))


async def _mark_pipeline_start_failed(pipeline_id: str, error: Exception) -> None:
    try:
        pool = await get_db()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "UPDATE pipelines SET status = $1, error_message = $2, completed_at = $3 WHERE id = $4",
                PipelineStatus.FAILED.value, str(error), datetime.now(timezone.utc), pipeline_id,
            )
    except Exception as db_err:
        logger.warning("db_start_failed_update_failed", pipeline_id=pipeline_id, error=str(db_err))


async def _cleanup_failed_pipeline_start(pipeline_id: str) -> None:
    await _release_pipeline_slot(pipeline_id)
    try:
        await context_manager.delete(pipeline_id)
    except Exception as redis_err:
        logger.warning("redis_start_cleanup_failed", pipeline_id=pipeline_id, error=str(redis_err))
    await _delete_pipeline_record(pipeline_id)


async def _get_owned_pipeline_context(pipeline_id: str, user_id: str) -> dict:
    """Return pipeline context only when user_id owns it."""
    ctx = await context_manager.get_all(pipeline_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Pipeline not found")

    if ctx.get("user_id") != user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    return ctx


@app.get("/health")
async def health():
    ollama_ok = await ollama_client.health()
    return {
        "status": "healthy",
        "ollama": "connected" if ollama_ok else "disconnected",
    }


async def _verify_pipeline_owner(pipeline_id: str, user_id: str) -> None:
    """Raise HTTP 403 if user_id does not own the pipeline."""
    await _get_owned_pipeline_context(pipeline_id, user_id)


@app.post("/pipeline", response_model=PipelineCreateResponse)
async def create_pipeline(
    request: PipelineCreateRequest,
    user_id: str = Depends(require_user_id),
):
    """Create and execute a new pipeline."""
    pipeline_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())

    logger.info(
        "pipeline_create",
        pipeline_id=pipeline_id,
        user_id=user_id,
        input_length=len(request.input_text),
    )

    await _reserve_pipeline_slot(pipeline_id, user_id)
    try:
        await _create_pipeline_record(pipeline_id, user_id, request.input_text)
        await context_manager.set_many(pipeline_id, {
            "input_text": request.input_text,
            "user_id": user_id,
            "status": PipelineStatus.PENDING.value,
        })

        initial_state = PipelineState(
            pipeline_id=pipeline_id,
            user_id=user_id,
            correlation_id=correlation_id,
            input_text=request.input_text,
        )

        await _launch_reserved_pipeline(pipeline_id, initial_state)
    except Exception:
        await _cleanup_failed_pipeline_start(pipeline_id)
        raise

    return PipelineCreateResponse(
        pipeline_id=pipeline_id,
        status=PipelineStatus.PENDING,
        message="Pipeline created and execution started",
    )


async def _run_pipeline(pipeline_id: str, initial_state: PipelineState):
    """Execute the LangGraph pipeline."""
    start_time = datetime.now(timezone.utc)
    try:
        await context_manager.set(pipeline_id, "status", PipelineStatus.RUNNING.value)
        await context_manager.publish_event(pipeline_id, "pipeline.started", {})

        # Ensure the Postgres row exists and reflects that execution has started.
        await _mark_pipeline_running(pipeline_id, initial_state)

        result = await pipeline.ainvoke(initial_state.model_dump(mode="python"))

        final_status = PipelineStatus.COMPLETED if result.get("current_stage") == "completed" else PipelineStatus.FAILED
        await context_manager.set(pipeline_id, "status", final_status.value)
        await context_manager.set(pipeline_id, "result", result)

        # Update pipeline row in Postgres
        db = await get_db()
        await db.execute(
            """
            UPDATE pipelines
            SET status = $1, intent_type = $2, completed_at = $3
            WHERE id = $4
            """,
            final_status.value,
            result.get("intent_type"),
            datetime.now(timezone.utc),
            pipeline_id,
        )

        logger.info(
            "pipeline_complete",
            pipeline_id=pipeline_id,
            status=final_status.value,
            total_tokens=result.get("total_tokens", 0),
        )

    except asyncio.CancelledError:
        raise
    except Exception as e:
        logger.error("pipeline_error", pipeline_id=pipeline_id, error=str(e))
        await context_manager.set(pipeline_id, "status", PipelineStatus.FAILED.value)
        await context_manager.set(pipeline_id, "error", str(e))
        try:
            db = await get_db()
            await db.execute(
                "UPDATE pipelines SET status = $1, error_message = $2, completed_at = $3 WHERE id = $4",
                PipelineStatus.FAILED.value, str(e), datetime.now(timezone.utc), pipeline_id,
            )
        except Exception as db_err:
            logger.warning("db_error_update_failed", pipeline_id=pipeline_id, error=str(db_err))


@app.get("/pipeline/{pipeline_id}/status")
async def get_pipeline_status(
    pipeline_id: str,
    user_id: str = Depends(require_user_id),
):
    """Get pipeline status and stage information."""
    ctx = await _get_owned_pipeline_context(pipeline_id, user_id)

    result = ctx.get("result", {})
    current_stage = ctx.get("current_stage", None)
    status = ctx.get("status", "pending")

    # Build stage list from context
    stage_order = ["requirements", "architect", "codegen", "review", "test", "hitl", "deploy"]
    stage_statuses = {}
    if isinstance(result, dict):
        stage_statuses = result.get("stage_status", {})

    # Map internal stage names (cicd, monitor) to UI stage name (deploy)
    if "cicd" in stage_statuses or "monitor" in stage_statuses:
        cicd_status = stage_statuses.get("cicd", "pending")
        monitor_status = stage_statuses.get("monitor", "pending")
        if cicd_status == "failed":
            stage_statuses["deploy"] = "failed"
        elif monitor_status == "completed" or cicd_status == "completed":
            stage_statuses["deploy"] = "completed"
        elif cicd_status == "running" or monitor_status == "running":
            stage_statuses["deploy"] = "running"

    # Map internal current_stage names to UI names
    ui_current_stage = current_stage
    if current_stage in ("cicd", "monitor"):
        ui_current_stage = "deploy"
    elif current_stage == "classify":
        ui_current_stage = "requirements"

    stages = []
    for stage_name in stage_order:
        if stage_name in stage_statuses:
            stages.append({"name": stage_name, "status": stage_statuses[stage_name]})
        elif ui_current_stage == stage_name:
            stages.append({"name": stage_name, "status": "running"})
        elif ui_current_stage and ui_current_stage in stage_order and stage_order.index(stage_name) < stage_order.index(ui_current_stage):
            stages.append({"name": stage_name, "status": "completed"})
        else:
            stages.append({"name": stage_name, "status": "pending"})

    # Collect agent outputs from context (individual keys stored during execution)
    # AND from result (full state stored after pipeline completes)
    agents = []

    # Merge: ctx has live intermediate data, result has final state
    merged = dict(ctx)
    if isinstance(result, dict):
        merged.update(result)

    # Requirements spec
    spec = merged.get("spec")
    if spec:
        agents.append({
            "agent": "requirements",
            "stage": "requirements",
            "status": "completed",
            "output": spec,
        })
    # Architecture decisions & file plan
    arch = merged.get("architecture_decisions")
    file_plan = merged.get("file_plan")
    if arch or file_plan:
        agents.append({
            "agent": "architect",
            "stage": "architect",
            "status": "completed",
            "output": {
                "architecture_decisions": arch,
                "file_plan": file_plan,
            },
        })
    # Generated code / files
    generated = merged.get("generated_files") or merged.get("generated_code")
    if generated:
        agents.append({
            "agent": "codegen",
            "stage": "codegen",
            "status": "completed",
            "output": generated,
        })
    # Review feedback
    review = merged.get("review_issues") or merged.get("review_feedback")
    if review:
        agents.append({
            "agent": "review",
            "stage": "review",
            "status": "completed",
            "output": review,
        })
    # Test results
    tests = merged.get("test_results") or merged.get("tests")
    if tests:
        agents.append({
            "agent": "test",
            "stage": "test",
            "status": "completed",
            "output": tests,
        })
    # CI/CD deployment info
    docker_image = merged.get("docker_image")
    deploy_url = merged.get("deploy_url")
    if docker_image or deploy_url:
        agents.append({
            "agent": "deploy",
            "stage": "deploy",
            "status": "completed",
            "output": {
                "docker_image": docker_image,
                "deploy_url": deploy_url,
                "summary": "Application built and deployed successfully",
            },
        })
    # Monitor / health status
    health_status = merged.get("health_status")
    if health_status:
        agents.append({
            "agent": "monitor",
            "stage": "deploy",
            "status": "completed",
            "output": {"health_status": health_status},
        })

    return {
        "id": pipeline_id,
        "pipeline_id": pipeline_id,
        "status": status,
        "current_stage": ui_current_stage,
        "intent_type": result.get("intent_type") if isinstance(result, dict) else None,
        "stages": stages,
        "agents": agents,
        "error_message": ctx.get("error"),
        "description": ctx.get("input_text", ""),
    }


@app.get("/pipeline/{pipeline_id}/result")
async def get_pipeline_result(
    pipeline_id: str,
    user_id: str = Depends(require_user_id),
):
    """Get full pipeline result including all agent outputs."""
    return await _get_owned_pipeline_context(pipeline_id, user_id)


@app.post("/pipeline/{pipeline_id}/approve")
async def approve_pipeline(
    pipeline_id: str,
    request: HITLRequest,
    user_id: str = Depends(require_user_id),
):
    """Human-in-the-loop approval endpoint."""
    await _verify_pipeline_owner(pipeline_id, user_id)
    await context_manager.set_many(pipeline_id, {
        "hitl_decision": request.decision.value,
        "hitl_comments": request.comments or "",
    })
    await context_manager.publish_event(pipeline_id, "pipeline.hitl_decision", {
        "decision": request.decision.value,
        "comments": request.comments,
    })
    return {"status": "ok", "decision": request.decision.value}


@app.delete("/pipeline/{pipeline_id}")
async def delete_pipeline(
    pipeline_id: str,
    user_id: str = Depends(require_user_id),
):
    """Delete a pipeline — cancels if running, removes from DB and Redis."""
    await _verify_pipeline_owner(pipeline_id, user_id)
    await _cancel_tracked_pipeline(pipeline_id)

    # Clean up Docker containers
    try:
        import httpx
        docker_svc_url = os.getenv("DOCKER_SVC_URL", "http://forge-docker-svc:8082")
        async with httpx.AsyncClient(timeout=10) as client:
            await client.delete(
                f"{docker_svc_url}/docker/cleanup/{pipeline_id}",
                headers=internal_api_headers(),
            )
    except Exception:
        pass

    # Remove from Redis
    await context_manager.delete(pipeline_id)

    # Remove from Postgres
    try:
        db = await get_db()
        await db.execute("DELETE FROM pipelines WHERE id = $1", pipeline_id)
    except Exception as db_err:
        logger.warning("db_delete_failed", pipeline_id=pipeline_id, error=str(db_err))

    await context_manager.publish_event(pipeline_id, "pipeline.deleted", {})
    logger.info("pipeline_deleted", pipeline_id=pipeline_id)
    return {"status": "ok", "pipeline_id": pipeline_id, "message": "Pipeline deleted"}


@app.post("/pipeline/{pipeline_id}/cancel")
async def cancel_pipeline(
    pipeline_id: str,
    user_id: str = Depends(require_user_id),
):
    """Cancel a running pipeline."""
    await _verify_pipeline_owner(pipeline_id, user_id)
    await _cancel_tracked_pipeline(pipeline_id)

    await context_manager.set(pipeline_id, "status", PipelineStatus.CANCELLED.value)

    # Update Postgres
    try:
        db = await get_db()
        await db.execute(
            "UPDATE pipelines SET status = $1, completed_at = $2 WHERE id = $3",
            PipelineStatus.CANCELLED.value, datetime.now(timezone.utc), pipeline_id,
        )
    except Exception as db_err:
        logger.warning("db_cancel_failed", pipeline_id=pipeline_id, error=str(db_err))

    await context_manager.publish_event(pipeline_id, "pipeline.cancelled", {})
    logger.info("pipeline_cancelled", pipeline_id=pipeline_id)
    return {"status": "ok", "pipeline_id": pipeline_id, "message": "Pipeline cancelled"}


@app.post("/pipeline/{pipeline_id}/retry")
async def retry_pipeline(
    pipeline_id: str,
    user_id: str = Depends(require_user_id),
):
    """Retry a failed pipeline from the beginning."""
    ctx = await _get_owned_pipeline_context(pipeline_id, user_id)

    input_text = ctx.get("input_text", "")
    if not input_text:
        raise HTTPException(status_code=400, detail="No input_text found for pipeline")

    await _cancel_tracked_pipeline(pipeline_id)
    await _reserve_pipeline_slot(pipeline_id, user_id)
    try:
        await context_manager.set_many(pipeline_id, {
            "status": PipelineStatus.PENDING.value,
            "error": "",
            "result": {},
        })

        initial_state = PipelineState(
            pipeline_id=pipeline_id,
            user_id=user_id,
            correlation_id=str(uuid.uuid4()),
            input_text=input_text,
        )
        await _launch_reserved_pipeline(pipeline_id, initial_state)
    except Exception:
        await _release_pipeline_slot(pipeline_id)
        raise

    # Persist retry in Postgres
    try:
        db = await get_db()
        await db.execute(
            "UPDATE pipelines SET status = $1, completed_at = NULL, error_message = NULL WHERE id = $2",
            PipelineStatus.PENDING.value, pipeline_id,
        )
    except Exception as db_err:
        logger.warning("db_retry_update_failed", pipeline_id=pipeline_id, error=str(db_err))

    await context_manager.publish_event(pipeline_id, "pipeline.retried", {})
    logger.info("pipeline_retried", pipeline_id=pipeline_id)
    return {"status": "ok", "pipeline_id": pipeline_id, "message": "Pipeline restarted"}


class ModifyPipelineRequest(BaseModel):
    message: str


@app.post("/pipeline/{pipeline_id}/modify")
async def modify_pipeline(
    pipeline_id: str,
    request: ModifyPipelineRequest,
    user_id: str = Depends(require_user_id),
):
    """Create an iteration pipeline that modifies an existing completed app.

    Fetches the generated files from the source pipeline, then runs a new
    pipeline starting at codegen (skipping requirements + architect) using a
    diff-aware prompt with only the files that need to change.
    """
    if not request.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    # Fetch source pipeline context to get its generated files
    source_ctx = await _get_owned_pipeline_context(pipeline_id, user_id)

    result_data = source_ctx.get("result", {})
    existing_files: dict = {}
    if isinstance(result_data, dict):
        existing_files = result_data.get("generated_files", {})

    # Also check top-level context key (set by codegen_node)
    if not existing_files:
        existing_files = source_ctx.get("generated_files", {})

    if not existing_files:
        raise HTTPException(
            status_code=422,
            detail="Source pipeline has no generated files to modify. Wait until codegen completes.",
        )

    # Create a new pipeline for this modification run
    new_pipeline_id = str(uuid.uuid4())

    all_file_paths = list(existing_files.keys())
    files_to_modify = all_file_paths[:10]
    if len(all_file_paths) > len(files_to_modify):
        logger.warning(
            "pipeline_modify_file_plan_truncated",
            source_pipeline_id=pipeline_id,
            new_pipeline_id=new_pipeline_id,
            total_file_count=len(all_file_paths),
            included_file_count=len(files_to_modify),
            omitted_file_count=len(all_file_paths) - len(files_to_modify),
        )

    logger.info(
        "pipeline_modify",
        source_pipeline_id=pipeline_id,
        new_pipeline_id=new_pipeline_id,
        message=request.message[:100],
        file_count=len(existing_files),
    )

    await _reserve_pipeline_slot(new_pipeline_id, user_id)
    try:
        await _create_pipeline_record(
            new_pipeline_id,
            user_id,
            request.message,
            parent_pipeline_id=pipeline_id,
        )
        await context_manager.set_many(new_pipeline_id, {
            "input_text": request.message,
            "user_id": user_id,
            "status": PipelineStatus.PENDING.value,
            "modification_request": request.message,
            "parent_pipeline_id": pipeline_id,
        })

        initial_state = PipelineState(
            pipeline_id=new_pipeline_id,
            user_id=user_id,
            correlation_id=str(uuid.uuid4()),
            input_text=request.message,
            modification_request=request.message,
            existing_files=existing_files,
            parent_pipeline_id=pipeline_id,
            # Provide a minimal spec so downstream review/test agents still work
            spec={"title": request.message, "description": request.message},
            file_plan={"files_to_modify": files_to_modify},
        )
        await _launch_reserved_pipeline(new_pipeline_id, initial_state)
    except Exception:
        await _cleanup_failed_pipeline_start(new_pipeline_id)
        raise

    return {
        "pipeline_id": new_pipeline_id,
        "parent_pipeline_id": pipeline_id,
        "status": PipelineStatus.PENDING.value,
        "message": "Modification pipeline started",
    }


@app.post("/pipeline/{pipeline_id}/fork")
async def fork_pipeline(
    pipeline_id: str,
    user_id: str = Depends(require_user_id),
):
    """Fork a completed pipeline — starts a fresh pipeline with the same input."""
    source_ctx = await _get_owned_pipeline_context(pipeline_id, user_id)

    input_text = source_ctx.get("input_text", "")
    if not input_text:
        raise HTTPException(status_code=422, detail="source pipeline has no input_text")

    # Optionally pre-load generated files so the fork starts from existing code
    result_data = source_ctx.get("result", {})
    existing_files: dict = {}
    if isinstance(result_data, dict):
        existing_files = result_data.get("generated_files", {})
    if not existing_files:
        existing_files = source_ctx.get("generated_files", {})

    new_pipeline_id = str(uuid.uuid4())
    logger.info("pipeline_fork", source=pipeline_id, new=new_pipeline_id)

    await _reserve_pipeline_slot(new_pipeline_id, user_id)
    try:
        await _create_pipeline_record(
            new_pipeline_id,
            user_id,
            input_text,
            parent_pipeline_id=pipeline_id,
        )
        await context_manager.set_many(new_pipeline_id, {
            "input_text": input_text,
            "user_id": user_id,
            "status": PipelineStatus.PENDING.value,
            "parent_pipeline_id": pipeline_id,
        })

        initial_state = PipelineState(
            pipeline_id=new_pipeline_id,
            user_id=user_id,
            correlation_id=str(uuid.uuid4()),
            input_text=input_text,
            existing_files=existing_files or {},
            parent_pipeline_id=pipeline_id,
        )
        await _launch_reserved_pipeline(new_pipeline_id, initial_state)
    except Exception:
        await _cleanup_failed_pipeline_start(new_pipeline_id)
        raise

    return {
        "pipeline_id": new_pipeline_id,
        "source_pipeline_id": pipeline_id,
        "status": PipelineStatus.PENDING.value,
        "message": "Fork pipeline started",
    }


async def _create_pipeline_from_schedule(
    pipeline_id: str,
    user_id: str,
    input_text: str,
    workspace_id: str | None = None,
    template_id: str | None = None,
    pipeline_record_exists: bool = False,
) -> None:
    """Called by the background scheduler to fire a pipeline from a template."""
    try:
        await _reserve_pipeline_slot(pipeline_id, user_id)
    except HTTPException as exc:
        logger.warning(
            "scheduled_pipeline_skipped",
            pipeline_id=pipeline_id,
            user_id=user_id,
            error=exc.detail,
        )
        if pipeline_record_exists:
            await _mark_pipeline_start_failed(pipeline_id, exc)
        return

    try:
        if not pipeline_record_exists:
            await _create_pipeline_record(
                pipeline_id,
                user_id,
                input_text,
                workspace_id=workspace_id,
                template_id=template_id,
            )
        await context_manager.set_many(pipeline_id, {
            "input_text": input_text,
            "user_id": user_id,
            "status": PipelineStatus.PENDING.value,
        })
        initial_state = PipelineState(
            pipeline_id=pipeline_id,
            user_id=user_id,
            correlation_id=str(uuid.uuid4()),
            input_text=input_text,
        )
        await _launch_reserved_pipeline(pipeline_id, initial_state)
    except Exception as exc:
        await _release_pipeline_slot(pipeline_id)
        try:
            await context_manager.delete(pipeline_id)
        except Exception as redis_err:
            logger.warning("redis_scheduled_start_cleanup_failed", pipeline_id=pipeline_id, error=str(redis_err))
        if pipeline_record_exists:
            await _mark_pipeline_start_failed(pipeline_id, exc)
        else:
            await _delete_pipeline_record(pipeline_id)
        logger.error("scheduled_pipeline_start_failed", pipeline_id=pipeline_id, error=str(exc))
        return


@app.get("/pipelines")
async def list_pipelines(
    user_id: str = Depends(require_user_id),
    limit: int = Query(default=20, ge=1, le=MAX_LIST_LIMIT),
):
    """List recent pipelines for the authenticated user."""
    try:
        db = await get_db()
        rows = await db.fetch(
            """
            SELECT id, user_id, status, intent_type, created_at, completed_at, error_message, parent_pipeline_id, input_text
            FROM pipelines
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            user_id, limit,
        )
        return {
            "pipelines": [
                {
                    "id": str(r["id"]),
                    "pipeline_id": str(r["id"]),
                    "user_id": r["user_id"],
                    "status": r["status"],
                    "intent_type": r["intent_type"],
                    "created_at": r["created_at"].isoformat() if r["created_at"] else None,
                    "completed_at": r["completed_at"].isoformat() if r["completed_at"] else None,
                    "error_message": r["error_message"],
                    "parent_pipeline_id": str(r["parent_pipeline_id"]) if r["parent_pipeline_id"] else None,
                    "input_text": r["input_text"],
                }
                for r in rows
            ]
        }
    except Exception as e:
        logger.warning("list_pipelines_db_error", error=str(e))
        return {"pipelines": [], "error": "Database unavailable"}
