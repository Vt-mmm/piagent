test("request lifecycle ignores old epochs and settles only the active request", async () => {
  const { initialRequestState, requestLifecycleReducer: reduce } = await import("../src/frontend/request-lifecycle.js");
  const view = ({ activeRequestId, connectionEpoch, loading, results, error }) =>
    ({ activeRequestId, connectionEpoch, loading, results, error });
  const call = (state, action) => {
    const before = structuredClone(state), event = structuredClone(action);
    const next = reduce(state, action);
    assert.deepEqual(state, before);
    assert.deepEqual(action, event);
    return next;
  };
  const base = { ...initialRequestState, connectionEpoch: 5, results: ["previous"], error: "previous-error" };
  assert.equal(call(base, { type: "request/start", requestId: "old", epoch: 4 }), base);
  const first = call(base, { type: "request/start", requestId: "a", epoch: 6 });
  assert.deepEqual(view(first), { ...view(base), activeRequestId: "a", connectionEpoch: 6, loading: true, error: null });
  for (const epoch of [5, 6]) assert.equal(call(first, { type: "connection/reconnect", epoch }), first);
  const reconnected = call(first, { type: "connection/reconnect", epoch: 7 });
  assert.deepEqual(view(reconnected), { ...view(first), activeRequestId: null, connectionEpoch: 7, loading: false, error: null });
  assert.equal(call(reconnected, { type: "request/success", requestId: "a", epoch: 6, results: ["stale"] }), reconnected);
  const active = call(reconnected, { type: "request/start", requestId: "b", epoch: 7 });
  for (const type of ["request/success", "request/failure"]) {
    assert.equal(call(active, { type, requestId: "a", epoch: 7, results: [], error: "stale" }), active);
    assert.equal(call(active, { type, requestId: "b", epoch: 6, results: [], error: "stale" }), active);
  }
  const event = { type: "request/success", requestId: "b", epoch: 7, results: ["current"] };
  const settled = call(active, event);
  assert.deepEqual(view(settled), { ...view(active), activeRequestId: null, loading: false, results: ["current"], error: null });
  assert.notEqual(settled.results, event.results);
  assert.equal(call(settled, event), settled);
  const failure = { type: "request/failure", requestId: "b", epoch: 7, error: "offline" };
  const failed = call(active, failure);
  assert.deepEqual(view(failed), { ...view(active), activeRequestId: null, loading: false, error: "offline" });
  assert.equal(call(failed, failure), failed);
});
