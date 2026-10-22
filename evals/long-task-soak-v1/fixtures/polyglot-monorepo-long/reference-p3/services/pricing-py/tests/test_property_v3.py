"""Property-style tests: seeded random v1/v2/v3 payloads (reproducible: SEED)."""
import copy
import random
import unittest
import warnings

from pricing import ContractError, parse_order, quote, settlement_total
from pricing.compat_v1 import LEGACY_FIELDS

LEGACY_NAME = {new: old for old, new in LEGACY_FIELDS.items()}  # account_id -> legacy v1 name

SEED = 20251021
CURRENCIES = ("VND", "USD", "EUR", "JPY", "SGD")
TIERS = ("standard", "gold", "vip")


def random_payload(rng):
    version = rng.choice((1, 2, 3))
    currency = rng.choice(CURRENCIES)
    data = {"contract_version": version, "order_id": "O-%d" % rng.randrange(10 ** 6)}
    name = (lambda key: LEGACY_NAME[key]) if version == 1 else (lambda key: key)
    data[name("account_id")] = "A-%d" % rng.randrange(10 ** 5)
    data[name("account_tier")] = rng.choice(TIERS)
    data["currency"] = currency
    if version == 3:
        data["settlement_currency"] = rng.choice(CURRENCIES)
        data["fx_rate_ppm"] = 1000000 if data["settlement_currency"] == currency else rng.randrange(1, 10 ** 9 + 1)
    data["items"] = [{"sku": "S%d" % i, "qty": rng.randrange(1, 51), "unit_price": rng.randrange(0, 5000001)} for i in range(rng.randrange(1, 5))]
    if version == 1 and rng.random() < 0.5:
        del data["contract_version"]
    return data


def read(data):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        return parse_order(copy.deepcopy(data))


class PropertyV3Test(unittest.TestCase):
    def test_valid_payloads(self):
        rng = random.Random(SEED)
        for _ in range(500):
            data = random_payload(rng)
            order = read(data)
            q = quote(order)
            self.assertEqual(order.source_version, data.get("contract_version", 1))
            self.assertTrue(0 <= q["discount"] <= q["subtotal"])
            self.assertEqual(q["total"], q["subtotal"] - q["discount"])
            self.assertEqual(settlement_total(order), q["total"] * order.fx_rate_ppm // 1000000)
            wire = order.to_dict()
            self.assertEqual(wire["contract_version"], 3 if order.settlement_currency != order.currency else 2)
            again = read(wire)
            self.assertEqual((again.account_id, again.items, again.settlement_currency, again.fx_rate_ppm),
                             (order.account_id, order.items, order.settlement_currency, order.fx_rate_ppm))

    def test_mutations(self):
        rng = random.Random(SEED + 1)
        for _ in range(300):
            data = random_payload(rng)
            version = data.get("contract_version", 1)
            mutated, code = copy.deepcopy(data), "INVALID"
            choice = rng.randrange(4)
            if choice == 0:
                mutated["contract_version"], code = rng.choice((0, 4, "3", 2.5, None)), "UNSUPPORTED_VERSION"
            elif choice == 1 and version != 3:
                mutated["fx_rate_ppm"], code = 1000000, "MIXED_FIELDS"
            elif choice == 2:
                mutated["items"][0]["qty"] = rng.choice((0, -1, "1", 1.5, True))
            else:
                mutated["currency"] = rng.choice(("usd", "US1", "EURO", ""))
            with self.assertRaises(ContractError, msg=str(mutated)) as caught:
                read(mutated)
            self.assertEqual(caught.exception.code, code, mutated)


if __name__ == "__main__":
    unittest.main()
