# Shortcuts for the docker compose deployment and local development.
# `make help` lists the targets.

TEST_DB    := fma-test-mariadb
TEST_MAIL  := fma-test-greenmail
TEST_ENV   := DATABASE_URL=mysql://mail:mail@127.0.0.1:33306/mail_test \
              MAIL_ALLOW_PRIVATE_HOSTS=1 MAIL_INSECURE_TRANSPORT=1 \
              GREENMAIL_HOST=127.0.0.1 GREENMAIL_IMAP_PORT=3143 GREENMAIL_SMTP_PORT=3025 \
              GREENMAIL_USER=testuser@example.com GREENMAIL_PASSWORD=secret123

.PHONY: help env up down ps logs setup-code backup upgrade test-services test-services-down check e2e

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-20s %s\n", $$1, $$2}'

env: ## Create .env (never overwrites an existing one)
	./scripts/setup-env.sh

up: ## Build and start the stack, wait until all services are healthy
	docker compose up -d --build --wait

down: ## Stop the stack (data stays)
	docker compose down

ps: ## Service status
	docker compose ps

logs: ## Follow the logs of php and worker
	docker compose logs -f --tail=50 php worker

setup-code: ## Print the first-run setup code (or a new one)
	docker compose exec php php bin/setup-code.php

backup: ## Encrypted backup to ./backups
	./scripts/backup.sh

upgrade: ## Upgrade to origin/main (see docs/operations/upgrade.md)
	./scripts/upgrade.sh main

test-services: ## Start MariaDB (33306) and GreenMail (3143/3025, TLS 3993/3465) for tests; after changes: make test-services-down
	docker start $(TEST_DB) 2>/dev/null || docker run -d --name $(TEST_DB) \
	  -e MARIADB_USER=mail -e MARIADB_PASSWORD=mail -e MARIADB_DATABASE=mail_test \
	  -e MARIADB_ROOT_PASSWORD=root -p 127.0.0.1:33306:3306 mariadb:11 \
	  --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
	docker start $(TEST_MAIL) 2>/dev/null || docker run -d --name $(TEST_MAIL) \
	  -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled -Dgreenmail.users=testuser@example.com:secret123' \
	  -p 127.0.0.1:3143:3143 -p 127.0.0.1:3025:3025 -p 127.0.0.1:3993:3993 -p 127.0.0.1:3465:3465 greenmail/standalone:2.1.14
	@until docker exec $(TEST_DB) healthcheck.sh --connect --innodb_initialized >/dev/null 2>&1; do sleep 1; done
	-docker exec $(TEST_DB) mariadb -uroot -proot -e "CREATE DATABASE IF NOT EXISTS mail_e2e; GRANT ALL ON mail_e2e.* TO 'mail'@'%'"

test-services-down: ## Remove the test containers
	docker rm -f $(TEST_DB) $(TEST_MAIL)

check: test-services ## Lint, format, typecheck, tests and build (as in CI), plus PHP integration tests
	pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
	cd apps/server-php && composer cs && composer analyse && composer test && $(TEST_ENV) composer test:integration

e2e: test-services ## Browser tests against a local stack (pnpm build first)
	cd e2e && $(TEST_ENV) E2E_DATABASE_URL=mysql://mail:mail@127.0.0.1:33306/mail_e2e pnpm e2e
