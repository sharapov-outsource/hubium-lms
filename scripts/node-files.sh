#!/bin/sh
# node.tar.gz of a release in DIR: the files of local nodes (docker/node), which
# install-hubium.sh unpacks into the installation as node/ (--node, enable-nodes).
#   sh scripts/node-files.sh DIR
set -eu
cd "$(dirname "$0")/../docker"
tar -czf "$1/node.tar.gz" --owner=0 --group=0 --sort=name \
  node/compose.yml node/Caddyfile node/replica.sh \
  node/cloud.yml node/cloud-db.sh node/cloud-hba.conf node/node-certs.sh
