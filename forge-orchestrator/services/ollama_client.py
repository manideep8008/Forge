"""Centralized Ollama client wrapper for all agent LLM calls."""

import os
import time
import structlog
from ollama import AsyncClient

logger = structlog.get_logger()


class OllamaClient:
    """Wrapper around Ollama for easy model swapping and metrics."""

    def __init__(self):
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
        self.client = AsyncClient(host=self.base_url)

    async def generate(
        self,
        prompt: str,
        model: str,
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 4096,
    ) -> dict:
        """Generate a completion from Ollama.

        Returns dict with 'response', 'tokens_used', 'duration_ms', 'model'.
        """
        start = time.monotonic()

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        try:
            response = await self.client.chat(
                model=model,
                messages=messages,
                options={
                    "temperature": temperature,
                    "num_predict": max_tokens,
                },
            )

            duration_ms = int((time.monotonic() - start) * 1000)
            # SDK v0.4.x returns a ChatResponse object — use attribute access
            tokens = getattr(response, "eval_count", 0) + getattr(response, "prompt_eval_count", 0)

            logger.info(
                "ollama_generate",
                model=model,
                tokens=tokens,
                duration_ms=duration_ms,
            )

            return {
                "response": response.message.content,
                "tokens_used": tokens,
                "duration_ms": duration_ms,
                "model": model,
            }
        except Exception as e:
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.error("ollama_generate_error", model=model, error=str(e), duration_ms=duration_ms)
            raise

    async def embed(self, text: str, model: str | None = None) -> list[float]:
        """Generate embeddings for text."""
        model = model or os.getenv("MODEL_EMBEDDING", "nomic-embed-text")
        # SDK v0.4.x uses .embed() and returns an EmbedResponse object
        response = await self.client.embed(model=model, input=text)
        return response.embeddings[0]

    async def health(self) -> bool:
        """Check if Ollama is reachable."""
        try:
            await self.client.list()
            return True
        except Exception:
            return False


# Singleton
ollama_client = OllamaClient()
