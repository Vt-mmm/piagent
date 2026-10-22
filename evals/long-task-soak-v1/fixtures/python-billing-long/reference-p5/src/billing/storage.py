"""SQLite storage: schema migrations, the invoice repository and the JSONL import (docs/PERSISTENCE.md)."""
import csv
import json
import re
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Callable, Dict, Iterator, List, Optional

from .errors import BillingError
from .invoices import Invoice, InvoiceLine
from .money import CURRENCY_DECIMALS

AMOUNTS = ("subtotal", "discount", "tax", "total", "refunded")
REQUIRED = ("number", "customer_id", "country", "currency", "issued_on", "subtotal", "discount", "tax", "total", "status")
STATUSES = ("paid", "partially_refunded", "refunded", "past_due")
AMOUNT_TEXT = re.compile(r"^[0-9]+(\.[0-9]+)?$")
DATE_TEXT = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

V1 = """
CREATE TABLE invoices (
    number TEXT PRIMARY KEY, customer_id TEXT NOT NULL, subscription_id TEXT, plan TEXT,
    country TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', issued_on TEXT NOT NULL,
    subtotal TEXT NOT NULL, discount TEXT NOT NULL, tax TEXT NOT NULL, total TEXT NOT NULL,
    refunded TEXT NOT NULL, status TEXT NOT NULL, coupon_code TEXT
);
CREATE TABLE invoice_lines (
    invoice_number TEXT NOT NULL REFERENCES invoices(number), position INTEGER NOT NULL,
    description TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY (invoice_number, position)
);
"""

V2 = """
CREATE TABLE invoices_v2 (
    number TEXT PRIMARY KEY, customer_id TEXT NOT NULL, subscription_id TEXT, plan TEXT,
    country TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', issued_on TEXT NOT NULL,
    subtotal_minor INTEGER NOT NULL, discount_minor INTEGER NOT NULL, tax_minor INTEGER NOT NULL,
    total_minor INTEGER NOT NULL, refunded_minor INTEGER NOT NULL, status TEXT NOT NULL, coupon_code TEXT
);
CREATE TABLE invoice_lines_v2 (
    -- points at invoices_v2 so that the rename below carries the reference over
    invoice_number TEXT NOT NULL REFERENCES invoices_v2(number), position INTEGER NOT NULL,
    description TEXT NOT NULL, amount_minor INTEGER NOT NULL, PRIMARY KEY (invoice_number, position)
);
CREATE TABLE customers (id TEXT PRIMARY KEY, country TEXT NOT NULL, first_invoice_on TEXT NOT NULL);
"""

V2_FINISH = """
DROP TABLE invoice_lines;
DROP TABLE invoices;
ALTER TABLE invoices_v2 RENAME TO invoices;
ALTER TABLE invoice_lines_v2 RENAME TO invoice_lines;
CREATE INDEX invoices_customer ON invoices(customer_id);
CREATE INDEX invoices_issued ON invoices(issued_on);
"""


