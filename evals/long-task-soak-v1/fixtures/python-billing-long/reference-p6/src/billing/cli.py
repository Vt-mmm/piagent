"""`python -m billing`: migrate, import, finance reports and exports (docs/CLI.md)."""
import argparse
import datetime
import sys
from typing import Callable, Dict, List, Optional, Tuple

from . import reports, storage
from .errors import BillingError
from .export import export_csv, export_json
from .reports.vat import COUNTRIES

# report name -> (text function, csv function or None, required options, optional options)
REPORTS: Dict[str, Tuple[Callable, Optional[Callable], Tuple[str, ...], Tuple[str, ...]]] = {
    "revenue-by-month": (reports.revenue_by_month, reports.revenue_by_month_csv, ("year",), ()),
    "revenue-by-quarter": (reports.revenue_by_quarter, reports.revenue_by_quarter_csv, ("year",), ()),
    "revenue-by-week": (reports.revenue_by_week, reports.revenue_by_week_csv, ("year",), ()),
    "revenue-by-country": (reports.revenue_by_country, reports.revenue_by_country_csv, (), ("year",)),
    "revenue-by-plan": (reports.revenue_by_plan, reports.revenue_by_plan_csv, (), ("year",)),
    "vat": (reports.vat_return, reports.vat_return_csv, ("country", "year", "quarter"), ()),
    "aging": (reports.aging_report, reports.aging_report_csv, ("as_of",), ()),
    "statement": (reports.customer_statement, reports.customer_statement_csv, ("customer",), ()),
    "top-customers": (reports.top_customers, reports.top_customers_csv, (), ("year", "limit")),
    "coupon-usage": (reports.coupon_usage, reports.coupon_usage_csv, (), ("year",)),
    "refunds": (reports.refund_report, reports.refund_report_csv, ("year",), ()),
    "status-summary": (reports.status_summary, reports.status_summary_csv, (), ("year",)),
    "daily-sales": (reports.daily_sales, reports.daily_sales_csv, ("year", "month"), ()),
    "invoice-register": (reports.invoice_register, reports.invoice_register_csv, ("year", "month"), ()),
    "mrr": (reports.mrr_report, reports.mrr_report_csv, ("year",), ()),
    "churn": (reports.churn_report, reports.churn_report_csv, ("year",), ()),
    "discount-leakage": (reports.discount_leakage, reports.discount_leakage_csv, (), ("year",)),
    "tax-summary": (reports.tax_summary, reports.tax_summary_csv, ("year",), ()),
    "close-pack": (reports.monthly_close_pack, None, ("year", "month"), ()),
}


def _date(text: str) -> datetime.date:
    try:
        return datetime.date.fromisoformat(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a date (YYYY-MM-DD): {text!r}") from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m billing", description="Billing back office.")
    commands = parser.add_subparsers(dest="command", required=True)
    migrate = commands.add_parser("migrate", help="bring the database to the latest schema")
    migrate.add_argument("--db", required=True)
    load = commands.add_parser("import", help="import a JSONL export of invoices")
    load.add_argument("file")
    load.add_argument("--db", required=True)
    load.add_argument("--errors", help="write the rejected lines to this CSV file")
    report = commands.add_parser("report", help="print a finance report")
    report.add_argument("name", choices=sorted(REPORTS))
    report.add_argument("--db", required=True)
    report.add_argument("--year", type=int)
    report.add_argument("--quarter", type=int, choices=range(1, 5))
    report.add_argument("--month", type=int, choices=range(1, 13))
    report.add_argument("--country", choices=sorted(COUNTRIES))
    report.add_argument("--as-of", dest="as_of", type=_date)
    report.add_argument("--customer")
    report.add_argument("--limit", type=int)
    report.add_argument("--csv", action="store_true")
    export = commands.add_parser("export", help="export invoices as CSV or JSON")
    export.add_argument("--db", required=True)
    export.add_argument("--format", required=True, choices=("csv", "json"))
    export.add_argument("--year", type=int)
    return parser


def _report(parser: argparse.ArgumentParser, args: argparse.Namespace) -> str:
    text_fn, csv_fn, required, optional = REPORTS[args.name]
    missing = [name for name in required if getattr(args, name) is None]
    if missing:
        parser.error(f"report {args.name} needs --{missing[0].replace('_', '-')}")
    if args.csv and csv_fn is None:
        parser.error(f"report {args.name} has no CSV variant")
    conn = storage.connect(args.db)
    storage.migrate(conn)
    values: List = [getattr(args, name) for name in required]
    kwargs = {name: getattr(args, name) for name in optional if getattr(args, name) is not None}
    return (csv_fn if args.csv else text_fn)(storage.report_records(conn), *values, **kwargs)


def run(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "migrate":
            print(f"schema version {storage.migrate(storage.connect(args.db))}")
        elif args.command == "import":
            conn = storage.connect(args.db)
            result = storage.import_jsonl(conn, args.file)
            if args.errors:
                storage.write_error_report(result, args.errors)
            print(f"imported {result.imported}, rejected {len(result.rejected)}")
        elif args.command == "report":
            sys.stdout.write(_report(parser, args))
        else:
            conn = storage.connect(args.db)
            storage.migrate(conn)
            invoices = storage.InvoiceRepository(conn).list(year=args.year)
            sys.stdout.write(export_csv(invoices) if args.format == "csv" else export_json(invoices) + "\n")
    except BillingError as error:
        print(f"error: {error.code}: {error.message}", file=sys.stderr)
        return 1
    return 0
