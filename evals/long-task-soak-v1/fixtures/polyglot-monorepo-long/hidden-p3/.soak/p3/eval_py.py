"""Hidden evaluator: pricing-py on .soak/p3/cases.jsonl → JSON lines on stdout."""
import json
import sys
import warnings

sys.path.insert(0, "services/pricing-py")
import pricing  # noqa: E402

warnings.simplefilter("ignore")
for line in open(".soak/p3/cases.jsonl", encoding="utf-8"):
    data = json.loads(line)
    try:
        order = pricing.parse_order(data)
        q = pricing.quote(order)
        out = {"ok": {"source_version": order.source_version, "account_id": order.account_id, "account_tier": order.account_tier,
                      "currency": order.currency, "settlement_currency": order.settlement_currency, "fx_rate_ppm": order.fx_rate_ppm,
                      "subtotal": q["subtotal"], "discount": q["discount"], "total": q["total"],
                      "settlement_total": pricing.settlement_total(order), "wire": order.to_dict()}}
    except pricing.ContractError as error:
        out = {"error": error.code}
    except Exception as error:  # a crash is a wrong answer, not a harness failure
        out = {"crash": "%s: %s" % (type(error).__name__, error)}
    print(json.dumps(out, ensure_ascii=False))
