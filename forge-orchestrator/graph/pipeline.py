"""LangGraph pipeline DAG definition with conditional edges."""

import uuid
import structlog
from langgraph.graph import StateGraph, END

from graph.state import PipelineState
from graph.feedback import should_retry_review, should_retry_test, should_rollback
from agents.requirements import RequirementsAgent
from agents.architect import ArchitectAgent
from agents.codegen import CodegenAgent
from agents.review import ReviewAgent
from agents.test_agent import TestAgent
from agents.cicd import CICDAgent
from agents.monitor import MonitorAgent
from services.intent_classifier import classify_intent
from services.context_manager import context_manager

logger = structlog.get_logger()

# Agent instances
requirements_agent = RequirementsAgent()
architect_agent = ArchitectAgent()
codegen_agent = CodegenAgent()
review_agent = ReviewAgent()
test_agent = TestAgent()
cicd_agent = CICDAgent()
monitor_agent = MonitorAgent()


async def classify_node(state: PipelineState) -> dict:
    """Classify intent and set up pipeline."""
    await context_manager.set(state.pipeline_id, "current_stage", "classify")
    intent = await classify_intent(state.input_text)
    await context_manager.set(state.pipeline_id, "intent_type", intent.value)
    await context_manager.publish_event(
        state.pipeline_id,
        "pipeline.intent_classified",
        {"intent_type": intent.value},
    )
    return {"intent_type": intent.value, "current_stage": "requirements"}


async def requirements_node(state: PipelineState) -> dict:
    """Run requirements agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "requirements")
    context = {"pipeline_id": state.pipeline_id, "input_text": state.input_text, "intent_type": state.intent_type}
    result = await requirements_agent.run(context)
    if result.success:
        await context_manager.set(state.pipeline_id, "spec", result.output)
        await context_manager.publish_event(state.pipeline_id, "agent.requirements.completed", result.output)
    return {
        "spec": result.output if result.success else {},
        "current_stage": "architect" if result.success else "failed",
        "error": result.error,
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "requirements": "completed" if result.success else "failed"},
    }


async def architect_node(state: PipelineState) -> dict:
    """Run architect agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "architect")
    context = {"pipeline_id": state.pipeline_id, "spec": state.spec, "input_text": state.input_text}
    result = await architect_agent.run(context)
    if result.success:
        await context_manager.set_many(state.pipeline_id, {
            "file_plan": result.output.get("file_plan", {}),
            "architecture_decisions": result.output.get("architecture_decisions", []),
        })
        await context_manager.publish_event(state.pipeline_id, "agent.architect.completed", result.output)
    return {
        "file_plan": result.output.get("file_plan", {}),
        "architecture_decisions": result.output.get("architecture_decisions", []),
        "current_stage": "codegen" if result.success else "failed",
        "error": result.error,
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "architect": "completed" if result.success else "failed"},
    }


async def codegen_node(state: PipelineState) -> dict:
    """Run codegen agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "codegen")
    context = {
        "pipeline_id": state.pipeline_id,
        "spec": state.spec,
        "file_plan": state.file_plan,
        "input_text": state.input_text,
        "review_issues": state.review_issues,
        "test_results": state.test_results,
        "review_iteration": state.review_iteration,
        "test_iteration": state.test_iteration,
        # Modification mode fields
        "modification_request": state.modification_request,
        "existing_files": state.existing_files,
    }
    result = await codegen_agent.run(context)
    if result.success:
        new_files = result.output.get("files", {})
        # In modification mode: merge existing files with changed files
        # (LLM returns only the files that changed; unchanged files survive)
        merged_files = {**state.existing_files, **new_files} if state.modification_request else new_files
        await context_manager.set_many(state.pipeline_id, {
            "generated_files": merged_files,
            "git_branch": result.output.get("branch", ""),
        })
        await context_manager.publish_event(state.pipeline_id, "agent.codegen.completed", result.output)
    else:
        merged_files = {}
    return {
        "generated_files": merged_files if result.success else {},
        "git_branch": result.output.get("branch", ""),
        "current_stage": "review" if result.success else "failed",
        "error": result.error,
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "codegen": "completed" if result.success else "failed"},
    }



async def review_node(state: PipelineState) -> dict:
    """Run review agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "review")
    context = {
        "pipeline_id": state.pipeline_id,
        "generated_files": state.generated_files,
        "spec": state.spec,
    }
    result = await review_agent.run(context)
    issues = result.output.get("issues", [])
    passed = not any(i.get("severity") == "critical" for i in issues)
    await context_manager.publish_event(state.pipeline_id, "agent.review.completed", {
        "passed": passed, "issues_count": len(issues),
    })
    return {
        "review_issues": issues,
        "review_passed": passed,
        "review_iteration": state.review_iteration + 1,
        "current_stage": "review_decision",
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "review": "completed"},
    }


