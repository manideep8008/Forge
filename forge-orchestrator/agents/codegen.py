"""Codegen Agent — generates code and creates git branches."""

from __future__ import annotations

import json
import os
import re
from typing import Any

import structlog

from agents.base import BaseAgent
from models.schemas import AgentResult, CodegenOutputError, RetryDecision
from services.ollama_client import ollama_client

logger = structlog.get_logger()

SYSTEM_PROMPT = """You are an expert full-stack web developer. You build beautiful, production-quality web applications.

Your stack is ALWAYS:
- Frontend: React (Vite) + Tailwind CSS — prioritize stunning, modern, polished UI/UX.
- Backend: Node.js (Express) for APIs and server logic.
- Database: Add SQLite, PostgreSQL, or MongoDB only when the app needs data persistence.
- Services: Add Redis, WebSockets, etc. only when the app genuinely needs them.

Given a specification and file plan, generate the actual code for each file.

The JSON must have this exact structure:
{
  "files": {
    "path/to/file.jsx": "file content here...",
    "path/to/server.js": "file content here..."
  },
  "branch": "feat/<descriptive-branch-name>",
  "commit_message": "feat: descriptive commit message"
}

Rules:
- Write production-quality, well-structured code with beautiful UI
- Always include ALL config files: package.json (with dev, build, start scripts), vite.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.jsx, etc.
- Make the UI visually impressive — use gradients, animations, proper spacing, modern design patterns
- Include proper error handling and loading states
- If previous review issues or test failures are provided, fix them
- You may use thinking tags internally, but ensure the final output is clean JSON
- Output ONLY the JSON object — no ```json blocks, no extra text"""


def _extract_json(text: str) -> dict | None:
    """Try multiple strategies to extract a JSON object from LLM output."""
    # Strip thinking tags (qwen, deepseek, etc.) — multiple formats
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"<\|think\|>.*?<\|/think\|>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"<thinking>.*?</thinking>", "", text, flags=re.DOTALL).strip()
    # Strip unclosed thinking tags (model cut off before closing)
    text = re.sub(r"<think>.*", "", text, flags=re.DOTALL).strip()

    # Strategy 1: Direct parse
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Strategy 2: Extract from ```json ... ``` blocks
    json_blocks = re.findall(r"```json\s*(.*?)```", text, re.DOTALL)
    for block in json_blocks:
        try:
            return json.loads(block.strip())
        except json.JSONDecodeError:
            continue

    # Strategy 3: Extract from ``` ... ``` blocks
    code_blocks = re.findall(r"```\s*(.*?)```", text, re.DOTALL)
    for block in code_blocks:
        try:
            return json.loads(block.strip())
        except json.JSONDecodeError:
            continue

    # Strategy 3.5: Find first { and last } and try to parse that slice
    first_brace = text.find("{")
    last_brace = text.rfind("}")
    if first_brace != -1 and last_brace > first_brace:
        candidate = text[first_brace : last_brace + 1]
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            # Try fixing truncated JSON by closing open strings/braces
            repaired = _repair_truncated_json(candidate)
            if repaired:
                try:
                    return json.loads(repaired)
                except json.JSONDecodeError:
                    pass

    # Strategy 4: Find the LARGEST valid { ... } block
    brace_depth = 0
    start = None
    candidates = []
    for i, ch in enumerate(text):
        if ch == "{":
            if brace_depth == 0:
                start = i
            brace_depth += 1
        elif ch == "}":
            brace_depth -= 1
            if brace_depth == 0 and start is not None:
                try:
                    obj = json.loads(text[start : i + 1])
                    candidates.append((i + 1 - start, obj))
                except json.JSONDecodeError:
                    pass
                start = None

    if candidates:
        # Return the largest valid JSON block
        candidates.sort(key=lambda x: x[0], reverse=True)
        return candidates[0][1]

    return None


def _repair_truncated_json(text: str) -> str | None:
    """Attempt to repair truncated JSON by closing open structures."""
    # Common case: LLM output cut off, leaving unclosed strings/objects/arrays
    # Try progressively adding closing chars
    closers = ['"', "}", "]", "}", "]", "}"]
    repaired = text
    for closer in closers:
        try:
            json.loads(repaired)
            return repaired
        except json.JSONDecodeError as e:
            msg = str(e).lower()
            if "unterminated string" in msg:
                repaired += '"'
            elif "expecting ',' " in msg or "expecting '}'" in msg:
                repaired += "}"
            elif "expecting ']'" in msg:
                repaired += "]"
            else:
                repaired += "}"
    try:
        json.loads(repaired)
        return repaired
    except json.JSONDecodeError:
        return None


class CodegenAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "codegen"

    def get_model(self) -> str:
        return os.getenv("MODEL_CODEGEN", "qwen3-coder-next:cloud")

    async def validate(self, context: dict) -> bool:
        # Normal mode needs spec + file_plan; modification mode just needs existing_files + request
        if context.get("modification_request"):
            return bool(context.get("existing_files"))
        return bool(context.get("spec") and context.get("file_plan"))

    async def on_failure(self, context: dict, error: Exception) -> RetryDecision:
        return RetryDecision.RETRY

    async def execute(self, context: dict) -> AgentResult:
        modification_request = context.get("modification_request", "")
        existing_files = context.get("existing_files", {})
        review_issues = context.get("review_issues", [])
        test_results = context.get("test_results", [])

        # ── Modification mode: diff-aware prompt ──────────────────────────────
        if modification_request and existing_files:
            file_list = "\n".join(
                f"### {path}\n```\n{content[:800]}{'...(truncated)' if len(content) > 800 else ''}\n```"
                for path, content in list(existing_files.items())[:20]
            )
            prompt = f"""You are modifying an existing codebase. Return ONLY the files that need to change.

USER REQUEST: {modification_request}

EXISTING FILES:
{file_list}

Instructions:
- Analyse which files need to be created or modified to fulfil the request
- Return ONLY those files in the JSON — do NOT include unchanged files
- The unchanged files will be merged automatically
- Output ONLY the JSON object. Start with {{"""
        else:
            # ── Normal mode: full generation ─────────────────────────────────
            spec = context["spec"]
            file_plan = context["file_plan"]
            prompt = f"""Generate code based on this specification and file plan.
Output ONLY a JSON object with "files", "branch", and "commit_message" keys. No other text.

SPECIFICATION:
{json.dumps(spec, indent=2)}

FILE PLAN:
{json.dumps(file_plan, indent=2)}
"""

        # Appended to both normal and diff-aware prompts when looping
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
        prompt += '\nRespond with ONLY the JSON object. Start your response with {'

        # Use smaller token budget on retries (fixing issues doesn't need full output)
        is_retry = bool(review_issues or test_results)
        result = await ollama_client.generate(
            prompt=prompt,
            model=self.get_model(),
            system=SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=8192 if is_retry else 32768,
        )

        response_text = result["response"].strip()
        output = _extract_json(response_text)

        if output is None:
            parse_detail = ""
            try:
                json.loads(response_text)
            except json.JSONDecodeError as e:
                parse_detail = str(e)[:200]
            raise CodegenOutputError(
                message="LLM output could not be parsed as JSON",
                parse_error=parse_detail,
                response_snippet=response_text[:500],
            )

        # Validate schema: files must be a dict.
        files = output.get("files")
        if not isinstance(files, dict):
            raise CodegenOutputError(
                message=f"LLM output 'files' field must be a dict, got {type(files).__name__}",
                response_snippet=response_text[:500],
            )

        return AgentResult(
            success=bool(files),
            output=output,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
            error=None if files else "No files generated",
        )
