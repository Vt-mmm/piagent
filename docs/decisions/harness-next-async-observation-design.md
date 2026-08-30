# Approved asynchronous observations and callback contracts

Implementation design, not a qualification claim. The production retry and
partial-checkpoint APIs require async functions and injected callbacks. Reducer
contracts also require exact object identity. Replacing those APIs with a
synchronous accumulator or structural JSON equality would change the task.

## Primary-source basis

QuickJS-emscripten's pinned
[0.32.0 runtime implementation](https://github.com/justjake/quickjs-emscripten/blob/v0.32.0/packages/quickjs-emscripten-core/src/runtime.ts)
supports bounded `executePendingJobs` calls. Its
[context implementation](https://github.com/justjake/quickjs-emscripten/blob/v0.32.0/packages/quickjs-emscripten-core/src/context.ts)
queries intrinsic Promise state; a non-Promise returns the original handle,
while settled Promise results own a separate handle. The convenience
`resolvePromise` uses guest global Promise/then properties, so it is not the
trusted observation path here. The
[ECMAScript Promise specification](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#sec-promise-objects)
distinguishes settlement and queued reactions; invoking an async function is
not evidence that its result or side effects have finished.

The transfer is bounded job draining under the existing thread CPU and request
wall limits, with explicit host-approved `awaitResult` on a case. Default
synchronous cases retain abstention on async behavior. This is an in-memory
Promise capability, not arbitrary Node timers, IO, package/CommonJS resolution
or a replacement event loop.

## Observed capabilities

- A case may declare finite callback tables and error instances as input data.
  Callback arguments use a tagged reference, including inside records such as
  retry options. No operator/model-supplied host JavaScript is executed.
- Callbacks run in a private guest-intrinsics closure created before the
  candidate, without host bindings. Responses, explicit repeat-last policy,
  sync/Promise mode and error identities are fixed in the approved input.
- Captured callback calls preserve global order and typed argument snapshots.
  Promise callbacks also emit settlement events, indexed by invocation. They
  settle after 1–32 guest await jobs (default one), not real elapsed time.
  This distinguishes calling sleep from actually awaiting it. A return step
  supplies the same approved data object on repeated uses, not a fresh clone.
  Promise response data with candidate-installed callable/accessor `then`
  behavior or proxy prototypes is unsupported. The check occurs immediately
  before resolution, without a yield, so settlement markers cannot precede
  hidden thenable assimilation. Ordinary target thenables remain supported.
  Expected traces stay on the host. Overflow, unsupported argument observation
  and stale callbacks leave a sticky verifier fault, even if candidate code
  catches the callback's exception.
- `observeIdentity` compares the actual returned reference with direct object
  arguments using captured intrinsics, never JSON equality or candidate output.
- `observeError` records identity against approved error instances and inert
  enumerable own properties. This tests rethrowing the same callback error with
  a newly attached checkpoint without trusting its name, serializer or getters.
- Callback state belongs to one case. A later case cannot silently invoke an
  old callback under a different plan. Existing explicit result references
  still carry data copies, not transferable object handles.
- An `error-property` argument can copy one inert own property actually
  observed on a prior throw in the same history, including across a realm
  reset. This permits resuming from the real attached checkpoint, not a host
  expected checkpoint. Missing, unobserved or callback-containing properties
  abstain; no arbitrary property access or candidate getter is invoked.

All capabilities are carried by the authenticated case plan and exact
verifier/image identity. The host parser validates their observation shape and
coverage. Async non-settlement, unsupported IO and resource exhaustion remain
unknown/error, not code-defect proof or completion. Default resource limits,
current project-test evidence, source closure, durable accounting and repair
authority remain separate and unchanged.

The pinned engine has no exposed host Promise-rejection tracker. These checks
observe the target's settlement and drain bounded pending jobs; they do not
certify Node's policy for detached unhandled rejections. Project tests remain
required for that policy and other host-runtime semantics. Async mode allows
at most 1,024 guest jobs per case; it does not grant timers or external IO.

## Predeclared qualification obligations

Valid equivalent retry, partial-checkpoint, four-layer configuration and reducer
implementations must execute without source rewrites. Concrete variants must
expose wrong call count/order/delays, lost partial results, duplicate replay,
wrong error identity, input mutation and shape-equal-but-new reducer returns.
Tests must also retain default sync abstention; nested Promise settlement and
rejection; top-level await; unresolved/infinite job sequences; captured
intrinsics under hostile prototype/Promise changes; callback overflow/staleness;
missing/forged observations; exact approval and durable/runtime admission.

These are exposed development tests. Independently held-out evaluation and the
full frozen release campaign remain required; no research score is imported
as a Piagent quality or efficiency result.

The queued-CPU-stop regression found a concrete implementation error during
development: QuickJS reported a processed job while the interrupt rejected the
final Promise. The first worker emitted `guest-resource-error` with CPU stop
samples, which the strict host parser correctly rejected. The drainer now
checks interruption once more after the queue empties, preserving the actual
budget cause. The parser, resource ceilings and completion rule were not
relaxed. Unit and actual isolated execution regressions cover this boundary.
