# syntax=docker/dockerfile:1.6
# Multi-stage build with two final targets: `api` (Node) and `web` (nginx static).

ARG NODE_VERSION=20-alpine

# ── Base with pnpm via corepack ──────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /repo

# ── Install workspace deps (cached unless lockfile/manifests change) ─────────
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ── Build both packages ──────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN pnpm --filter gateway-client build \
 && pnpm --filter gateway-server build

# ── Produce a self-contained server bundle (prod deps only) ──────────────────
FROM build AS api-deploy
RUN pnpm deploy --filter=gateway-server --prod /out

# ── Final API image ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS api
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4000
COPY --from=api-deploy /out/dist ./dist
COPY --from=api-deploy /out/node_modules ./node_modules
COPY --from=api-deploy /out/package.json ./package.json
EXPOSE 4000
CMD ["node", "dist/index.js"]

# ── Final Web image (static SPA) ─────────────────────────────────────────────
FROM nginx:alpine AS web
COPY --from=build /repo/client/dist /usr/share/nginx/html
COPY deploy/nginx.web.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
