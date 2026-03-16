"""Redis-backed context manager for agent shared state."""

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

    async def _get_redis(self) -> redis.Redis:
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
        serialized = json.dumps(value) if not isinstance(value, str) else value
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
        serialized = {
            k: json.dumps(v) if not isinstance(v, str) else v
            for k, v in data.items()
        }
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

    async def close(self) -> None:
        if self._redis:
            await self._redis.close()


# Singleton
context_manager = ContextManager()
