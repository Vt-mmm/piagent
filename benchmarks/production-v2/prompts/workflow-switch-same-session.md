Fix `src/platform/workflow-session.js` while preserving
`reduceWorkflowSession(state, event)`.

Selecting a workflow changes only `currentWorkflow`; it must never clear prior
messages or prevent later workflow changes. An accepted message has a unique
non-empty id and text and is appended once with the workflow active for that
message. A duplicate message id is an idempotent no-op returning the existing
state object. A message may explicitly select a different workflow for that
message and future work. Preserve message order, do not mutate inputs, and
throw `TypeError` for malformed select or message events. Run the configured
verification.
