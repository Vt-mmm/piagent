# Hidden acceptance checks for docs/PERSISTENCE.md: migrations v0->v1->v2 with the
# data migration, the invoice repository, and the import of data/invoices_2025.jsonl
# with its 30 bad lines.
# The soak oracle lays this file over the agent's work; the agent never sees it.
import csv
import hashlib
import sqlite3
from datetime import date
from decimal import Decimal as D
from pathlib import Path

import pytest

from billing import BillingError, BillingService, Plan, load_fx_rates
from billing import storage

PROJECT = Path(__file__).resolve().parents[1]
DATA = PROJECT / "data" / "invoices_2025.jsonl"
DATA_SHA256 = "f56615055cbec50f9a91a0230979f51a6bde5a18d5d4eacf2ba0559b534ad848"
BAD_LINES = [
    (164, "BAD_AMOUNT"), (463, "MISSING_FIELD"), (532, "BAD_AMOUNT"), (834, "BAD_STATUS"), (1230, "DUPLICATE_NUMBER"),
    (1372, "MISSING_FIELD"), (2236, "UNKNOWN_CURRENCY"), (2659, "BAD_JSON"), (3480, "BAD_AMOUNT"), (4015, "BAD_DATE"),
    (4255, "BAD_STATUS"), (4778, "BAD_STATUS"), (6203, "MISSING_FIELD"), (6547, "TOTAL_MISMATCH"), (6622, "BAD_DATE"),
    (7601, "DUPLICATE_NUMBER"), (8598, "DUPLICATE_NUMBER"), (8737, "BAD_JSON"), (8872, "TOTAL_MISMATCH"),
    (9863, "BAD_AMOUNT"), (10050, "BAD_DATE"), (10228, "TOTAL_MISMATCH"), (10551, "UNKNOWN_CURRENCY"),
    (10749, "MISSING_FIELD"), (13279, "BAD_JSON"), (13410, "BAD_AMOUNT"), (13590, "BAD_JSON"),
    (13669, "UNKNOWN_CURRENCY"), (13833, "BAD_DATE"), (14925, "TOTAL_MISMATCH"),
]
MISSING = {463: "currency", 1372: "total", 6203: "issued_on", 10749: "customer_id"}

V1_DDL = """
CREATE TABLE invoices (
    number TEXT PRIMARY KEY, customer_id TEXT NOT NULL, subscription_id TEXT, plan TEXT, country TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD', issued_on TEXT NOT NULL, subtotal TEXT NOT NULL, discount TEXT NOT NULL,
    tax TEXT NOT NULL, total TEXT NOT NULL, refunded TEXT NOT NULL, status TEXT NOT NULL, coupon_code TEXT
);
CREATE TABLE invoice_lines (
    invoice_number TEXT NOT NULL REFERENCES invoices(number), position INTEGER NOT NULL,
    description TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (invoice_number, position)
);
PRAGMA user_version = 1;
"""
V1_ROWS = [
    ("OLD-3", "C9", "SUB-3", "pro", "JP", "JPY", "2024-05-02", "4500", "0", "450", "4950", "1500", "partially_refunded", None),
    ("OLD-1", "C1", "SUB-1", "basic", "DE", "EUR", "2024-03-01", "9.20", "0.00", "1.75", "10.95", "0.00", "paid", None),
    ("OLD-2", "C1", "SUB-2", "pro", "FR", "EUR", "2024-02-15", "27.60", "3.31", "5.52", "29.81", "0", "paid", "WELCOME10"),
    ("OLD-0", "C1", "SUB-0", "pro", "GB", "GBP", "2024-02-15", "23.70", "0", "4.74", "28.44", "0", "past_due", None),
]


def code(excinfo):
    return excinfo.value.code


def columns(conn, table):
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]


