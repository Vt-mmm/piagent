# Hidden acceptance checks for the reports refactor (docs/REPORTS.md):
# billing.reports reproduces every legacy report byte for byte (goldens kept
# here, out of the agent's reach), the package is split and typed, and the
# legacy module is gone or a thin shim.
# The soak oracle lays this file over the agent's work; the agent never sees it.
import ast
import datetime
import importlib
import inspect
import json
from pathlib import Path

import pytest

GOLDEN = Path(__file__).parent / "zz_reports_golden"
CASES = json.loads((GOLDEN / "cases.json").read_text())
SRC = Path(__file__).resolve().parents[1] / "src" / "billing"
PUBLIC = ['aging_report', 'aging_report_csv', 'churn_report', 'churn_report_csv', 'coupon_usage', 'coupon_usage_csv', 'customer_statement', 'customer_statement_csv', 'daily_sales', 'daily_sales_csv', 'discount_leakage', 'discount_leakage_csv', 'invoice_register', 'invoice_register_csv', 'monthly_close_pack', 'mrr_report', 'mrr_report_csv', 'refund_report', 'refund_report_csv', 'revenue_by_country', 'revenue_by_country_csv', 'revenue_by_month', 'revenue_by_month_csv', 'revenue_by_plan', 'revenue_by_plan_csv', 'revenue_by_quarter', 'revenue_by_quarter_csv', 'revenue_by_week', 'revenue_by_week_csv', 'status_summary', 'status_summary_csv', 'tax_summary', 'tax_summary_csv', 'top_customers', 'top_customers_csv', 'vat_return', 'vat_return_csv', 'vat_return_de', 'vat_return_de_csv', 'vat_return_es', 'vat_return_es_csv', 'vat_return_fr', 'vat_return_fr_csv', 'vat_return_gb', 'vat_return_gb_csv', 'vat_return_it', 'vat_return_it_csv', 'vat_return_jp', 'vat_return_jp_csv', 'vat_return_nl', 'vat_return_nl_csv', 'vat_return_se', 'vat_return_se_csv', 'vat_return_us', 'vat_return_us_csv', 'vat_return_vn', 'vat_return_vn_csv']


@pytest.fixture(scope="module")
def reports():
    return importlib.import_module("billing.reports")


@pytest.fixture(scope="module")
def records():
    return [json.loads(line) for line in (GOLDEN / "sample_invoices.jsonl").read_text().splitlines() if line.strip()]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_report_output_is_unchanged(case, reports, records):
    args = [datetime.date.fromisoformat(a["date"]) if isinstance(a, dict) else a for a in case["args"]]
    produced = getattr(reports, case["function"])(list(reversed(records)), *args, **case["kwargs"])
    assert produced == (GOLDEN / (case["id"] + ".txt")).read_text()


def test_vat_errors_unchanged(reports):
    with pytest.raises(ValueError):
        reports.vat_return([], "XX", 2025, 1)
    with pytest.raises(ValueError):
        reports.vat_return_de([], 2025, 5)


@pytest.mark.parametrize("name", PUBLIC)
def test_public_function_is_kept_and_fully_typed(name, reports):
    fn = getattr(reports, name)
    assert callable(fn)
    sig = inspect.signature(fn)
    assert sig.return_annotation is not inspect.Signature.empty, f"{name}: no return annotation"
    for param in sig.parameters.values():
        assert param.annotation is not inspect.Parameter.empty, f"{name}({param.name}): no annotation"
    assert list(sig.parameters)[0] == "records"


def test_package_is_split_into_small_modules():
    package = SRC / "reports"
    assert (package / "__init__.py").is_file(), "billing/reports/ must be a package"
    modules = [p for p in package.rglob("*.py") if p.name != "__init__.py"]
    assert len(modules) >= 4, f"only {len(modules)} modules besides __init__.py"
    for path in package.rglob("*.py"):
        source = path.read_text()
        assert len(source.splitlines()) <= 600, f"{path.name} is longer than 600 lines"
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.ImportFrom):
                assert "legacy_reports" not in (node.module or "") and all(a.name != "legacy_reports" for a in node.names), \
                    f"{path.name} still imports legacy_reports"
            if isinstance(node, ast.Import):
                assert all("legacy_reports" not in a.name for a in node.names), f"{path.name} still imports legacy_reports"
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                length = node.end_lineno - node.lineno + 1
                assert length <= 80, f"{path.name}:{node.name} is {length} lines"


def test_legacy_module_is_gone_or_a_shim():
    legacy = SRC / "legacy_reports.py"
    if legacy.exists():
        assert len(legacy.read_text().splitlines()) <= 40, "legacy_reports.py must be deleted or a re-export shim of at most 40 lines"
