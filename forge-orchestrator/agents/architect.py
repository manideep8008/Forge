"""Architect Agent — analyzes codebase and designs file plan."""

import json
import os

from agents.base import BaseAgent
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a senior software architect. Given a specification, design the implementation plan.

Produce a JSON response with:
{
  "file_plan": {
    "files_to_create": ["path/to/new/file.py"],
    "files_to_modify": ["path/to/existing/file.py"],
    "files_to_delete": []
  },
  "architecture_decisions": [
    "Decision 1: Use X pattern because Y",
    "Decision 2: Choose A over B because C"
  ],
  "dependency_graph": {
    "file1.py": ["file2.py", "file3.py"]
  },
  "implementation_order": ["file1.py", "file2.py"]
}

Consider: separation of concerns, testability, existing patterns, minimal changes.
Always respond with valid JSON only."""


class ArchitectAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "architect"

    def get_model(self) -> str:
        return os.getenv("MODEL_ARCHITECT", "llama3:8b")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("spec"))

    async def execute(self, context: dict) -> AgentResult:
        spec = context["spec"]

        prompt = f"""Design the implementation plan for this specification:

SPECIFICATION:
{json.dumps(spec, indent=2)}

Consider the existing codebase structure and produce a file plan with architecture decisions.
Respond with valid JSON only."""

        result = await ollama_client.generate(
            prompt=prompt,
            model=self.get_model(),
            system=SYSTEM_PROMPT,
            temperature=0.3,
        )

        response_text = result["response"].strip()
        if "```json" in response_text:
            response_text = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            response_text = response_text.split("```")[1].split("```")[0].strip()

        try:
            plan = json.loads(response_text)
        except json.JSONDecodeError:
            plan = {
                "file_plan": {"files_to_create": [], "files_to_modify": [], "files_to_delete": []},
                "architecture_decisions": [response_text[:500]],
                "dependency_graph": {},
                "implementation_order": [],
            }

        return AgentResult(
            success=True,
            output=plan,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
