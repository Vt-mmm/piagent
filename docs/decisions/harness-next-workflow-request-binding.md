# Exact benchmark workflow request binding

## Reproduced integration defect

At source `84f8aca`, the verification catalog allowed only the digest of a
trimmed public prompt. A WebUI journey carrying `workflow: "task"` instead
dispatches `/workflow task <request>`, then sends `/task <request>` as an
extension-origin follow-up. The agent-start hook preserves that workflow prefix
for ordinary prose; automatic task intake stores its digest. A valid catalog
therefore failed to select the request that the runtime actually created.

The source trace was checked against installed Pi 0.84.1, whose
`sendUserMessage` disables prompt-template expansion. The regression captures
the repository's actual workflow dispatcher, preserving its newline-aware
argument parsing. Before the fix, the selected catalog regression set reported
1 pass and 16 failures, including refusal of the actual workflow digest and
acceptance of the undelivered raw prompt digest. Those are development tests,
not benchmark sessions or independent evaluation.

Current production-v2 has eight explicitly workflow-tagged turns across
`tenant-cache-isolation`, `workflow-switch-same-session` and
`reconnect-chat-event-order`. The six S12 scenarios have none. No current public
benchmark prompt starts with a command, triggers governed-boilerplate extraction,
changes under secret redaction or exceeds 8,000 UTF-16 units.

## Correction and invariants

The runtime namespace and catalog use one pure follow-up builder. Existing
onboarding text is moved without changes; fresh-session command behavior stays
unchanged. The hook and catalog share the existing agent-start request
normalization. Only the catalog additionally projects bounded/redacted request
persistence; runtime classification and criterion derivation still see the
original query, with no new pre-redaction or whitespace flattening.

Catalog preview refuses transformations it cannot bind statically: bare command
dispatch, raw boilerplate collapse/freshening, long raw inputs, possible image
attachment rewriting and missing bounded identity. It also refuses distinct
scenario inputs that normalize/redact to one digest, while retaining identical
repeated requests. It never reads a referenced image to decide the identity.
Unsupported metadata fails closed instead of becoming an ordinary prompt.

The copied-guard integration regression runs the actual namespace, extension
input hook and agent-start hook, then reads the persisted task. It checks the
exact prefix, internal newlines and catalog digest, with the receipt still
pending. Host SDK entry points are stubbed: this is not a real model session,
browser campaign, independent custody review or verifier-worker execution.

## Release boundary

No expected answer, hidden grader, completion gate, provider configuration or
worker algorithm changes. No authority is created by request projection. A
matching prospective request does not prove task admission or matching criterion
IDs: pending-task reuse, uncertain-send recovery, policy and intake limits still
apply. New source/verifier and public-test exposure identities require fresh
qualification and independent review; earlier full-run or campaign receipts
cannot be relabeled as evidence for this change.
