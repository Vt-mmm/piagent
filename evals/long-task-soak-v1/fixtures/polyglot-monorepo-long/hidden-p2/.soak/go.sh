#!/usr/bin/env bash
# Hidden helper: run a shell command in services/ledger-go inside the Go Docker
# image. The repository is streamed in with tar (no bind mount), so it works
# wherever the oracle copy lives.
set -u
export COPYFILE_DISABLE=1
[ -f services/ledger-go/go.mod ] || { echo "services/ledger-go/go.mod is missing"; exit 1; }
tar -cf - services/ledger-go shared .soak | docker run -i --rm -v piagent-soak-gocache:/root/.cache/go-build \
  golang:1.26.3-alpine3.23 sh -c "mkdir -p /src && tar -xf - -C /src && cd /src/services/ledger-go && $1"
