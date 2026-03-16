import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import asyncpg
import structlog
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import make_asgi_app, Counter, Histogram

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    asyncio.create_task(_run_pipeline(pipeline_id, initial_state))

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

    stages = []
    for stage_name in stage_order:
        if stage_name in stage_statuses:
            stages.append({"name": stage_name, "status": stage_statuses[stage_name]})
        elif current_stage == stage_name:
            stages.append({"name": stage_name, "status": "running"})
        elif current_stage and stage_order.index(stage_name) < stage_order.index(current_stage):
            stages.append({"name": stage_name, "status": "completed"})
        else:
            stages.append({"name": stage_name, "status": "pending"})

    return {
        "id": pipeline_id,
        "pipeline_id": pipeline_id,
        "status": status,
        "current_stage": current_stage,
        "intent_type": result.get("intent_type") if isinstance(result, dict) else None,
        "stages": stages,
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
