# Forge - AI-Powered Development Platform

## Overview
Forge is a microservices-based LLM application that orchestrates AI agents for software development tasks (requirements, architecture, code generation, review, testing, CI/CD, monitoring).

## Architecture

```
forge-web (React/TS)  →  forge-gateway (Go)  →  forge-orchestrator (Python/FastAPI)
                                                        ↓
                                               LangGraph Agent Pipeline
                                                        ↓
                                                  Ollama LLM Models
```

### Services
| Service | Language | Port | Purpose |
|---------|----------|------|---------|
| forge-web | TypeScript/React/Vite | 3000 | Frontend UI |
| forge-gateway | Go 1.23 (chi) | 8080 | API gateway, auth (JWT), WebSocket |
| forge-orchestrator | Python (FastAPI) | 8090 | LangGraph agent pipeline, LLM orchestration |
| forge-git-svc | Go 1.23 (chi) | 8081 | Git operations |
| forge-docker-svc | Go 1.23 (chi) | 8082 | Docker operations |

### Data Layer
| Service | Port | Purpose |
|---------|------|---------|
| forge-postgres | 5432 | Primary database (PostgreSQL 16) |
| forge-redis | 6379 | Cache & message queue (Redis 7) |
| forge-chroma | 8000 | Vector database for embeddings |

## Running the App

```bash
# Start all services
docker compose up -d

# Start specific service
docker compose up -d forge-gateway

# Rebuild after code changes
docker compose up -d --build

# View logs
docker compose logs -f <service-name>

# Stop everything
docker compose down
```

## Key Tech Stack

### Frontend (forge-web)
- React 18 + TypeScript 5.6
- Vite 6 (build tool)
- Tailwind CSS 3.4
- React Router DOM 6
- Lucide React (icons)

### Orchestrator (forge-orchestrator)
- FastAPI + Uvicorn
- LangGraph 0.2 (agent workflow framework)
- LangChain Core 0.3
- Ollama 0.4 (LLM client)
- ChromaDB 0.5 (vector store)
- SQLAlchemy 2.0 + asyncpg (async PostgreSQL)
- Pydantic 2.10

### Go Services (gateway, git-svc, docker-svc)
- chi/v5 (HTTP router)
- pgx/v5 (PostgreSQL)
- go-redis/v9
- golang-jwt/jwt/v5
- gorilla/websocket
- zerolog (logging)

## Project Structure

```
Forge/
├── forge-web/              # React frontend
├── forge-gateway/          # Go API gateway
├── forge-orchestrator/     # Python orchestration engine
├── forge-git-svc/          # Go git service
├── forge-docker-svc/       # Go docker service
├── db/migrations/          # PostgreSQL migrations
├── docker-compose.yml      # Container orchestration
├── Makefile                # Task automation
├── .env                    # Environment variables (DO NOT COMMIT)
└── .env.example            # Env template
```

## Environment Variables

Configured in `.env` (see `.env.example` for template). Key vars:
- `OLLAMA_BASE_URL` — LLM endpoint
- `MODEL_*` — Model selections per agent role (requirements, architect, codegen, review, test, cicd, monitor, intent, embedding)
- `JWT_SECRET` — Auth secret
- `POSTGRES_*` — Database config
- `DEV_MODE` — Development mode flag

## Development Notes

- The pipeline uses multiple specialized LLM models (one per agent role)
- WebSocket connections used for real-time pipeline status updates
- All Go services follow chi router patterns with middleware chains
- Python orchestrator uses LangGraph for multi-agent state machines
- Database migrations auto-load on PostgreSQL container startup
