from decimal import Decimal, InvalidOperation

from .errors import BillingError

CENT = Decimal("0.01")


def to_money(value) -> Decimal:
    """Decimal, int or numeric str -> Decimal. Floats are refused on purpose."""
    if isinstance(value, bool) or isinstance(value, float):
        raise BillingError("INVALID_AMOUNT", f"use Decimal or str, not {type(value).__name__}")
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, int):
        result = Decimal(value)
    elif isinstance(value, str):
        try:
            result = Decimal(value.strip())
        except InvalidOperation:
            raise BillingError("INVALID_AMOUNT", f"not a number: {value!r}") from None
    else:
        raise BillingError("INVALID_AMOUNT", f"unsupported type {type(value).__name__}")
    if not result.is_finite():
        raise BillingError("INVALID_AMOUNT", f"not a finite number: {value!r}")
    return result


def format_money(amount) -> str:
    return f"{to_money(amount).quantize(CENT):.2f}"


def round_money(value) -> Decimal:
    """Round to cents. The rounding mode is still open (see SPEC.md §1)."""
    raise NotImplementedError("round_money: rounding mode not decided yet")
