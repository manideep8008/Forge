"""Centralized Ollama client wrapper for all agent LLM calls."""

import asyncio
import os
import time
import structlog
from ollama import AsyncClient

logger = structlog.get_logger()


class OllamaClient:
    """Wrapper around Ollama for easy model swapping and metrics."""

    def __init__(self):
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self._client: AsyncClient | None = None
        self._client_lock = asyncio.Lock()

    async def _get_client(self) -> AsyncClient:
        if self._client is None:
            async with self._client_lock:
                if self._client is None:
                    self._client = AsyncClient(host=self.base_url)
        return self._client

    async def generate(
        self,
        prompt: str,
        model: str,
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 16384,
        timeout: float = 300.0,
    ) -> dict:
        """Generate a completion from Ollama.

        Returns dict with 'response', 'tokens_used', 'duration_ms', 'model'.
        """
        start = time.monotonic()

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        fallback_model = os.getenv("MODEL_FALLBACK", "deepseek-v3.2:cloud")
        max_attempts = max(1, int(os.getenv("OLLAMA_MAX_ATTEMPTS", "3")))
        retry_base_seconds = max(0.1, float(os.getenv("OLLAMA_RETRY_BASE_SECONDS", "1.0")))
        models_to_try = [model]
        if model != fallback_model:
            models_to_try.append(fallback_model)

        last_error: Exception | None = None
        for attempt_model in models_to_try:
            for attempt in range(1, max_attempts + 1):
                attempt_start = time.monotonic()
                try:
                    client = await self._get_client()
                    response = await asyncio.wait_for(
                        client.chat(
                            model=attempt_model,
                            messages=messages,
                            options={
                                "temperature": temperature,
                                "num_predict": max_tokens,
                            },
                        ),
                        timeout=timeout,
                    )

                    duration_ms = int((time.monotonic() - attempt_start) * 1000)
                    tokens = getattr(response, "eval_count", 0) + getattr(response, "prompt_eval_count", 0)

                    if attempt_model != model:
                        logger.warning("ollama_fallback_used", primary=model, fallback=attempt_model)

                    logger.info(
                        "ollama_generate",
                        model=attempt_model,
                        attempt=attempt,
                        tokens=tokens,
                        duration_ms=duration_ms,
                    )

                    content = response.message.content or ""
                    if not content.strip():
                        thinking = getattr(response.message, "thinking", None) or getattr(response, "thinking", None) or ""
                        if thinking:
                            content = thinking

                    return {
                        "response": content,
                        "tokens_used": tokens,
                        "duration_ms": duration_ms,
                        "model": attempt_model,
                    }
                except Exception as e:
                    duration_ms = int((time.monotonic() - attempt_start) * 1000)
                    last_error = e
                    should_retry = attempt < max_attempts
                    logger.error(
                        "ollama_generate_error",
                        model=attempt_model,
                        attempt=attempt,
                        max_attempts=max_attempts,
                        will_retry=should_retry,
                        error=str(e),
                        duration_ms=duration_ms,
                    )
                    if should_retry:
                        await asyncio.sleep(min(retry_base_seconds * (2 ** (attempt - 1)), 8.0))

        raise last_error

    async def embed(self, text: str, model: str | None = None) -> list[float]:
        """Generate embeddings for text."""
        model = model or os.getenv("MODEL_EMBEDDING", "nomic-embed-text")
        # SDK v0.4.x uses .embed() and returns an EmbedResponse object
        client = await self._get_client()
        response = await client.embed(model=model, input=text)
        return response.embeddings[0]

    async def health(self) -> bool:
        """Check if Ollama is reachable."""
        try:
            client = await self._get_client()
            await client.list()
            return True
        except Exception:
            return False


# Singleton
ollama_client = OllamaClient()
