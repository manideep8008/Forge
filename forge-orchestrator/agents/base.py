"""Base agent interface — all 7 agents implement this contract."""

from abc import ABC, abstractmethod
import time
import structlog

from models.schemas import AgentResult, RetryDecision

logger = structlog.get_logger()


class BaseAgent(ABC):
    """Abstract base class for all Forge agents."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Agent name for logging and events."""

    @abstractmethod
    def get_model(self) -> str:
        """Return the Ollama model name this agent uses."""

    @abstractmethod
    async def validate(self, context: dict) -> bool:
        """Check that required inputs exist in the context before executing.

        Returns True if all prerequisites are met.
        """

    @abstractmethod
    async def execute(self, context: dict) -> AgentResult:
        """Main agent logic. Calls Ollama, processes results, returns output.

        Context dict contains all shared state from previous agents.
        """

    async def on_failure(self, context: dict, error: Exception) -> RetryDecision:
        """Handle failures. Default: abort.

        Override in subclasses for custom retry logic.
        """
        logger.error(
            "agent_failure",
            agent=self.name,
            error=str(error),
            pipeline_id=context.get("pipeline_id"),
        )
        return RetryDecision.ABORT

    async def run(self, context: dict) -> AgentResult:
        """Execute the agent with validation, timing, and error handling."""
        pipeline_id = context.get("pipeline_id", "unknown")

        logger.info("agent_start", agent=self.name, pipeline_id=pipeline_id)

        if not await self.validate(context):
            return AgentResult(
                success=False,
                error=f"Validation failed for {self.name}: missing required context",
            )

        start = time.monotonic()
        try:
            result = await self.execute(context)
            result.duration_ms = int((time.monotonic() - start) * 1000)

            logger.info(
                "agent_complete",
                agent=self.name,
                pipeline_id=pipeline_id,
                success=result.success,
                tokens=result.tokens_used,
                duration_ms=result.duration_ms,
            )
            return result

        except Exception as e:
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "agent_error",
                agent=self.name,
                pipeline_id=pipeline_id,
                error=str(e),
                duration_ms=duration_ms,
            )
            decision = await self.on_failure(context, e)
            return AgentResult(
                success=False,
                error=str(e),
                duration_ms=duration_ms,
                output={"retry_decision": decision.value},
            )
