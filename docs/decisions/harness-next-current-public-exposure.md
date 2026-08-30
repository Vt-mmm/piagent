# Current public evaluation exposure must be complete

The retained v1 custody exposure file lists four suites. A read-only audit at
`0d03cfffea0b32ac04bb6c0b37a4b57e3cf6cc38` found two additional public suites:
`deep-logic-v1` (seven scenarios) and `production-v2` (27 scenarios). Its existing
test checked every declared entry, but not whether an entry had been omitted.
The readiness CLI compared the receipt hash to that incomplete file. Therefore
a hash match alone could not establish complete public-exposure accounting.
This does not show that an actual independent holdout or receipt was compromised;
no such private data was accessed or fabricated.

V2 inventories every current suite, contract-family version and nine public
development trees. It keeps the predecessor hash rather than rewriting the v1
file, historical FS4 matrix, example assurance receipts or any campaign record.
The current readiness CLI recomputes the inventory before comparing receipt
bindings. The current FS4 evaluator checks it before tests and records its
separate binding; its E3 test group also runs the new refusal regressions.

Tree digests bind sorted filename/content-hash pairs. Tests exercise added
suites, unchanged manifests with changed fixtures, added public examples,
changed families, deleted files, omitted descriptors, stale receipts after
regeneration, symlinked inputs and oversized files. Synthetic custody fixtures
test protocol behavior only: they are not independent attestations. Expected
answers, completion gates and isolated-worker budgets are unchanged.

The first packaging check in the dependency-free development clone failed two
checks because that clone lacked built WebUI assets and its local dependency
link. The readiness checks passed. Those packaging failures are setup evidence,
not a passing package qualification. They must be distinguished from a subsequent
run after normal local build preparation, without relaxing either assertion.

The subsequent 70/71 run caught a real CLI-entry bug: comparing a requested
path with Node's canonical module URL could skip execution across `/var` and
`/private/var` aliases, returning zero without checking anything. The entry
guard now compares real file identities. Direct and symlinked invocations must
emit a checked inventory on success and refuse later drift; exit zero alone is
not accepted. The installed-package refusal assertion remains unchanged.

Read-only cross-review then found that the tree walker sorted each directory,
not the complete flattened filename list described by the public format.
The existing `request.js` and `request/constants.js` files in the public Hono
fixture reproduce different digests under these two orderings. Two new tests
failed before the correction: a literal `a.js`/`a/leaf.js` vector and an
independent recursive inventory of all current public roots. Flattened paths
are now globally sorted by UTF-16 code units before compact JSON/UTF-8 hashing;
the exact encoding is documented and the v2 inventory is regenerated. No
existing custody receipt is rewritten. This cross-review is development
evidence, not independent private-holdout evaluation.

The runtime package intentionally omits development tests. It must refuse a
complete-source freshness check rather than omit those author-visible examples.
An independent custodian needs the frozen full-source artifact. Source-only
restore checks and runtime packaging checks are different qualification layers.

This inventory cannot describe everything an author has previously seen.
Independent custody must additionally compare retained diagnostics, campaigns,
earlier versions and external exposure. It still requires independent people,
blinded review, full reference/mutation qualification and origin attestation.
No provider run, private evaluation, efficiency or release claim is authorized
by generation or a structurally valid readiness receipt.
