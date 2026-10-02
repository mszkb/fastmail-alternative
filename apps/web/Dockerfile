# syntax=docker/dockerfile:1
# Build the Nuxt PWA. Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /repo

RUN corepack enable

COPY . .

RUN pnpm install --frozen-lockfile --filter @fma/web...
RUN pnpm --filter @fma/web build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /repo/LICENSE ./LICENSE
COPY --from=build /repo/apps/web/.output ./.output

USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