def make_v1(path, rows=V1_ROWS):
    raw = sqlite3.connect(str(path))
    raw.executescript(V1_DDL)
    raw.executemany("INSERT INTO invoices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    raw.execute("INSERT INTO invoice_lines VALUES ('OLD-1', 1, 'Basic 2024-03-01..2024-04-01', '9.20')")
    raw.execute("INSERT INTO invoice_lines VALUES ('OLD-3', 1, 'Pro 2024-05-02..2024-06-02', '4500')")
    raw.commit()
    raw.close()


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    path = tmp_path_factory.mktemp("import") / "billing.db"
    conn = storage.connect(str(path))
    report = storage.import_jsonl(conn, str(DATA))
    return conn, report, path


# --- the 2025 import ----------------------------------------------------------------------

def test_data_file_untouched():
    assert hashlib.sha256(DATA.read_bytes()).hexdigest() == DATA_SHA256


def test_import_counts_and_rejections(imported):
    conn, report, _ = imported
    assert report.imported == 14970
    assert [(r.line, r.code) for r in report.rejected] == BAD_LINES
    assert {r.line: r.detail for r in report.rejected if r.code == "MISSING_FIELD"} == MISSING
    assert storage.schema_version(conn) == 2
    assert conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0] == 14970


def test_error_report_csv(imported, tmp_path):
    _, report, _ = imported
    out = tmp_path / "errors.csv"
    storage.write_error_report(report, str(out))
    text = out.read_text()
    assert text.startswith("line,code,detail\n") and text.endswith("\n") and "\r" not in text
    rows = list(csv.reader(text.splitlines()))
    assert rows[0] == ["line", "code", "detail"]
    assert [(int(r[0]), r[1]) for r in rows[1:]] == BAD_LINES
    assert all(len(r) == 3 for r in rows)


def test_imported_values_are_exact(imported):
    conn, _, _ = imported
    records = storage.report_records(conn, year=2025)
    assert len(records) == 14970
    first = records[0]
    assert {k: first[k] for k in ("number", "customer_id", "plan", "country", "currency", "issued_on", "subtotal",
                                  "discount", "tax", "total", "refunded", "status", "coupon_code")} == {
        "number": "INV-2025-00001", "customer_id": "C00003", "plan": "pro", "country": "IT", "currency": "EUR",
        "issued_on": "2025-01-01", "subtotal": "27.41", "discount": "3.34", "tax": "6.03", "total": "30.10",
        "refunded": "0.00", "status": "paid", "coupon_code": "WELCOME10"}
    yen = next(r for r in records if r["number"] == "INV-2025-00006")
    assert (yen["currency"], yen["subtotal"], yen["tax"], yen["total"], yen["refunded"]) == ("JPY", "4380", "438", "4818", "0")
    assert yen["coupon_code"] is None
    assert all(a["issued_on"] <= b["issued_on"] for a, b in zip(records, records[1:]))
    assert storage.report_records(conn, year=2024) == []
    assert conn.execute("SELECT total_minor FROM invoices WHERE number = 'INV-2025-00001'").fetchone()[0] == 3010
    customers = conn.execute("SELECT COUNT(*) FROM customers").fetchone()[0]
    assert customers == conn.execute("SELECT COUNT(DISTINCT customer_id) FROM invoices").fetchone()[0]


def test_reimport_rejects_everything(imported):
    conn, _, _ = imported
    again = storage.import_jsonl(conn, str(DATA))
    assert again.imported == 0
    assert len(again.rejected) == 15000
    assert sum(1 for r in again.rejected if r.code == "DUPLICATE_NUMBER") == 14973
    assert conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0] == 14970


