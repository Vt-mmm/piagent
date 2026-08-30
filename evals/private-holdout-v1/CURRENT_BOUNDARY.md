# Current public exposure boundary

Use `public-exposure.v2.json` for a new custody review. The v1 file and
`CUSTODIAN_RUNBOOK.md` are retained historical inputs, not a complete current
exposure inventory. All role separation, private-data restrictions, reference
and mutation checks, blinded review and independent attestation requirements
in that runbook remain mandatory. Its step 1 must now bind the v2 exposure file.

The earlier file omitted the public `deep-logic-v1` and `production-v2` suites.
V2 includes all six current public suites (66 scenarios), all 13 contract-family
versions and nine public development trees, including test programs and
author-written calibration examples. The predecessor digest preserves prior
exposure. These counts are inventory counts, not executed or passing sessions.

Before custody review, check the complete public source tree, including its
development tests. The runtime npm package intentionally omits those tests and
cannot establish inventory freshness alone; use the exact frozen source bundle
or checkout, without substituting a current checkout for a different candidate:

```text
node scripts/public-evaluation-exposure.mjs --check
```

The maintainer may regenerate the inventory with `--write` after public source
changes. Generation grants no authority: a changed digest requires a new
independent lineage comparison and custody receipt. Do not edit an existing
custody receipt to substitute the new digest. The current readiness CLI and
FS4 evaluator refuse stale or incomplete inventories. Old v1-bound receipts
remain historical metadata, not current readiness.

Tree digests cover sorted pairs of repository-relative filename and file
SHA-256. Changing a fixture without changing its suite manifest, adding a
public test or altering a contract library invalidates the inventory. Symlinked
and oversized inputs are refused. These are local filesystem checks, not a
security sandbox against another actor with the same OS privileges; freeze
and independently verify the exact candidate artifact in the controlled
environment before and after private execution.

The inventory is not a complete record of author knowledge. Independently
account for previous diagnostic replays, retained campaigns and any material
outside these public roots. Compare actual lineage and acceptance mechanisms,
not just names or hashes. Never bring private prompts, graders, repositories,
reviewer identities or raw scores into the author environment. Only the closed
assurance receipt and independent custody attestation may cross that boundary.

`ready: true` still grants no provider execution, generalization or release
claim. Independent custody and the remaining exact-candidate release gates
remain separate requirements.
