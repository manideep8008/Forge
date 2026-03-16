"""LangGraph state definition for the Forge pipeline."""

from __future__ import annotations

from typing import Any, Annotated
from langgraph.graph import add_messages
from pydantic import BaseModel, Field


class PipelineState(BaseModel):
    """Full state passed through the LangGraph pipeline.

    Each agent reads what it needs and writes its outputs here.
    The state is checkpointed to Redis for crash recovery.
    """

    # Core identifiers
    pipeline_id: str = ""
    user_id: str = "default-user"
    correlation_id: str = ""

    # Input
    input_text: str = ""
    intent_type: str = ""

    # Stage tracking
    current_stage: str = "pending"
    stage_status: dict[str, str] = Field(default_factory=dict)

    # Requirements agent output
    spec: dict[str, Any] = Field(default_factory=dict)

    # Architect agent output
    file_plan: dict[str, Any] = Field(default_factory=dict)
    architecture_decisions: list[str] = Field(default_factory=list)

    # Codegen agent output
    generated_files: dict[str, str] = Field(default_factory=dict)
    git_branch: str = ""

    # Review agent output
    review_issues: list[dict[str, Any]] = Field(default_factory=list)
    review_passed: bool = False

    # Test agent output
    test_results: list[dict[str, Any]] = Field(default_factory=list)
    tests_passed: bool = False
    coverage_percent: float = 0.0

    # Feedback loop tracking
    review_iteration: int = 0
    test_iteration: int = 0
    max_iterations: int = 3

    # HITL gate
    hitl_decision: str = ""
    hitl_comments: str = ""

    # CI/CD agent output
    docker_image: str = ""
    deploy_url: str = ""

    # Monitor agent output
    health_status: dict[str, Any] = Field(default_factory=dict)
    should_rollback: bool = False

    # Error tracking
    error: str | None = None
    failed_stage: str | None = None

    # Metrics
    total_tokens: int = 0
