from graph.feedback import should_retry_test
from graph.state import PipelineState


def test_not_executed_tests_route_to_hitl():
    state = PipelineState(
        pipeline_id="pipeline-1",
        tests_passed=False,
        test_execution_status="not_executed",
        test_requires_hitl=True,
        test_results=[
            {
                "test_name": "test_smoke",
                "status": "not_executed",
            },
        ],
    )

    assert should_retry_test(state) == "hitl"
