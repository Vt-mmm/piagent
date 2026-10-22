"""Hidden check (p4): scripts/log_report.py gives the exact numbers on the prod log and on an unseen log."""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CASES = [
    ("logs/prod-2025-10.log", os.path.join(HERE, "expected.json")),
    (os.path.join(HERE, "mini.log"), os.path.join(HERE, "mini-expected.json")),
]
problems = []

if not os.path.exists("scripts/log_report.py"):
    print("scripts/log_report.py is missing")
    sys.exit(1)

for log, expected_file in CASES:
    expected = json.load(open(expected_file, encoding="utf-8"))
    run = subprocess.run(["/usr/bin/python3", "scripts/log_report.py", log], capture_output=True, text=True, timeout=240)
    name = os.path.basename(log)
    if run.returncode != 0:
        problems.append("%s: exit %s: %s" % (name, run.returncode, run.stderr[-800:]))
        continue
    try:
        got = json.loads(run.stdout)
    except ValueError:
        problems.append("%s: stdout is not one JSON document: %r" % (name, run.stdout[:400]))
        continue
    for key, want in expected.items():
        if key not in got:
            problems.append("%s: missing key %s" % (name, key))
        elif key == "incident":
            for field, value in want.items():
                if not isinstance(got[key], dict) or got[key].get(field) != value:
                    problems.append("%s: incident.%s = %r, expected %r" % (name, field, (got[key] or {}).get(field) if isinstance(got[key], dict) else got[key], value))
        elif got[key] != want:
            problems.append("%s: %s = %s, expected %s" % (name, key, json.dumps(got[key], ensure_ascii=False)[:600], json.dumps(want, ensure_ascii=False)[:600]))

top = subprocess.run(["/usr/bin/python3", "scripts/log_report.py", CASES[1][0], "--top", "2"], capture_output=True, text=True, timeout=120)
try:
    if len(json.loads(top.stdout)["top_errors"]) != 2:
        problems.append("--top 2 does not limit top_errors to 2")
except (ValueError, KeyError, TypeError):
    problems.append("--top 2 failed: %s" % (top.stderr[-400:] or top.stdout[:200]))

missing = subprocess.run(["/usr/bin/python3", "scripts/log_report.py", "logs/does-not-exist.log"], capture_output=True, text=True, timeout=60)
if missing.returncode != 2:
    problems.append("a missing log file should exit 2, got %s" % missing.returncode)
if not os.path.exists("scripts/tests/test_log_report.py"):
    problems.append("scripts/tests/test_log_report.py is missing")
incident_doc = "docs/incidents/2025-10-14.md"
if not os.path.exists(incident_doc):
    problems.append("%s is missing" % incident_doc)
else:
    text = open(incident_doc, encoding="utf-8").read()
    for needle in ("13:07", "13:32", "UNSUPPORTED_VERSION", "POST /orders"):
        if needle not in text:
            problems.append("%s does not mention %s" % (incident_doc, needle))

for problem in problems:
    print(problem)
print("%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
