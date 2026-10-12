# syntax=docker/dockerfile:1.7
# Multi-target image: `--target web`, `--target worker`, `--target migrate`.

ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc* ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma
COPY packages/db/prisma.config.ts packages/db/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ui/package.json packages/ui/
COPY packages/tooling/package.json packages/tooling/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @hubium/db generate

FROM deps AS build
COPY . .
RUN pnpm --filter @hubium/db generate \
 && pnpm --filter @hubium/web build \
 && pnpm --filter @hubium/worker build

# ── web: Next.js standalone server ──────────────────────────────────────────────
FROM node:${NODE_VERSION} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 1001 hubium && mkdir -p /data && chown hubium /data
COPY --from=build --chown=hubium /app/apps/web/.next/standalone ./
COPY --from=build --chown=hubium /app/apps/web/.next/static ./apps/web/.next/static
USER hubium
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

# ── worker: bundled pg-boss consumers ───────────────────────────────────────────
FROM node:${NODE_VERSION} AS worker
ENV NODE_ENV=production
WORKDIR /app
RUN useradd --system --uid 1001 hubium && mkdir -p /data && chown hubium /data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/
USER hubium
WORKDIR /app/apps/worker
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.mjs"]

# ── worker-media: worker + ffmpeg for video transcoding ─────────────────────────
FROM worker AS worker-media
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
USER hubium
ENV WORKER_QUEUES=media

# ── migrate: one-shot migrations + idempotent seed ──────────────────────────────
FROM build AS migrate
WORKDIR /app
CMD ["sh", "-c", "pnpm --filter @hubium/db migrate:deploy && pnpm db:seed --profile ${SEED_PROFILE:-minimal}"]
