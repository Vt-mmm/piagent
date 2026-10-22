#!/usr/bin/env python3
"""Deterministic generator for the p4 log investigation (not part of the member's repo).

    python3 gen_log.py --out project/logs/prod-2025-10.log --truth hidden-p4/.soak/p4/expected.json
    python3 gen_log.py --seed 7 --start 2025-10-21T02:00 --minutes 45 --incident 02:11-02:19 \
        --decoy 02:30-02:31 --rate 18 --out hidden-p4/.soak/p4/mini.log --truth hidden-p4/.soak/p4/mini-expected.json

The truth file is computed from what was generated (not by parsing the log), so
it cross-checks the reference scripts/log_report.py.
"""
import argparse
import json
import math
import random
import re
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
LOCAL = timezone(timedelta(hours=7))

ENDPOINTS = [  # (method, path template, weight, base latency ms)
    ("GET", "/accounts/{acc}/quotes", 30, 45),
    ("POST", "/accounts/{acc}/quotes", 22, 120),
    ("GET", "/orders/{ord}", 18, 35),
    ("POST", "/orders", 12, 160),
    ("GET", "/catalog/items", 12, 25),
    ("GET", "/healthz", 6, 2),
]


def normalize_endpoint(method, path):
    path = path.split("?", 1)[0]
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    parts = ["{id}" if re.fullmatch(r"[A-Z]-\d+|\d+", seg) else seg for seg in path.split("/")]
    return method + " " + "/".join(parts)


def signature(svc, message):
    message = re.sub(r"\b[0-9a-f]{8,}\b", "<hex>", message)
    message = re.sub(r"\d+", "<n>", message)
    return svc + ": " + message


def p95(values):
    values = sorted(values)
    return values[math.ceil(0.95 * len(values)) - 1]


