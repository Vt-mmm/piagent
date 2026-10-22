# Hidden acceptance checks for the last phase: the CLI (docs/CLI.md) over the
# imported 2025 data, the README, and the member's mid-session rule change:
#   invoice numbers are INV-YYYY-NNNNN, the sequence restarting every calendar year.
# The soak oracle lays this file over the agent's work; the agent never sees it.
import csv
import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import date
from decimal import Decimal as D
from pathlib import Path

import pytest

from billing import BillingService, Coupon, Plan

PROJECT = Path(__file__).resolve().parents[1]
GOLDEN = Path(__file__).parent / "zz_cli_golden"
CASES = json.loads((GOLDEN / "cases.json").read_text())
REPORT_NAMES = ["revenue-by-month", "revenue-by-quarter", "revenue-by-week", "revenue-by-country", "revenue-by-plan",
                "vat", "aging", "statement", "top-customers", "coupon-usage", "refunds", "status-summary", "daily-sales",
                "invoice-register", "mrr", "churn", "discount-leakage", "tax-summary", "close-pack"]


def cli(*argv, cwd=PROJECT):
    env = dict(os.environ, PYTHONPATH=str(PROJECT / "src"))
    return subprocess.run([sys.executable, "-m", "billing", *argv], cwd=cwd, env=env, capture_output=True, text=True, timeout=300)


@pytest.fixture(scope="module")
def db(tmp_path_factory):
    folder = tmp_path_factory.mktemp("cli")
    path, errors = folder / "billing.db", folder / "errors.csv"
    done = cli("import", str(PROJECT / "data" / "invoices_2025.jsonl"), "--db", str(path), "--errors", str(errors))
    assert done.returncode == 0, done.stderr
    assert done.stdout == "imported 14970, rejected 30\n"
    return path, errors


# --- the member's rule change: INV-YYYY-NNNNN ----------------------------------------------

def test_invoice_numbers_restart_every_year():
    s = BillingService([Plan("basic", "Basic", D("10.00")), Plan("pro", "Pro", D("30.00"))])
    a = s.subscribe("c1", "basic", "US", date(2026, 12, 15))
    b = s.subscribe("c2", "basic", "US", date(2026, 12, 20))
    c = s.renew(a.subscription_id)                       # issued 2027-01-15
    d = s.change_plan(b.subscription_id, "pro", date(2027, 1, 3))
    e = s.subscribe("c3", "basic", "US", date(2026, 11, 30))  # issued after, dated 2026
    assert [i.number for i in (a, b, c, d, e)] == [
        "INV-2026-00001", "INV-2026-00002", "INV-2027-00001", "INV-2027-00002", "INV-2026-00003"]
    assert s.invoice("INV-2027-00002") is d or s.invoice("INV-2027-00002").number == "INV-2027-00002"
    s.add_coupon(Coupon("X", "fixed", D("1")))
    many = [s.subscribe(f"m{i}", "basic", "US", date(2028, 2, 1)).number for i in range(12)]
    assert many[0] == "INV-2028-00001" and many[-1] == "INV-2028-00012"
    assert all(re.fullmatch(r"INV-\d{4}-\d{5}", n) for n in many)


def test_spec_documents_the_new_format():
    assert re.search(r"INV-YYYY-N{5}", (PROJECT / "SPEC.md").read_text())


# --- commands --------------------------------------------------------------------------------

def test_migrate(tmp_path):
    done = cli("migrate", "--db", str(tmp_path / "new.db"))
    assert (done.returncode, done.stdout) == (0, "schema version 2\n")
    again = cli("migrate", "--db", str(tmp_path / "new.db"))
    assert (again.returncode, again.stdout) == (0, "schema version 2\n")


def test_import_error_report(db):
    _, errors = db
    rows = list(csv.reader(errors.read_text().splitlines()))
    assert rows[0] == ["line", "code", "detail"] and len(rows) == 31
    assert [r[1] for r in rows[1:]].count("DUPLICATE_NUMBER") == 3
    assert [int(r[0]) for r in rows[1:]][:3] == [164, 463, 532]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_report_output(case, db):
    path, _ = db
    done = cli("report", case["argv"][0], "--db", str(path), *case["argv"][1:])
    assert done.returncode == 0, done.stderr
    assert done.stdout == (GOLDEN / (case["id"] + ".txt")).read_text()


def test_export(db):
    path, _ = db
    done = cli("export", "--db", str(path), "--format", "csv", "--year", "2025")
    assert done.returncode == 0, done.stderr
    lines = done.stdout.split("\n")
    assert lines[0] == "number,customer_id,subscription_id,country,issued_on,subtotal,discount,tax,total,refunded,status"
    assert len(lines) == 14972 and lines[-1] == ""
    assert lines[1] == "INV-2025-00001,C00003,SUB-00001,IT,2025-01-01,27.41,3.34,6.03,30.10,0.00,paid"
    js = cli("export", "--db", str(path), "--format", "json", "--year", "2025")
    data = json.loads(js.stdout)
    assert len(data) == 14970 and data[5]["currency"] == "JPY" and data[5]["total"] == "4818"
    assert cli("export", "--db", str(path), "--format", "csv", "--year", "2024").stdout.count("\n") == 1


@pytest.mark.parametrize("argv", [
    ["report", "no-such-report"],
    ["report", "revenue-by-month"],                         # --year missing
    ["report", "vat", "--year", "2025", "--quarter", "1", "--country", "XX"],
    ["report", "aging", "--as-of", "31/12/2025"],
    ["frobnicate"],
])
def test_usage_errors(argv, db):
    path, _ = db
    done = cli(*argv, "--db", str(path)) if argv[0] == "report" else cli(*argv)
    assert done.returncode == 2
    assert done.stdout == ""
    assert done.stderr.strip()


def test_billing_error_exit_code(tmp_path):
    path = tmp_path / "old.db"
    raw = sqlite3.connect(str(path))
    raw.executescript("""
        CREATE TABLE invoices (number TEXT PRIMARY KEY, customer_id TEXT NOT NULL, subscription_id TEXT, plan TEXT,
            country TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', issued_on TEXT NOT NULL, subtotal TEXT NOT NULL,
            discount TEXT NOT NULL, tax TEXT NOT NULL, total TEXT NOT NULL, refunded TEXT NOT NULL, status TEXT NOT NULL,
            coupon_code TEXT);
        CREATE TABLE invoice_lines (invoice_number TEXT NOT NULL REFERENCES invoices(number), position INTEGER NOT NULL,
            description TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (invoice_number, position));
        INSERT INTO invoices VALUES ('X-1', 'c', NULL, NULL, 'US', 'USD', '2024-01-01', 'ten', '0', '0', '10', '0', 'paid', NULL);
        PRAGMA user_version = 1;""")
    raw.commit()
    raw.close()
    done = cli("migrate", "--db", str(path))
    assert done.returncode == 1
    assert done.stdout == ""
    assert done.stderr.startswith("error: MIGRATION_FAILED")


# --- documentation -----------------------------------------------------------------------------

def test_readme_documents_the_cli():
    readme = (PROJECT / "README.md").read_text()
    assert "python -m billing" in readme
    for command in ("migrate", "import", "report", "export"):
        assert re.search(rf"python -m billing {command}\b", readme) or re.search(rf"`{command}`", readme), command
    for name in REPORT_NAMES:
        assert re.search(rf"(?<![\w-]){re.escape(name)}(?![\w-])", readme), f"README does not document report {name}"
