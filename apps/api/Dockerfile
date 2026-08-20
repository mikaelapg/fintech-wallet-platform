# syntax=docker/dockerfile:1.7
# Build context: repository root (docker build -f apps/api/Dockerfile .)

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @wallet/api
COPY apps/api apps/api
RUN pnpm --filter @wallet/api build \
 && pnpm --filter @wallet/api deploy --prod --legacy /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# Never run as root inside the container.
USER node
EXPOSE 3333
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3333/health/live || exit 1
CMD ["node", "dist/main.js"]
