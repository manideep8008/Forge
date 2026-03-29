import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncpg
import structlog
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import make_asgi_app, Counter, Histogram
from pydantic import BaseModel

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

logger = structlog.get_logger()

# Metrics
PIPELINE_COUNTER = Counter("forge_pipelines_total", "Total pipelines created", ["intent_type"])
PIPELINE_DURATION = Histogram("forge_pipeline_duration_seconds", "Pipeline execution duration", ["intent_type", "status"])

# Global DB pool
_db_pool: asyncpg.Pool | None = None

# Track running pipeline tasks so we can cancel them
_running_tasks: dict[str, "asyncio.Task"] = {}


async def get_db() -> asyncpg.Pool:
    """Return the asyncpg connection pool (lazy init)."""
    global _db_pool
    if _db_pool is None:
        import os
        postgres_url = os.getenv("POSTGRES_URL", "postgresql://forge:forge_dev_password@localhost:5432/forge")
        _db_pool = await asyncpg.create_pool(postgres_url, min_size=2, max_size=10)
    return _db_pool


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("forge_orchestrator_starting")
    try:
        await get_db()  # pre-warm the connection pool
        logger.info("postgres_connected")
    except Exception as e:
        logger.warning("postgres_unavailable", error=str(e))
    yield
    await context_manager.close()
    if _db_pool:
        await _db_pool.close()
    logger.info("forge_orchestrator_stopped")


app = FastAPI(
    title="Forge Orchestrator",
    version="1.0.0",
    description="AI-Powered SDLC Automation Platform",
    lifespan=lifespan,
)

