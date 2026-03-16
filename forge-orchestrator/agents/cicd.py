"""CI/CD Agent — builds Docker images and deploys containers."""

import json
import os

import httpx
from agents.base import BaseAgent
from models.schemas import AgentResult
from services.ollama_client import ollama_client

SYSTEM_PROMPT = """You are a DevOps engineer. Given code and deployment context,
generate a Dockerfile and deployment configuration.

Produce a JSON response with:
{
  "dockerfile": "FROM python:3.12-slim\\n...",
  "docker_compose_override": {},
  "deploy_config": {
    "port": 8000,
    "env_vars": {},
    "health_check_path": "/health"
  },
  "summary": "Deployment plan description"
}

Always respond with valid JSON only."""


class CICDAgent(BaseAgent):

    @property
    def name(self) -> str:
        return "cicd"

    def get_model(self) -> str:
        return os.getenv("MODEL_CICD", "llama3:8b")

    async def validate(self, context: dict) -> bool:
        return bool(context.get("generated_files") or context.get("git_branch"))

    async def execute(self, context: dict) -> AgentResult:
        pipeline_id = context["pipeline_id"]
        files = context.get("generated_files", {})
        branch = context.get("git_branch", "")

        files_text = ""
        for path, content in files.items():
            files_text += f"\n--- {path} ---\n{content}\n"

        prompt = f"""Create deployment configuration for this code:

BRANCH: {branch}
FILES:
{files_text}

Generate Dockerfile and deployment config. Respond with valid JSON only."""

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
            output = json.loads(response_text)
        except json.JSONDecodeError as e:
            # We log the error but swallow it to use fallback logic below
            print(f"CICD Agent JSON Error: {e}\nRaw Text:\n{response_text}")
            output = {
                "dockerfile": "",
                "deploy_config": {"port": 8080},
                "summary": "Failed to parse deployment config; using fallback.",
            }

        # Robust Dockerfile fallback
        dockerfile_content = output.get("dockerfile", "")
        if not dockerfile_content and "Dockerfile" in files:
            dockerfile_content = files["Dockerfile"]
            
        if not dockerfile_content:
            if any(f.endswith(".go") for f in files):
                dockerfile_content = "FROM golang:1.22-alpine\nWORKDIR /app\nCOPY . .\nRUN go build -o main ./cmd/... || go build -o main .\nCMD [\"./main\"]"
            elif any("package.json" in f for f in files):
                dockerfile_content = "FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install\nCMD [\"npm\", \"start\"]"
            else:
                dockerfile_content = "FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install fastapi uvicorn httpx || true\nRUN pip install -r requirements.txt || true\nCMD [\"python\", \"-m\", \"uvicorn\", \"main:app\", \"--host\", \"0.0.0.0\", \"--port\", \"8000\"]"
                
        output["dockerfile"] = dockerfile_content

        # Write generated files and Dockerfile to /workspace/pipeline_id
        # Both forge-orchestrator and forge-docker-svc mount the same /workspace volume
        context_path = f"/workspace/{pipeline_id}"
        os.makedirs(context_path, exist_ok=True)
        
        # Write the dockerfile
        dockerfile_content = output.get("dockerfile", "")
        if dockerfile_content:
            with open(os.path.join(context_path, "Dockerfile"), "w") as f:
                f.write(dockerfile_content)
                
        # Write all generated source files
        for fpath, fcontent in files.items():
            full_path = os.path.join(context_path, fpath)
            os.makedirs(os.path.dirname(full_path), exist_ok=True)
            with open(full_path, "w") as f:
                f.write(fcontent)

        # Call Docker service to build and deploy
        docker_svc_url = os.getenv("DOCKER_SVC_URL", "http://forge-docker-svc:8082")
        image_tag = f"forge-{pipeline_id}:latest"
        deploy_data = {}
        docker_error = None
        
        target_port = str(output.get("deploy_config", {}).get("port", 8000))

        try:
            async with httpx.AsyncClient(timeout=120) as client:
                build_resp = await client.post(
                    f"{docker_svc_url}/docker/build",
                    json={"pipeline_id": pipeline_id, "tag": image_tag, "context_path": context_path},
                )
                if build_resp.status_code != 200:
                    docker_error = f"Docker build failed ({build_resp.status_code}): {build_resp.text}"
                else:
                    deploy_resp = await client.post(
                        f"{docker_svc_url}/docker/deploy",
                        json={"pipeline_id": pipeline_id, "image": image_tag, "port": target_port},
                    )
                    if deploy_resp.status_code != 200:
                        docker_error = f"Docker deploy failed ({deploy_resp.status_code}): {deploy_resp.text}"
                    else:
                        deploy_data = deploy_resp.json()
        except Exception as exc:
            docker_error = f"Docker service unreachable: {exc}"

        return AgentResult(
            success=docker_error is None,
            error=docker_error,
            output={
                "image": image_tag,
                "deploy_url": deploy_data.get("url", ""),
                "dockerfile": output.get("dockerfile", ""),
                "deploy_config": output.get("deploy_config", {}),
                "summary": output.get("summary", ""),
                "context_path": context_path,
            },
            tokens_used=result["tokens_used"],
            model_used=result["model"],
        )
