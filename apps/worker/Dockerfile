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

COPY --from=build /repo/LICENSE ./LICENSE
COPY --from=build /repo/apps/worker/dist ./dist

USER node
CMD ["node", "dist/main.js"]
