"""Pydantic models for Forge orchestrator."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class PipelineStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    APPROVED = "approved"
    DEPLOYING = "deploying"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class IntentType(str, Enum):
    FEATURE = "feature"
    BUGFIX = "bugfix"
    REFACTOR = "refactor"
    HOTFIX = "hotfix"


class StageStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class Severity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class RetryDecision(str, Enum):
    RETRY = "retry"
    REPLAN = "replan"
    ABORT = "abort"


# === Request/Response Models ===

class PipelineCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input_text: str = Field(..., min_length=1, max_length=10000)
    repo_url: str | None = None


class PipelineCreateResponse(BaseModel):
    pipeline_id: str
    status: PipelineStatus = PipelineStatus.PENDING
    message: str = "Pipeline created"


class PipelineStatusResponse(BaseModel):
    pipeline_id: str
    status: PipelineStatus
    intent_type: IntentType | None = None
    stages: list[StageInfo] = []
    created_at: datetime | None = None
    completed_at: datetime | None = None
    error_message: str | None = None


class StageInfo(BaseModel):
    stage_name: str
    agent_name: str
    status: StageStatus
    started_at: datetime | None = None
    duration_ms: int | None = None
    tokens_used: int = 0
    iteration: int = 1


# === Agent Models ===

class AgentResult(BaseModel):
    success: bool
    output: dict[str, Any] = {}
    tokens_used: int = 0
    model_used: str = ""
    error: str | None = None
    duration_ms: int = 0


class ReviewIssue(BaseModel):
    severity: Severity
    file: str
    line: int | None = None
    message: str
    suggestion: str | None = None


class StructuredSpec(BaseModel):
    title: str
    description: str
    acceptance_criteria: list[str] = []
    edge_cases: list[str] = []
    dependencies: list[str] = []
    estimated_complexity: str = "medium"


class FilePlan(BaseModel):
    files_to_create: list[str] = []
    files_to_modify: list[str] = []
    files_to_delete: list[str] = []
    architecture_decisions: list[str] = []
    dependency_graph: dict[str, list[str]] = {}


class TestResult(BaseModel):
    test_name: str
    status: str
    duration_ms: int = 0
    error_message: str | None = None


class HealthStatus(BaseModel):
    healthy: bool
    error_rate: float = 0.0
    response_time_ms: float = 0.0
    details: dict[str, Any] = {}


# === Event Models ===

class PipelineEvent(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    pipeline_id: str
    event_type: str
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    payload: dict[str, Any] = {}


# === HITL Models ===

class HITLDecision(str, Enum):
    APPROVE = "approve"
    REJECT = "reject"
    MODIFY = "modify"


class HITLRequest(BaseModel):
    pipeline_id: str
    decision: HITLDecision
    comments: str | None = None
    modifications: dict[str, Any] | None = None


# === Exceptions ===

class CodegenOutputError(Exception):
    """Raised when the LLM returns unparseable or schema-invalid output."""

    def __init__(self, message: str, parse_error: str | None = None, response_snippet: str | None = None):
        super().__init__(message)
        self.parse_error = parse_error
        self.response_snippet = response_snippet
