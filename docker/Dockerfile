# syntax=docker/dockerfile:1.7
# Multi-target image: `--target web`, `--target worker`, `--target worker-media`, `--target migrate`.

ARG NODE_VERSION=24-trixie-slim

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# pnpm 12 is a native binary that corepack cannot set up; install the version pinned in
# package.json ("packageManager") with npm instead.
COPY package.json ./
RUN npm install -g "$(node -p "require('./package.json').packageManager")" && pnpm --version

# Downloads every package in the lockfile; this layer only changes with the lockfile.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --store-dir /pnpm/store

FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store
# Server modules create their database and auth clients on import, which `next build` does
# while collecting routes; nothing connects. These placeholders never reach the images.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/build \
    APP_SECRET=build-time-placeholder-not-used-at-runtime \
    pnpm --filter @hubium/web build \
 && pnpm --filter @hubium/worker build

# ── web: Next.js standalone server ──────────────────────────────────────────────
FROM node:${NODE_VERSION} AS web
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
RUN useradd --system --uid 1001 hubium && mkdir -p /data && chown hubium /data
COPY --from=build --chown=hubium /app/apps/web/.next/standalone ./
COPY --from=build --chown=hubium /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=hubium /app/apps/web/public ./apps/web/public
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

# ── migrate: one-shot migrations, storage bucket and idempotent seed ────────────
FROM build AS migrate
WORKDIR /app
CMD ["sh", "-c", "pnpm --filter @hubium/db migrate:deploy && pnpm storage:init && pnpm db:seed --profile ${SEED_PROFILE:-minimal}"]
