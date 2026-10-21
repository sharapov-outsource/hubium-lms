#!/bin/sh
# The cloud's database ready for local nodes, around the image's own entrypoint: TLS with the
# certificate in /src (server.crt, server.key: install-hubium.sh makes them), the access
# rules of cloud-hba.conf, a slot for each node that keeps the WAL it has not received for
# up to NODE_WAL_KEEP, and connections to a node that stopped answering ended within a
# minute (a stalled one would hold up the checkpoints).
set -eu

mkdir -p /etc/hubium-db
cp /src/server.crt /src/server.key /etc/hubium-db/
if [ -f /src/pg_hba.conf ]; then cp /src/pg_hba.conf /etc/hubium-db/; else cp /cloud-hba.conf /etc/hubium-db/pg_hba.conf; fi
chown -R postgres:postgres /etc/hubium-db
chmod 600 /etc/hubium-db/server.key

exec docker-entrypoint.sh postgres \
  -c ssl=on -c ssl_cert_file=/etc/hubium-db/server.crt -c ssl_key_file=/etc/hubium-db/server.key \
  -c hba_file=/etc/hubium-db/pg_hba.conf \
  -c max_wal_senders=64 -c max_replication_slots=64 \
  -c max_slot_wal_keep_size="${NODE_WAL_KEEP:-20GB}" \
  -c wal_sender_timeout=60s -c tcp_user_timeout=60000 \
  -c tcp_keepalives_idle=30 -c tcp_keepalives_interval=10 -c tcp_keepalives_count=3 \
  "$@"