def test_import_rules_on_small_file(tmp_path):
    good = '{"number": "N1", "customer_id": "c", "country": "US", "currency": "USD", "issued_on": "2025-01-02", "subtotal": "10.00", "discount": "1", "tax": "0.5", "total": "9.50", "status": "paid"}'
    lines = [
        good,
        "",
        good.replace('"N1"', '"N2"').replace('"9.50"', '"9.5"'),             # same value, fewer decimals: fine
        good.replace('"N1"', '"N3"').replace('"status": "paid"', '"status": null'),
        good.replace('"N1"', '"N4"').replace('"currency": "USD"', '"currency": "JPY"'),  # decimals for JPY
        good.replace('"N1"', '"N5"').replace('"10.00"', '"1e1"'),
        good,                                                                    # duplicate of line 1
        good.replace('"N1"', '"N8"').replace('"2025-01-02"', '"2025-1-02"'),
        "[1, 2]",
    ]
    path = tmp_path / "small.jsonl"
    path.write_text("\n".join(lines) + "\n")
    conn = storage.connect(":memory:")
    report = storage.import_jsonl(conn, str(path))
    assert report.imported == 2
    assert [(r.line, r.code) for r in report.rejected] == [
        (4, "MISSING_FIELD"), (5, "BAD_AMOUNT"), (6, "BAD_AMOUNT"), (7, "DUPLICATE_NUMBER"), (8, "BAD_DATE"), (9, "BAD_JSON")]
    assert report.rejected[0].detail == "status"
    rec = storage.report_records(conn)[0]
    assert rec["refunded"] == "0.00" and rec["subscription_id"] is None and rec["plan"] is None


# --- migrations -----------------------------------------------------------------------------

def test_fresh_database_goes_to_v2(tmp_path):
    conn = storage.connect(str(tmp_path / "fresh.db"))
    assert storage.schema_version(conn) == 0
    assert storage.migrate(conn, target=1) == 1
    assert "total" in columns(conn, "invoices")
    assert storage.migrate(conn) == 2
    assert storage.migrate(conn) == 2
    cols = columns(conn, "invoices")
    for name in ("subtotal_minor", "discount_minor", "tax_minor", "total_minor", "refunded_minor"):
        assert name in cols
    assert "total" not in cols and "subtotal" not in cols
    assert "amount_minor" in columns(conn, "invoice_lines") and "amount" not in columns(conn, "invoice_lines")
    assert columns(conn, "customers")[:1] == ["id"] and set(columns(conn, "customers")) == {"id", "country", "first_invoice_on"}
    with pytest.raises(BillingError) as e:
        storage.migrate(conn, target=3)
    assert code(e) == "UNKNOWN_SCHEMA_VERSION"


def test_v1_data_is_migrated(tmp_path):
    path = tmp_path / "old.db"
    make_v1(path)
    conn = storage.connect(str(path))
    assert storage.schema_version(conn) == 1
    assert storage.migrate(conn) == 2
    rows = dict((r[0], tuple(r)[1:]) for r in conn.execute(
        "SELECT number, subtotal_minor, discount_minor, tax_minor, total_minor, refunded_minor FROM invoices"))
    assert rows["OLD-1"] == (920, 0, 175, 1095, 0)
    assert rows["OLD-2"] == (2760, 331, 552, 2981, 0)
    assert rows["OLD-3"] == (4500, 0, 450, 4950, 1500)
    lines = sorted(tuple(r) for r in conn.execute("SELECT invoice_number, position, description, amount_minor FROM invoice_lines"))
    assert lines == [("OLD-1", 1, "Basic 2024-03-01..2024-04-01", 920), ("OLD-3", 1, "Pro 2024-05-02..2024-06-02", 4500)]
    customers = sorted(tuple(r) for r in conn.execute("SELECT id, country, first_invoice_on FROM customers"))
    assert customers == [("C1", "GB", "2024-02-15"), ("C9", "JP", "2024-05-02")]  # earliest date, then lowest number
    indexed = {r[2] for r in conn.execute("SELECT * FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")}
    assert "invoices" in indexed
    index_cols = set()
    for (name,) in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invoices' AND sql IS NOT NULL"):
        index_cols |= {row[2] for row in conn.execute(f"PRAGMA index_info('{name}')")}
    assert {"customer_id", "issued_on"} <= index_cols
    repo = storage.InvoiceRepository(conn)
    old = repo.get("OLD-3")
    assert (old.total, old.refunded, old.status, old.issued_on) == (D("4950"), D("1500"), "partially_refunded", date(2024, 5, 2))


