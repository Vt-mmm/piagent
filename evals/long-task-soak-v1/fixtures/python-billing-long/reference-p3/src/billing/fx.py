import bisect
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Dict, List, Set, Tuple

from .errors import BillingError


class FxTable:
    """Units of each currency one US dollar buys, by business day."""

    def __init__(self, rows: Dict[str, List[Tuple[date, Decimal]]]):
        self._rows = {cur: sorted(items) for cur, items in rows.items()}
        self._dates = {cur: [d for d, _ in items] for cur, items in self._rows.items()}

    def currencies(self) -> Set[str]:
        return set(self._rows) | {"USD"}

    def rate(self, currency: str, on: date) -> Decimal:
        if currency == "USD":
            return Decimal(1)
        if currency not in self._rows:
            raise BillingError("UNKNOWN_CURRENCY", str(currency))
        index = bisect.bisect_right(self._dates[currency], on)
        if index == 0:
            raise BillingError("FX_RATE_MISSING", f"{currency} on {on.isoformat()}")
        return self._rows[currency][index - 1][1]


def load_fx_rates(path) -> FxTable:
    rows: Dict[str, List[Tuple[date, Decimal]]] = {}
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            line = line.strip()
            if number == 1 or not line:
                continue
            fields = line.split(",")
            if len(fields) != 3:
                raise BillingError("BAD_FX_FILE", f"line {number}: expected 3 fields")
            try:
                day = date.fromisoformat(fields[0].strip())
                rate = Decimal(fields[2].strip())
            except (ValueError, InvalidOperation):
                raise BillingError("BAD_FX_FILE", f"line {number}: bad date or rate") from None
            if not rate.is_finite() or rate <= 0:
                raise BillingError("BAD_FX_FILE", f"line {number}: rate must be positive")
            rows.setdefault(fields[1].strip(), []).append((day, rate))
    return FxTable(rows)
