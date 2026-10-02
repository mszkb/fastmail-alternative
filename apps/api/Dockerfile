# syntax=docker/dockerfile:1
# Build the Fastify API. Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter @fma/api...
RUN pnpm --filter @fma/api build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/LICENSE ./LICENSE
COPY --from=build /repo/apps/api/dist ./dist

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
