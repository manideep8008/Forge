"""Feedback controller — manages review/test retry loops."""

import structlog

from graph.state import PipelineState

logger = structlog.get_logger()


def should_retry_review(state: PipelineState) -> str:
    """Decide whether to loop back to codegen after review.

    Returns: "codegen" to retry, "test" to proceed, "halt" to stop.
    """
    if state.current_stage == "failed":
        logger.warning("review_failed_halt", pipeline_id=state.pipeline_id)
        return "halt"

    if state.review_passed:
        logger.info("review_passed", pipeline_id=state.pipeline_id)
        return "test"

    if state.review_iteration >= state.max_iterations:
        logger.warning(
            "review_max_iterations",
            pipeline_id=state.pipeline_id,
            iterations=state.review_iteration,
        )
        return "halt"

    # Only retry on CRITICAL issues (crashes, data loss)
    has_critical = any(
        issue.get("severity") == "critical"
        for issue in state.review_issues
    )

    if has_critical:
        logger.info(
            "review_retry",
            pipeline_id=state.pipeline_id,
            iteration=state.review_iteration + 1,
            critical_issues=sum(
                1 for i in state.review_issues
                if i.get("severity") == "critical"
            ),
        )
        return "codegen"

    # High/medium/low issues — proceed to testing anyway
    return "test"


def should_retry_test(state: PipelineState) -> str:
    """Decide whether to loop back to codegen after testing.

    Returns: "codegen" to retry, "hitl" to proceed, "halt" to stop.
    """
    if state.test_requires_hitl or state.test_execution_status == "not_executed":
        logger.warning(
            "tests_not_executed_hitl_required",
            pipeline_id=state.pipeline_id,
            execution_status=state.test_execution_status,
        )
        return "hitl"

    if state.tests_passed:
        logger.info("tests_passed", pipeline_id=state.pipeline_id)
        return "hitl"

    if state.test_iteration >= state.max_iterations:
        logger.warning(
            "test_max_iterations",
            pipeline_id=state.pipeline_id,
            iterations=state.test_iteration,
        )
        return "halt"

    logger.info(
        "test_retry",
        pipeline_id=state.pipeline_id,
        iteration=state.test_iteration + 1,
        failed_tests=sum(
            1 for t in state.test_results if t.get("status") == "failed"
        ),
    )
    return "codegen"
