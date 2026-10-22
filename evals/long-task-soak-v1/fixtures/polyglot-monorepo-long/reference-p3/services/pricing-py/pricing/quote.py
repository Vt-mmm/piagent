"""Quotes: subtotal, account-tier discount, total (integers, smallest currency unit)."""

from .account import account_discount_rate
from .order import PPM


def quote(order):
    subtotal = sum(item.qty * item.unit_price for item in order.items)
    discount = subtotal * account_discount_rate(order.account_tier) // 100
    return {
        "order_id": order.order_id,
        "account_id": order.account_id,
        "currency": order.currency,
        "subtotal": subtotal,
        "discount": discount,
        "total": subtotal - discount,
    }


def settlement_total(order):
    """The quote total in the settlement currency: total * fx_rate_ppm / 1 000 000, rounded down."""
    return quote(order)["total"] * order.fx_rate_ppm // PPM
