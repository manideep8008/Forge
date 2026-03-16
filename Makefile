.PHONY: up down restart logs test clean status pull

# Start all services
up:
	docker compose up -d --build

# Stop all services
down:
	docker compose down

# Restart all services
restart: down up

# View logs (all or specific service)
logs:
	docker compose logs -f $(SVC)

# Run tests
test:
	docker compose exec forge-orchestrator python -m pytest tests/ -v

# Clean everything (volumes too)
clean:
	docker compose down -v --remove-orphans

# Show service status
status:
	docker compose ps

# Pull latest images
pull:
	docker compose pull

# Pull Ollama models
models:
	docker compose exec forge-ollama ollama pull llama3:8b
	docker compose exec forge-ollama ollama pull codellama:13b
	docker compose exec forge-ollama ollama pull phi3:mini

# Database shell
db:
	docker compose exec forge-postgres psql -U forge -d forge

# Redis CLI
redis:
	docker compose exec forge-redis redis-cli
