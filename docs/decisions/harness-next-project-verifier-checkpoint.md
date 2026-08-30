# Harness Next project verifier binding — 2026-08-30

Status: integrated into the development runtime; not released. Independent contract admission remains unfinished.

## Current workspace, not just current dirt

The existing working-tree digest describes changes relative to Git HEAD. Different clean commits can have the same digest. Runtime verification now additionally captures a versioned workspace revision identity before and after execution: canonical project identity, every discovered Git root, and its HEAD (including unborn repositories). A missing, incomplete, malformed, or changed baseline cannot establish a current passing verifier.

Before-snapshots are retained by project, session, task run, actual tool invocation, and command/input fingerprint. Equal commands running concurrently cannot consume each other's observations. Consumption is one-shot; duplicate invocation identities become unusable rather than selecting an arbitrary snapshot. No state is imported from model-authored JSON into this host invocation map.

Actual verification hooks persist both baseline identities with the pre/post dirty-tree digests. Completion, exact-verifier reuse, work-plan advancement, digest refresh, recovery classification, resume, handoff, and operator status all require the current baseline. A later failed observation still takes precedence over an older passing one. A verifier spanning two different clean commits remains non-passing even when its exit status is zero.

Historical task records remain readable. Old unbound evidence does not satisfy current production verification gates. Pure historical projection helpers remain compatible when no new baseline is requested; runtime consumers explicitly supply the current baseline. Handoff validation rejects a claimed current pass without matching before/after baseline evidence.

## Verification

- Acceptance suite: 180/180 pass, zero failures or skips, with actual isolated execution and retained expiry replay enabled.
- Guard integration, failure intelligence, recovery, continuation budgets, and journal suite: 159/159 pass, zero failures or skips.
- Workspace binding, exact reuse, task normalization, resume, handoff, runtime session modules, operator UX, and WebUI history: 140/140 pass, zero failures or skips.
- An additional real-hook regression changes HEAD during a verifier, then changes HEAD again after a passing verifier. The runtime refuses both stale passes and completes only after fresh stable verification.
- Typecheck and architecture checks pass; architecture covers 526 source files. Full offline release verification and a new release campaign remain pending.

## Remaining authority boundary

These revision fields identify observed code; they are not signatures authenticating arbitrary task files. Production independent verification must use actual host observations, not trust `observed: true` in imported JSON. The durable runner's current-project-verification callback, approved backend/contract selection, host authority provisioning, and authenticated assessment admission still need integration. Non-Git workspaces cannot currently establish this Git-baseline proof; this is an explicit unsupported state, not a source defect.

No new provider benchmark, main-workspace edits, old-campaign rewrites, or release occurred. The independent evidence store is not yet an S0 benchmark-resume implementation; those guarantees must be tested separately.
