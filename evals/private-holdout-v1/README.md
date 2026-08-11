# E3 private holdout custody boundary

This directory contains only the public, provider-free boundary for `CF-FS4-04`.
It does not contain a holdout suite, private repository, prompt, grader, oracle,
reference solution, reviewer identity, raw score sheet, or private locator.

The operational handoff is documented in `CUSTODIAN_RUNBOOK.md`. The readiness
CLI checks the closed receipt, while the independent FS4-05 auditor must verify
its custody origin outside this repository; authors cannot self-attest E3.

The external custodian must:

1. compare every private task-family lineage and repository lineage with
   `public-exposure.v1.json` inside the controlled environment;
2. keep candidate authors outside the custodian, reviewer, and adjudicator roles;
3. expose an execute-only interface to the benchmark operator after an exact RC
   is frozen;
4. validate every reference solution and declared mutation;
5. sample at least 12 items from at least four families, double-score all of
   them with at least two blinded reviewers, preserve first-pass scores, and
   independently adjudicate every disagreement;
6. export only a schema-v2 `benchmark-assurance-evidence` receipt whose fields
   are closed enums, counts, timestamps, booleans, and SHA-256 commitments.

Schema-v1 assurance evidence remains parseable as historical metadata, but it
cannot unlock a private-holdout/generalization claim. The release benchmark must
still use the exact frozen RC, explicit provider approval, Piagent versus Codex
CLI parity, and the later FS5-FS7 gates.
