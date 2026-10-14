#!/bin/sh
# Assembles a release from a built checkout (web, worker and cli built):
#   scripts/bundle.sh <dest> [<node binary>]
# <dest> becomes the directory that releases unpack to and that the images keep in
# /opt/hubium. With a Node binary, it goes into <dest>/node, which bin/hubium prefers.
set -eu

dest=$1
node_bin=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)

rm -rf "$dest"
mkdir -p "$dest/bin" "$dest/web/apps/web/.next" "$dest/worker" "$dest/cli" "$dest/deploy"

# Next.js standalone server, its static files and the public directory
cp -R "$root/apps/web/.next/standalone/." "$dest/web/"
cp -R "$root/apps/web/.next/static" "$dest/web/apps/web/.next/static"
cp -R "$root/apps/web/public" "$dest/web/apps/web/public"
# the worker and the hubium command are self-contained bundles
cp -R "$root/apps/worker/dist/." "$dest/worker/"
cp -R "$root/apps/cli/dist/." "$dest/cli/"
cp -R "$root/packages/db/prisma/migrations" "$dest/cli/migrations"

cp "$root/deploy/bin/hubium" "$dest/bin/hubium"
chmod 755 "$dest/bin/hubium"
cp -R "$root/deploy/systemd" "$dest/deploy/systemd"
cp "$root/deploy/hubium.env.example" "$root/docker/Caddyfile" "$root/docker/compose.yml" \
  "$root/.env.production.example" "$dest/deploy/"
cp "$root/deploy/README.txt" "$dest/README.txt"
cp "$root/LICENSE" "$dest/LICENSE"
node -p "require('$root/package.json').version" > "$dest/VERSION"

if [ -n "$node_bin" ]; then
  mkdir -p "$dest/node/bin"
  cp "$node_bin" "$dest/node/bin/node"
  license=$(dirname "$(dirname "$node_bin")")/LICENSE
  if [ -f "$license" ]; then cp "$license" "$dest/node/LICENSE"; fi
fi

# no environment file of the build machine travels with the server
find "$dest/web" -name '.env*' -type f -delete
