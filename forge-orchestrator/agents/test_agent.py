"""Test Agent — generates and executes tests."""

import httpx
import json
import os

import structlog

from agents.base import BaseAgent
from agents.codegen import _extract_json
from internal_auth import internal_api_headers
from models.schemas import AgentResult, RetryDecision
from services.ollama_client import ollama_client

logger = structlog.get_logger()

SYSTEM_PROMPT = """You are a senior QA engineer for full-stack web applications (React + Vite + Tailwind CSS frontend, Node.js Express backend).
Given code and a specification, generate comprehensive test cases.

Produce a JSON response with:
{
  "test_files": {
    "tests/App.test.jsx": "import { describe, it, expect } from 'vitest';\\n..."
  },
  "test_results": [
    {
      "test_name": "test_feature_basic",
      "status": "passed|failed|skipped",
      "duration_ms": 50,
      "error_message": null
    }
  ],
  "coverage_percent": 85.0,
  "summary": "Overall test assessment"
}

Guidelines:
- For React/Node.js apps: use vitest or jest with @testing-library/react
- Cover happy paths, edge cases, and error scenarios
- Test against acceptance criteria from the spec
- Include both unit and integration tests where appropriate
- Be aware of imports and file dependencies across the codebase
- You may reason internally, but your final output must be valid JSON only
- Do NOT wrap the JSON in markdown code fences"""


class TestAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "test"

    def get_model(self) -> str:
        return os.getenv("MODEL_TEST", "devstral-small-2:24b-cloud")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("generated_files") and context.get("spec"))

    async def on_failure(self, context: dict, error: Exception) -> RetryDecision:
        return RetryDecision.RETRY

    async def execute(self, context: dict) -> AgentResult:
        files = context["generated_files"]
        spec = context["spec"]

        MAX_FILE_CHARS = 800
        MAX_FILES = 10
        files_text = ""
        for path, content in list(files.items())[:MAX_FILES]:
            files_text += f"\n--- {path} ---\n{content[:MAX_FILE_CHARS]}\n"

        prompt = f"""Generate comprehensive tests for this code:

SPECIFICATION:
{json.dumps(spec, indent=2)}

CODE:
{files_text}

Write pytest tests covering acceptance criteria, edge cases, and error handling.
Respond with valid JSON only."""

        result = await ollama_client.generate(
            prompt=prompt,
            model=self.get_model(),
            system=SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=8192,
        )

        response_text = result["response"].strip()
        test_output = _extract_json(response_text)
        if test_output is None:
            test_output = {
                "test_files": {},
                "test_results": [],
                "coverage_percent": 0.0,
                "summary": "Failed to parse test output",
            }

        test_files = test_output.get("test_files", {})

        # --- Real execution via forge-docker-svc ---
        if test_files:
            real = await self._run_tests_in_container(
                context["pipeline_id"], files, test_files
            )
            if real is not None:
                real_passed = real.get("passed", 0)
                real_failed = real.get("failed", 0)
                real_total = real.get("total", 0)
                if real_total == 0:
                    error = real.get("error") or "Docker test runner produced no executed test results"
                    return AgentResult(
                        success=False,
                        output={
                            "test_files": test_files,
                            "test_results": self._mark_not_executed([], test_files),
                            "coverage_percent": 0.0,
                            "execution_status": "not_executed",
                            "requires_hitl": True,
                            "summary": error,
                        },
                        tokens_used=result["tokens_used"],
                        model_used=result["model"],
                    )

                # Success = at least one test ran AND none failed
                real_success = real_total > 0 and real_failed == 0
                return AgentResult(
                    success=real_success,
                    output={
                        "test_files": test_files,
                        "test_results": real.get("test_results", []),
                        "coverage_percent": real.get("coverage_percent", 0.0),
                        "execution_status": "executed",
                        "requires_hitl": False,
                        "summary": (
                            f"{real_passed} passed, "
                            f"{real_failed} failed, "
                            f"{real_total} total "
                            f"(real execution)"
                        ),
                    },
                    tokens_used=result["tokens_used"],
                    model_used=result["model"],
                )

        # --- Fallback: tests generated, but not executed ---
        simulated_results = test_output.get("test_results", [])

        # If no simulated results but we have test files, generate synthetic
        # results by parsing test/describe/it names from the code.
        if not simulated_results and test_files:
            simulated_results = self._extract_test_names(test_files)

        not_executed_results = self._mark_not_executed(simulated_results, test_files)
        if test_files:
            summary = (
                "Tests were generated but not executed because the Docker "
                "test runner was unavailable. Human approval is required."
            )
        else:
            summary = (
                test_output.get("summary")
                or "Tests were not generated or executed. Human approval is required."
            )

        return AgentResult(
            success=False,
            output={
                "test_files": test_files,
                "test_results": not_executed_results,
                "coverage_percent": 0.0,
                "execution_status": "not_executed",
                "requires_hitl": True,
                "summary": summary,
            },
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )

    @staticmethod
    def _extract_test_names(test_files: dict) -> list[dict]:
        """Parse test/it/describe names from generated test files."""
        import re
        results = []
        for path, code in test_files.items():
            # Match patterns like: test('name', ...) / it('name', ...) / def test_name
            for match in re.finditer(
                r'''(?:test|it)\s*\(\s*['\"](.+?)['\"]'''
                r'''|def\s+(test_\w+)''',
                code,
            ):
                name = match.group(1) or match.group(2)
                results.append({
                    "test_name": name,
                    "name": name,
                    "status": "not_executed",
                    "duration_ms": 0,
                    "error_message": None,
                })
        return results

    @staticmethod
    def _mark_not_executed(test_results: list[dict], test_files: dict) -> list[dict]:
        """Convert unverified LLM/synthetic results into not-executed records."""
        results = []
        for index, test in enumerate(test_results):
            name = (
                test.get("test_name")
                or test.get("name")
                or f"generated_test_{index + 1}"
            )
            results.append({
                **test,
                "test_name": name,
                "name": name,
                "status": "not_executed",
                "duration_ms": 0,
                "error_message": "not executed: Docker test runner unavailable",
                "error": "not executed: Docker test runner unavailable",
            })

        if results or not test_files:
            return results

        return [
            {
                "test_name": f"{path}: not executed",
                "name": f"{path}: not executed",
                "status": "not_executed",
                "duration_ms": 0,
                "error_message": "not executed: Docker test runner unavailable",
                "error": "not executed: Docker test runner unavailable",
            }
            for path in test_files
        ]

    async def _run_tests_in_container(
        self, pipeline_id: str, generated_files: dict, test_files: dict
    ) -> dict | None:
        """POST generated + test files to forge-docker-svc and return real results."""
        docker_svc_url = os.getenv("DOCKER_SVC_URL", "http://forge-docker-svc:8082")
        try:
            async with httpx.AsyncClient(timeout=180) as client:
                resp = await client.post(
                    f"{docker_svc_url}/docker/test",
                    headers=internal_api_headers(),
                    json={
                        "pipeline_id": pipeline_id,
                        "generated_files": generated_files,
                        "test_files": test_files,
                        "timeout_seconds": 150,
                    },
                )
                if resp.status_code == 200:
                    return resp.json()
                logger.warning(
                    "test_execution_bad_status",
                    pipeline_id=pipeline_id,
                    status=resp.status_code,
                )
        except Exception as exc:
            logger.warning(
                "test_execution_unavailable",
                pipeline_id=pipeline_id,
                error=str(exc),
            )
        return None
