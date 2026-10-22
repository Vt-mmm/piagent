"""Quotes: subtotal, account-tier discount, total (integers, smallest currency unit)."""

from .account import account_discount_rate


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
