"""Hidden check: no leftover "customer" outside the allowed places, plus CHANGELOG/TODO/docs/env bookkeeping."""
import json
import os
import re
import sys

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".soak"}
problems = []


def allowed(rel):
    base = os.path.basename(rel)
    return rel in ("CHANGELOG.md", "TODO.md") or "compat" in base or "hidden" in base


for top, dirs, files in os.walk("."):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for name in files:
        rel = os.path.relpath(os.path.join(top, name), ".")
        if allowed(rel):
            continue
        if "customer" in rel.lower():
            problems.append("file name still says customer: %s" % rel)
            continue
        with open(rel, "rb") as handle:
            text = handle.read().decode("utf-8", "replace")
        for number, line in enumerate(text.splitlines(), 1):
            if "customer" in line.lower():
                problems.append("%s:%d: %s" % (rel, number, line.strip()[:120]))

changelog = open("CHANGELOG.md", encoding="utf-8").read()
match = re.search(r"^## \[2\.0\.0\][^\n]*\n(.*?)(?=^## \[|\Z)", changelog, re.S | re.M)
if not match:
    problems.append("CHANGELOG.md has no ## [2.0.0] section")
else:
    section = match.group(1)
    for word in ("customer_id", "account_id", "ACCOUNT_API_URL", "3.0.0"):
        if word not in section:
            problems.append("CHANGELOG 2.0.0 section does not mention %s" % word)
    if changelog.index("## [2.0.0]") > changelog.index("## [1.4.0]"):
        problems.append("CHANGELOG 2.0.0 section is not above 1.4.0")

todo = open("TODO.md", encoding="utf-8").read()
if "- [ ]" in todo:
    problems.append("TODO.md still has unticked items")
if not os.path.exists("docs/account-tiers.md"):
    problems.append("docs/account-tiers.md is missing")
contract_doc = open("docs/contract.md", encoding="utf-8").read() if os.path.exists("docs/contract.md") else ""
if "legacy v1 payload" not in contract_doc.lower() or "account_id" not in contract_doc:
    problems.append("docs/contract.md does not describe v2 and the legacy v1 payload")
env_example = open(".env.example", encoding="utf-8").read()
if not re.search(r"^ACCOUNT_API_URL=", env_example, re.M):
    problems.append(".env.example has no ACCOUNT_API_URL")
if not os.path.exists("services/pricing-py/fixtures/accounts.json"):
    problems.append("services/pricing-py/fixtures/accounts.json is missing")
version = json.load(open("services/web-js/package.json", encoding="utf-8")).get("version")
if version != "2.0.0":
    problems.append("web-js version is %s" % version)

for problem in problems:
    print(problem)
print("%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
