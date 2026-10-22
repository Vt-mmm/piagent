from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass
class CreditNote:
    number: str
    invoice_number: str
    amount: Decimal
    tax_portion: Decimal
    issued_on: date
