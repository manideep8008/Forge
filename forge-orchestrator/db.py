"""Shared asyncpg connection pool for the Forge orchestrator."""
from __future__ import annotations

import os

import asyncpg
import structlog

logger = structlog.get_logger()

_pool: asyncpg.Pool | None = None


async def init_pool() -> asyncpg.Pool:
    global _pool
    postgres_url = os.getenv(
        "POSTGRES_URL",
        "postgresql://forge:forge_dev_password@localhost:5432/forge",
    )
    _pool = await asyncpg.create_pool(postgres_url, min_size=2, max_size=10)
    logger.info("postgres_pool_ready")
    return _pool


async def get_db() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        await init_pool()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool:
        await _pool.close()
        _pool = None
