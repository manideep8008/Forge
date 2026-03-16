"""Codegen Agent — generates code and creates git branches."""

import json
import os

from agents.base import BaseAgent
from models.schemas import AgentResult, RetryDecision
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are an expert software engineer. Given a specification and file plan,
generate the actual code for each file.

Produce a JSON response with:
{
  "files": {
    "path/to/file.py": "file content here...",
    "path/to/another.py": "file content here..."
  },
  "branch": "feat/<descriptive-branch-name>",
  "commit_message": "feat: descriptive commit message"
}

Rules:
- Write production-quality, well-structured code
- Follow the language's conventions and best practices
- Include proper error handling
- Add docstrings/comments where needed
- If previous review issues or test failures are provided, fix them
- Always respond with valid JSON only"""


class CodegenAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "codegen"

    def get_model(self) -> str:
        return os.getenv("MODEL_CODEGEN", "codellama:13b")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("spec") and context.get("file_plan"))

    async def on_failure(self, context: dict, error: Exception) -> RetryDecision:
        return RetryDecision.RETRY

    async def execute(self, context: dict) -> AgentResult:
        spec = context["spec"]
        file_plan = context["file_plan"]
        review_issues = context.get("review_issues", [])
        test_results = context.get("test_results", [])

        prompt = f"""Generate code based on this specification and file plan:

SPECIFICATION:
{json.dumps(spec, indent=2)}

FILE PLAN:
{json.dumps(file_plan, indent=2)}
"""

        if review_issues:
            prompt += f"""
PREVIOUS REVIEW ISSUES (fix these):
{json.dumps(review_issues, indent=2)}
"""

        if test_results:
            failed = [t for t in test_results if t.get("status") == "failed"]
            if failed:
                prompt += f"""
FAILED TESTS (fix the code so these pass):
{json.dumps(failed, indent=2)}
"""

        prompt += "\nRespond with valid JSON only."

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
            output = json.loads(response_text)
        except json.JSONDecodeError:
            output = {
                "files": {},
                "branch": f"feat/{context.get('pipeline_id', 'unknown')}",
                "commit_message": "feat: generated code",
            }

        return AgentResult(
            success=bool(output.get("files")),
            output=output,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
            error="No files generated" if not output.get("files") else None,
        )
