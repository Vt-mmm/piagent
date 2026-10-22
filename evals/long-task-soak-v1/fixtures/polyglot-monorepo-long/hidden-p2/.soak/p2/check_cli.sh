#!/usr/bin/env bash
# Hidden check (p2): the ledger CLI books .soak/p2/events.jsonl exactly; a missing file exits 2.
set -u
out="$(bash .soak/go.sh 'timeout 300 go build -o /tmp/ledger ./cmd/ledger && /tmp/ledger /src/.soak/p2/events.jsonl' 2>.soak/p2/cli.stderr)"
code=$?
[ $code -eq 0 ] || { echo "go run ./cmd/ledger failed ($code): $out" | tail -c 2000; exit 1; }
printf '%s' "$out" | /usr/bin/python3 -c '
import json, sys
want = json.load(open(".soak/p2/events-expected.json"))
try:
    got = json.loads(sys.stdin.read())
except ValueError as e:
    print("ledger output is not JSON:", e); sys.exit(1)
bad = [k for k in want if got.get(k) != want[k]]
for k in bad:
    print("%s differs:\n got %s\nwant %s" % (k, json.dumps(got.get(k))[:800], json.dumps(want[k])[:800]))
sys.exit(1 if bad else 0)' || exit 1
bash .soak/go.sh 'timeout 300 go build -o /tmp/ledger ./cmd/ledger && /tmp/ledger /src/does-not-exist.jsonl' >/dev/null 2>&1
code=$?
[ $code -eq 2 ] || { echo "missing file should exit 2, got $code"; exit 1; }
exit 0
