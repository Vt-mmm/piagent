// Public, exposed witnesses. Authoring these data templates does not qualify
// them as an independent oracle or held-out evaluation.
import { retryCases, checkpointCases, configCases } from "./async-production-cases.mjs";
import { data, callback, record, returns, throws, callbackPlan, stepReturn, stepThrow, callEvent, settleEvent, errorInput, errorObserved } from "./async-contract-cases.mjs";

export const invocation = (id, call, args, outcome = "return") => [callEvent(id, call, ...args), settleEvent(id, call, outcome)];
export const reference = (id, left, right) => ({ id, left, right });
export const argument = (index, path = []) => ({ root: "argument", index, path });
export const returned = (path = []) => ({ root: "return", path });
export const referenceExpected = pairs => pairs.map(({ id }) => ({ id, same: false }));

export function retryFamilyCases() {
  const cases = retryCases();
  const first = cases[0], exponential = cases[1], final = cases[2];
  const defaults = structuredClone(final); defaults.id = "default-attempts-and-delay";
  defaults.args[1] = record({ sleep: callback("sleep") }); defaults.expected.argsAfter = defaults.args;
  defaults.expected.callbackTrace = [
    ...invocation("operation", 0, [1], "throw"), ...invocation("sleep", 0, [10]),
    ...invocation("operation", 1, [2], "throw"), ...invocation("sleep", 1, [20]), ...invocation("operation", 2, [3], "throw")];
  const zero = structuredClone(exponential); zero.id = "zero-delay-still-awaited";
  zero.args[1].value.find(item => item.key === "baseDelayMs").value = data(0); zero.expected.argsAfter = zero.args;
  zero.expected.callbackTrace.filter(event => event.callback === "sleep" && event.event === "call").forEach(event => { event.args = [data(0)]; });
  const sync = structuredClone(exponential); sync.id = "synchronous-operation-and-sleep";
  sync.callbacks.forEach(plan => { plan.mode = "sync"; delete plan.settleAfterJobs; });
  sync.expected.callbackTrace = sync.expected.callbackTrace.filter(event => event.event === "call");
  // No timer is reached on first success. The actual default timer remains
  // outside this injected-sleep family's certification scope.
  const omitted = structuredClone(first); omitted.id = "omitted-options-first-success";
  omitted.args = [callback("operation")]; omitted.expected.argsAfter = omitted.args;
  const explicit = structuredClone(defaults); explicit.id = "explicit-undefined-defaults";
  explicit.args[1] = record({ maxAttempts: data(undefined), baseDelayMs: data(undefined), sleep: callback("sleep") }); explicit.expected.argsAfter = explicit.args;
  const sleepFailure = structuredClone(final); sleepFailure.id = "sleep-failure-stops-retry";
  sleepFailure.callbacks[1].steps = [stepThrow("second")];
  sleepFailure.expected = throws("Error", { argsAfter: sleepFailure.args, errorObservation: errorObserved("second"),
    callbackTrace: [...invocation("operation", 0, [1], "throw"), ...invocation("sleep", 0, [5], "throw")] });
  const oneFailure = structuredClone(first); oneFailure.id = "single-final-failure";
  oneFailure.callbacks[0].steps = [stepThrow("last")];
  oneFailure.expected = throws("Error", { argsAfter: oneFailure.args, errorObservation: errorObserved("last"), callbackTrace: invocation("operation", 0, [1], "throw") });
  for (const [field, values] of [["maxAttempts", [Infinity, null, false]], ["baseDelayMs", [-Infinity, null, false]]]) {
    for (const [index, value] of values.entries()) {
      const invalid = structuredClone(first); invalid.id = `additional-invalid-${field}-${index}`;
      invalid.args[1].value.find(item => item.key === field).value = data(value);
      invalid.expected = throws("TypeError", { argsAfter: invalid.args, errorObservation: errorObserved(null), callbackTrace: [] }); cases.push(invalid);
    }
  }
  return [...cases, defaults, zero, sync, omitted, explicit, sleepFailure, oneFailure];
}

export function checkpointFamilyCases() {
  const cases = checkpointCases(), failed = cases[0];
  const pairs = [reference("fresh-checkpoint", { root: "error", path: ["checkpoint"] }, argument(1))];
  failed.referencePairs = pairs; failed.expected.referenceIdentity = referenceExpected(pairs);
  const immediately = structuredClone(failed); immediately.id = "first-remaining-item-fails"; delete immediately.sequence;
  immediately.callbacks[0].steps = [stepThrow("failed")];
  immediately.expected.errorObservation = errorObserved("failed", { code: "E_WORK", checkpoint: { nextIndex: 1, results: ["done:a"] } });
  immediately.expected.callbackTrace = invocation("process", 0, ["b", 1], "throw");
  const empty = { id: "empty-complete", awaitResult: true, observeIdentity: true, observeArgs: true,
    args: [data([]), data({ nextIndex: 0, results: [] }), callback("process")],
    callbacks: [callbackPlan("process", [stepReturn("unreachable")], { repeatLast: true })],
    expected: returns({ nextIndex: 0, results: [] }, { returnIdentity: [], callbackTrace: [] }) };
  empty.expected.argsAfter = empty.args;
  const all = { id: "start-at-zero-sync-results", awaitResult: true, observeIdentity: true, observeArgs: true,
    args: [data([0, false, ""]), data({ nextIndex: 0, results: [] }), callback("process")],
    callbacks: [callbackPlan("process", [stepReturn(undefined), stepReturn(null), stepReturn({ value: false })], { mode: "sync", repeatLast: true })],
    expected: returns({ nextIndex: 3, results: [undefined, null, { value: false }] }, { returnIdentity: [],
      callbackTrace: [...invocation("process", 0, [0, 0]), ...invocation("process", 1, [false, 1]), ...invocation("process", 2, ["", 2])] }) };
  all.expected.argsAfter = all.args;
  all.expected.callbackTrace = all.expected.callbackTrace.filter(event => event.event === "call");
  for (const [index, value] of [undefined, {}, { nextIndex: "0", results: [] }, { nextIndex: NaN, results: [] },
    { nextIndex: 0, results: {} }, { nextIndex: 0, results: ["extra"] }, { nextIndex: Infinity, results: [] }].entries()) {
    const invalid = structuredClone(cases[2]); invalid.id = `invalid-shape-${index}`; invalid.args[1] = data(value); cases.push(invalid);
  }
  return [...cases, immediately, empty, all];
}

export function configFamilyCases() {
  const cases = configCases();
  // Every layer wins independently, including values often mistaken for absence.
  for (let layer = 0; layer < 4; layer++) for (const [index, value] of [0, false, "", null, NaN].entries()) {
    const args = Array.from({ length: 4 }, (_, position) => position < layer ? { port: undefined, debug: undefined, label: undefined }
      : position === layer ? { port: value, debug: value, label: value } : { port: 42, debug: true, label: "fallback" });
    cases.push({ id: `layer-${layer}-defined-${index}`, args: args.map(data), observeArgs: true,
      expected: returns({ port: value, debug: value, label: value }, { argsAfter: args.map(data) }) });
  }
  return cases;
}
