"""Golden-file regression for the finance reports.

Every case in tests/golden/reports/cases.json runs one report function over
tests/golden/sample_invoices.jsonl and must reproduce the stored output byte
for byte (finance diff these reports month to month).
"""
import datetime
import json
from pathlib import Path

import pytest

from billing import legacy_reports

GOLDEN = Path(__file__).parent / "golden"
CASES = json.loads((GOLDEN / "reports" / "cases.json").read_text())


@pytest.fixture(scope="module")
def records():
    lines = (GOLDEN / "sample_invoices.jsonl").read_text().splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def _args(case):
    return [datetime.date.fromisoformat(a["date"]) if isinstance(a, dict) else a for a in case["args"]]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_report_matches_golden(case, records):
    produced = getattr(legacy_reports, case["function"])(records, *_args(case), **case["kwargs"])
    expected = (GOLDEN / "reports" / (case["id"] + ".txt")).read_text()
    assert produced == expected
