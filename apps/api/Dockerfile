# syntax=docker/dockerfile:1
# Build the Fastify API together with the static PWA it serves (ADR-0007:
# no separate web container). Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter @fma/api... --filter @fma/web...
RUN pnpm --filter @fma/web generate
RUN pnpm --filter @fma/api build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Static PWA (apps/api/src/web-app.ts); unset WEB_DIR to serve the api only.
ENV WEB_DIR=/app/web

COPY --from=build /repo/LICENSE ./LICENSE
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/web/.output/public ./web/public
COPY --from=build /repo/apps/web/.output/security-headers.json ./web/security-headers.json

# The api mounts mail-data read-only, but api and worker start in parallel:
# if the api is first to mount a fresh volume, Docker initializes it from
# this directory. Keep it node-owned like the worker image so the worker can
# always write to the volume.
RUN mkdir -p /app/mail-data && chown node:node /app/mail-data

USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
