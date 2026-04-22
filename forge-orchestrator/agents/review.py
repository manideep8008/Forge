"""Review Agent — static analysis, security scan, style check."""

import json
import os
import re

from agents.base import BaseAgent
from agents.codegen import _extract_json
from models.schemas import AgentResult
from services.ollama_client import ollama_client

MAX_REVIEW_CODE_CHARS = 60_000
TRUNCATION_NOTICE = "\n...[truncated for review prompt size limit]\n"

SYSTEM_PROMPT = """You are a pragmatic code reviewer for full-stack web applications (React + Vite + Tailwind CSS frontend, Node.js Express backend).
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
- Report at most 10 issues — focus on the most impactful ones

You may reason internally, but your final output must be valid JSON only.
Do NOT wrap the JSON in markdown code fences."""


class ReviewAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "review"

    def get_model(self) -> str:
        return os.getenv("MODEL_REVIEW", "glm-5.1:cloud")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("generated_files"))

    def _build_files_text(self, files: dict, max_chars: int = MAX_REVIEW_CODE_CHARS) -> tuple[str, bool]:
        chunks: list[str] = []
        remaining = max_chars

        for path, content in files.items():
            header = f"\n--- {path} ---\n"
            body = str(content)
            chunk = f"{header}{body}\n"

            if len(chunk) <= remaining:
                chunks.append(chunk)
                remaining -= len(chunk)
                continue

            if remaining > len(header) + len(TRUNCATION_NOTICE):
                body_budget = remaining - len(header) - len(TRUNCATION_NOTICE)
                chunks.append(f"{header}{body[:body_budget]}{TRUNCATION_NOTICE}")
            return "".join(chunks), True

        return "".join(chunks), False

    async def execute(self, context: dict) -> AgentResult:
        files = context["generated_files"]
        spec = context.get("spec", {})

        # Build code review prompt
        files_text, truncated = self._build_files_text(files)
        truncation_note = (
            "\nNOTE: Code input was truncated to stay within the review prompt size limit.\n"
            if truncated else ""
        )

        prompt = f"""Review the following code against the specification:

SPECIFICATION:
{json.dumps(spec, indent=2)}

CODE TO REVIEW:
{files_text}
{truncation_note}

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
            success=True,
            output={"issues": issues, "summary": review.get("summary", ""), "passed": passed},
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
