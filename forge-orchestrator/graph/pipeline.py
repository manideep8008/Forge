"""LangGraph pipeline DAG definition with conditional edges."""

import uuid
import structlog
from langgraph.graph import StateGraph, END

from graph.state import PipelineState
from graph.feedback import should_retry_review, should_retry_test
from agents.requirements import RequirementsAgent
from agents.architect import ArchitectAgent
from agents.codegen import CodegenAgent, validate_generated_files
from agents.review import ReviewAgent
from agents.test_agent import TestAgent
from agents.cicd import CICDAgent
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


async def classify_node(state: PipelineState) -> dict:
    """Classify intent and set up pipeline."""
    await context_manager.set(state.pipeline_id, "current_stage", "classify")
    await context_manager.publish_event(
        state.pipeline_id,
        "stage_started",
        {"stage": "requirements", "message": "Classifying project intent…"},
    )
    intent = await classify_intent(state.input_text)
    await context_manager.set(state.pipeline_id, "intent_type", intent.value)
    await context_manager.publish_event(
        state.pipeline_id,
        "pipeline.intent_classified",
        {"intent_type": intent.value, "message": f"Classified as {intent.value}"},
    )
    return {"intent_type": intent.value, "current_stage": "requirements"}


async def requirements_node(state: PipelineState) -> dict:
    """Run requirements agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "requirements")
    await context_manager.publish_event(
        state.pipeline_id, "stage_started",
        {"stage": "requirements", "message": "Analyzing requirements from your prompt…"},
    )
    context = {"pipeline_id": state.pipeline_id, "input_text": state.input_text, "intent_type": state.intent_type}
    result = await requirements_agent.run(context)
    if result.success:
        spec_title = result.output.get("title", "") if isinstance(result.output, dict) else ""
        await context_manager.set(state.pipeline_id, "spec", result.output)
        await context_manager.publish_event(state.pipeline_id, "agent.requirements.completed", {
            **result.output,
            "message": f"Requirements extracted: {spec_title}" if spec_title else "Requirements specification generated",
            "tokens_used": result.tokens_used,
        })
    else:
        await context_manager.publish_event(state.pipeline_id, "stage_failed", {
            "stage": "requirements", "message": f"Requirements failed: {result.error}",
        })
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
    await context_manager.publish_event(
        state.pipeline_id, "stage_started",
        {"stage": "architect", "message": "Designing system architecture…"},
    )
    context = {"pipeline_id": state.pipeline_id, "spec": state.spec, "input_text": state.input_text}
    result = await architect_agent.run(context)
    if result.success:
        file_plan = result.output.get("file_plan", {})
        decisions = result.output.get("architecture_decisions", [])
        await context_manager.set_many(state.pipeline_id, {
            "file_plan": file_plan,
            "architecture_decisions": decisions,
        })
        await context_manager.publish_event(state.pipeline_id, "agent.architect.completed", {
            **result.output,
            "message": f"{len(decisions)} architecture decisions, {len(file_plan)} files planned",
            "decision_count": len(decisions),
            "file_count": len(file_plan),
            "tokens_used": result.tokens_used,
        })
    else:
        await context_manager.publish_event(state.pipeline_id, "stage_failed", {
            "stage": "architect", "message": f"Architecture failed: {result.error}",
        })
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
    is_iteration = state.review_iteration > 0 or state.test_iteration > 0
    await context_manager.publish_event(
        state.pipeline_id, "stage_started",
        {
            "stage": "codegen",
            "message": "Applying fixes from review feedback…" if is_iteration else "Generating source code…",
            "iteration": state.review_iteration + state.test_iteration,
        },
    )
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
        merged_files = (
            {**validate_generated_files(state.existing_files), **new_files}
            if state.modification_request
            else new_files
        )
        await context_manager.set_many(state.pipeline_id, {
            "generated_files": merged_files,
            "git_branch": result.output.get("branch", ""),
        })
        file_names = sorted(merged_files.keys())
        await context_manager.publish_event(state.pipeline_id, "agent.codegen.completed", {
            "message": f"Generated {len(merged_files)} files",
            "file_count": len(merged_files),
            "file_names": file_names,
            "branch": result.output.get("branch", ""),
            "commit_message": result.output.get("commit_message", ""),
            "tokens_used": result.tokens_used,
        })
    else:
        merged_files = {}
        await context_manager.publish_event(state.pipeline_id, "stage_failed", {
            "stage": "codegen", "message": f"Code generation failed: {result.error}",
        })
    return {
        "generated_files": merged_files if result.success else {},
        "git_branch": result.output.get("branch", "") if result.success else state.git_branch,
        "current_stage": "review" if result.success else "failed",
        "error": result.error,
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "codegen": "completed" if result.success else "failed"},
    }



async def review_node(state: PipelineState) -> dict:
    """Run review agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "review")
    await context_manager.publish_event(
        state.pipeline_id, "stage_started",
        {"stage": "review", "message": "Reviewing code for quality issues…"},
    )
    context = {
        "pipeline_id": state.pipeline_id,
        "generated_files": state.generated_files,
        "spec": state.spec,
    }
    result = await review_agent.run(context)
    if not result.success:
        error = result.error or "Review agent failed"
        await context_manager.publish_event(state.pipeline_id, "stage_failed", {
            "stage": "review", "message": f"Review failed: {error}",
        })
        return {
            "review_issues": [],
            "review_passed": False,
            "current_stage": "failed",
            "error": error,
            "total_tokens": state.total_tokens + result.tokens_used,
            "stage_status": {**state.stage_status, "review": "failed"},
        }

    issues = result.output.get("issues", [])
    passed = not any(i.get("severity") == "critical" for i in issues)
    critical = sum(1 for i in issues if i.get("severity") == "critical")
    warnings = sum(1 for i in issues if i.get("severity") == "warning")
    info_count = sum(1 for i in issues if i.get("severity") == "info")
    msg = f"Review {'passed' if passed else 'found critical issues'}: {len(issues)} issues"
    if critical:
        msg += f" ({critical} critical)"
    await context_manager.publish_event(state.pipeline_id, "agent.review.completed", {
        "passed": passed, "issues_count": len(issues),
        "critical_count": critical, "warning_count": warnings, "info_count": info_count,
        "message": msg,
        "tokens_used": result.tokens_used,
    })
    return {
        "review_issues": issues,
        "review_passed": passed,
        "review_iteration": state.review_iteration + 1,
        "current_stage": "review",
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "review": "completed"},
    }


