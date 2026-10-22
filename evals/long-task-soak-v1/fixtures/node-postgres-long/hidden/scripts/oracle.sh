#!/usr/bin/env bash
# Soak oracle: throwaway PostgreSQL 17 on a free port, migrations, then the
# whole test/ directory (the agent's tests and the hidden acceptance file).
# The container is removed on exit; it also stops by itself after 25 minutes
# in case this script is killed with SIGKILL on a timeout.
set -euo pipefail
cd "$(dirname "$0")/.."
run=$(printf '%s' "${SOAK_RUN:-local}" | tr -c 'a-zA-Z0-9_.-' '-')
name="soak-pg-${run}-$RANDOM"
port=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
trap 'exit 130' INT TERM

docker run -d --rm --name "$name" --label soak-oracle=1 \
  -e POSTGRES_PASSWORD=soak -e POSTGRES_DB=phonghop -p "127.0.0.1:${port}:5432" \
  --entrypoint timeout postgres:17.6-alpine3.22 1500 docker-entrypoint.sh postgres >/dev/null

ready=
for _ in $(seq 1 90); do
  if docker exec "$name" pg_isready -U postgres -d phonghop -h 127.0.0.1 >/dev/null 2>&1 \
     && docker exec "$name" psql -U postgres -d phonghop -h 127.0.0.1 -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || { echo "postgres did not become ready"; docker logs "$name" 2>&1 | tail -20; exit 1; }

export DATABASE_URL="postgres://postgres:soak@127.0.0.1:${port}/phonghop"
node scripts/migrate.js
node --test --test-concurrency=1 test/
