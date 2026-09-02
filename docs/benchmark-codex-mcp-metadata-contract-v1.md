# Controlled comparison metadata contract v1
<!-- language: en -->

Status: frozen for benchmark measurement

Contract ID: `piagent-codex-mcp-metadata-v1`

Machine-readable schema: `schemas/public-contracts/codex-mcp-metadata-v1.schema.json`

## Basis and scope

This contract covers only the optional JSON-RPC `params._meta` object received by the scoped benchmark MCP broker. It was derived before measurement from:

- pinned comparison-client source commit `f70e26c29ccb731e22d1104de550b1b9594d7070`;
- comparison-client release `0.151.0-alpha.7.2`;
- the exact raw `tools/call` capture with SHA-256 `515947a4831cb7c7e1859b64aa448b48eb0f2d063050d5ef09edb0f95d9f45e2`.

The contract does not expand the broker tool surface or change any PASS/FAIL criterion. Candidate and comparison arms must use the same contract version, scoped tool definitions, approval setting, and broker source closure before a measurement is admissible.

## Authority rule

All accepted metadata is untrusted and has **no authority**. After validation, the broker records a bounded `codex-mcp-turn-observation-v1` transport observation, then removes `_meta` before validating business parameters or invoking the kernel. The observation is usable only for post-process identity reconciliation; metadata cannot:

- select a tool, material, verifier, image, path, nonce, or permission;
- satisfy identity, replay, cancellation, deadline, receipt, cleanup, or completion checks;
- alter a request digest or journaled kernel reservation;
- authorize a write or a PASS result.

The signed transport journal commits the original frame bytes, the allow/deny decision and the bounded observation. It does not promote metadata values into broker identity, admission or PASS authority.

## Allowed fields

For `initialize`, `ping`, and `tools/list`, only `progressToken` is allowed. It is a safe integer or a well-formed UTF-8 string of at most 160 bytes.

For `tools/call`, the only allowed keys are:

- `progressToken`;
- `callId`;
- `threadId`;
- `itemId`;
- `x-codex-turn-metadata`;
- `codex/sandbox-state-meta`.

If any Codex-specific key is present, `callId`, `threadId`, `itemId`, and `x-codex-turn-metadata` must all be present. The three identity-like strings match `[A-Za-z0-9_.:-]{1,160}`. `threadId` must equal the nested `thread_id`; this is a consistency check only.

The complete metadata object is limited to 65,536 UTF-8 bytes.

### Turn metadata

`x-codex-turn-metadata` has no additional properties. These fields are required:

- string IDs: `session_id`, `thread_id`, `turn_id`, and `model`;
- non-negative safe integer: `turn_started_at_unix_ms`;
- booleans: `node_repl_disabled`, `auto_review_enabled`, and `node_repl_auto_review_required`;
- `thread_source: "user"`;
- a bounded non-empty `sandbox` string;
- `sandbox_mode: "workspace-write"`.

`reasoning_effort` is optional and is one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `ultra`.

Fields emitted by other Codex modes, plugins, apps, subagents, or future builds are not implicitly accepted. A new field requires a new reviewed contract version.

### Sandbox state

`codex/sandbox-state-meta` is optional. The broker does not advertise the capability in v1, but it validates the pinned source shape if supplied:

- exact top-level fields: `permissionProfile`, `codexLinuxSandboxExe`, `sandboxCwd`, and `useLegacyLandlock`;
- `sandboxCwd` is a bounded `file:` URI;
- `codexLinuxSandboxExe` is null or a canonical absolute path;
- `useLegacyLandlock` is boolean;
- `permissionProfile` is exactly one pinned `managed`, `disabled`, or `external` variant;
- managed filesystem entries are bounded to 64 and use only pinned path, access, and missing-path variants.

This state is discarded with the rest of `_meta`; it cannot prove the actual sandbox.

## Valid examples

A native list request:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
```

A native call bundle:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "_meta": {
      "callId": "call_e2_read",
      "itemId": "fc_01a05acb-0762-76b3-90ad-f2d79b4afc29",
      "progressToken": 1,
      "threadId": "01a05acb-06e2-7c92-8f08-77358d771975",
      "x-codex-turn-metadata": {
        "session_id": "01a05acb-06e2-7c92-8f08-77358d771975",
        "thread_id": "01a05acb-06e2-7c92-8f08-77358d771975",
        "turn_started_at_unix_ms": 1788229650265,
        "turn_id": "01a05acb-0758-7772-97cb-2b83d691d176",
        "node_repl_disabled": false,
        "thread_source": "user",
        "sandbox": "seatbelt",
        "sandbox_mode": "workspace-write",
        "auto_review_enabled": false,
        "node_repl_auto_review_required": false,
        "model": "gpt-5.6-luna",
        "reasoning_effort": "medium"
      }
    },
    "name": "scoped_read",
    "arguments": {"materialId":"input"}
  }
}
```

## Invalid examples

Every example below is invalid:

```json
{"progressToken":0,"nonce":"broker-nonce"}
```

```json
{"callId":7,"threadId":"t","itemId":"i","x-codex-turn-metadata":{}}
```

```json
{"callId":"c","threadId":"t","itemId":"i","x-codex-turn-metadata":{"authority":"approve"}}
```

```json
{"callId":"c"}
```

Extra fields, wrong types, partial Codex bundles, mismatched thread IDs, over-limit values, and unknown nested sandbox variants are rejected.

## Error and lifecycle behavior

Invalid metadata produces internal reason `mcp-invalid-metadata`. For a request with an ID, the broker returns JSON-RPC error `-32602` with public message `request-rejected`, records the denial, performs no kernel reservation or effect, fail-closes the transport, and durably appends `transport-end` followed by `end`.

Replay is enforced by the one-use JSON-RPC request ID and by single-use signed broker custody. `callId` is deliberately not a replay authority. Cancellation is bound to the exact in-flight JSON-RPC request ID. Deadlines, cleanup, receipts, and reconciliation remain host/supervisor decisions.

On clean EOF or a quiescent Codex SIGTERM, all response write callbacks must already be complete; the broker then synchronously fsyncs `transport-end` and `end`. An interrupted frame or in-flight operation fail-closes, records the tail/cancellation as applicable, reconciles host work, and still seals both terminal rows.

## Required negative coverage

Before exact-binary E2 or benchmark measurement, the contract suite must cover:

- extra metadata field;
- wrong metadata type;
- duplicate JSON-RPC request replay;
- exact-request cancellation;
- transport and verification deadlines;
- normal EOF, quiescent SIGTERM, and interrupted shutdown;
- restart/replay refusal for an already-used signed journal;
- host-crash reconciliation when an eligible real verifier path is available.
