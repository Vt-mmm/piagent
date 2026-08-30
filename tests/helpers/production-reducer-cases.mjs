import { workflowCases } from "./async-production-cases.mjs";
import { data, returns, throws } from "./async-contract-cases.mjs";
import { reference, argument, returned, referenceExpected } from "./production-family-cases.mjs";

const transition = (id, state, action, value, same = false) => ({ id, args: [data(state), data(action)], observeArgs: true, observeIdentity: true,
  expected: returns(value, { returnIdentity: same ? [0] : [], argsAfter: [data(state), data(action)] }) });
const history = (id, sequence, prior, priorData, action, value, same = false, reset = false) => {
  const item = transition(id, priorData, action, value, same); item.sequence = sequence; item.args[0] = { type: "result", value: prior };
  if (reset) item.reset = true; return item;
};

export function workflowFamilyCases() {
  const cases = workflowCases(), state = { currentWorkflow: "alpha", messages: [{ id: "m1", text: "first", workflow: "alpha" }] };
  for (const field of ["id", "text", "workflow"]) for (const [index, value] of [undefined, null, "", 0, false].entries()) {
    const event = { type: "message/accepted", id: "m1", text: "valid", workflow: "alpha", [field]: value };
    const item = transition(`malformed-duplicate-${field}-${index}`, state, event, null);
    item.expected = { ...throws(), argsAfter: item.args }; cases.push(item);
  }
  for (const [index, value] of [undefined, null, 0, false].entries()) {
    const item = transition(`malformed-select-${index}`, state, { type: "workflow/select", workflow: value }, null);
    item.expected = { ...throws(), argsAfter: item.args }; cases.push(item);
  }
  const selected = { currentWorkflow: "alpha", messages: [] };
  const first = transition("initial-select", undefined, { type: "workflow/select", workflow: "alpha" }, selected); first.sequence = "workflow-history";
  const once = { currentWorkflow: "alpha", messages: [{ id: "m1", text: "first", workflow: "alpha" }] };
  const switched = { ...once, currentWorkflow: "beta" };
  const twice = { currentWorkflow: "beta", messages: [...once.messages, { id: "m2", text: "second", workflow: "beta" }] };
  return [...cases, first,
    history("first-message", "workflow-history", "initial-select", selected, { type: "message/accepted", id: "m1", text: "first" }, once),
    history("second-workflow", "workflow-history", "first-message", once, { type: "workflow/select", workflow: "beta" }, switched),
    history("after-switch-message", "workflow-history", "second-workflow", switched, { type: "message/accepted", id: "m2", text: "second" }, twice),
    history("replay-after-reset", "workflow-history", "after-switch-message", twice, { type: "message/accepted", id: "m1", text: "again", workflow: "gamma" }, twice, true, true),
    transition("initial-override", undefined, { type: "message/accepted", id: "m0", text: "start", workflow: "gamma" },
      { currentWorkflow: "gamma", messages: [{ id: "m0", text: "start", workflow: "gamma" }] }),
    transition("unknown-event", state, { type: "ignored" }, state, true)];
}

export function searchFamilyCases() {
  const state = { requestId: "current", loading: true, results: ["previous"] }, settled = { ...state, loading: false, results: ["fresh"] };
  const cases = [
    transition("initial-search", undefined, { type: "search/start", requestId: "r1" }, { requestId: "r1", loading: true, results: [] }),
    transition("matching-success", state, { type: "search/success", requestId: "current", results: ["fresh"] }, settled),
    transition("matching-failure-preserves-results", state, { type: "search/failure", requestId: "current" }, { ...state, loading: false }),
    transition("unknown-action", state, { type: "ignored", requestId: "current" }, state, true)
  ];
  for (const [index, requestId] of ["old", undefined, 7].entries()) for (const type of ["search/success", "search/failure"]) {
    cases.push(transition(`stale-${type.slice(7)}-${index}`, state, { type, requestId, results: ["wrong"] }, state, true));
  }
  const started = { ...state, requestId: "new" }, first = transition("new-search", state, { type: "search/start", requestId: "new" }, started);
  first.sequence = "search-history";
  return [...cases, first, history("old-after-new", "search-history", "new-search", started, { type: "search/success", requestId: "current", results: ["wrong"] }, started, true),
    history("new-failure", "search-history", "old-after-new", started, { type: "search/failure", requestId: "new" }, { ...started, loading: false })];
}

export function requestFamilyCases() {
  const state = { activeRequestId: "r1", connectionEpoch: 2, loading: true, results: ["previous"], error: null };
  const action = { type: "request/success", requestId: "r1", epoch: 2, results: ["fresh"] };
  const settled = { ...state, activeRequestId: null, loading: false, results: ["fresh"] };
  const success = transition("matching-success-fresh-array", state, action, settled);
  success.referencePairs = [reference("fresh-results", returned(["results"]), argument(1, ["results"]))];
  success.expected.referenceIdentity = referenceExpected(success.referencePairs);
  const reconnected = { ...state, activeRequestId: null, connectionEpoch: 3, loading: false, error: null };
  const cases = [success,
    transition("failure-clears-active", state, { type: "request/failure", requestId: "r1", epoch: 2, error: "failed" }, { ...state, activeRequestId: null, loading: false, error: "failed" }),
    transition("start-records-epoch-and-clears-error", { ...state, loading: false, error: "old" }, { type: "request/start", requestId: "r2", epoch: 3 }, { ...state, activeRequestId: "r2", connectionEpoch: 3 }),
    transition("default-start", undefined, { type: "request/start", requestId: "r0", epoch: 1 }, { activeRequestId: "r0", connectionEpoch: 1, loading: true, results: [], error: null }),
    transition("reconnect-cancels-active", { ...state, error: "old" }, { type: "connection/reconnect", epoch: 3 }, reconnected),
    transition("same-reconnect-unchanged", state, { type: "connection/reconnect", epoch: 2 }, state, true),
    transition("older-reconnect-unchanged", state, { type: "connection/reconnect", epoch: 1 }, state, true),
    transition("unknown-action", state, { type: "ignored" }, state, true)
  ];
  for (const [index, patch] of [{ requestId: "old" }, { epoch: 1 }, { epoch: 3 }, { requestId: "old", epoch: 1 }].entries()) {
    for (const type of ["request/success", "request/failure"]) cases.push(transition(`stale-${type.slice(8)}-${index}`, state, { ...action, ...patch, type, error: "wrong" }, state, true));
  }
  const first = structuredClone(success); first.id = "settle-before-duplicate"; first.sequence = "request-history";
  return [...cases, first,
    history("duplicate-success", "request-history", first.id, settled, action, settled, true),
    history("duplicate-failure", "request-history", "duplicate-success", settled, { type: "request/failure", requestId: "r1", epoch: 2, error: "wrong" }, settled, true),
    history("reconnect-after-settle", "request-history", "duplicate-failure", settled, { type: "connection/reconnect", epoch: 3 }, { ...reconnected, results: ["fresh"] }),
    history("old-epoch-after-reset", "request-history", "reconnect-after-settle", { ...reconnected, results: ["fresh"] }, action, { ...reconnected, results: ["fresh"] }, true, true)];
}