def hhmm(day, text):
    h, m = text.split(":")
    return day.replace(hour=int(h), minute=int(m))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=20251014)
    ap.add_argument("--start", default="2025-10-14T12:00")
    ap.add_argument("--minutes", type=int, default=300)
    ap.add_argument("--incident", default="13:07-13:31")
    ap.add_argument("--decoy", default="15:40-15:43")
    ap.add_argument("--rate", type=int, default=76, help="mean requests per minute")
    ap.add_argument("--out", required=True)
    ap.add_argument("--truth", required=True)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    start = datetime.strptime(args.start, "%Y-%m-%dT%H:%M").replace(tzinfo=UTC)
    inc = [hhmm(start, t) for t in args.incident.split("-")]
    dec = [hhmm(start, t) for t in args.decoy.split("-")]

    events = []  # (utc datetime, seq, line)
    requests = []  # (minute, endpoint, status, latency or None)
    errors = []  # (utc datetime, signature)
    seq = 0

    def emit(when, line):
        nonlocal seq
        seq += 1
        events.append((when, seq, line))

    def webjs(when, level, rest):
        stamp = when.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (when.microsecond // 1000)
        emit(when, "%s level=%s svc=web-js %s" % (stamp, level, rest))

    def pricing(when, level, logger, message):
        local = when.astimezone(LOCAL)
        stamp = local.strftime("%Y-%m-%d %H:%M:%S,") + "%03d+0700" % (local.microsecond // 1000)
        emit(when, "%s %-7s %s: %s" % (stamp, level, logger, message))
        if level == "ERROR":
            errors.append((when, signature("pricing-py", "%s: %s" % (logger, message))))

    def webjs_error(when, message):
        webjs(when, "error", 'req=%010x msg="%s"' % (rng.getrandbits(40), message))
        errors.append((when, signature("web-js", message)))

    def traceback(when, fn, line_no, final):
        when = when + timedelta(microseconds=1)
        emit(when, "Traceback (most recent call last):")
        emit(when, '  File "/app/pricing/order.py", line %d, in %s' % (line_no, fn))
        emit(when, "    raise ContractError(code, message)")
        emit(when, final)

    weights = [e[2] for e in ENDPOINTS]
    order_no = 55000
    for minute_index in range(args.minutes):
        minute = start + timedelta(minutes=minute_index)
        in_incident = inc[0] <= minute <= inc[1]
        in_decoy = dec[0] <= minute <= dec[1]
        count = max(8, int(rng.gauss(args.rate, args.rate * 0.08)))
        fail_p = 0.46 if in_incident else 0.36 if in_decoy else 0.012
        seconds = sorted(rng.randrange(60_000_000) for _ in range(count))
        for micro in seconds:
            when = minute + timedelta(microseconds=micro)
            method, template, _, base = rng.choices(ENDPOINTS, weights)[0]
            acc = "A-%d" % rng.randrange(1000, 1400)
            order_no += 1
            ordid = ("O-%d" % order_no) if rng.random() < 0.8 else str(order_no)
            path = template.format(acc=acc, ord=ordid)
            if path == "/catalog/items":
                roll = rng.random()
                if roll < 0.35:
                    path += "?page=%d" % rng.randrange(1, 40)
                elif roll < 0.45:
                    path += "/"
            latency = max(1, int(rng.expovariate(1 / base)) + base // 3)
            if template == "/healthz":
                status = 200
            elif rng.random() < fail_p:
                status = rng.choice([500, 502, 502, 503, 504])
                latency += rng.randrange(800, 3000) if (in_incident or in_decoy) else rng.randrange(0, 300)
            elif rng.random() < 0.035:
                status = rng.choice([400, 404, 409, 422])
            elif rng.random() < 0.004:
                status = 499
            else:
                status = 201 if method == "POST" else 200
            lat_text = "-" if status == 499 else str(latency)
            level = "warn" if status >= 500 else "info"
            req = "%010x" % rng.getrandbits(40)
            line_rest = "req=%s method=%s path=%s status=%d latency_ms=%s" % (req, method, path, status, lat_text)
            if rng.random() < 0.0012 and status < 500:
                # truncated by the log shipper: cut before status=
                cut = line_rest.index(" status=")
                webjs(when, level, line_rest[: cut - rng.randrange(0, 4)])
                continue
            webjs(when, level, line_rest)
            requests.append((minute, normalize_endpoint(method, path), status, None if status == 499 else latency))

            # Errors attached to requests.
            if status >= 500:
                if in_incident or in_decoy:
                    if rng.random() < 0.25:
                        webjs_error(when + timedelta(microseconds=200), "upstream pricing-py returned %d" % status)
                elif rng.random() < 0.5:
                    webjs_error(when + timedelta(microseconds=200), "upstream timeout after %dms calling pricing-py" % rng.choice([3000, 5000]))
            if template.startswith("/accounts") and status == 404 and rng.random() < 0.9:
                webjs_error(when + timedelta(microseconds=300), "account lookup failed for %s: 404 from account-api" % acc)
            if template == "/accounts/{acc}/quotes" and method == "POST":
                ptime = when + timedelta(microseconds=500)
                oid = "O-%d" % order_no
                if in_incident and rng.random() < 0.72:
                    pricing(ptime, "ERROR", "pricing.order", "ContractError(UNSUPPORTED_VERSION): unsupported contract_version: 3 [order=%s]" % oid)
                    if rng.random() < 0.25:
                        traceback(ptime, "parse_order", 112, "pricing.order.ContractError: unsupported contract_version: 3")
                elif status == 422:
                    msg = rng.choice(["ContractError(INVALID): items[%d].qty must be a positive integer [order=%s]" % (rng.randrange(0, 3), oid),
                                      "ContractError(INVALID): currency must be a 3-letter code [order=%s]" % oid])
                    pricing(ptime, "ERROR", "pricing.order", msg)
                    if rng.random() < 0.5:
                        traceback(ptime, "parse_order", 97, "pricing.order.ContractError: invalid order")
                elif status < 400 and rng.random() < 0.25:
                    pricing(ptime, "INFO", "pricing.quote", "quoted order=%s total=%d" % (oid, rng.randrange(1, 900) * 1000))
                elif status < 400 and rng.random() < 0.02:
                    pricing(ptime, "WARNING", "pricing.quote", "slow quote %dms order=%s" % (rng.randrange(400, 900), oid))
        # Background noise per minute.
        if rng.random() < 0.09:
            when = minute + timedelta(seconds=rng.randrange(60))
            pricing(when, "ERROR", "pricing.cache", "quote cache write failed: redis timeout after %dms (key=q:%010x)" % (rng.choice([250, 500]), rng.getrandbits(40) | (0xA << 36)))
        if rng.random() < 0.05:
            webjs_error(minute + timedelta(seconds=rng.randrange(60)), "rate limited by account-api, retry in %ds" % rng.randrange(5, 30))
        if rng.random() < 0.012:
            emit(minute + timedelta(seconds=rng.randrange(60)), "-- logrotate: reopened /var/log/shopflow/app.log --")
        if rng.random() < 0.03:
            pricing(minute + timedelta(seconds=rng.randrange(60)), "INFO", "pricing.health", "ok workers=%d" % rng.randrange(2, 9))

    events.sort()
    lines = [line for _, _, line in events]
    with open(args.out, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")

    # Truth.
    per_minute = {}
    for minute, _, status, _ in requests:
        total, bad = per_minute.get(minute, (0, 0))
        per_minute[minute] = (total + 1, bad + (status >= 500))
    best = None
    run = []
    for index in range(args.minutes + 1):
        minute = start + timedelta(minutes=index)
        total, bad = per_minute.get(minute, (0, 0))
        if total and bad / total >= 0.2:
            run.append(minute)
            continue
        if run and (best is None or len(run) > len(best)):
            best = run
        run = []
    window_start, window_end = best[0], best[-1] + timedelta(minutes=1)
    in_window = [s for t, s in errors if window_start <= t < window_end]
    counts = {}
    for sig in in_window:
        counts[sig] = counts.get(sig, 0) + 1
    top_in_window = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    all_counts = {}
    for _, sig in errors:
        all_counts[sig] = all_counts.get(sig, 0) + 1
    by_endpoint = {}
    for _, endpoint, _, latency in requests:
        if latency is not None:
            by_endpoint.setdefault(endpoint, []).append(latency)
    fmt = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
    truth = {
        "total_lines": len(lines),
        "unparsed_lines": len(lines) - len(requests) - len(errors) - sum(1 for l in lines if re.match(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d{3}\+0700 (INFO|WARNING) ", l)),
        "requests": len(requests),
        "top_errors": [{"signature": s, "count": c} for s, c in sorted(all_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:5]],
        "p95_latency_ms": {e: p95(v) for e, v in sorted(by_endpoint.items())},
        "incident": {
            "start": fmt(window_start),
            "end": fmt(window_end),
            "minutes": len(best),
            "requests": sum(per_minute[m][0] for m in best),
            "errors_5xx": sum(per_minute[m][1] for m in best),
            "top_error": top_in_window,
        },
    }
    with open(args.truth, "w", encoding="utf-8") as handle:
        json.dump(truth, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    print(json.dumps(truth, indent=2, ensure_ascii=False))
    print("ERROR-rate per minute around incident:")
    for index in range(args.minutes):
        minute = start + timedelta(minutes=index)
        total, bad = per_minute.get(minute, (0, 0))
        if total and bad / total >= 0.1:
            print("  ", fmt(minute), total, bad, round(bad / total, 3))


if __name__ == "__main__":
    main()
