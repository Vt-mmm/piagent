Fix `src/frontend/request-lifecycle.js` without changing its exports.

The reducer tracks one active request within a connection epoch. A newer
`connection/reconnect` epoch cancels the active request, clears loading and any
error, and preserves prior results. Success or failure may settle work only
when both request id and epoch match the active request; stale, duplicate, or
older-epoch events must return the existing state object unchanged. Starting a
request records its id and epoch and clears the prior error. A successful
settlement stores results, while a failure stores its error; both clear the
active request and loading. Do not mutate state, actions, or result arrays.
Store successful results in a fresh array. Run the configured verification.
