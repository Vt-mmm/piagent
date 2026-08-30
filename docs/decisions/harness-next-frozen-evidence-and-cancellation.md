# Harness Next: frozen evidence and phase-specific cancellation

Status: development verification. A complete release evaluation and a new
production campaign remain required.

## Historical readability is not current execution eligibility

The old golden FS5 test compared historical protocol hashes directly to the
latest source files. A legitimate schema change therefore made old evidence
unreadable. Replacing the old expected hash with the new one would instead
mislabel that evidence. Neither behavior preserves a meaningful experiment.

[SLSA 1.2 artifact verification](https://slsa.dev/spec/v1.2/verifying-artifacts)
separates the artifact digest to which provenance applies from the consumer's
expected source and build parameters. This change borrows that separation:
historical bytes are checked against historical expectations, while any new
preflight/execution argument construction checks current source independently.
It does not implement signed SLSA provenance or claim a SLSA level.

[Reproducible Builds' definition](https://reproducible-builds.org/docs/definition/)
requires matching source, environment, instructions and output bytes. Retaining
only the source hashes is thus insufficient to reproduce an agent campaign.
The archive below is evidence preservation, not a claim that nondeterministic
model output or an entire benchmark can be reproduced bit for bit.

The implemented boundaries are:

- All five protocol files remain byte-for-byte unchanged. A self-contained
  content-addressed archive retains all 17 distinct path/digest bindings,
  totaling 458,632 bytes. Each was retrieved from local Git and verified against
  its original expected digest. Retrieval commits are not represented as
  original campaign candidate identities.
- The historical check reads archived bytes, not executable modules. The same
  archive can be verified without Git history or a network connection.
- Each protocol version's artifact-binding list has an immutable digest in the
  current validator. Replacing its expected hashes cannot preserve the old
  protocol identity and silently open another run.
- Dry-run argument inspection remains available. Preflight and execution
  argument construction read the current checker's source root, with no
  caller-controlled root or historical fallback. Changed, missing, symlinked,
  duplicate, malformed and oversized inputs are refused.
- The check is repeated on each call; no prior matching result is reused after
  a file changes. The benchmark runner still owns complete candidate freezing,
  provider authorization, campaign state and spend control. This argument
  builder is not an independent launcher or a replacement for those gates.

Tests exercise the current checker in an isolated fixture containing the
declared input bytes. They do not run archived code or launch a provider.
Positive matching cases, later source drift, archive-only data, attempted
root overrides and rewritten historical bindings are tested separately.

## Cancellation must identify the phase it actually exercises

The old worker test aborted 150 ms after invocation and assumed that the
container had started. Under full concurrency that timer could fire during
CREATE instead. An unacknowledged CREATE cannot safely be treated as successful
cleanup merely because a subsequent inspection finds no container yet.

[Docker's event interface](https://docs.docker.com/reference/cli/docker/system/events/)
provides distinct container create/start/destroy events and identity filters.
The current test subscribes before launching its worker, matches the fresh
run UUID and exact name, and aborts only after the real daemon emits START.
The bounded recent-event buffer covers the response/subscription transition
visible in the [Moby event handler](https://github.com/moby/moby/blob/v27.5.1/api/server/router/system/system_routes.go).
This is a test synchronization mechanism, not a new production event authority.

A local test proxy controls CREATE acknowledgement timing while forwarding
real inspect and removal requests to the approved local engine. Separate cases
prove the following behavior of the unchanged production executor:

- Aborted before CREATE is forwarded: no worker starts, no observation is
  returned, and the host reports cleanup as unconfirmed rather than guessing
  that a remote request had no effect.
- Aborted after real CREATE but before its acknowledgement reaches the CLI:
  the executor locates the exact owned container, validates image and label,
  and reports cancellation only with successful removal.
- CREATE delayed until after the host has returned: the late container can
  still appear. The original result remains unconfirmed; reusing the reserved
  execution ID refuses a conflict instead of executing or deleting it. The
  test explicitly reconciles only its own image/label-checked container.
- Aborted after daemon START: cancellation returns without an observation and
  only after cleanup confirmation; an independent engine read verifies that
  the exact container is absent.

These tests remove a scheduling assumption; they do not weaken the production
cleanup requirement or promise that killing a client cancels a remote CREATE.
Uncertain cleanup continues to stop automatic continuation. Unexpected engine
errors and incomplete observations are not converted into passing results.

## Evidence and remaining work

Focused FS5/artifact-binding checks pass 20/20 with zero skips. The real local
isolated-executor checks pass 18/18 with zero skips, including the four distinct
cancellation boundaries. These are development regressions, not production S0
or model-provider benchmark sessions. Full offline/concurrent verification is
tracked separately; its result must not be inferred from focused passes.

Independent held-out evaluation, benchmark approval integration, a new frozen
candidate and the staged S0/S12/S18/S54/S108 campaign remain outstanding. Old
campaigns are neither resumed nor merged into new results by this change.
