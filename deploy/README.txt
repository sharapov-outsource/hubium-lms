Hubium LMS — release archive
============================

An open-source learning management system. This directory is a complete installation:
the web server (web/), the background worker (worker/), the `hubium` command with the
database migrations (cli/), Node.js (node/) and the launcher bin/hubium.

The easiest way to install it is install-hubium.sh, published with every release:

  curl -fsSLO https://github.com/sharapov-outsource/hubium-lms/releases/latest/download/install-hubium.sh
  sudo bash install-hubium.sh

It asks a few questions and sets up PostgreSQL, Caddy, systemd services and the first
administrator. To do the same by hand:

  1. PostgreSQL 16 or newer with pgvector; an empty database owned by a hubium role.
  2. Unpack to /opt/hubium/releases/<version> and link /opt/hubium/current to it.
  3. Copy deploy/hubium.env.example to /etc/hubium/hubium.env and fill it in.
  4. hubium doctor db                 (checks the database)
     hubium migrate --seed minimal    (tables, first administrator)
  5. Copy deploy/systemd/*.service to /etc/systemd/system and start hubium-web and
     hubium-worker (hubium-worker-media too, for video, with ffmpeg installed).
  6. Point a reverse proxy with HTTPS at 127.0.0.1:3000 for both APP_URL and CONTENT_HOST.
     For Caddy, deploy/Caddyfile works once APP_URL, CONTENT_HOST and
     HUBIUM_WEB=127.0.0.1:3000 are in its environment (or written into the file).

deploy/compose.yml and .env.production.example run the same release in Docker.

Documentation: https://github.com/sharapov-outsource/hubium-lms/blob/main/docs/operations.md
License: GNU AGPL v3 (LICENSE); Node.js: node/LICENSE.
