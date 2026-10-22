#!/usr/bin/env python3
"""Incident report for a merged web-js + pricing-py production log.

    python3 scripts/log_report.py logs/prod-2025-10.log          # JSON report on stdout
    python3 scripts/log_report.py logs/prod-2025-10.log --top 10

See docs/specs/4-log-report.md for the exact definitions (Python 3.9, stdlib only).
"""
import argparse
import json
import math
import re
import sys
from datetime import datetime, timedelta, timezone

WEBJS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3})Z level=(\w+) svc=web-js (.*)$")
PRICING = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),(\d{3})([+-]\d{4}) +(DEBUG|INFO|WARNING|ERROR|CRITICAL) +(.*)$")
FIELD = re.compile(r'(\w+)=("[^"]*"|\S+)')
ID_SEGMENT = re.compile(r"[A-Z]-\d+|\d+")
INCIDENT_RATE = 0.2


def normalize_endpoint(method, path):
    path = path.split("?", 1)[0]
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return method + " " + "/".join("{id}" if ID_SEGMENT.fullmatch(seg) else seg for seg in path.split("/"))


def signature(service, message):
    message = re.sub(r"\b[0-9a-f]{8,}\b", "<hex>", message)
    return service + ": " + re.sub(r"\d+", "<n>", message)


def p95(values):
    ordered = sorted(values)
    return ordered[math.ceil(0.95 * len(ordered)) - 1]


def parse_line(line):
    """→ ('request', when, endpoint, status, latency|None) | ('error', when, signature) | ('other', when) | None."""
    match = WEBJS.match(line)
    if match:
        when = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S.%f").replace(tzinfo=timezone.utc)
        level, fields = match.group(2), dict(FIELD.findall(match.group(3)))
        if level == "error" and "msg" in fields:
            return ("error", when, signature("web-js", fields["msg"].strip('"')))
        if "method" in fields:
            if not all(k in fields for k in ("path", "status", "latency_ms")) or not fields["status"].isdigit():
                return None
            latency = None if fields["latency_ms"] == "-" else int(fields["latency_ms"])
            return ("request", when, normalize_endpoint(fields["method"], fields["path"]), int(fields["status"]), latency)
        return ("other", when)
    match = PRICING.match(line)
    if match:
        offset = match.group(3)
        tz = timezone((1 if offset[0] == "+" else -1) * timedelta(hours=int(offset[1:3]), minutes=int(offset[3:])))
        when = datetime.strptime(match.group(1), "%Y-%m-%d %H:%M:%S").replace(microsecond=int(match.group(2)) * 1000, tzinfo=tz)
        if match.group(4) in ("ERROR", "CRITICAL"):
            return ("error", when.astimezone(timezone.utc), signature("pricing-py", match.group(5)))
        return ("other", when.astimezone(timezone.utc))
    return None


def report(lines, top=5):
    total = unparsed = 0
    requests, errors = [], []
    for raw in lines:
        line = raw.rstrip("\n")
        total += 1
        parsed = parse_line(line)
        if parsed is None:
            unparsed += 1
        elif parsed[0] == "request":
            requests.append(parsed[1:])
        elif parsed[0] == "error":
            errors.append(parsed[1:])

    counts = {}
    for _, sig in errors:
        counts[sig] = counts.get(sig, 0) + 1
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    latencies = {}
    per_minute = {}
    for when, endpoint, status, latency in requests:
        if latency is not None:
            latencies.setdefault(endpoint, []).append(latency)
        minute = when.replace(second=0, microsecond=0)
        seen, bad = per_minute.get(minute, (0, 0))
        per_minute[minute] = (seen + 1, bad + (status >= 500))

    best, run = [], []
    for minute in sorted(per_minute):
        seen, bad = per_minute[minute]
        hot = bad / seen >= INCIDENT_RATE
        if hot and run and minute - run[-1] == timedelta(minutes=1):
            run.append(minute)
        elif hot:
            run = [minute]
        else:
            run = []
        if len(run) > len(best):
            best = list(run)

    incident = None
    if best:
        start, end = best[0], best[-1] + timedelta(minutes=1)
        window = {}
        for when, sig in errors:
            if start <= when < end:
                window[sig] = window.get(sig, 0) + 1
        stamp = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
        incident = {
            "start": stamp(start),
            "end": stamp(end),
            "minutes": len(best),
            "requests": sum(per_minute[m][0] for m in best),
            "errors_5xx": sum(per_minute[m][1] for m in best),
            "top_error": sorted(window.items(), key=lambda kv: (-kv[1], kv[0]))[0][0] if window else None,
        }
    return {
        "total_lines": total,
        "unparsed_lines": unparsed,
        "requests": len(requests),
        "top_errors": [{"signature": s, "count": c} for s, c in ranked[:top]],
        "p95_latency_ms": {e: p95(v) for e, v in sorted(latencies.items())},
        "incident": incident,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("log")
    parser.add_argument("--top", type=int, default=5)
    args = parser.parse_args(argv)
    try:
        with open(args.log, encoding="utf-8", errors="replace") as handle:
            result = report(handle, args.top)
    except OSError as error:
        print("log_report: %s" % error, file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
