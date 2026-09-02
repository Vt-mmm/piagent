# Public contract addendum v2 — approved input schemas
<!-- language: en -->

The operator approved DA2 on 2026-08-31. This file materializes the revocation and subscription-contract portions of that approved revision. The worker, composite evidence and new benchmark registration remain inactive until their separate implementation and qualification gates pass. This document alone does not approve a specific executable plan or issue a PASS receipt.

Original public suites, fixture implementations and historical results remain unchanged. These versioned schemas label existing positional function arguments using a JSON wrapper; they do not replace the exported APIs. The source-based requirements and explicit schema choices are distinguished below. JavaScript invariants supplement structural JSON Schema validation.

Before any fresh measurement, the complete approved public revision, examples, API profile and noncode rubrics must be available symmetrically to every measured arm, with fresh request/criterion/configuration digests and independent evaluator compatibility. No hidden evaluator is used to infer these choices. Missing coverage or unknown compatibility blocks dispatch; it does not loosen a PASS condition.

## 1. Revocation predicate

**Sourced:** [benchmarks/production-v2/prompts/revoked-session-cache.md](../benchmarks/production-v2/prompts/revoked-session-cache.md) requires matching non-empty tenant/user/capability identifiers, matching permission revision, evaluation not in the future, strictly unexpired time, revocation at/before now denying use, finite integer time/revision validation, TypeError, nonmutation and configured verification. **Seed-interface clues only:** [benchmarks/production-v2/project/src/backend/revocation-cache.js](../benchmarks/production-v2/project/src/backend/revocation-cache.js) exposes `isCachedAccessUsable(entry, request)`, `userId`, `request.now`, `entry.expiresAt`; the faulty comparison is not an oracle.

**DA2-approved schema:** [JSON Schema](../schemas/public-contracts/revocation-v1.schema.json). Both arguments have `tenantId`, `userId`, `capabilityId`, `permissionRevision`. Entry additionally requires `evaluatedAt`, `expiresAt`; request requires `now`, `revokedAt`. No aliases are accepted for required fields. The JSON wrapper labels existing positional arguments; it is not a changed function API.

```json
{"entry":{"tenantId":"t1","userId":"u1","capabilityId":"read","permissionRevision":7,"evaluatedAt":90,"expiresAt":110},"request":{"tenantId":"t1","userId":"u1","capabilityId":"read","permissionRevision":7,"now":100,"revokedAt":null}}
```

Expected return: `true`. After complete validation, the exact predicate is:

```js
entry.tenantId === request.tenantId &&
entry.userId === request.userId &&
entry.capabilityId === request.capabilityId &&
entry.permissionRevision === request.permissionRevision &&
entry.evaluatedAt <= request.now &&
request.now < entry.expiresAt &&
(request.revokedAt === null || request.revokedAt > request.now)
```

Approved boundary choices: identifiers are literal strings with `length > 0`, compared case-sensitively without trim/case folding/Unicode normalization; a single space is therefore valid and distinct. Required fields must be own data properties of ordinary JSON-compatible records; arrays/null are not records. Extra JSON metadata properties are ignored. Numeric fields require `typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)`; no coercion, Date conversion, sign restriction, safe-integer restriction or hidden clock read. `-0` equals `0`; negative revisions/times remain valid because the public requirement says finite integer, not nonnegative. Times use one caller-supplied unit; no calendar/epoch range is invented. Neither `expiresAt >= evaluatedAt` nor a maximum cache age is added. `revokedAt` is required; missing/undefined is not null.

Canonical validation order: entry shape → request shape → entry identifiers (tenant/user/capability) → request identifiers → entry revision → request revision → entry evaluatedAt → entry expiresAt → request now → request revokedAt → predicate. Any malformed value is **TypeError**, including when an earlier identity mismatch would otherwise return false. Message/stack/first-field diagnostics are not normative. Multiple malformed fields have the same observable class; these inert-data checks do not certify accessor evaluation order.

| Change to the valid example | Expected |
|---|---|
| entry.evaluatedAt=100 | true (evaluation equality) |
| entry.evaluatedAt=101 | false |
| entry.expiresAt=100 | false (strict expiry) |
| request.revokedAt=100 or99 | false |
| request.revokedAt=101 | true |
| request.tenantId/userId/capabilityId differs, or revision8 | false, one dimension at a time |
| request.now="100",100.5,NaN,Infinity,undefined | TypeError |
| request.revokedAt omitted, or "100" | TypeError |
| mismatched tenant plus malformed revision | TypeError, never early false |
| both revisions=-1 and otherwise valid example | true |
| entry=null/array; empty required identifier | TypeError |