@pytest.mark.parametrize("bad", [("total", "abc"), ("tax", "1.755"), ("currency", "XYZ")])
def test_failed_migration_changes_nothing(tmp_path, bad):
    field, value = bad
    keys = ["number", "customer_id", "subscription_id", "plan", "country", "currency", "issued_on", "subtotal",
            "discount", "tax", "total", "refunded", "status", "coupon_code"]
    broken = list(V1_ROWS[1])
    broken[keys.index(field)] = value
    path = tmp_path / "broken.db"
    make_v1(path, [V1_ROWS[0], tuple(broken), *V1_ROWS[2:]])
    conn = storage.connect(str(path))
    with pytest.raises(BillingError) as e:
        storage.migrate(conn)
    assert code(e) == "MIGRATION_FAILED"
    assert "OLD-1" in str(e.value)
    assert storage.schema_version(conn) == 1
    assert "total" in columns(conn, "invoices") and "total_minor" not in columns(conn, "invoices")
    assert conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0] == 4
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert tables == {"invoices", "invoice_lines"}


# --- repository -------------------------------------------------------------------------------

@pytest.fixture
def service(tmp_path):
    fx = tmp_path / "fx.csv"
    fx.write_text("date,currency,per_usd\n2026-01-02,JPY,150.00\n")
    return BillingService([Plan("basic", "Basic", D("10.00")), Plan("pro", "Pro", D("30.00"))], fx=load_fx_rates(str(fx)))


def test_repository_round_trip(service):
    conn = storage.connect(":memory:")
    storage.migrate(conn)
    repo = storage.InvoiceRepository(conn)
    yen = service.subscribe("c1", "pro", "JP", date(2026, 1, 10), currency="JPY")
    usd = service.subscribe("c2", "basic", "DE", date(2026, 1, 3))
    repo.add(yen)
    repo.add(usd)
    for original in (yen, usd):
        back = repo.get(original.number)
        for name in ("number", "customer_id", "subscription_id", "country", "currency", "issued_on", "subtotal",
                     "discount", "tax", "total", "refunded", "status", "coupon_code"):
            assert getattr(back, name) == getattr(original, name), name
        assert [(l.description, l.amount) for l in back.lines] == [(l.description, l.amount) for l in original.lines]
    assert repo.get(yen.number).subtotal == D("4500") and repo.get(usd.number).tax == D("1.90")
    with pytest.raises(BillingError) as e:
        repo.add(yen)
    assert code(e) == "DUPLICATE_INVOICE"
    with pytest.raises(BillingError) as e:
        repo.get("NOPE")
    assert code(e) == "UNKNOWN_INVOICE"
    service.refund(usd.number, D("2.00"))
    repo.update(usd)
    assert (repo.get(usd.number).status, repo.get(usd.number).refunded) == ("partially_refunded", D("2.00"))
    assert [i.number for i in repo.list()] == [usd.number, yen.number]
    assert [i.number for i in repo.list(customer_id="c1")] == [yen.number]
    assert [i.number for i in repo.list(status="partially_refunded")] == [usd.number]
    assert repo.list(year=2025) == [] and len(repo.list(year=2026)) == 2
    assert repo.count() == 2
    # The repository may set its own row factory (sqlite3.Row): compare as tuples.
    assert sorted(tuple(r) for r in conn.execute("SELECT id, country FROM customers")) == sorted([("c1", "JP"), ("c2", "DE")])
    stranger = service.subscribe("c3", "basic", "US", date(2026, 1, 4))
    with pytest.raises(BillingError) as e:
        repo.update(stranger)
    assert code(e) == "UNKNOWN_INVOICE"


def test_repository_needs_v2(tmp_path):
    path = tmp_path / "old.db"
    make_v1(path)
    with pytest.raises(BillingError) as e:
        storage.InvoiceRepository(storage.connect(str(path)))
    assert code(e) == "SCHEMA_OUTDATED"
