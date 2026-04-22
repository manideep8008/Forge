import asyncio
import json

from agents.test_agent import TestAgent
from services.ollama_client import ollama_client


def test_docker_unavailable_marks_generated_tests_not_executed(monkeypatch):
    async def fake_generate(**_kwargs):
        return {
            "response": json.dumps({
                "test_files": {
                    "tests/test_app.py": "def test_smoke():\n    assert True\n",
                },
                "test_results": [
                    {
                        "test_name": "test_smoke",
                        "status": "passed",
                        "duration_ms": 5,
                        "error_message": None,
                    },
                ],
                "coverage_percent": 91.0,
                "summary": "All tests passed",
            }),
            "tokens_used": 12,
            "model": "test-model",
        }

    async def fake_run_tests_in_container(self, pipeline_id, generated_files, test_files):
        return None

    monkeypatch.setattr(ollama_client, "generate", fake_generate)
    monkeypatch.setattr(TestAgent, "_run_tests_in_container", fake_run_tests_in_container)

    result = asyncio.run(TestAgent().execute({
        "pipeline_id": "pipeline-1",
        "generated_files": {"app.py": "print('hello')"},
        "spec": {"acceptance_criteria": ["starts"]},
    }))

    output = result.output
    assert result.success is False
    assert output["coverage_percent"] == 0.0
    assert output["execution_status"] == "not_executed"
    assert output["requires_hitl"] is True
    assert output["test_results"][0]["status"] == "not_executed"
    assert "not executed" in output["test_results"][0]["error_message"]


def test_zero_executed_tests_are_marked_not_executed(monkeypatch):
    async def fake_generate(**_kwargs):
        return {
            "response": json.dumps({
                "test_files": {
                    "tests/App.test.jsx": "import { it } from 'vitest';\nit('renders', () => {});\n",
                },
                "test_results": [],
                "coverage_percent": 0.0,
                "summary": "Generated tests",
            }),
            "tokens_used": 12,
            "model": "test-model",
        }

    async def fake_run_tests_in_container(self, pipeline_id, generated_files, test_files):
        return {
            "success": False,
            "test_results": [],
            "coverage_percent": 0.0,
            "passed": 0,
            "failed": 0,
            "skipped": 0,
            "total": 0,
            "error": "test execution timed out before producing results",
        }

    monkeypatch.setattr(ollama_client, "generate", fake_generate)
    monkeypatch.setattr(TestAgent, "_run_tests_in_container", fake_run_tests_in_container)

    result = asyncio.run(TestAgent().execute({
        "pipeline_id": "pipeline-1",
        "generated_files": {"src/App.jsx": "export default function App() { return null }"},
        "spec": {"acceptance_criteria": ["renders"]},
    }))

    output = result.output
    assert result.success is False
    assert output["execution_status"] == "not_executed"
    assert output["requires_hitl"] is True
    assert output["test_results"][0]["status"] == "not_executed"
    assert output["summary"] == "test execution timed out before producing results"
