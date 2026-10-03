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

# pg_dump/pg_restore for the backup CLI (dist/backup.js, roadmap 6.2); the
# major version must be >= the postgres service (docker-compose.yml).
RUN apk add --no-cache postgresql17-client

COPY --from=build /repo/LICENSE ./LICENSE
COPY --from=build /repo/apps/worker/dist ./dist

USER node
CMD ["node", "dist/main.js"]