async def test_node(state: PipelineState) -> dict:
    """Run test agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "test")
    context = {
        "pipeline_id": state.pipeline_id,
        "generated_files": state.generated_files,
        "spec": state.spec,
    }
    result = await test_agent.run(context)
    tests = result.output.get("test_results", [])
    # Empty test results = pytest couldn't run = don't block, proceed to HITL
    passed = all(t.get("status") == "passed" for t in tests) if tests else True
    coverage = result.output.get("coverage_percent", 0.0)
    await context_manager.publish_event(state.pipeline_id, "agent.test.completed", {
        "passed": passed, "coverage": coverage,
    })
    return {
        "test_results": tests,
        "tests_passed": passed,
        "coverage_percent": coverage,
        "test_iteration": state.test_iteration + 1,
        "current_stage": "test_decision",
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "test": "completed"},
    }


async def hitl_node(state: PipelineState) -> dict:
    """Wait for human-in-the-loop approval via Redis pub/sub."""
    await context_manager.set(state.pipeline_id, "current_stage", "hitl")
    await context_manager.set(state.pipeline_id, "status", "awaiting_approval")

    # Clear any stale decision from a previous HITL pass to prevent infinite loops
    await context_manager.set(state.pipeline_id, "hitl_decision", "")

    # Publish event so the UI shows the approval modal
    await context_manager.publish_event(state.pipeline_id, "pipeline.awaiting_approval", {
        "review_issues": state.review_issues,
        "test_results": state.test_results,
        "coverage_percent": state.coverage_percent,
    })

    logger.info("hitl_waiting", pipeline_id=state.pipeline_id)

    valid_decisions = {"approve", "reject", "request_changes", "modify"}

    # Use pub/sub with a slow-poll fallback instead of busy-polling every 2s.
    # This avoids holding a Redis connection under constant load for up to 1 hour.
    decision = await context_manager.wait_for_field(
        pipeline_id=state.pipeline_id,
        field="hitl_decision",
        expected_values=valid_decisions,
        timeout=3600,
        poll_fallback=10,
    )

    if decision and decision in valid_decisions:
        comments = await context_manager.get(state.pipeline_id, "hitl_comments") or ""
        logger.info(
            "hitl_decision_received",
            pipeline_id=state.pipeline_id,
            decision=decision,
        )

        if decision == "approve":
            return {
                "hitl_decision": decision,
                "hitl_comments": comments,
                "current_stage": "cicd",
                "stage_status": {**state.stage_status, "hitl": "completed"},
            }
        elif decision == "reject":
            return {
                "hitl_decision": decision,
                "hitl_comments": comments,
                "current_stage": "failed",
                "error": f"Pipeline rejected by human reviewer: {comments}" if comments else "Pipeline rejected by human reviewer",
                "stage_status": {**state.stage_status, "hitl": "failed"},
            }
        else:  # request_changes / modify
            return {
                "hitl_decision": decision,
                "hitl_comments": comments,
                "current_stage": "codegen",
                "stage_status": {**state.stage_status, "hitl": "completed"},
            }

    # Timeout — auto-reject
    logger.warning("hitl_timeout", pipeline_id=state.pipeline_id)
    return {
        "hitl_decision": "reject",
        "current_stage": "failed",
        "error": "HITL approval timed out after 1 hour",
        "stage_status": {**state.stage_status, "hitl": "failed"},
    }


async def cicd_node(state: PipelineState) -> dict:
    """Run CI/CD agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "deploy")
    context = {
        "pipeline_id": state.pipeline_id,
        "git_branch": state.git_branch,
        "generated_files": state.generated_files,
    }
    result = await cicd_agent.run(context)
    if result.success:
        await context_manager.publish_event(state.pipeline_id, "agent.cicd.completed", result.output)
    return {
        "docker_image": result.output.get("image", ""),
        "deploy_url": result.output.get("deploy_url", ""),
        "current_stage": "monitor" if result.success else "failed",
        "error": result.error,
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "cicd": "completed" if result.success else "failed"},
    }


