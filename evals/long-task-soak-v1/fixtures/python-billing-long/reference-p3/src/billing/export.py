import csv
import io
import json

from .money import format_money

COLUMNS = ["number", "customer_id", "subscription_id", "country", "issued_on",
           "subtotal", "discount", "tax", "total", "refunded", "status"]
AMOUNTS = {"subtotal", "discount", "tax", "total", "refunded"}


def _row(invoice):
    row = {}
    for key in COLUMNS:
        value = getattr(invoice, key)
        if key in AMOUNTS:
            value = format_money(value)
        elif key == "issued_on":
            value = value.isoformat()
        row[key] = value
    return row


def export_csv(invoices) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(COLUMNS)
    for invoice in invoices:
        row = _row(invoice)
        writer.writerow([row[key] for key in COLUMNS])
    return out.getvalue()


def export_json(invoices) -> str:
    items = []
    for invoice in invoices:
        row = _row(invoice)
        cur = invoice.currency
        for key in AMOUNTS:
            row[key] = format_money(getattr(invoice, key), cur)
        row["coupon_code"] = invoice.coupon_code
        row["currency"] = cur
        row["total_usd"] = format_money(invoice.total_usd)
        row["lines"] = [{"description": line.description, "amount": format_money(line.amount, cur)} for line in invoice.lines]
        items.append(row)
    return json.dumps(items, indent=2)
