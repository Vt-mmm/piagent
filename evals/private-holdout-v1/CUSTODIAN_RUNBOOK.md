# E3 custodian runbook

This runbook is for an independent holdout custodian. It is intentionally safe
to ship with the public candidate: it contains no private task, repository,
grader, reviewer identity, score, credential, or locator.

## Trust boundary

The candidate author cannot act as custodian, reviewer, adjudicator, or release
auditor. The readiness CLI validates a closed receipt, but it is not a
self-authenticating proof of who created that receipt. The independent release
auditor must verify the receipt origin and append-only custody record in the
controlled environment before `CF-FS4-05` can pass. Candidate authors cannot
self-attest E3.

Never copy the private suite, source repositories, prompts, graders, reference
solutions, mutations, access log, raw reviewer sheets, or private paths into the
candidate repository, benchmark output, public tracker, or model context.

## Inputs held outside the candidate-author environment

- a private suite with at least six task-family lineages from at least six
  repository lineages;
- the append-only access log and independent custodian identity;
- hidden graders, reference solutions, declared mutations and their reports;
- the blinded reviewer roster, sealed first-pass score sheets, disagreement log
  and independent adjudication record;
- the exact public candidate package or commit being evaluated.

## Procedure

1. Record the exact candidate identity and the SHA-256 commitments for
   `access-policy.v1.json`, `human-rubric.v1.json`,
   `public-exposure.v1.json`, and `real-task-taxonomy.v1.json`.
2. Compare private family and repository lineage against every entry in the
   public exposure file. A rename, fork, vendor copy, generated variant, or
   shared fixture lineage is overlap, not disjointness.
3. Verify that the candidate author had no private prompt, grader, repository,
   reviewer, or raw-score access and that the benchmark operator had only an
   execute-only interface. Seal the append-only access-log commitment before
   private execution.
4. Run every reference solution and declared mutation in the controlled
   environment. Every reference must pass and every mutation must be killed.
5. Select at least 12 items across at least four task families after candidate
   freeze. Have at least two blinded reviewers independently score every item.
   Preserve both initial scores, record every disagreement, and use an
   independent adjudicator. No unresolved disagreement is permitted.
6. Create a schema-v2 assurance receipt containing only the closed values
   allowed by `benchmark-assurance-evidence.schema.json`. Do not add raw text,
   paths, locators, reviewer identities, outputs, credentials, or private
   metadata.
7. In the controlled environment, run:

   ```text
   node scripts/private-holdout-readiness.mjs --evidence <secure-receipt-path>
   ```

8. Independently read back the candidate identity, receipt SHA-256, custody
   origin, access validity window, disjointness counts, reference/mutation
   totals, sample counts, agreement arithmetic, and zero-unresolved status.
9. Export only the CLI's redacted JSON output plus the auditor's external
   custody attestation. Do not export the input path or private artifacts.

## Stop conditions

Stop without rerunning the candidate if any author access, lineage overlap,
surviving mutation, failed reference, invalid/expired access receipt, missing
double score, unresolved disagreement, arithmetic mismatch, digest mismatch,
candidate drift, or private-field leak is observed. A failed receipt cannot be
repaired by changing the private task or grader after observing candidate
output; create a new versioned holdout and a new evaluation attempt instead.

## Output boundary

`ready: true` means only that the sealed E3 readiness receipt is structurally
and cryptographically hash-bound to the current public boundary. It does not by
itself grant a quality, token, latency, generalization, production-stability, or
release claim. Those claims require the later exact-RC FS5-FS7 evidence and an
independent GO decision.
