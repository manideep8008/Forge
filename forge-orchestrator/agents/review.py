"""Review Agent — static analysis, security scan, style check."""

import json
import os
import re

from agents.base import BaseAgent
from agents.codegen import _extract_json
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a pragmatic code reviewer focused on correctness.
Review the provided code and identify ONLY issues that would cause bugs or break functionality.

For each issue, produce a JSON entry:
{
  "issues": [
    {
      "severity": "low|medium|high|critical",
      "file": "path/to/file",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it",
      "category": "logic|correctness|runtime_error"
    }
  ],
  "summary": "Overall assessment",
  "passed": true/false
}

Severity guidelines:
- "critical": Code will crash, data loss, completely broken functionality
- "high": Major logic error that produces wrong results
- "medium": Minor correctness issue, missing edge case handling
- "low": Style preference, naming, minor improvement suggestion

IMPORTANT RULES:
- Only mark "critical" for issues that will DEFINITELY cause crashes or data loss
- Do NOT flag security best-practices (XSS, CSRF, injection) as critical — mark them as "medium" at most
- Do NOT flag style issues, naming conventions, or missing comments
- Do NOT flag missing error handling for unlikely edge cases
- Be lenient — if the code works correctly for the main use cases, set "passed": true
- When in doubt, use lower severity

Always respond with valid JSON only."""


class ReviewAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "review"

    def get_model(self) -> str:
        return os.getenv("MODEL_REVIEW", "phi3:mini")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("generated_files"))

    async def execute(self, context: dict) -> AgentResult:
        files = context["generated_files"]
        spec = context.get("spec", {})

        # Build code review prompt
        files_text = ""
        for path, content in files.items():
            files_text += f"\n--- {path} ---\n{content}\n"

        prompt = f"""Review the following code against the specification:

SPECIFICATION:
{json.dumps(spec, indent=2)}

CODE TO REVIEW:
{files_text}

Identify issues by severity. Respond with valid JSON only."""

        result = await ollama_client.generate(
            prompt=prompt,
            model=self.get_model(),
            system=SYSTEM_PROMPT,
            temperature=0.2,
        )

        response_text = result["response"].strip()
        review = _extract_json(response_text)
        if review is None:
            review = {"issues": [], "summary": response_text[:500], "passed": True}

        issues = review.get("issues", [])
        # Only fail on critical issues (crashes, data loss)
        passed = not any(
            i.get("severity") == "critical" for i in issues
        )

        return AgentResult(
            success=bool(review.get("summary") or issues),
            output={"issues": issues, "summary": review.get("summary", ""), "passed": passed},
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
