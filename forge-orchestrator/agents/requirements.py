"""Requirements Agent — parses natural language into structured spec."""

import json
import os

from agents.base import BaseAgent
from agents.codegen import _extract_json
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a senior software requirements analyst. Given a feature request in natural language,
produce a structured specification in JSON format with these fields:

{
  "title": "Brief descriptive title",
  "description": "Detailed description of what needs to be built",
  "acceptance_criteria": ["List of specific, testable acceptance criteria"],
  "edge_cases": ["Edge cases and error scenarios to handle"],
  "dependencies": ["External dependencies or prerequisites"],
  "estimated_complexity": "low|medium|high"
}

Be thorough but concise. Focus on what the software should DO.
If the request is a web application, assume it will be built with modern React (Vite) and Node.js.
You may use <think> tags for reasoning, but your final answer must be valid JSON only.
No markdown code fences, no explanations outside of <think> tags."""


class RequirementsAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "requirements"

    def get_model(self) -> str:
        return os.getenv("MODEL_REQUIREMENTS", "deepseek-v3.2:cloud")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("input_text"))

    async def execute(self, context: dict) -> AgentResult:
        input_text = context["input_text"]
        intent = context.get("intent_type", "feature")

        prompt = f"""Analyze this {intent} request and produce a structured specification:

REQUEST:
{input_text}

Respond with valid JSON only."""

        result = await ollama_client.generate(
            prompt=prompt,
            model=self.get_model(),
            system=SYSTEM_PROMPT,
            temperature=0.3,
        )

        response_text = result["response"].strip()
        spec = _extract_json(response_text)
        if spec is None:
            # Fallback: create basic spec from raw response
            spec = {
                "title": input_text[:100],
                "description": response_text[:500],
                "acceptance_criteria": [],
                "edge_cases": [],
                "dependencies": [],
                "estimated_complexity": "medium",
            }

        success = bool(spec.get("acceptance_criteria") or spec.get("description"))
        return AgentResult(
            success=success,
            output=spec,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
