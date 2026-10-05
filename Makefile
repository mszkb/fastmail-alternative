# Shortcuts for the docker compose deployment and local development.
# `make help` lists the targets.

TEST_PG    := fma-test-pg
TEST_MAIL  := fma-test-greenmail
TEST_ENV   := DATABASE_URL=postgres://mail:mail@127.0.0.1:55432/mail_test \
              MAIL_ALLOW_PRIVATE_HOSTS=1 MAIL_INSECURE_TRANSPORT=1 \
              GREENMAIL_HOST=127.0.0.1 GREENMAIL_IMAP_PORT=3143 GREENMAIL_SMTP_PORT=3025 \
              GREENMAIL_USER=testuser@example.com GREENMAIL_PASSWORD=secret123

.PHONY: help env up down ps logs setup-code backup upgrade test-services test-services-down check e2e

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-20s %s\n", $$1, $$2}'

env: ## Create .env (never overwrites an existing one)
	node scripts/setup-env.mjs

up: ## Build and start the stack, wait until all services are healthy
	docker compose up -d --build --wait

down: ## Stop the stack (data stays)
	docker compose down

ps: ## Service status
	docker compose ps

logs: ## Follow the logs of api and worker
	docker compose logs -f --tail=50 api worker

setup-code: ## Print the first-run setup code
	docker compose logs api | grep "FIRST-RUN SETUP CODE"

backup: ## Encrypted backup to ./backups
	./scripts/backup.sh

upgrade: ## Upgrade to origin/main (see docs/operations/upgrade.md)
	./scripts/upgrade.sh main

test-services: ## Start PostgreSQL (55432) and GreenMail (3143/3025) for tests
	docker start $(TEST_PG) 2>/dev/null || docker run -d --name $(TEST_PG) \
	  -e POSTGRES_USER=mail -e POSTGRES_PASSWORD=mail -e POSTGRES_DB=mail_test \
	  -p 127.0.0.1:55432:5432 postgres:17-alpine
	docker start $(TEST_MAIL) 2>/dev/null || docker run -d --name $(TEST_MAIL) \
	  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=testuser@example.com:secret123' \
	  -p 127.0.0.1:3143:3143 -p 127.0.0.1:3025:3025 greenmail/standalone:2.1.14
	@until docker exec $(TEST_PG) pg_isready -U mail -q; do sleep 1; done
	-docker exec $(TEST_PG) createdb -U mail mail_e2e 2>/dev/null

test-services-down: ## Remove the test containers
	docker rm -f $(TEST_PG) $(TEST_MAIL)

check: test-services ## Lint, format, typecheck, tests and build (as in CI)
	pnpm lint && pnpm format:check && pnpm typecheck && $(TEST_ENV) pnpm test && pnpm build

e2e: test-services ## Browser tests against a local stack (pnpm build first)
	cd e2e && $(TEST_ENV) E2E_DATABASE_URL=postgres://mail:mail@127.0.0.1:55432/mail_e2e pnpm e2e
