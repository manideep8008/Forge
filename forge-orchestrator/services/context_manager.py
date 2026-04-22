"""Redis-backed context manager for agent shared state."""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

import redis.asyncio as redis
import structlog

logger = structlog.get_logger()

CONTEXT_TTL = 86400  # 24 hours


class ContextManager:
    """Manages agent shared context in Redis hashes."""

    def __init__(self):
        self.redis_url = os.getenv("REDIS_URL", "redis://localhost:6379")
        self._redis: redis.Redis | None = None
        self._redis_lock = asyncio.Lock()

    async def _get_redis(self) -> redis.Redis:
        if self._redis is None:
            async with self._redis_lock:
                if self._redis is None:
                    self._redis = redis.from_url(self.redis_url, decode_responses=True)
        return self._redis

    def _key(self, pipeline_id: str) -> str:
        return f"ctx:{pipeline_id}"

    async def get(self, pipeline_id: str, field: str) -> Any | None:
        """Get a single field from pipeline context."""
        r = await self._get_redis()
        val = await r.hget(self._key(pipeline_id), field)
        if val is None:
            return None
        try:
            return json.loads(val)
        except (json.JSONDecodeError, TypeError):
            return val

    async def set(self, pipeline_id: str, field: str, value: Any) -> None:
        """Set a single field in pipeline context."""
        r = await self._get_redis()
        key = self._key(pipeline_id)
        serialized = json.dumps(value)
        await r.hset(key, field, serialized)
        await r.expire(key, CONTEXT_TTL)

    async def get_all(self, pipeline_id: str) -> dict[str, Any]:
        """Get entire pipeline context."""
        r = await self._get_redis()
        raw = await r.hgetall(self._key(pipeline_id))
        result = {}
        for k, v in raw.items():
            try:
                result[k] = json.loads(v)
            except (json.JSONDecodeError, TypeError):
                result[k] = v
        return result

    async def set_many(self, pipeline_id: str, data: dict[str, Any]) -> None:
        """Set multiple fields in pipeline context."""
        r = await self._get_redis()
        key = self._key(pipeline_id)
        serialized = {k: json.dumps(v) for k, v in data.items()}
        await r.hset(key, mapping=serialized)
        await r.expire(key, CONTEXT_TTL)

    async def delete(self, pipeline_id: str) -> None:
        """Delete entire pipeline context."""
        r = await self._get_redis()
        await r.delete(self._key(pipeline_id))

    async def publish_event(self, pipeline_id: str, event_type: str, payload: dict) -> None:
        """Publish event to Redis pub/sub for WebSocket fanout."""
        r = await self._get_redis()
        event = json.dumps({
            "pipeline_id": pipeline_id,
            "event_type": event_type,
            "payload": payload,
        })
        await r.publish(f"ws:{pipeline_id}", event)

    async def wait_for_field(
        self,
        pipeline_id: str,
        field: str,
        expected_values: set[str],
        timeout: int = 3600,
        poll_fallback: int = 10,
    ) -> str | None:
        """Wait for a Redis hash field to match one of the expected values.

        Uses pub/sub on the ``ws:{pipeline_id}`` channel for instant wake-up,
        with a slow poll fallback every *poll_fallback* seconds in case the
        pub/sub message was missed.

        Returns the matched value, or ``None`` on timeout.
        """
        import asyncio

        r = await self._get_redis()
        pubsub = r.pubsub()
        channel = f"ws:{pipeline_id}"
        await pubsub.subscribe(channel)

        async def _cleanup_pubsub() -> None:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

        def _log_cleanup_result(task: asyncio.Task) -> None:
            try:
                exc = task.exception()
            except asyncio.CancelledError as cancel_err:
                exc = cancel_err
            if exc:
                logger.warning(
                    "pubsub_cleanup_failed",
                    pipeline_id=pipeline_id,
                    error=str(exc),
                )

        deadline = asyncio.get_running_loop().time() + timeout
        try:
            while asyncio.get_running_loop().time() < deadline:
                # Check current value first (covers race where value was set
                # before we subscribed).
                current = await self.get(pipeline_id, field)
                if current and current in expected_values:
                    return current

                # Wait for a pub/sub message or fall back after poll_fallback seconds.
                remaining = deadline - asyncio.get_running_loop().time()
                wait_time = min(poll_fallback, remaining)
                if wait_time <= 0:
                    break

                try:
                    msg = await asyncio.wait_for(
                        pubsub.get_message(ignore_subscribe_messages=True, timeout=wait_time),
                        timeout=wait_time + 1,
                    )
                except asyncio.TimeoutError:
                    pass  # Fall through to re-check the field.
        finally:
            cleanup_task = asyncio.create_task(_cleanup_pubsub())
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                cleanup_task.add_done_callback(_log_cleanup_result)
                raise

        # Final check after timeout.
        current = await self.get(pipeline_id, field)
        if current and current in expected_values:
            return current
        return None

    async def close(self) -> None:
        if self._redis:
            await self._redis.close()


# Singleton
context_manager = ContextManager()
