#!/usr/bin/env python3
"""Deterministic cross-language cases for p3 (v1/v2/v3 payloads), with the
expected outcome built from the spec (not from any implementation).

    python3 gen_p3_cases.py <out dir>   # writes cases.jsonl and expected.jsonl
"""
import copy
import json
import random
import sys

PPM = 1000000
CURRENCIES = ["VND", "USD", "EUR", "JPY", "SGD", "THB"]
TIERS = {"standard": 0, "gold": 5, "vip": 10}
rng = random.Random(3_000_003)


def valid():
    version = rng.choice([1, 2, 2, 3, 3, 3])
    currency = rng.choice(CURRENCIES)
    tier = rng.choice(list(TIERS))
    acc = rng.choice(["A-%d" % rng.randrange(1, 10 ** 6), "acct_%x" % rng.getrandbits(24), "Đ-%d" % rng.randrange(100)])
    data = {"contract_version": version, "order_id": "O-%d" % rng.randrange(10 ** 7)}
    if version == 1:
        data["customer_id"], data["customer_tier"] = acc, tier
    else:
        data["account_id"], data["account_tier"] = acc, tier
    data["currency"] = currency
    settlement, rate = currency, PPM
    if version == 3:
        settlement = rng.choice(CURRENCIES)
        rate = PPM if settlement == currency else rng.choice([rng.randrange(1, 1000), rng.randrange(1, 10 ** 9 + 1), 10 ** 9, 1])
        data["settlement_currency"], data["fx_rate_ppm"] = settlement, rate
    n = rng.randrange(1, 6)
    data["items"] = [{"sku": "SKU-%d" % rng.randrange(1000), "qty": rng.randrange(1, 60), "unit_price": rng.choice([0, rng.randrange(1, 100), rng.randrange(1, 6_000_000)])} for _ in range(n)]
    if rng.random() < 0.05:
        # the BigInt trap: total * rate far above 2^53
        big_price, big_rate = rng.choice([(424946923, 796870377), (656098743, 585825537), (409487004, 753684249)])
        data["items"] = [{"sku": "BIG", "qty": 1, "unit_price": big_price}]
        data["account_tier" if version != 1 else "customer_tier"] = "standard"
        tier = "standard"
        if version == 3 and settlement != currency:
            data["fx_rate_ppm"] = rate = big_rate
    if version == 1 and rng.random() < 0.4:
        del data["contract_version"]
    subtotal = sum(i["qty"] * i["unit_price"] for i in data["items"])
    discount = subtotal * TIERS[tier] // 100
    total = subtotal - discount
    converts = settlement != currency or rate != PPM
    wire = {"contract_version": 3 if converts else 2, "order_id": data["order_id"], "account_id": acc, "account_tier": tier, "currency": currency}
    if converts:
        wire["settlement_currency"], wire["fx_rate_ppm"] = settlement, rate
    wire["items"] = copy.deepcopy(data["items"])
    ok = {"source_version": version, "account_id": acc, "account_tier": tier, "currency": currency, "settlement_currency": settlement,
          "fx_rate_ppm": rate, "subtotal": subtotal, "discount": discount, "total": total, "settlement_total": total * rate // PPM, "wire": wire}
    return data, {"ok": ok}


def mutate(data):
    version = data.get("contract_version", 1)
    legacy = version == 1
    idk, tierk = ("customer_id", "customer_tier") if legacy else ("account_id", "account_tier")
    options = [
        ("UNSUPPORTED_VERSION", lambda d: d.__setitem__("contract_version", rng.choice([0, 4, -1, "2", "3", 2.5, None, True, 99]))),
        ("INVALID", lambda d: d.__setitem__(idk, rng.choice(["", 7, None, ["A"]]))),
        ("INVALID", lambda d: d.pop(idk)),
        ("INVALID", lambda d: d.__setitem__(tierk, rng.choice(["platinum", "Gold", None, 1]))),
        ("INVALID", lambda d: d.__setitem__("currency", rng.choice(["usd", "US1", "EURO", "", "U D", 840, "ÀBC"]))),
        ("INVALID", lambda d: d.__setitem__("order_id", rng.choice(["", None, 12]))),
        ("INVALID", lambda d: d.__setitem__("items", rng.choice([[], {}, ["x"], None, "items"]))),
        ("INVALID", lambda d: d["items"][0].__setitem__("sku", rng.choice(["", None]))),
        ("INVALID", lambda d: d["items"][-1].__setitem__("qty", rng.choice([0, -1, "1", 1.5, True, None]))),
        ("INVALID", lambda d: d["items"][0].__setitem__("unit_price", rng.choice([-1, "5", False, 0.5, None]))),
    ]
    if legacy:
        options += [
            ("MIXED_FIELDS", lambda d: d.__setitem__(rng.choice(["account_id", "account_tier"]), "x")),
            ("MIXED_FIELDS", lambda d: d.__setitem__(rng.choice(["settlement_currency", "fx_rate_ppm"]), "x")),
        ]
    else:
        options.append(("MIXED_FIELDS", lambda d: d.__setitem__(rng.choice(["customer_id", "customer_tier"]), "x")))
    if version == 2:
        options.append(("MIXED_FIELDS", lambda d: d.__setitem__(rng.choice(["settlement_currency", "fx_rate_ppm"]), rng.choice(["VND", PPM]))))
    if version == 3:
        options += [
            ("INVALID", lambda d: d.pop(rng.choice(["settlement_currency", "fx_rate_ppm"]))),
            ("INVALID", lambda d: d.__setitem__("settlement_currency", rng.choice(["vnd", "VN", "", 704]))),
            ("INVALID", lambda d: d.__setitem__("fx_rate_ppm", rng.choice([0, -1, 10 ** 9 + 1, "1000000", 1.5, True, None]))),
            ("INVALID", lambda d: (d.__setitem__("settlement_currency", d["currency"]), d.__setitem__("fx_rate_ppm", rng.choice([999999, 1000001, 2 * PPM])))),
        ]
    code, apply = rng.choice(options)
    mutated = copy.deepcopy(data)
    apply(mutated)
    return mutated, {"error": code}


def main(out):
    cases, expected = [], []
    for n in range(1500):
        data, outcome = valid()
        if rng.random() < 0.45:
            data, outcome = mutate(data)
        if n % 250 == 7:
            data, outcome = rng.choice(["order", [], None, 5, [data]]), {"error": "INVALID"}
        cases.append(json.dumps(data, ensure_ascii=False))
        expected.append(json.dumps(outcome, ensure_ascii=False))
    with open(out + "/cases.jsonl", "w", encoding="utf-8") as h:
        h.write("\n".join(cases) + "\n")
    with open(out + "/expected.jsonl", "w", encoding="utf-8") as h:
        h.write("\n".join(expected) + "\n")
    print(len(cases), "cases;", sum('"error"' in e for e in expected), "errors")


if __name__ == "__main__":
    main(sys.argv[1])
