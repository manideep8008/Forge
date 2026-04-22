import asyncio

from graph import pipeline as pipeline_module
from graph.feedback import should_retry_review
from graph.state import PipelineState
from models.schemas import AgentResult


def test_review_node_fails_closed_when_agent_fails(monkeypatch):
    events = []

    class FailingReviewAgent:
        async def run(self, _context):
            return AgentResult(
                success=False,
                error="review timeout",
                output={},
                tokens_used=3,
            )

    class FakeContextManager:
        async def set(self, *_args, **_kwargs):
            return None

        async def publish_event(self, pipeline_id, event_type, payload):
            events.append((pipeline_id, event_type, payload))

    monkeypatch.setattr(pipeline_module, "review_agent", FailingReviewAgent())
    monkeypatch.setattr(pipeline_module, "context_manager", FakeContextManager())

    state = PipelineState(
        pipeline_id="pipeline-1",
        generated_files={"app.py": "print('hello')"},
        spec={"acceptance_criteria": ["starts"]},
    )
    result = asyncio.run(pipeline_module.review_node(state))
    next_state = PipelineState(**{**state.model_dump(), **result})

    assert result["current_stage"] == "failed"
    assert result["review_passed"] is False
    assert result["error"] == "review timeout"
    assert result["stage_status"]["review"] == "failed"
    assert should_retry_review(next_state) == "halt"
    assert events[0] == (
        "pipeline-1",
        "stage_started",
        {"stage": "review", "message": "Reviewing code for quality issues…"},
    )
    assert events[1] == (
        "pipeline-1",
        "stage_failed",
        {
            "stage": "review",
            "message": "Review failed: review timeout",
        },
    )
