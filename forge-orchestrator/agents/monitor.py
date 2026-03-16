"""Monitor Agent — health checks, log analysis, rollback decisions."""

import json
import os

import httpx
from agents.base import BaseAgent
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a site reliability engineer. Analyze deployment health data
and decide if the deployment is healthy or needs rollback.

Given health check data, produce a JSON response:
{
  "health_status": {
    "healthy": true/false,
    "error_rate": 0.02,
    "response_time_ms": 150,
    "checks_passed": 5,
    "checks_total": 5
  },
  "should_rollback": false,
  "rollback_reason": null,
  "recommendations": ["List of recommendations"]
}

Rollback if:
- Error rate > 5%
- Response time > 5000ms
- Health checks failing > 50%

Always respond with valid JSON only."""

ERROR_RATE_THRESHOLD = 0.05
RESPONSE_TIME_THRESHOLD = 5000


class MonitorAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "monitor"

    def get_model(self) -> str:
        return os.getenv("MODEL_MONITOR", "phi3:mini")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("pipeline_id"))

    async def execute(self, context: dict) -> AgentResult:
        pipeline_id = context["pipeline_id"]
        deploy_url = context.get("deploy_url", "")
        docker_image = context.get("docker_image", "")

        # Collect health data
        health_data = await self._check_health(deploy_url, pipeline_id)

        prompt = f"""Analyze this deployment health data and determine if rollback is needed:

DEPLOYMENT:
- Pipeline: {pipeline_id}
- Image: {docker_image}
- URL: {deploy_url}

HEALTH DATA:
{json.dumps(health_data, indent=2)}

Respond with valid JSON only."""

        result = await ollama_client.generate(
            prompt=prompt,
            model=self.get_model(),
            system=SYSTEM_PROMPT,
            temperature=0.1,
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
                "health_status": health_data,
                "should_rollback": False,
                "recommendations": [],
            }

        return AgentResult(
            success=True,
            output=output,
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )

    async def _check_health(self, deploy_url: str, pipeline_id: str) -> dict:
        """Perform basic health checks on deployed service."""
        if not deploy_url:
            return {
                "healthy": True,
                "error_rate": 0.0,
                "response_time_ms": 0,
                "checks_passed": 0,
                "checks_total": 0,
                "note": "No deploy URL — skipping live checks",
            }

        docker_svc_url = os.getenv("DOCKER_SVC_URL", "http://forge-docker-svc:8082")

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{docker_svc_url}/docker/health/{pipeline_id}")
                if resp.status_code == 200:
                    return resp.json()
        except Exception:
            pass

        return {
            "healthy": True,
            "error_rate": 0.0,
            "response_time_ms": 0,
            "checks_passed": 0,
            "checks_total": 0,
            "note": "Health check service unavailable — assuming healthy",
        }
