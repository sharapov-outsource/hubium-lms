#!/bin/sh
# The cloud's certificates for local nodes (docker/node/cloud.yml): the newest certificate
# and key Caddy has for the hosts of APP_URL and CONTENT_HOST, copied to /out as <host>.crt
# and <host>.key for the web server (uid 1001), which hands them to the nodes. Checked
# every hour; Caddy renews them a month before they expire.
set -eu

host() { printf '%s' "$1" | sed -E 's#^[a-z]+://([^/:]+).*#\1#'; }

hosts=$(host "$APP_URL")
[ -n "${CONTENT_HOST:-}" ] && hosts="$hosts $(host "$CONTENT_HOST")"

copy() { # copy SOURCE TARGET
  cmp -s "$1" "$2" 2>/dev/null && return 0
  cp "$1" "$2.tmp"
  chown 1001 "$2.tmp"
  chmod 600 "$2.tmp"
  mv "$2.tmp" "$2"
  echo "node-certs: $2 updated"
}

while :; do
  for h in $hosts; do
    # shellcheck disable=SC2012 # names Caddy gives its files: no newlines
    crt=$(find /caddy/caddy/certificates -type f -name "$h.crt" -exec ls -t {} + 2>/dev/null | head -n 1)
    [ -n "$crt" ] && [ -f "${crt%.crt}.key" ] || continue
    copy "${crt%.crt}.key" "/out/$h.key"
    copy "$crt" "/out/$h.crt"
  done
  sleep 3600
done
