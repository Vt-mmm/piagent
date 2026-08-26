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
