"""Quotes: subtotal, customer-tier discount, total (integers, smallest currency unit)."""

from .customer import customer_discount_rate


def quote(order):
    subtotal = sum(item.qty * item.unit_price for item in order.items)
    discount = subtotal * customer_discount_rate(order.customer_tier) // 100
    return {
        "order_id": order.order_id,
        "customer_id": order.customer_id,
        "currency": order.currency,
        "subtotal": subtotal,
        "discount": discount,
        "total": subtotal - discount,
    }
