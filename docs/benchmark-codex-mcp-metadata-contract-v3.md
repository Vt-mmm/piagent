# Controlled comparison metadata contract v3
<!-- language: en -->

Status: frozen for benchmark measurement

Contract ID: `piagent-codex-mcp-metadata-v3`

Machine-readable schema: `schemas/public-contracts/codex-mcp-metadata-v3.schema.json`

## Basis and scope

This contract covers only the optional JSON-RPC `params._meta` object received
by the scoped benchmark MCP broker. It was derived before a replacement
measurement from:

- pinned comparison-client source commit
  `f70e26c29ccb731e22d1104de550b1b9594d7070`;
- comparison-client release `0.151.0-alpha.7.2`;
- an exact clean-workspace native `tools/call` frame with SHA-256
  `b2405a3aabb2814f91dd40f39cf68e00339491a5e6603f438c512b9be77e651d`;
- an exact dirty-workspace resumed `tools/call` frame with SHA-256
  `2775abccf80bd44064bec9220a2e9df4734248d324f36b1a81d9f3a2c7695aa3`.

Contracts v1 and v2 remain immutable historical contracts. Contract v1 omitted
the native `workspaces` turn field. Contract v2 accepted workspace states with
only `has_changes`; it therefore fail-closed when the pinned client supplied
the Git observation `latest_git_commit_hash`.

Contract v3 adds only that optional bounded, zero-authority Git observation to
each workspace state. It does not expand the broker tool surface or change any
PASS/FAIL criterion.

Candidate and comparison arms must use the same contract version, scoped tool
definitions, approval setting, sandbox mode, and broker source closure before a
measurement is admissible.

## Authority rule

All accepted metadata is untrusted and has **no authority**. After validation,
the broker records a bounded `codex-mcp-turn-observation-v1` transport
observation, then removes `_meta` before validating business parameters or
invoking the kernel. Metadata cannot:

- select a tool, material, verifier, image, path, nonce, or permission;
- satisfy identity, replay, cancellation, deadline, receipt, cleanup, or
  completion checks;
- alter a request digest or journaled kernel reservation;
- authorize a write or a PASS result.

The signed transport journal commits the original frame bytes, the allow/deny
decision, and the bounded observation. It does not copy workspace paths or
promote metadata values into broker identity, admission, or PASS authority.

## Allowed fields

For `initialize`, `ping`, and `tools/list`, only `progressToken` is
allowed. It is a safe integer or a well-formed UTF-8 string of at most 160
bytes.

For `tools/call`, the only allowed keys are:

- `progressToken`;
- `callId`;
- `threadId`;
- `itemId`;
- `x-codex-turn-metadata`;
- `codex/sandbox-state-meta`.

If any Codex-specific key is present, `callId`, `threadId`, `itemId`, and
`x-codex-turn-metadata` must all be present. The three identity-like strings
match `[A-Za-z0-9_.:-]{1,160}`. `threadId` must equal the nested
`thread_id`; this is a consistency check only.

The complete metadata object is limited to 65,536 UTF-8 bytes.

### Turn metadata

`x-codex-turn-metadata` has no additional properties. These fields are
required:

- string IDs: `session_id`, `thread_id`, `turn_id`, and `model`;
- non-negative safe integer: `turn_started_at_unix_ms`;
- booleans: `node_repl_disabled`, `auto_review_enabled`, and
  `node_repl_auto_review_required`;
- `thread_source: "user"`;
- a bounded non-empty `sandbox` string;
- `sandbox_mode: "workspace-write"`;
- `workspaces`: one to sixteen canonical absolute workspace paths, each
  mapped to an exact object containing required `has_changes: boolean` and
  optional `latest_git_commit_hash`, a lowercase 40- or 64-hex Git object ID.

`reasoning_effort` is optional and is one of `none`, `minimal`, `low`,
`medium`, `high`, `xhigh`, `max`, or `ultra`.

The workspace map is observational only. It is size-bounded, hashed as part of
the complete metadata, discarded before kernel admission, and cannot grant
path access. Both initial and resumed comparison invocations must independently
pin `workspace-write`; inherited or default resume permissions are not
accepted.

Fields emitted by other Codex modes, plugins, apps, subagents, or future builds
are not implicitly accepted. A new field requires another reviewed contract
version.

### Sandbox state

`codex/sandbox-state-meta` is optional. The broker does not advertise the
capability, but validates the pinned source shape if supplied:

- exact top-level fields: `permissionProfile`, `codexLinuxSandboxExe`,
  `sandboxCwd`, and `useLegacyLandlock`;
- `sandboxCwd` is a bounded `file:` URI;
- `codexLinuxSandboxExe` is null or a canonical absolute path;
- `useLegacyLandlock` is boolean;
- `permissionProfile` is exactly one pinned `managed`, `disabled`, or
  `external` variant;
- managed filesystem entries are bounded to 64 and use only pinned path,
  access, and missing-path variants.

This state is discarded with the rest of `_meta`; it cannot prove the actual
sandbox.

## Valid native call shape

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
        "workspaces": {
          "/workspace": {
            "latest_git_commit_hash": "b47c3ec0460f1b7716531968766aa2a46bf50e1e",
            "has_changes": false
          }
        },
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
    "arguments": {"materialId": "input"}
  }
}
```

Missing, relative, empty, oversized, or over-count workspace maps; non-boolean
`has_changes`; malformed or non-lowercase `latest_git_commit_hash`; other
nested extra fields; read-only resumes; partial Codex bundles;
mismatched thread IDs; wrong types; and other extra fields are invalid.

## Error and lifecycle behavior

Invalid metadata produces internal reason `mcp-invalid-metadata`. For a
request with an ID, the broker returns JSON-RPC error `-32602` with public
message `request-rejected`, records the denial, performs no kernel reservation
or effect, fail-closes the transport, and durably appends `transport-end`
followed by `end`.

Replay is enforced by the one-use JSON-RPC request ID and by single-use signed
broker custody. `callId` is deliberately not a replay authority.
Cancellation is bound to the exact in-flight JSON-RPC request ID. Deadlines,
cleanup, receipts, and reconciliation remain host/supervisor decisions.

## Required negative coverage

Before exact-binary E2 or benchmark measurement, the contract suite must cover:

- extra metadata and nested workspace fields;
- optional 40- and 64-hex Git observations plus malformed, uppercase, and
  wrong-length rejection;
- missing, relative, malformed, oversized, and over-count workspace maps;
- wrong metadata types and read-only resume drift;
- duplicate JSON-RPC request replay and exact-request cancellation;
- transport and verification deadlines;
- normal EOF, quiescent SIGTERM, interrupted shutdown, and restart refusal;
- host-crash reconciliation when an eligible real verifier path is available.

