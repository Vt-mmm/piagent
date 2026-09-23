/**
 * Public state: activeRequestId, connectionEpoch, loading, results, error.
 * A start at the current or a newer epoch records that epoch in connectionEpoch.
 * Older starts and reconnects at the same or an older epoch return the same state.
 * A newer reconnect cancels active work; only the active id/current epoch settles.
 * Settlements clear active work; duplicates preserve state identity. Do not mutate
 * inputs, and copy successful results. Extra internal fields are implementation details.
 */
export const initialRequestState = Object.freeze({
  activeRequestId: null,
  connectionEpoch: 0,
  loading: false,
  results: [],
  error: null
});

export function requestLifecycleReducer(state = initialRequestState, action) {
  if (action.type === "request/start") return { ...state, activeRequestId: action.requestId, loading: true };
  if (action.type === "request/success") return { ...state, loading: false, results: action.results };
  if (action.type === "request/failure") return { ...state, loading: false, error: action.error };
  if (action.type === "connection/reconnect") return { ...state, connectionEpoch: action.epoch };
  return state;
}