Required finite checks cover every listed field independently, conjunction/short-circuit negatives, equal/±1 boundaries, large represented finite integers, explicit special-number/undefined negative probes, ignored own metadata, and unchanged input snapshots on return **and throw**. They do not certify arbitrary proxies/accessors/prototypes, arbitrary graph sizes, thread races, storage isolation or live authorization. The schema is not an execution receipt; actual bounded-plan qualification remains required.

## 2. Subscription contract comparison

**Sourced:** [benchmarks/production-v2/prompts/backend-frontend-contract-sync.md](../benchmarks/production-v2/prompts/backend-frontend-contract-sync.md) defines the five output fields, backend-minus-frontend missing values, frontend-only extra statuses, unique non-empty status/field strings, input-order independence, UTF-8 byte sorting, positive equal versions, TypeError for malformed/duplicate declarations and nonmutation. **Seed-interface clues only:** [benchmarks/production-v2/project/src/fullstack/contract-sync.js](../benchmarks/production-v2/project/src/fullstack/contract-sync.js) establishes `statuses` and the output names, but not the input field/version property names.

**DA2-approved schema:** [JSON Schema](../schemas/public-contracts/subscription-contract-v1.schema.json). Each argument is an ordinary record with required own `statuses: string[]`, `fields: string[]`, `version: number`. Arrays may be empty and must be dense; declarations are unique within each array. Unknown JSON metadata keys are ignored. `fields` and `version` are the chosen public names; aliases do not satisfy missing properties.

Approved boundary choices: version must be a finite positive integer. Missing/non-number/nonfinite/fractional/zero/negative versions are malformed and throw **TypeError**. For valid contracts, `versionMismatch = backend.version !== frontend.version`. This explicitly resolves the alternative interpretation that invalid versions merely produce `versionMismatch: true`; it is a decision, not something proven by the seed. No safe-integer limit is silently introduced.

Declaration strings are literal, non-empty and well-formed Unicode scalar sequences; do not trim, fold case or normalize NFC/NFD. A whitespace-only declaration is valid. Reject lone UTF-16 surrogates with TypeError so different strings cannot collapse to identical UTF-8 replacement bytes. This Unicode validity rule is an explicit approved addition and supplements the structural JSON Schema. Compare duplicates by exact string equality. Sort by unsigned bytes of the UTF-8 encoding, not locale collation or JavaScript's default UTF-16 sort. Strings containing `__proto__` or `constructor` are ordinary declarations, not object keys to execute.

```js
missingStatuses = sortUtf8(backend.statuses minus frontend.statuses);
extraStatuses   = sortUtf8(frontend.statuses minus backend.statuses);
missingFields   = sortUtf8(backend.fields minus frontend.fields);
versionMismatch = backend.version !== frontend.version;
compatible = !missingStatuses.length && !extraStatuses.length &&
             !missingFields.length && !versionMismatch;
```

Return a newly allocated ordinary object containing exactly those five fields. The lists are arrays of strings. Extra frontend fields do not create a mismatch or an `extraFields` output. Do not mutate input arrays/records, even while sorting or before throwing. No independent nested-list identity requirement is added: public text only requires a new outer object and no input mutation.

Canonical validation order: backend record → frontend record → backend version → frontend version → backend statuses (shape, each element, then duplicates) → frontend statuses → backend fields → frontend fields → set differences/sort/output. All shape/type/duplicate errors are **TypeError**; error messages/stack are not graded. Validate even declarations whose omission would not change compatibility.

| Inputs (compact) | Expected |
|---|---|
| B={statuses:["active","trial"],fields:["id","plan"],version:1}, F={statuses:["trial","active"],fields:["plan","id","debug"],version:1} | {compatible:true,missingStatuses:[],extraStatuses:[],missingFields:[],versionMismatch:false} |
| Same B; F={statuses:["paused","active"],fields:["id"],version:2} | {compatible:false,missingStatuses:["trial"],extraStatuses:["paused"],missingFields:["plan"],versionMismatch:true} |
| Both empty lists, version1 | compatible:true |
| B status "é", F status "é" (decomposed) | missing["é"],extra["é"]; no normalization |
| B statuses ["😀","é","z","\uE000"], F statuses[] | missingStatuses order ["z","é","\uE000","😀"] |
| Duplicate in any one of the four arrays | TypeError, not deduplication |
| fields missing, version0/null/"1"/1.5, a null declaration, sparse array, lone surrogate | TypeError |

Required finite checks cover all five outputs independently, each malformed property/duplicate list, empty and reordered lists, byte-order/case/normalization distinctions, ignored metadata, new outer-result identity and complete argument snapshots on return/throw. These are bounded ordinary-data checks, not universal Unicode/JavaScript reflection assurance.
