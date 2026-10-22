"""Builds reference-p2 conformance cases and hidden-p2 vectors; expectations from the reference Python reader.

Usage: copy project/, reference/ and reference-p2/ (in that order) into <fixture>/stage, then
    python3 gen_p2_cases.py <fixture dir>   (and remove stage/ afterwards)
"""
import json, sys, warnings, copy
F = sys.argv[1]
sys.path.insert(0, F + "/stage/services/pricing-py")
from pricing import parse_order, quote, ContractError

def outcome(payload):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            o = parse_order(copy.deepcopy(payload))
        except ContractError as e:
            return {"error": e.code}
    q = quote(o)
    return {"ok": {"source_version": o.source_version, "account_id": o.account_id, "account_tier": o.account_tier,
                   "currency": o.currency, "subtotal": q["subtotal"], "discount": q["discount"], "total": q["total"]}}

V2 = {"contract_version": 2, "order_id": "O-1", "account_id": "A-1", "account_tier": "gold", "currency": "VND",
      "items": [{"sku": "TEA-01", "qty": 3, "unit_price": 45000}, {"sku": "CUP-02", "qty": 1, "unit_price": 120001}]}
V1 = {"contract_version": 1, "order_id": "O-2", "customer_id": "C-2", "customer_tier": "vip", "currency": "USD",
      "items": [{"sku": "TEA-01", "qty": 7, "unit_price": 1999}]}
def p(base, **kw):
    d = copy.deepcopy(base); d.update(kw); return d
def drop(base, key):
    d = copy.deepcopy(base); d.pop(key); return d

own = [
    ("v2 gold", V2), ("v2 standard", p(V2, account_tier="standard")), ("v2 vip rounding", p(V2, account_tier="vip", items=[{"sku": "A", "qty": 1, "unit_price": 999}])),
    ("unit price zero", p(V2, items=[{"sku": "A", "qty": 2, "unit_price": 0}])),
    ("version four", p(V2, contract_version=4)), ("version string", p(V2, contract_version="2")), ("version zero", p(V2, contract_version=0)),
    ("v2 extra field ignored", p(V2, note="x")), ("empty account", p(V2, account_id="")), ("unknown tier", p(V2, account_tier="platinum")),
    ("lowercase currency", p(V2, currency="vnd")), ("digit in currency", p(V2, currency="US1")), ("no items", p(V2, items=[])),
    ("qty zero", p(V2, items=[{"sku": "A", "qty": 0, "unit_price": 1}])), ("qty bool", p(V2, items=[{"sku": "A", "qty": True, "unit_price": 1}])),
    ("negative price", p(V2, items=[{"sku": "A", "qty": 1, "unit_price": -1}])), ("missing order id", drop(V2, "order_id")), ("not an object", [V2]),
]
compat = [("v2 with legacy id", p(V2, customer_id="C-1")), ("v1 vip", V1), ("v1 without version", drop(V1, "contract_version")), ("v1 with new id", p(V1, account_id="A-2")), ("v1 bad tier", p(V1, customer_tier="gold ")),]
def cases(rows):
    return [{"name": n, "payload": pl, "expect": outcome(pl)} for n, pl in rows]
def dump(path, rows):
    with open(path, "w", encoding="utf-8") as h:
        h.write("[\n" + ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n")
dump(F + "/reference-p2/shared/contracts/conformance/cases.json", cases(own))
dump(F + "/reference-p2/shared/contracts/conformance/cases-compat-v1.json", cases(compat))

hidden = [
    ("h v2 basic", p(V2, order_id="H-1", account_id="ACC-77")),
    ("h v2 big", p(V2, account_tier="vip", items=[{"sku": "X", "qty": 50, "unit_price": 4999999}, {"sku": "Y", "qty": 3, "unit_price": 7}])),
    ("h v2 many items", p(V2, account_tier="gold", items=[{"sku": "S%d" % i, "qty": i, "unit_price": 1001 * i} for i in range(1, 9)])),
    ("h v1", p(V1, order_id="H-2")), ("h v1 no version", drop(p(V1, customer_tier="standard"), "contract_version")),
    ("h v1 version bool", p(V1, contract_version=True)), ("h null version", p(V2, contract_version=None)), ("h version 2.5", p(V2, contract_version=2.5)),
    ("h version -1", p(V2, contract_version=-1)), ("h version 4", p(V2, contract_version=4)),
    ("h v2 legacy tier", p(V2, customer_tier="gold")), ("h v1 new tier", p(V1, account_tier="gold")),
    ("h currency US1", p(V2, currency="US1")), ("h currency 4", p(V2, currency="EURO")), ("h currency number", p(V2, currency=840)),
    ("h tier null", p(V2, account_tier=None)), ("h account number", p(V2, account_id=12)), ("h order empty", p(V2, order_id="")),
    ("h items not list", p(V2, items={"sku": "A"})), ("h item not object", p(V2, items=["A"])), ("h sku empty", p(V2, items=[{"sku": "", "qty": 1, "unit_price": 1}])),
    ("h qty string", p(V2, items=[{"sku": "A", "qty": "2", "unit_price": 1}])), ("h qty float", p(V2, items=[{"sku": "A", "qty": 1.5, "unit_price": 1}])),
    ("h price bool", p(V2, items=[{"sku": "A", "qty": 1, "unit_price": False}])), ("h price missing", p(V2, items=[{"sku": "A", "qty": 1}])),
    ("h string payload", "order"), ("h null payload", None), ("h array payload", []),
    ("h v1 empty legacy id", p(V1, customer_id="")),
]
dump(F + "/hidden-p2/.soak/p2/vectors.json", cases(hidden))
for n, pl in hidden: print(n, outcome(pl))
