# Harness Next: structured data, stateful histories and development calibration

Status: development checkpoint; not a frozen release, held-out result or production campaign.

## Why this capability was required

The previous backend discarded module state after every call and could not observe a configuration record or structured checkpoint. Consequently, isolated scalar examples could not establish the required configuration-precedence or stateful-recovery coverage. Re-labelling evidence-store lifecycle tests as application recovery tests would not close that gap.

[fast-check's model-based testing guide](https://fast-check.dev/docs/advanced/model-based-testing/) describes command histories checked against a simpler independent model, warns against copying the implementation into that model, and provides replay/shrinking mechanisms. This checkpoint transfers the command-history and independent-expectation principles. It uses deterministic, explicitly labelled development contract tables; it does not install fast-check, claim randomized/shrunk coverage, or call those tables held-out data.

## Mechanism and authority

The worker now accepts bounded data trees and explicitly grouped multi-call sequences. Named operations can share module state. Reset creates a fresh realm, and a later operation may receive a copy of data actually returned by an earlier checkpoint call. Expected checkpoint contents remain on the host. A missing/unsupported checkpoint cannot supply invented state or invoke a dependent restore.

Host comparison checks data values independently of object construction order and can require exact post-call argument snapshots. Stateful counterexamples retain the complete input prefix, including reset and prior-result references, so a final call is not presented as an isolated reproduction. Request/source/response/time/memory limits remain fixed; repeated counterexample-prefix inputs have an additional pre-execution 2 MiB bound.

Admission recompiles and compares these observations through the existing authenticated path. Structured values, named operations, history IDs, reset flags and argument-observation requirements are included in the approved plan and request digest. Worker and comparison identities advance to `quickjs-contract-worker-v2` and `bounded-data-contract-comparison-v2`. A v1 worker cannot silently satisfy a v2 observation, and existing approvals do not bypass changed installed-verifier bindings.

The [worker reference](../../packages/piagent-core/extensions/acceptance-executor/README.md) specifies data limits and unsupported semantics. Records represent own enumerable data properties, not universal object identity or hidden-brand proofs. The worker does not traverse getters, returned proxies or cycles, and never serializes a candidate object through candidate-controlled JSON hooks. Internal proxy use may still produce supported primitive observations; runtime-specific intrinsic reflection remains outside a Node-equivalence claim.

## A failure found in the new mechanism

The first structured suite passed 9/10. Its mutation counterexample exposed that the QuickJS wrapper's `defineProp` API does not accept a `writable` descriptor field: inputs were unintentionally non-writable, so an otherwise valid mutation threw instead of changing the input. The original failing log is retained.

Input creation now uses a captured in-realm `Object.defineProperty` with a null-prototype data descriptor. This preserves mutability and an own `__proto__` key even after the candidate changes reflection functions or adds inherited descriptor fields. Both directions are tested: permitted mutation passes; forbidden mutation produces the actual changed argument snapshot. The corrected structured suite passed 10/10 before the final history-budget and Proxy-metadata regression additions.

Final source review then reproduced a distinct observation-integrity failure: the worker's Proxy wrappers used ordinary handler objects. A candidate-added inherited `get` or `getPrototypeOf` trap could expose the original untracked factory. An untracked Proxy over `{x:2}` then supplied a property descriptor containing `1`, and the worker incorrectly reported a passing `{x:1}` observation. The original failing regression log is retained; the preceding 246/246 acceptance and 21/21 development results did not reveal this defect.

Both wrapper handlers now have null prototypes, so candidate prototype changes cannot add missing traps. The added real-worker regression covers constructor extraction through inherited `get`, extraction through inherited `getPrototypeOf`, and extraction of the revocable factory. The corrected direct structured suite passes 12/12, including prior serialization-tampering, mutability, Proxy metadata and stateful replay checks. This is a concrete reason to retain adversarial regression evidence separately from a small development-calibration score.

## Development calibration, not held-out evidence

`evals/harness-next/development-corpus.mjs` contains 21 labelled programs across four required domains:

| Domain | Equivalent correct programs | Deliberate defects | Explicit unsupported variant |
| --- | --- | --- | --- |
| Pure function | Loop and validated reduction | Dropped negatives; coerced invalid values | Async result |
| Temporal input | Direct and branching normalization | Strict expiry boundary; negative remaining duration | Async result |
| Configuration precedence | Selection and iteration | Truthiness fallback; defaults taking precedence | Module import |
| Stateful recovery | Indexed state and event journal | Duplicate applied; dedup state lost; restored total lost | Async operation |

Expectations come from declared contract tables, not execution of the candidate. The stateful table checks that unsaved work disappears after reset, saved work is restored, duplicate replay is idempotent and a separate history starts empty. It tests component checkpoint semantics, **not** OS/process death or disk persistence.

The real local-worker calibration, repeated after the inherited-trap correction, matched all 21 labels: 8 correct programs passed; 9 defective programs failed with captured counterexamples; 4 unsupported programs remained unknown. False acceptance, false rejection, unexpected abstention and executor error were all zero **within this development set**. The report always records `heldOut: false` and `claimEligible: false`; matching an expected unknown is not a correctness pass. The separately discovered inherited-trap defect demonstrates why this small set cannot establish a general false-acceptance rate.

The runner saves all rows, exact corpus/verifier/image identities, actual observations and separate error/abstention counts. It refuses empty/malformed/relabelled corpora before execution, reserves a new private output path without overwriting earlier results, and rejects unconfirmed cleanup or a claimed failure without a counterexample. Accounting-unit fixtures are labelled as injected observations, not worker runs.

## Verification and remaining gates

The actual-backend acceptance/binding/runtime-contract and calibration-accounting regression passed 247/247 with no skips after the inherited-trap correction. The direct structured suite passed 12/12, broader runtime regression passed 230/230 and product/package regression passed 34/34, all with no skips. Host-approval tests accept the new structured schema and reject invalid references or incomplete snapshots. Durable admission tests authenticate correct histories, reuse unchanged evidence without a new attempt and retain full-prefix counterexamples after a real source defect. The broader runtime run exercises the actual completion hook, cancellation/recovery and current project-verifier binding on this worker image.

The worker image is `sha256:21efc95b65836e3e90fe92037fe8d9dc52d5aaada66d7741635cdbf95cc2840d`. The development report binds corpus digest `de5979ebe974a056fe18bea1df2c650dcb94984c93b6b0a776c2a394fdf21bad` and installed host-verifier digest `0bab72aa4dead6d941755209c5d9efe7a58b181e39965777cdb7022fc3267b5b`; the host-verifier digest remained current after execution. The separately pinned image identifies worker code not reached by host-runtime imports. Typecheck, architecture (542 source files), documentation-language and diff checks passed on host Node `v24.11.1`.

No dependency download, root dependency installation, production host authority, model-provider campaign, push or publish was performed. The new worker is built from the same locally available Node base and dedicated locked dependencies; source work stays in the isolated development checkout.

Remaining work includes independently frozen held-out calibration, reusable contract selection for real project obligations, general source-closure/import/async support or separately approved backends, complete operator projections, minimum-Node installation and full offline release gates. Only then may a new candidate be frozen for a fresh S0 and spend-controlled S12 → S18 → S54 → S108. The small development corpus cannot establish general application correctness or a token-saving claim.
