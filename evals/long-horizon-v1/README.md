# Long-horizon lifecycle lane v1

This lane exercises one real repository task across three durable process
boundaries. It uses the existing Task Contract v2, task journal, handoff,
resume inspection, context telemetry, working-tree digest, and global
continuation budget. It does not introduce another product state machine.

The default run processes 90 logical one-minute units over at least 30 minutes
of real wall-clock time. The controller kills the first worker with `SIGKILL`
after unit 30, performs a planned handoff after unit 60, and completes in a
third process. Context compaction occurs at units 20, 40, 60, and 80.

```bash
node evals/long-horizon-v1/runner.mjs \
  --output evals/long-horizon-v1/reports/provider-free-30m-run.v1.json
```

The fast mode exists only for deterministic local calibration and cannot be
used as wall-clock evidence:

```bash
node evals/long-horizon-v1/runner.mjs \
  --calibration-fast --tick-ms 2 --output /tmp/long-horizon-fast.json
```

The recorded context value is explicitly a deterministic provider-free proxy,
not provider/model context usage. This lane can prove lifecycle durability,
bounded local-state growth, compaction, continuation enforcement, and stable
final verification. It cannot prove model quality, token or latency savings,
90-minute wall-clock behavior, generalization, or release readiness.
