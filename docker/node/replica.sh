#!/bin/sh
# A database of a local node, in the PostgreSQL image of Hubium (docker/node/compose.yml):
#   A  a physical replica of the cloud's database (REPLICA_UPSTREAM: the cloud)
#   B  a cascading replica of A (REPLICA_UPSTREAM: A), which the node agent promotes while
#      the node works without a connection
# The first start copies the upstream with pg_basebackup. The agent asks for a new copy
# (B after a sync, A after an outage longer than the cloud keeps WAL for) by creating
# $REPLICA_CONTROL/rebuild; the copy is made while postgres is stopped. The state of the
# replica is written to $REPLICA_CONTROL/state for the agent: copying, running, failed.
#
# REPLICA_UPSTREAM      libpq connection string of the upstream (with the node's role and
#                       password, and sslmode/sslrootcert for the cloud)
# REPLICA_SLOT          the physical replication slot on the upstream
# REPLICA_CREATE_SLOT   yes: create the slot on the upstream when it is missing (B on A)
# REPLICA_CA            the certificate of the upstream (PEM in base64), written to
#                       /var/lib/postgresql/upstream-ca.crt for sslrootcert
# REPLICA_CONTROL       directory shared with the agent (default /control)
set -eu

PGDATA=${PGDATA:-/var/lib/postgresql/18/docker}
CONTROL=${REPLICA_CONTROL:-/control}
HBA=/var/lib/postgresql/node-hba.conf
export PGDATA

if [ "$(id -u)" = 0 ]; then
  mkdir -p "$PGDATA" "$CONTROL"
  chown postgres:postgres "$PGDATA" "$CONTROL" /var/lib/postgresql
  chmod 700 "$PGDATA"
  # the agent runs as another user and asks for copies here
  chmod 777 "$CONTROL"
  exec gosu postgres "$0" "$@"
fi

: "${REPLICA_UPSTREAM:?REPLICA_UPSTREAM is required}"
: "${REPLICA_SLOT:?REPLICA_SLOT is required}"

if [ -n "${REPLICA_CA:-}" ]; then
  printf '%s' "$REPLICA_CA" | base64 -d >/var/lib/postgresql/upstream-ca.crt
  chmod 600 /var/lib/postgresql/upstream-ca.crt
fi

state() { printf '%s %s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$CONTROL/state"; }

# The node's own access rules: the copy carries the cloud's pg_hba.conf, which is not ours.
cat >"$HBA" <<'EOF'
local   all          all                 trust
host    all          all  127.0.0.1/32   trust
host    all          all  ::1/128        trust
host    all          all  all            scram-sha-256
host    replication  all  all            scram-sha-256
EOF

copy() {
  state copying
  if [ "${REPLICA_CREATE_SLOT:-no}" = yes ]; then
    # B's slot on A keeps the WAL B has not received yet; it stays across copies
    psql "$REPLICA_UPSTREAM dbname=hubium" -qAtc \
      "SELECT pg_create_physical_replication_slot('$REPLICA_SLOT', true)
       WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = '$REPLICA_SLOT')" \
      >/dev/null
  fi
  find "$PGDATA" -mindepth 1 -delete
  pg_basebackup -d "$REPLICA_UPSTREAM" -D "$PGDATA" -X stream -S "$REPLICA_SLOT" -R -c fast
}

# A standby needs these at least as high as its upstream: the copy's control file has them.
controlled() {
  pg_controldata "$PGDATA" | sed -n "s/^$1 setting: *//p"
}

start() {
  postgres -c hba_file="$HBA" -c listen_addresses='*' -c hot_standby=on \
    -c hot_standby_feedback=on -c max_standby_streaming_delay=30s \
    -c max_connections="$(controlled max_connections)" \
    -c max_worker_processes="$(controlled max_worker_processes)" \
    -c max_wal_senders="$(controlled max_wal_senders)" \
    -c max_prepared_transactions="$(controlled max_prepared_xacts)" \
    -c max_locks_per_transaction="$(controlled max_locks_per_xact)" &
  pid=$!
  state running
  # stopped for a new copy when the agent asks for one
  while kill -0 "$pid" 2>/dev/null; do
    if [ -e "$CONTROL/rebuild" ]; then
      pg_ctl -D "$PGDATA" stop -m fast >/dev/null || true
      break
    fi
    sleep 2
  done
  wait "$pid" || true
}

trap 'pg_ctl -D "$PGDATA" stop -m fast >/dev/null 2>&1 || true; exit 0' TERM INT

while :; do
  if [ -e "$CONTROL/rebuild" ] || [ ! -s "$PGDATA/PG_VERSION" ]; then
    if copy; then
      rm -f "$CONTROL/rebuild"
    else
      state failed
      sleep 10
      continue
    fi
  fi
  start
  # postgres ended without a request for a copy: start it again after a pause
  [ -e "$CONTROL/rebuild" ] || sleep 5
done
