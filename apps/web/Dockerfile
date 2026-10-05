# syntax=docker/dockerfile:1
# Build the Nuxt PWA as static files (SPA, no SSR runtime).
# Build context: repository root.
FROM node:26-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter @fma/web...
RUN pnpm --filter @fma/web generate

# Static files need no node runtime: nginx serves them (~10 MB RSS instead
# of ~80 MB for a node server).
FROM nginx:alpine

# Release version (set by .github/workflows/release.yml from the tag);
# only informational for the static web image. Local builds without the arg stay 0.0.0-dev.
ARG APP_VERSION=0.0.0-dev
ENV APP_VERSION=$APP_VERSION

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/.output/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/LICENSE /LICENSE
COPY --from=build /repo/apps/web/.output/public /usr/share/nginx/html

EXPOSE 3000
