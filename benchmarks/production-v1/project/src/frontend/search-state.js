export const initialSearchState = Object.freeze({ requestId: null, loading: false, results: [] });

export function searchReducer(state = initialSearchState, action) {
  if (action.type === "search/start") return { ...state, requestId: action.requestId, loading: true };
  if (action.type === "search/success") return { ...state, loading: false, results: action.results };
  if (action.type === "search/failure") return { ...state, loading: false };
  return state;
}
