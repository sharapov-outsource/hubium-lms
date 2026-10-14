# syntax=docker/dockerfile:1.7
# Targets:
#   hubium        web server, worker and the hubium command (ENTRYPOINT hubium, CMD web)
#   hubium-media  the same with ffmpeg, running the media worker (video transcoding)
#   bundle        the release archive: --target bundle --output type=local,dest=<dir>
# All three hold the same /opt/hubium, assembled once by scripts/bundle.sh.

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
# Commit shown in the sidebar, on the environment page and by `hubium version` (the context
# has no .git).
ARG BUILD_COMMIT=""
# Server modules create their database and auth clients on import, which `next build` does
# while collecting routes; nothing connects. These placeholders never reach the images.
RUN export BUILD_COMMIT="$BUILD_COMMIT" \
 && DATABASE_URL=postgresql://build:build@127.0.0.1:1/build \
    APP_SECRET=build-time-placeholder-not-used-at-runtime \
    pnpm --filter @hubium/web build \
 && pnpm --filter @hubium/worker build \
 && pnpm --filter @hubium/cli build \
 && sh scripts/bundle.sh /opt/hubium

# ── hubium: web, worker and CLI ─────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS hubium
# Local files live in /data, owned by the app user: unfinished uploads, and with
# STORAGE_DRIVER=fs the files themselves. compose.yml shares one volume there between web
# and the workers.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 \
    STORAGE_FS_ROOT=/data HUBIUM_HOME=/opt/hubium PATH=/opt/hubium/bin:$PATH
RUN useradd --system --uid 1001 hubium && mkdir -p /data && chown hubium /data
COPY --from=build /opt/hubium /opt/hubium
LABEL org.opencontainers.image.title="Hubium LMS" \
      org.opencontainers.image.description="Open-source learning management system: web server, worker and the hubium command" \
      org.opencontainers.image.source="https://github.com/sharapov-outsource/hubium" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
USER hubium
WORKDIR /opt/hubium
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s CMD ["hubium", "healthcheck"]
ENTRYPOINT ["hubium"]
CMD ["web"]

# ── hubium-media: the worker with ffmpeg for video transcoding ──────────────────
FROM hubium AS hubium-media
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
USER hubium
ENV WORKER_QUEUES=media
LABEL org.opencontainers.image.description="Hubium LMS worker with ffmpeg for video transcoding"
CMD ["worker"]

# ── bundle: hubium-<version>-linux-<arch>.tar.gz with Node.js inside ────────────
FROM build AS archive
ARG TARGETARCH
RUN version=$(cat /opt/hubium/VERSION) \
 && arch=$([ "$TARGETARCH" = amd64 ] && echo x64 || echo "$TARGETARCH") \
 && name="hubium-$version-linux-$arch" \
 && sh scripts/bundle.sh "/tmp/$name" /usr/local/bin/node \
 && mkdir /out && tar -C /tmp -czf "/out/$name.tar.gz" "$name"

FROM scratch AS bundle
COPY --from=archive /out/ /
