"""Test Agent — generates and executes tests."""

import json
import os

from agents.base import BaseAgent
from models.schemas import AgentResult, RetryDecision
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a senior QA engineer. Given code and a specification,
generate comprehensive test cases.

Produce a JSON response with:
{
  "test_files": {
    "tests/test_feature.py": "import pytest\\n\\ndef test_...():\\n    ..."
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
- Write pytest tests
- Cover happy paths, edge cases, and error scenarios
- Test against acceptance criteria from the spec
- Include both unit and integration tests where appropriate
- Always respond with valid JSON only"""


class TestAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "test"

    def get_model(self) -> str:
        return os.getenv("MODEL_TEST", "codellama:13b")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("generated_files") and context.get("spec"))

    async def on_failure(self, context: dict, error: Exception) -> RetryDecision:
        return RetryDecision.RETRY

    async def execute(self, context: dict) -> AgentResult:
        files = context["generated_files"]
        spec = context["spec"]

        files_text = ""
        for path, content in files.items():
            files_text += f"\n--- {path} ---\n{content}\n"

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
        if "```json" in response_text:
            response_text = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            response_text = response_text.split("```")[1].split("```")[0].strip()

        try:
            test_output = json.loads(response_text)
        except json.JSONDecodeError:
            test_output = {
                "test_files": {},
                "test_results": [],
                "coverage_percent": 0.0,
                "summary": "Failed to parse test output",
            }

        test_results = test_output.get("test_results", [])
        all_passed = all(t.get("status") == "passed" for t in test_results) if test_results else False

        return AgentResult(
            success=True,
            output={
                "test_files": test_output.get("test_files", {}),
                "test_results": test_results,
                "coverage_percent": test_output.get("coverage_percent", 0.0),
                "summary": test_output.get("summary", ""),
            },
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
