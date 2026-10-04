# syntax=docker/dockerfile:1
# Build the worker. Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter @fma/worker...
RUN pnpm --filter @fma/worker build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Release version (set by .github/workflows/release.yml from the tag);
# reported by /api/health. Local builds without the arg stay 0.0.0-dev.
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

# pg_dump/pg_restore for the backup CLI (dist/backup.js, roadmap 6.2); the
# major version must be >= the postgres service (docker-compose.yml).
RUN apk add --no-cache postgresql17-client

COPY --from=build /repo/LICENSE ./LICENSE
COPY --from=build /repo/apps/worker/dist ./dist

# Owned by the runtime user: when Docker initializes the mail-data volume
# from this directory, the worker (USER node) must be able to create
# account/message directories in it.
RUN mkdir -p /app/mail-data && chown node:node /app/mail-data

USER node
CMD ["node", "dist/main.js"]
