# Runtime conformance lane v1

This deterministic lane verifies the P0 runtime controls introduced for the
adaptive context governor, WebUI operation retry and settlement lifecycle,
bounded runtime emissions, and edit freshness enforcement. It does not call a
provider or model.

Run it with:

```bash
node evals/runtime-conformance-v1/runner.mjs \
  --output /tmp/piagent-runtime-conformance-v1.json
```

The receipt records every case, aggregate metrics, and explicit gates. A
passing receipt requires zero provider calls and model tokens, no projected
tool-protocol orphans, no admitted retry after visible output or a tool call,
exactly-once terminal settlement, final-message bypass of the emission guard,
and stale-edit recovery only after a fresh read.

This is runtime conformance evidence, not a quality or efficiency comparison.
It cannot support a Codex CLI-relative token claim. Keep `production-v1`
unchanged and use its paired GPT-5.6 Luna Medium runs for that claim after this
lane passes.

The paid diagnostic canary is frozen in `paid-canary.json`: four affected
deep-logic families, one repeat, both Piagent and controlled Codex CLI, for
exactly eight GPT-5.6 Luna Medium sessions. Evaluate its generated report with:

```bash
node evals/runtime-conformance-v1/evaluate-paid-canary.mjs \
  --report /path/to/report.json \
  --output /path/to/runtime-p0-canary-receipt.json
```

The evaluator fails closed on task/model/effort drift, provider-wire or causal
receipt gaps, quality/continuity regression, infrastructure retry, incomplete
token evidence, subagent overuse, pooled total traffic above `1.10`, or any
targeted family above `1.25`. The geometric point estimate, upper-95 interval,
and API-equivalent cost remain nonblocking diagnostics: four one-repeat families
cannot establish the final saving claim, and aggregate-only long-context usage
must not be priced by assumption. Passing allows preparation of a new
clean-source `production-v1` S12 stage; only S108 can establish the public claim.
