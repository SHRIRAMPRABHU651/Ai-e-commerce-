.PHONY: help install dev build test lint typecheck format seed worker migrate e2e production-check docker-up docker-down clean
help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'
install: ## install dependencies
	npm ci
dev: ## local stack: MongoDB + seed + API + worker + web
	npm run dev
build: ## build api, worker and web
	npm run build
test: ## unit + integration tests (in-memory MongoDB)
	npm test
lint: ## eslint, zero warnings
	npm run lint
typecheck: ## tsc across all workspaces
	npm run typecheck
format: ## prettier
	npm run format
seed: ## load demo data into MONGODB_URI (dev/staging only)
	npm run seed
worker: ## run the worker/scheduler on its own
	npm run worker
migrate: ## create collections + indexes
	npm run migrate
e2e: ## Playwright end-to-end tests (desktop + mobile)
	npm run e2e
production-check: ## lint + typecheck + tests + build + config/secret scan
	npm run production-check
docker-up: ## full stack in Docker (dev defaults) then: docker compose --profile seed run --rm seed
	docker compose up --build -d
docker-down:
	docker compose down
clean:
	rm -rf apps/*/dist apps/web/.next node_modules/.cache test-results playwright-report
