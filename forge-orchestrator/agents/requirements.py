"""Requirements Agent — parses natural language into structured spec."""

import json
import os

from agents.base import BaseAgent
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

Be thorough but concise. Focus on what the software should DO, not how to implement it.
Always respond with valid JSON only, no markdown or explanation."""


class RequirementsAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "requirements"

    def get_model(self) -> str:
        return os.getenv("MODEL_REQUIREMENTS", "llama3:8b")

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
        # Try to extract JSON from response
        if "```json" in response_text:
            response_text = response_text.split("```json")[1].split("```")[0].strip()
        elif "```" in response_text:
            response_text = response_text.split("```")[1].split("```")[0].strip()

        try:
            spec = json.loads(response_text)
        except json.JSONDecodeError:
            # Fallback: create basic spec from raw response
            spec = {
                "title": input_text[:100],
                "description": response_text,
                "acceptance_criteria": [],
                "edge_cases": [],
                "dependencies": [],
                "estimated_complexity": "medium",
            }

        return AgentResult(
            success=True,
            output=spec,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
