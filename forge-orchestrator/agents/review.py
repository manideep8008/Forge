"""Review Agent — static analysis, security scan, style check."""

import json
import os

from agents.base import BaseAgent
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a senior code reviewer specializing in code quality and security.
Review the provided code and identify issues.

For each issue, produce a JSON entry:
{
  "issues": [
    {
      "severity": "low|medium|high|critical",
      "file": "path/to/file",
      "line": 42,
      "message": "Description of the issue",
      "suggestion": "How to fix it",
      "category": "security|style|logic|performance|maintainability"
    }
  ],
  "summary": "Overall assessment",
  "passed": true/false
}

Focus on:
- Security vulnerabilities (injection, hardcoded secrets, etc.)
- Logic errors and edge cases
- Code style and conventions
- Performance issues
- Maintainability concerns

Be constructive. Only flag real issues, not style preferences.
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
        if "```json" in response_text:
            response_text = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            response_text = response_text.split("```")[1].split("```")[0].strip()

        try:
            review = json.loads(response_text)
        except json.JSONDecodeError:
            review = {"issues": [], "summary": response_text[:500], "passed": True}

        issues = review.get("issues", [])
        passed = not any(
            i.get("severity") in ("high", "critical") for i in issues
        )

        return AgentResult(
            success=True,
            output={"issues": issues, "summary": review.get("summary", ""), "passed": passed},
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
