import io
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import log_report  # noqa: E402

LOG = """\
2025-10-14T13:06:59.900Z level=info svc=web-js req=aaaa000001 method=GET path=/orders/O-1 status=200 latency_ms=10
2025-10-14T13:07:00.100Z level=warn svc=web-js req=aaaa000002 method=POST path=/accounts/A-12/quotes status=502 latency_ms=900
2025-10-14T13:07:10.000Z level=error svc=web-js req=aaaa000003 msg="upstream pricing-py returned 502"
2025-10-14 20:07:10,500+0700 ERROR   pricing.order: ContractError(UNSUPPORTED_VERSION): unsupported contract_version: 3 [order=O-77]
Traceback (most recent call last):
  File "/app/pricing/order.py", line 112, in parse_order
2025-10-14T13:07:20.000Z level=info svc=web-js req=aaaa000004 method=GET path=/catalog/items/?page=2 status=200 latency_ms=20
2025-10-14T13:07:30.000Z level=info svc=web-js req=aaaa000005 method=GET path=/orders/123 status=499 latency_ms=-
2025-10-14T13:08:01.000Z level=info svc=web-js req=aaaa000006 method=GET path=/orders/O-2 status=200 latency_ms=30
2025-10-14T13:08:02.000Z level=info svc=web-js req=aaaa000007 method=GET path=/orders/O-
2025-10-14 20:08:05,000+0700 INFO    pricing.quote: quoted order=O-78 total=1000
2025-10-14 20:08:06,000+0700 ERROR   pricing.cache: quote cache write failed: redis timeout after 250ms (key=q:abcdef0123)
-- logrotate --
"""


class LogReportTest(unittest.TestCase):
    def setUp(self):
        self.report = log_report.report(io.StringIO(LOG))

    def test_counts(self):
        self.assertEqual(self.report["total_lines"], 13)
        self.assertEqual(self.report["requests"], 5)
        self.assertEqual(self.report["unparsed_lines"], 4)

    def test_endpoints_and_p95(self):
        self.assertEqual(self.report["p95_latency_ms"], {"GET /catalog/items": 20, "GET /orders/{id}": 30, "POST /accounts/{id}/quotes": 900})

    def test_signatures(self):
        sigs = [e["signature"] for e in self.report["top_errors"]]
        self.assertIn("pricing-py: pricing.cache: quote cache write failed: redis timeout after <n>ms (key=q:<hex>)", sigs)
        self.assertIn("web-js: upstream pricing-py returned <n>", sigs)

    def test_incident_uses_utc(self):
        incident = self.report["incident"]
        self.assertEqual((incident["start"], incident["end"], incident["minutes"]), ("2025-10-14T13:07:00Z", "2025-10-14T13:08:00Z", 1))
        self.assertEqual((incident["requests"], incident["errors_5xx"]), (3, 1))
        self.assertEqual(incident["top_error"], "pricing-py: pricing.order: ContractError(UNSUPPORTED_VERSION): unsupported contract_version: <n> [order=O-<n>]")

    def test_no_incident(self):
        self.assertIsNone(log_report.report(io.StringIO(LOG.splitlines()[0] + "\n"))["incident"])

    def test_cli(self):
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as handle:
            handle.write(LOG)
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "log_report.py")
        out = subprocess.run([sys.executable, script, handle.name, "--top", "1"], capture_output=True, text=True)
        os.unlink(handle.name)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(len(json.loads(out.stdout)["top_errors"]), 1)
        missing = subprocess.run([sys.executable, script, "/nonexistent.log"], capture_output=True, text=True)
        self.assertEqual(missing.returncode, 2)


if __name__ == "__main__":
    unittest.main()