def connect(path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def schema_version(conn: sqlite3.Connection) -> int:
    return conn.execute("PRAGMA user_version").fetchone()[0]


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    previous = conn.isolation_level
    if conn.in_transaction:
        conn.commit()
    conn.isolation_level = None
    conn.execute("BEGIN")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.isolation_level = previous


def _script(conn: sqlite3.Connection, script: str) -> None:
    # executescript() would COMMIT the open transaction; run statement by statement instead.
    for statement in script.split(";"):
        if statement.strip():
            conn.execute(statement)


def to_minor(text, currency: str) -> int:
    places = CURRENCY_DECIMALS[currency]
    value = Decimal(str(text)).scaleb(places)
    if value != value.to_integral_value():
        raise ValueError(f"{text} has more than {places} decimals")
    return int(value)


def from_minor(minor: int, currency: str) -> Decimal:
    return Decimal(minor).scaleb(-CURRENCY_DECIMALS[currency])


def _migrate_v1(conn: sqlite3.Connection) -> None:
    _script(conn, V1)


def _migrate_v2(conn: sqlite3.Connection) -> None:
    _script(conn, V2)
    currencies = {}
    for row in conn.execute("SELECT number, customer_id, subscription_id, plan, country, currency, issued_on, "
                            "subtotal, discount, tax, total, refunded, status, coupon_code FROM invoices").fetchall():
        number, currency = row[0], row[5]
        try:
            minors = [to_minor(v, currency) for v in row[7:12]]
        except (KeyError, ValueError, InvalidOperation):
            raise BillingError("MIGRATION_FAILED", f"invoice {number}: bad amount or currency") from None
        currencies[number] = currency
        conn.execute("INSERT INTO invoices_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (*row[:7], *minors, *row[12:]))
    for number, position, description, amount in conn.execute("SELECT * FROM invoice_lines").fetchall():
        try:
            minor = to_minor(amount, currencies[number])
        except (KeyError, ValueError, InvalidOperation):
            raise BillingError("MIGRATION_FAILED", f"invoice {number} line {position}: bad amount") from None
        conn.execute("INSERT INTO invoice_lines_v2 VALUES (?,?,?,?)", (number, position, description, minor))
    conn.execute("INSERT INTO customers (id, country, first_invoice_on) "
                 "SELECT customer_id, country, issued_on FROM invoices_v2 i WHERE number = ("
                 "SELECT number FROM invoices_v2 j WHERE j.customer_id = i.customer_id ORDER BY issued_on, number LIMIT 1)")
    _script(conn, V2_FINISH)


MIGRATIONS: List[Callable[[sqlite3.Connection], None]] = [_migrate_v1, _migrate_v2]
LATEST = len(MIGRATIONS)


def migrate(conn: sqlite3.Connection, target: int = LATEST) -> int:
    if target > LATEST:
        raise BillingError("UNKNOWN_SCHEMA_VERSION", str(target))
    version = schema_version(conn)
    while version < target:
        with transaction(conn):
            MIGRATIONS[version](conn)
            version += 1
            conn.execute(f"PRAGMA user_version = {version}")
    return version


# --- repository -----------------------------------------------------------------------------

COLUMNS = ("number, customer_id, subscription_id, plan, country, currency, issued_on, subtotal_minor, discount_minor, "
           "tax_minor, total_minor, refunded_minor, status, coupon_code")


def _insert(conn: sqlite3.Connection, values: tuple) -> None:
    conn.execute(f"INSERT INTO invoices ({COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", values)
    conn.execute("INSERT OR IGNORE INTO customers (id, country, first_invoice_on) VALUES (?,?,?)",
                 (values[1], values[4], values[6]))


class InvoiceRepository:
    def __init__(self, conn: sqlite3.Connection):
        if schema_version(conn) < LATEST:
            raise BillingError("SCHEMA_OUTDATED", f"version {schema_version(conn)}")
        self.conn = conn

    def add(self, invoice: Invoice) -> None:
        cur = invoice.currency
        if self.conn.execute("SELECT 1 FROM invoices WHERE number = ?", (invoice.number,)).fetchone():
            raise BillingError("DUPLICATE_INVOICE", invoice.number)
        with transaction(self.conn):
            _insert(self.conn, (invoice.number, invoice.customer_id, invoice.subscription_id, None, invoice.country, cur,
                                invoice.issued_on.isoformat(), *[to_minor(getattr(invoice, k), cur) for k in AMOUNTS],
                                invoice.status, invoice.coupon_code))
            for position, line in enumerate(invoice.lines, start=1):
                self.conn.execute("INSERT INTO invoice_lines VALUES (?,?,?,?)",
                                  (invoice.number, position, line.description, to_minor(line.amount, cur)))

    def _load(self, row) -> Invoice:
        cur = row[5]
        lines = [InvoiceLine(d, from_minor(a, cur)) for d, a in self.conn.execute(
            "SELECT description, amount_minor FROM invoice_lines WHERE invoice_number = ? ORDER BY position", (row[0],))]
        amounts = dict(zip(AMOUNTS, (from_minor(v, cur) for v in row[7:12])))
        return Invoice(number=row[0], customer_id=row[1], subscription_id=row[2], country=row[4],
                       issued_on=date.fromisoformat(row[6]), lines=lines, coupon_code=row[13], status=row[12],
                       currency=cur, **amounts)

    def get(self, number: str) -> Invoice:
        row = self.conn.execute(f"SELECT {COLUMNS} FROM invoices WHERE number = ?", (number,)).fetchone()
        if row is None:
            raise BillingError("UNKNOWN_INVOICE", number)
        return self._load(row)

    def update(self, invoice: Invoice) -> None:
        with transaction(self.conn):
            changed = self.conn.execute("UPDATE invoices SET status = ?, refunded_minor = ? WHERE number = ?", (
                invoice.status, to_minor(invoice.refunded, invoice.currency), invoice.number)).rowcount
        if not changed:
            raise BillingError("UNKNOWN_INVOICE", invoice.number)

    def list(self, customer_id: Optional[str] = None, status: Optional[str] = None, year: Optional[int] = None) -> List[Invoice]:
        where, args = _filters(customer_id=customer_id, status=status, year=year)
        rows = self.conn.execute(f"SELECT {COLUMNS} FROM invoices{where} ORDER BY issued_on, number", args).fetchall()
        return [self._load(row) for row in rows]

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM invoices").fetchone()[0]


def _filters(customer_id=None, status=None, year=None):
    clauses, args = [], []
    if customer_id is not None:
        clauses.append("customer_id = ?"); args.append(customer_id)
    if status is not None:
        clauses.append("status = ?"); args.append(status)
    if year is not None:
        clauses.append("substr(issued_on, 1, 4) = ?"); args.append("%04d" % int(year))
    return (" WHERE " + " AND ".join(clauses) if clauses else ""), args


# --- import ---------------------------------------------------------------------------------

@dataclass(frozen=True)
class Rejection:
    line: int
    code: str
    detail: str = ""


@dataclass
class ImportReport:
    imported: int = 0
    rejected: List[Rejection] = field(default_factory=list)


class _Bad(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(code)
        self.code, self.detail = code, detail


def _check(text: str, seen) -> tuple:
    try:
        record = json.loads(text)
    except ValueError:
        raise _Bad("BAD_JSON", "not valid JSON") from None
    if not isinstance(record, dict):
        raise _Bad("BAD_JSON", "not a JSON object")
    for key in REQUIRED:
        if record.get(key) is None:
            raise _Bad("MISSING_FIELD", key)
    issued_on = record["issued_on"]
    try:
        if not (isinstance(issued_on, str) and DATE_TEXT.match(issued_on)):
            raise ValueError
        date.fromisoformat(issued_on)
    except ValueError:
        raise _Bad("BAD_DATE", str(issued_on)) from None
    amounts = {k: record.get(k) if record.get(k) is not None else "0" for k in AMOUNTS}
    for key, value in amounts.items():
        if not (isinstance(value, str) and AMOUNT_TEXT.match(value)):
            raise _Bad("BAD_AMOUNT", f"{key}={value!r}")
    cur = record["currency"]
    if cur not in CURRENCY_DECIMALS:
        raise _Bad("UNKNOWN_CURRENCY", str(cur))
    try:
        minor = {k: to_minor(v, cur) for k, v in amounts.items()}
    except ValueError as error:
        raise _Bad("BAD_AMOUNT", str(error)) from None
    if minor["subtotal"] - minor["discount"] + minor["tax"] != minor["total"]:
        raise _Bad("TOTAL_MISMATCH", f"{amounts['subtotal']} - {amounts['discount']} + {amounts['tax']} != {amounts['total']}")
    if record["status"] not in STATUSES:
        raise _Bad("BAD_STATUS", str(record["status"]))
    if seen(record["number"]):
        raise _Bad("DUPLICATE_NUMBER", str(record["number"]))
    return (record["number"], record["customer_id"], record.get("subscription_id"), record.get("plan"), record["country"],
            cur, issued_on, *[minor[k] for k in AMOUNTS], record["status"], record.get("coupon_code"))


def import_jsonl(conn: sqlite3.Connection, path) -> ImportReport:
    migrate(conn)
    report = ImportReport()
    numbers = set()
    in_db = lambda n: n in numbers or conn.execute("SELECT 1 FROM invoices WHERE number = ?", (n,)).fetchone() is not None  # noqa: E731
    with transaction(conn), open(path, encoding="utf-8") as handle:
        for line_no, text in enumerate(handle, start=1):
            if not text.strip():
                continue
            try:
                values = _check(text, in_db)
            except _Bad as bad:
                report.rejected.append(Rejection(line_no, bad.code, bad.detail))
                continue
            _insert(conn, values)
            numbers.add(values[0])
            report.imported += 1
    return report


def write_error_report(report: ImportReport, path) -> None:
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(["line", "code", "detail"])
        for rejection in sorted(report.rejected, key=lambda r: r.line):
            writer.writerow([rejection.line, rejection.code, rejection.detail])


def report_records(conn: sqlite3.Connection, year: Optional[int] = None) -> List[Dict[str, object]]:
    where, args = _filters(year=year)
    out = []
    for row in conn.execute(f"SELECT {COLUMNS} FROM invoices{where} ORDER BY issued_on, number", args):
        cur = row[5]
        record = dict(zip(("number", "customer_id", "subscription_id", "plan", "country", "currency", "issued_on"), row[:7]))
        record.update({k: str(from_minor(v, cur)) for k, v in zip(AMOUNTS, row[7:12])})
        record.update(status=row[12], coupon_code=row[13])
        out.append(record)
    return out