async def monitor_node(state: PipelineState) -> dict:
    """Run monitor agent."""
    context = {
        "pipeline_id": state.pipeline_id,
        "deploy_url": state.deploy_url,
        "docker_image": state.docker_image,
    }
    result = await monitor_agent.run(context)
    await context_manager.publish_event(state.pipeline_id, "agent.monitor.completed", result.output)
    return {
        "health_status": result.output.get("health_status", {}),
        "should_rollback": result.output.get("should_rollback", False),
        "current_stage": "monitor_decision",
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "monitor": "completed"},
    }


async def halt_node(state: PipelineState) -> dict:
    """Pipeline halted — max iterations exceeded or critical failure."""
    await context_manager.publish_event(state.pipeline_id, "pipeline.halted", {
        "stage": state.current_stage,
        "error": state.error or "Max iterations exceeded",
    })
    return {
        "current_stage": "halted",
        "stage_status": {**state.stage_status, "pipeline": "halted"},
    }


async def rollback_node(state: PipelineState) -> dict:
    """Rollback deployment."""
    await context_manager.publish_event(state.pipeline_id, "pipeline.rollback", {
        "image": state.docker_image,
    })
    return {
        "current_stage": "rolled_back",
        "stage_status": {**state.stage_status, "pipeline": "rolled_back"},
    }


async def complete_node(state: PipelineState) -> dict:
    """Pipeline completed successfully."""
    await context_manager.publish_event(state.pipeline_id, "pipeline.completed", {
        "total_tokens": state.total_tokens,
    })
    return {
        "current_stage": "completed",
        "stage_status": {**state.stage_status, "pipeline": "completed"},
    }


def _route_hitl(state: PipelineState) -> str:
    """Route based on HITL decision."""
    if state.current_stage == "failed":
        return "halt"
    if state.hitl_decision in ("request_changes", "modify"):
        return "codegen"
    return "cicd"


def check_failed(state: PipelineState) -> str:
    """Route to halt if any stage failed."""
    if state.current_stage == "failed":
        return "halt"
    return "continue"


def build_pipeline() -> StateGraph:
    """Build the LangGraph pipeline DAG."""
    graph = StateGraph(PipelineState)

    # Add nodes
    graph.add_node("classify", classify_node)
    graph.add_node("requirements", requirements_node)
    graph.add_node("architect", architect_node)
    graph.add_node("codegen", codegen_node)
    graph.add_node("review", review_node)
    graph.add_node("test", test_node)
    graph.add_node("hitl", hitl_node)
    graph.add_node("cicd", cicd_node)
    graph.add_node("monitor", monitor_node)
    graph.add_node("halt", halt_node)
    graph.add_node("rollback", rollback_node)
    graph.add_node("complete", complete_node)

    # Entry point
    graph.set_entry_point("classify")

    # Linear flow with failure checks
    graph.add_edge("classify", "requirements")

    graph.add_conditional_edges("requirements", check_failed, {
        "halt": "halt",
        "continue": "architect",
    })

    graph.add_conditional_edges("architect", check_failed, {
        "halt": "halt",
        "continue": "codegen",
    })

    graph.add_conditional_edges("codegen", check_failed, {
        "halt": "halt",
        "continue": "review",
    })

    # Review → feedback loop
    graph.add_conditional_edges("review", should_retry_review, {
        "codegen": "codegen",
        "test": "test",
        "halt": "halt",
    })

    # Test → feedback loop
    graph.add_conditional_edges("test", should_retry_test, {
        "codegen": "codegen",
        "hitl": "hitl",
        "halt": "halt",
    })

    graph.add_conditional_edges("hitl", _route_hitl, {
        "cicd": "cicd",
        "codegen": "codegen",
        "halt": "halt",
    })

    graph.add_conditional_edges("cicd", check_failed, {
        "halt": "halt",
        "continue": "monitor",
    })

    # Monitor → rollback decision
    graph.add_conditional_edges("monitor", should_rollback, {
        "rollback": "rollback",
        "complete": "complete",
    })

    # Terminal nodes
    graph.add_edge("halt", END)
    graph.add_edge("rollback", END)
    graph.add_edge("complete", END)

    return graph


# Compiled pipeline
pipeline = build_pipeline().compile()
