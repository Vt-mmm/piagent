from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import List, Optional, Tuple

from .errors import BillingError


@dataclass(frozen=True)
class DunningPolicy:
    retry_days: Tuple[int, ...] = (1, 3, 7)
    grace_days: int = 7

    def __post_init__(self):
        days = tuple(self.retry_days)
        if not days or any(not isinstance(d, int) or d <= 0 for d in days) or any(b <= a for a, b in zip(days, days[1:])):
            raise BillingError("INVALID_POLICY", f"retry_days {self.retry_days!r}")
        if not isinstance(self.grace_days, int) or self.grace_days < 0:
            raise BillingError("INVALID_POLICY", f"grace_days {self.grace_days!r}")
        object.__setattr__(self, "retry_days", days)


@dataclass(frozen=True)
class DunningEvent:
    on: date
    kind: str
    invoice_number: str
    attempt: Optional[int] = None


@dataclass
class DunningCase:
    """One invoice in dunning: the retries still to run, then the grace period."""
    invoice_number: str
    retries: List[Tuple[int, date]] = field(default_factory=list)
    grace_end: Optional[date] = None

    @classmethod
    def start(cls, invoice_number: str, failed_on: date, policy: DunningPolicy) -> "DunningCase":
        retries = [(n, failed_on + timedelta(days=d)) for n, d in enumerate(policy.retry_days, start=1)]
        return cls(invoice_number, retries)
