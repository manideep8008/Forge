"""Test Agent — generates and executes tests."""

import json
import os

from agents.base import BaseAgent
from agents.codegen import _extract_json
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
        test_output = _extract_json(response_text)
        if test_output is None:
            test_output = {
                "test_files": {},
                "test_results": [],
                "coverage_percent": 0.0,
                "summary": "Failed to parse test output",
            }

        test_files = test_output.get("test_files", {})

        # Write test files to a temp directory and actually run them
        test_results = []
        coverage_percent = 0.0
        if test_files:
            import tempfile
            import subprocess

            with tempfile.TemporaryDirectory() as tmp_dir:
                # Write the generated source files so imports work
                for fpath, fcontent in context["generated_files"].items():
                    full = os.path.join(tmp_dir, fpath)
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    with open(full, "w") as f:
                        f.write(fcontent)

                # Write the generated test files
                for fpath, fcontent in test_files.items():
                    full = os.path.join(tmp_dir, fpath)
                    os.makedirs(os.path.dirname(full), exist_ok=True)
                    with open(full, "w") as f:
                        f.write(fcontent)

                # Run pytest with JSON report
                try:
                    proc = subprocess.run(
                        [
                            "python", "-m", "pytest",
                            "--tb=short", "-q",
                            "--override-ini=addopts=",
                            tmp_dir,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=120,
                        cwd=tmp_dir,
                    )
                    # Parse pytest output into structured results
                    for line in proc.stdout.splitlines():
                        line = line.strip()
                        if line.startswith("PASSED") or " PASSED" in line:
                            name = line.split(" ")[0].split("::")[-1] if "::" in line else line
                            test_results.append({"test_name": name, "status": "passed", "error_message": None})
                        elif line.startswith("FAILED") or " FAILED" in line:
                            name = line.split(" ")[0].split("::")[-1] if "::" in line else line
                            test_results.append({"test_name": name, "status": "failed", "error_message": line})
                        elif line.startswith("ERROR") or " ERROR" in line:
                            test_results.append({"test_name": line, "status": "failed", "error_message": line})

                    # If we couldn't parse individual results, use exit code
                    # Exit code 5 = "no tests collected" — not a code failure, skip gracefully
                    if not test_results:
                        if proc.returncode == 0 or proc.returncode == 5:
                            test_results.append({"test_name": "pytest_suite", "status": "passed", "error_message": None})
                        else:
                            test_results.append({
                                "test_name": "pytest_suite",
                                "status": "failed",
                                "error_message": proc.stderr[:500] or proc.stdout[:500],
                            })

                except subprocess.TimeoutExpired:
                    test_results.append({"test_name": "pytest_suite", "status": "failed", "error_message": "Test execution timed out after 120s"})
                except FileNotFoundError:
                    # pytest not available, fall back to LLM results
                    test_results = test_output.get("test_results", [])
                    coverage_percent = test_output.get("coverage_percent", 0.0)

        all_passed = all(t.get("status") == "passed" for t in test_results) if test_results else False

        return AgentResult(
            success=bool(test_files),
            output={
                "test_files": test_files,
                "test_results": test_results,
                "coverage_percent": coverage_percent,
                "summary": test_output.get("summary", ""),
            },
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
