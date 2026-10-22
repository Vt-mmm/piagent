#!/usr/bin/env bash
# Khởi động PostgreSQL 17 trong Docker trên một cổng trống và in DATABASE_URL.
#   eval "$(bash scripts/db-up.sh)"   # đặt DATABASE_URL cho shell hiện tại
#   npm run migrate && npm test
set -euo pipefail
cd "$(dirname "$0")/.."
name="phong-hop-pg-$(pwd | shasum | cut -c1-10)"
if ! docker ps --format '{{.Names}}' | grep -qx "$name"; then
  docker rm -f "$name" >/dev/null 2>&1 || true
  port=$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
  docker run -d --rm --name "$name" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=phonghop \
    -p "127.0.0.1:${port}:5432" postgres:17.6-alpine3.22 >/dev/null
fi
port=$(docker port "$name" 5432/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -U postgres -d phonghop -h 127.0.0.1 >/dev/null 2>&1; then
    echo "export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:${port}/phonghop"
    echo "# container: $name (dừng bằng: bash scripts/db-down.sh)" >&2
    exit 0
  fi
  sleep 1
done
echo "PostgreSQL chưa sẵn sàng sau 60 giây" >&2
exit 1
