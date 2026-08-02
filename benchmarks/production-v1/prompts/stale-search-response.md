Fix stale request handling in `src/frontend/search-state.js`.

Only a success or failure whose `requestId` equals the current state's
`requestId` may complete the active search. Stale completions must return the
existing state object unchanged. A matching failure clears loading but keeps
the previous results. Preserve the reducer API and verify the project.
