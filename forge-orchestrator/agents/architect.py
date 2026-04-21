"""Architect Agent — analyzes codebase and designs file plan."""

import json
import os

from agents.base import BaseAgent
from agents.codegen import _extract_json
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a senior software architect. You design full-stack web applications.
Given a specification, understand what the user wants to build and design the best architecture for it.

Every app you design is a full-stack web application with:
- Frontend: React (Vite) + Tailwind CSS — prioritize a beautiful, modern, polished UI/UX.
- Backend (if needed): Node.js (Express) or Python (FastAPI) for APIs and data persistence.
- Always include all necessary config files: package.json, vite.config.js, index.html, src/main.jsx, src/App.jsx, etc.
- Use a flat file structure — avoid deeply nested directories.

Focus on the user's intent. If they say "build a calendar app", think about what makes a great calendar — 
intuitive navigation, clean layout, responsive design — not just the technical implementation.

Produce a JSON object with exactly these keys:
{
  "file_plan": {
    "files_to_create": ["path/to/file.ext"],
    "files_to_modify": [],
    "files_to_delete": []
  },
  "architecture_decisions": [
    "Decision 1: why this approach best serves the user's goal"
  ],
  "dependency_graph": {
    "file1.ext": ["file2.ext"]
  },
  "implementation_order": ["file1.ext", "file2.ext"]
}

Rules:
- List ALL files the codegen agent will need — missing files cause build failures.
- implementation_order must respect the dependency_graph (dependencies first).
- You may reason internally, but your final output must be valid JSON only.
- Do NOT wrap the JSON in markdown code fences.
- Do NOT include any text outside the JSON object."""


class ArchitectAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "architect"

    def get_model(self) -> str:
        return os.getenv("MODEL_ARCHITECT", "glm-5.1:cloud")

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
        plan = _extract_json(response_text)
        if plan is None:
            plan = {
                "file_plan": {"files_to_create": [], "files_to_modify": [], "files_to_delete": []},
                "architecture_decisions": [response_text[:500]],
                "dependency_graph": {},
                "implementation_order": [],
            }

        success = bool(
            plan.get("file_plan", {}).get("files_to_create")
            or plan.get("file_plan", {}).get("files_to_modify")
        )
        return AgentResult(
            success=success,
            output=plan,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
