Fix `src/platform/workflow-session.js` while preserving
`reduceWorkflowSession(state, event)`.
When `state` is omitted or `undefined`, the reducer uses the exported
`initialWorkflowSession`.

The reducer accepts two tagged event variants. Tagged event variant
`workflow/select` requires field `workflow` to be a non-empty string. It
changes only `currentWorkflow`; it must never clear prior messages or prevent
later workflow changes.

Tagged event variant `message/accepted` requires fields `id` and `text` to be
non-empty strings. It is appended once with the workflow active for that
message. For tagged event variant `message/accepted`, its optional `workflow`
override, when supplied, must be a non-empty string. “Supplied” means the event
has its own `workflow` property, so an own property whose value is `undefined`
or `null` is malformed. Only when that property is absent is the current
workflow used. Validate the required fields and any supplied override before
applying duplicate handling. After that validation, a duplicate message id is
an idempotent no-op returning the existing state object, even if its valid text
or workflow differs. For a non-duplicate message with no own `workflow`
override, `currentWorkflow` must be a non-empty string or the reducer throws
`TypeError`. This active-workflow check occurs after duplicate handling, so a
fully field-valid duplicate still returns the exact existing state even when
`currentWorkflow` is `null`. A valid override selects that workflow for the
message and future work.

Preserve message order, do not mutate inputs, and throw `TypeError` for every
malformed tagged-event required field or supplied override on either named
event variant.
Run the configured verification.