async def test_node(state: PipelineState) -> dict:
    """Run test agent."""
    await context_manager.set(state.pipeline_id, "current_stage", "test")
    await context_manager.publish_event(
        state.pipeline_id, "stage_started",
        {"stage": "test", "message": "Running automated tests…"},
    )
    context = {
        "pipeline_id": state.pipeline_id,
        "generated_files": state.generated_files,
        "spec": state.spec,
    }
    result = await test_agent.run(context)
    tests = result.output.get("test_results", [])
    execution_status = result.output.get(
        "execution_status",
        "executed" if tests else "not_executed",
    )
    requires_hitl = bool(result.output.get("requires_hitl"))
    # Empty test results = pytest couldn't run = don't block, proceed to HITL.
    # Explicit not_executed results require HITL without treating tests as passed.
    passed = (
        False
        if execution_status == "not_executed" or not result.success
        else (all(t.get("status") == "passed" for t in tests) if tests else True)
    )
    coverage = result.output.get("coverage_percent", 0.0)
    passed_count = sum(1 for t in tests if t.get("status") == "passed")
    failed_count = sum(1 for t in tests if t.get("status") == "failed")
    if execution_status == "not_executed":
        msg = result.output.get("summary") or "Tests not executed; human approval required"
    elif not result.success and not tests:
        msg = result.output.get("summary") or "No tests were executed"
    else:
        msg = f"{passed_count}/{len(tests)} tests passed" if tests else "No tests to run"
    if coverage:
        msg += f", {coverage:.0f}% coverage"
    await context_manager.publish_event(state.pipeline_id, "agent.test.completed", {
        "passed": passed, "coverage": coverage,
        "total_tests": len(tests), "passed_count": passed_count, "failed_count": failed_count,
        "execution_status": execution_status,
        "requires_hitl": requires_hitl,
        "message": msg,
        "tokens_used": result.tokens_used,
    })
    return {
        "test_results": tests,
        "tests_passed": passed,
        "coverage_percent": coverage,
        "test_execution_status": execution_status,
        "test_requires_hitl": requires_hitl,
        "test_iteration": state.test_iteration + 1,
        "current_stage": "test",
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
    await context_manager.publish_event(state.pipeline_id, "hitl_required", {
        "review_issues": state.review_issues,
        "test_results": state.test_results,
        "coverage_percent": state.coverage_percent,
        "test_execution_status": state.test_execution_status,
        "test_requires_hitl": state.test_requires_hitl,
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
                # Reset iteration counters so the review/test loops
                # don't immediately halt on the next pass.
                "review_iteration": 0,
                "test_iteration": 0,
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
    await context_manager.publish_event(
        state.pipeline_id, "stage_started",
        {"stage": "deploy", "message": "Building Docker image and deploying…"},
    )
    context = {
        "pipeline_id": state.pipeline_id,
        "git_branch": state.git_branch,
        "generated_files": state.generated_files,
    }
    result = await cicd_agent.run(context)
    if result.success:
        deploy_url = result.output.get("deploy_url", "")
        await context_manager.publish_event(state.pipeline_id, "agent.cicd.completed", {
            **result.output,
            "message": f"Deployed to {deploy_url}" if deploy_url else "Build completed",
            "tokens_used": result.tokens_used,
        })
    else:
        await context_manager.publish_event(state.pipeline_id, "stage_failed", {
            "stage": "deploy", "message": f"Deployment failed: {result.error}",
        })
    return {
        "docker_image": result.output.get("image", ""),
        "deploy_url": result.output.get("deploy_url", ""),
        "current_stage": "completed" if result.success else "failed",
        "error": result.error,
        "total_tokens": state.total_tokens + result.tokens_used,
        "stage_status": {**state.stage_status, "cicd": "completed" if result.success else "failed"},
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
    if state.hitl_decision == "approve":
        return "cicd"
    if state.hitl_decision in ("request_changes", "modify"):
        return "codegen"
    # Unknown or empty decision — treat as halt to avoid silent misbehaviour
    logger.warning("hitl_unknown_decision", pipeline_id=state.pipeline_id, decision=state.hitl_decision)
    return "halt"


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
    graph.add_node("halt", halt_node)
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
        "continue": "complete",
    })

    # Terminal nodes
    graph.add_edge("halt", END)
    graph.add_edge("complete", END)

    return graph


# Compiled pipeline
pipeline = build_pipeline().compile()