import os
import os as _os
_cors_origins = [
    o.strip()
    for o in _os.getenv("CORS_ALLOWED_ORIGINS", "http://localhost:3000,http://localhost:8080").split(",")
    if o.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Prometheus metrics
metrics_app = make_asgi_app()
app.mount("/metrics", metrics_app)


@app.get("/health")
async def health():
    ollama_ok = await ollama_client.health()
    return {
        "status": "healthy",
        "ollama": "connected" if ollama_ok else "disconnected",
    }


@app.post("/pipeline", response_model=PipelineCreateResponse)
async def create_pipeline(request: PipelineCreateRequest):
    """Create and execute a new pipeline."""
    pipeline_id = str(uuid.uuid4())
    correlation_id = str(uuid.uuid4())

    logger.info(
        "pipeline_create",
        pipeline_id=pipeline_id,
        user_id=request.user_id,
        input_length=len(request.input_text),
    )

    # Initialize context
    await context_manager.set_many(pipeline_id, {
        "input_text": request.input_text,
        "user_id": request.user_id,
        "status": PipelineStatus.PENDING.value,
    })

    # Build initial state
    initial_state = PipelineState(
        pipeline_id=pipeline_id,
        user_id=request.user_id,
        correlation_id=correlation_id,
        input_text=request.input_text,
    )

    # Run pipeline asynchronously
    # In production, this would be dispatched to a task queue
    import asyncio

    def _pipeline_task_done(task: asyncio.Task):
        if task.cancelled():
            logger.warning("pipeline_task_cancelled", pipeline_id=pipeline_id)
        elif task.exception():
            logger.error(
                "pipeline_task_exception",
                pipeline_id=pipeline_id,
                error=str(task.exception()),
            )

    task = asyncio.create_task(_run_pipeline(pipeline_id, initial_state))
    task.add_done_callback(_pipeline_task_done)
    _running_tasks[pipeline_id] = task

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

        # Insert pipeline row in Postgres
        try:
            db = await get_db()
            await db.execute(
                """
                INSERT INTO pipelines (id, user_id, input_text, status)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (id) DO NOTHING
                """,
                pipeline_id, initial_state.user_id, initial_state.input_text,
                PipelineStatus.RUNNING.value,
            )
        except Exception as db_err:
            logger.warning("db_insert_failed", pipeline_id=pipeline_id, error=str(db_err))

        result = await pipeline.ainvoke(initial_state.model_dump())

        final_status = PipelineStatus.COMPLETED if result.get("current_stage") == "completed" else PipelineStatus.FAILED
        await context_manager.set(pipeline_id, "status", final_status.value)
        await context_manager.set(pipeline_id, "result", result)

        # Update pipeline row in Postgres
        try:
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
        except Exception as db_err:
            logger.warning("db_update_failed", pipeline_id=pipeline_id, error=str(db_err))

        logger.info(
            "pipeline_complete",
            pipeline_id=pipeline_id,
            status=final_status.value,
            total_tokens=result.get("total_tokens", 0),
        )

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
        except Exception:
            pass


@app.get("/pipeline/{pipeline_id}/status")
async def get_pipeline_status(pipeline_id: str):
    """Get pipeline status and stage information."""
    ctx = await context_manager.get_all(pipeline_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Pipeline not found")

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
        # deploy = completed only if both cicd and monitor completed
        cicd_status = stage_statuses.get("cicd", "pending")
        monitor_status = stage_statuses.get("monitor", "pending")
        if monitor_status == "completed":
            stage_statuses["deploy"] = "completed"
        elif cicd_status == "completed":
            stage_statuses["deploy"] = "running"
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
async def get_pipeline_result(pipeline_id: str):
    """Get full pipeline result including all agent outputs."""
    ctx = await context_manager.get_all(pipeline_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    return ctx


@app.post("/pipeline/{pipeline_id}/approve")
async def approve_pipeline(pipeline_id: str, request: HITLRequest):
    """Human-in-the-loop approval endpoint."""
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
async def delete_pipeline(pipeline_id: str):
    """Delete a pipeline — cancels if running, removes from DB and Redis."""
    # Cancel running task if any
    task = _running_tasks.pop(pipeline_id, None)
    if task and not task.done():
        task.cancel()

    # Clean up Docker containers
    try:
        import httpx
        docker_svc_url = os.getenv("DOCKER_SVC_URL", "http://forge-docker-svc:8082")
        async with httpx.AsyncClient(timeout=10) as client:
            await client.delete(f"{docker_svc_url}/docker/cleanup/{pipeline_id}")
    except Exception:
        pass

    # Remove from Redis
    await context_manager.delete(pipeline_id)

    # Remove from Postgres
    try:
        db = await get_db()
        await db.execute("DELETE FROM pipelines WHERE id = $1", pipeline_id)
    except Exception as e:
        logger.warning("db_delete_failed", pipeline_id=pipeline_id, error=str(e))

    await context_manager.publish_event(pipeline_id, "pipeline.deleted", {})
    logger.info("pipeline_deleted", pipeline_id=pipeline_id)
    return {"status": "ok", "pipeline_id": pipeline_id, "message": "Pipeline deleted"}


@app.post("/pipeline/{pipeline_id}/cancel")
async def cancel_pipeline(pipeline_id: str):
    """Cancel a running pipeline."""
    task = _running_tasks.pop(pipeline_id, None)
    if task and not task.done():
        task.cancel()

    await context_manager.set(pipeline_id, "status", PipelineStatus.CANCELLED.value)

    # Update Postgres
    try:
        db = await get_db()
        await db.execute(
            "UPDATE pipelines SET status = $1, completed_at = $2 WHERE id = $3",
            PipelineStatus.CANCELLED.value, datetime.now(timezone.utc), pipeline_id,
        )
    except Exception as e:
        logger.warning("db_cancel_failed", pipeline_id=pipeline_id, error=str(e))

    await context_manager.publish_event(pipeline_id, "pipeline.cancelled", {})
    logger.info("pipeline_cancelled", pipeline_id=pipeline_id)
    return {"status": "ok", "pipeline_id": pipeline_id, "message": "Pipeline cancelled"}


@app.post("/pipeline/{pipeline_id}/retry")
async def retry_pipeline(pipeline_id: str):
    """Retry a failed pipeline from the beginning."""
    ctx = await context_manager.get_all(pipeline_id)
    if not ctx:
        raise HTTPException(status_code=404, detail="Pipeline not found")

    input_text = ctx.get("input_text", "")
    user_id = ctx.get("user_id", "default-user")
    if not input_text:
        raise HTTPException(status_code=400, detail="No input_text found for pipeline")

    # Cancel existing task if still running
    task = _running_tasks.pop(pipeline_id, None)
    if task and not task.done():
        task.cancel()

    # Reset context
    await context_manager.set_many(pipeline_id, {
        "status": PipelineStatus.PENDING.value,
        "error": "",
        "result": {},
    })

    import asyncio
    initial_state = PipelineState(
        pipeline_id=pipeline_id,
        user_id=user_id,
        correlation_id=str(uuid.uuid4()),
        input_text=input_text,
    )
    new_task = asyncio.create_task(_run_pipeline(pipeline_id, initial_state))
    new_task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    _running_tasks[pipeline_id] = new_task


class ModifyPipelineRequest(BaseModel):
    message: str


@app.post("/pipeline/{pipeline_id}/modify")
async def modify_pipeline(pipeline_id: str, request: ModifyPipelineRequest):
    """Create an iteration pipeline that modifies an existing completed app.

    Fetches the generated files from the source pipeline, then runs a new
    pipeline starting at codegen (skipping requirements + architect) using a
    diff-aware prompt with only the files that need to change.
    """
    import asyncio

    if not request.message.strip():
        raise HTTPException(status_code=400, detail="message is required")

    # Fetch source pipeline context to get its generated files
    source_ctx = await context_manager.get_all(pipeline_id)
    if not source_ctx:
        raise HTTPException(status_code=404, detail="Source pipeline not found")

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
    user_id = source_ctx.get("user_id", "default-user")

    logger.info(
        "pipeline_modify",
        source_pipeline_id=pipeline_id,
        new_pipeline_id=new_pipeline_id,
        message=request.message[:100],
        file_count=len(existing_files),
    )

    # Initialise Redis context for the new pipeline
    await context_manager.set_many(new_pipeline_id, {
        "input_text": request.message,
        "user_id": user_id,
        "status": PipelineStatus.PENDING.value,
        "modification_request": request.message,
        "parent_pipeline_id": pipeline_id,
    })

    # Build state — pre-load existing files and skip requirements/architect
    # by setting spec/file_plan to empty dicts (codegen validate now accepts
    # modification_request + existing_files as a valid path).
    initial_state = PipelineState(
        pipeline_id=new_pipeline_id,
        user_id=user_id,
        correlation_id=str(uuid.uuid4()),
        input_text=request.message,
        modification_request=request.message,
        existing_files=existing_files,
        # Provide a minimal spec so downstream review/test agents still work
        spec={"title": request.message, "description": request.message},
        file_plan={"files_to_modify": list(existing_files.keys())[:10]},
    )

    def _done_cb(task: asyncio.Task):
        if task.cancelled():
            logger.warning("modify_task_cancelled", pipeline_id=new_pipeline_id)
        elif task.exception():
            logger.error("modify_task_exception", pipeline_id=new_pipeline_id, error=str(task.exception()))

    task = asyncio.create_task(_run_pipeline(new_pipeline_id, initial_state))
    task.add_done_callback(_done_cb)
    _running_tasks[new_pipeline_id] = task

    return {
        "pipeline_id": new_pipeline_id,
        "parent_pipeline_id": pipeline_id,
        "status": PipelineStatus.PENDING.value,
        "message": "Modification pipeline started",
    }


    # Update Postgres
    try:
        db = await get_db()
        await db.execute(
            "UPDATE pipelines SET status = $1, completed_at = NULL, error_message = NULL WHERE id = $2",
            PipelineStatus.PENDING.value, pipeline_id,
        )
    except Exception:
        pass

    await context_manager.publish_event(pipeline_id, "pipeline.retried", {})
    logger.info("pipeline_retried", pipeline_id=pipeline_id)
    return {"status": "ok", "pipeline_id": pipeline_id, "message": "Pipeline restarted"}


@app.get("/pipelines")
async def list_pipelines(limit: int = 20):
    """List recent pipelines from PostgreSQL."""
    try:
        db = await get_db()
        rows = await db.fetch(
            """
            SELECT id, user_id, status, intent_type, created_at, completed_at, error_message
            FROM pipelines
            ORDER BY created_at DESC
            LIMIT $1
            """,
            limit,
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
                }
                for r in rows
            ]
        }
    except Exception as e:
        logger.warning("list_pipelines_db_error", error=str(e))
        return {"pipelines": [], "error": "Database unavailable"}
