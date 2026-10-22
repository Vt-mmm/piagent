"""Hidden check (p6): CHANGELOG 3.0.0, docs and README are written for the release."""
import json
import os
import re
import sys

problems = []
read = lambda p: open(p, encoding="utf-8").read() if os.path.exists(p) else ""

changelog = read("CHANGELOG.md")
match = re.search(r"^## \[3\.0\.0\][^\n]*\n(.*?)(?=^## \[|\Z)", changelog, re.S | re.M)
if not match:
    problems.append("CHANGELOG.md has no ## [3.0.0] section")
else:
    section = match.group(1).lower()
    for words in (("ledger-go", "ledger"), ("settlement_currency",), ("fx_rate_ppm",), ("log_report",), ("src/router", "router"), ("ci.sh",),
                  ("account_id",), ("whitespace", "khoảng trắng", "trailing", "leading", "space")):
        if not any(w in section for w in words):
            problems.append("CHANGELOG 3.0.0 section does not mention %s" % " / ".join(words))
    if "## [2.0.0]" in changelog and changelog.index("## [3.0.0]") > changelog.index("## [2.0.0]"):
        problems.append("CHANGELOG 3.0.0 section is not above 2.0.0")

ledger = read("docs/ledger.md")
if not ledger:
    problems.append("docs/ledger.md is missing")
for code in ("BAD_JSON", "BAD_EVENT", "UNKNOWN_TYPE", "DUPLICATE", "order.refunded"):
    if ledger and code not in ledger:
        problems.append("docs/ledger.md does not mention %s" % code)
contract = read("docs/contract.md")
for word in ("settlement_currency", "fx_rate_ppm", "v3"):
    if word not in contract:
        problems.append("docs/contract.md does not mention %s" % word)
readme = read("README.md")
for word in ("ledger-go", "ci.sh"):
    if word not in readme:
        problems.append("README.md does not mention %s" % word)
versions = {
    "web-js": json.loads(read("services/web-js/package.json") or "{}").get("version"),
    "pricing-py": (re.search(r'^__version__ = "(.*)"$', read("services/pricing-py/pricing/__init__.py"), re.M) or [None, None])[1],
}
if versions != {"web-js": "3.0.0", "pricing-py": "3.0.0"}:
    problems.append("versions are %s" % versions)
for p in problems:
    print(p)
print("%d problem(s)" % len(problems))
sys.exit(1 if problems else 0)
