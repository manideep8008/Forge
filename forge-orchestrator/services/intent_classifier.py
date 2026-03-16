"""Intent classifier — categorizes user requests into pipeline types."""

import os

from models.schemas import IntentType
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are an intent classifier for a software development automation system.
Given a user's feature request, classify it into exactly one category:

- feature: New functionality being added
- bugfix: Fixing broken or incorrect behavior
- refactor: Restructuring existing code without changing behavior
- hotfix: Urgent fix for production issues

Respond with ONLY the category name, nothing else."""


async def classify_intent(input_text: str) -> IntentType:
    """Classify user input into an IntentType."""
    model = os.getenv("MODEL_INTENT", "llama3:8b")

    result = await ollama_client.generate(
        prompt=f"Classify this request:\n\n{input_text}",
        model=model,
        system=SYSTEM_PROMPT,
        temperature=0.1,
        max_tokens=20,
    )

    response = result["response"].strip().lower()

    for intent in IntentType:
        if intent.value in response:
            return intent

    return IntentType.FEATURE
