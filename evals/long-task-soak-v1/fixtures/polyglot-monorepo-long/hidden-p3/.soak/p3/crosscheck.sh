#!/usr/bin/env bash
# Hidden check (p3): 1500 seeded v1/v2/v3 payloads give the spec's outcome in Python, Node and Go.
set -u
py="$(/usr/bin/python3 .soak/p3/eval_py.py 2>.soak/p3/py.stderr)" || { echo "python evaluator failed"; tail -c 1500 .soak/p3/py.stderr; exit 1; }
js="$(node .soak/p3/eval_js.mjs 2>.soak/p3/js.stderr)" || { echo "node evaluator failed"; tail -c 1500 .soak/p3/js.stderr; exit 1; }
go="$(bash .soak/go.sh 'timeout 400 go run ./cmd/zzsoakeval /src/.soak/p3/cases.jsonl' 2>.soak/p3/go.stderr)" || { echo "go evaluator failed"; tail -c 1500 .soak/p3/go.stderr; exit 1; }
printf '%s' "$py" > .soak/p3/out-py.jsonl; printf '%s' "$js" > .soak/p3/out-js.jsonl; printf '%s' "$go" > .soak/p3/out-go.jsonl
/usr/bin/python3 - <<'PY'
import json, sys
cases = open(".soak/p3/cases.jsonl", encoding="utf-8").read().splitlines()
want = [json.loads(l) for l in open(".soak/p3/expected.jsonl", encoding="utf-8").read().splitlines()]
bad = 0
for lang in ("py", "js", "go"):
    got = [json.loads(l) for l in open(".soak/p3/out-%s.jsonl" % lang, encoding="utf-8").read().splitlines() if l.strip()]
    if len(got) != len(want):
        print("%s: %d answers for %d cases" % (lang, len(got), len(want))); bad += 1; continue
    wrong = [i for i, (g, w) in enumerate(zip(got, want)) if g != w]
    if wrong:
        bad += 1
        print("%s: %d/%d cases differ, e.g." % (lang, len(wrong), len(want)))
        for i in wrong[:4]:
            print("  case %d %s\n    want %s\n    got  %s" % (i + 1, cases[i][:300], json.dumps(want[i])[:400], json.dumps(got[i])[:400]))
sys.exit(1 if bad else 0)
PY
