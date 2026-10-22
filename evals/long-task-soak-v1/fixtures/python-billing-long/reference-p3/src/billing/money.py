from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from .errors import BillingError

CENT = Decimal("0.01")
CURRENCY_DECIMALS = {"USD": 2, "EUR": 2, "GBP": 2, "SEK": 2, "JPY": 0, "VND": 0}


def quantum(currency: str = "USD") -> Decimal:
    try:
        return Decimal(1).scaleb(-CURRENCY_DECIMALS[currency])
    except KeyError:
        raise BillingError("UNKNOWN_CURRENCY", str(currency)) from None


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


def format_money(amount, currency: str = "USD") -> str:
    q = quantum(currency)
    return f"{to_money(amount).quantize(q):.{CURRENCY_DECIMALS[currency]}f}"


def round_money(value, currency: str = "USD") -> Decimal:
    """Round half-even (banker's rounding, as the product owner decided) to the currency's decimals."""
    return to_money(value).quantize(quantum(currency), rounding=ROUND_HALF_EVEN)
