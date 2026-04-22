"""Shared asyncpg connection pool for the Forge orchestrator."""
from __future__ import annotations

import asyncio
import os

import asyncpg
import structlog

logger = structlog.get_logger()

_pool: asyncpg.Pool | None = None
_pool_lock = asyncio.Lock()


async def init_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                postgres_url = os.environ["POSTGRES_URL"]
                _pool = await asyncpg.create_pool(postgres_url, min_size=2, max_size=10)
                logger.info("postgres_pool_ready")
    return _pool


async def get_db() -> asyncpg.Pool:
    if _pool is None:
        await init_pool()
    assert _pool is not None
    return _pool


async def close_pool() -> None:
    global _pool
    async with _pool_lock:
        if _pool:
            await _pool.close()
            _pool = None
