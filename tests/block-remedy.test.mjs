import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { remedyForReason, withRemedy } from "../packages/piagent-core/runtime/policy/block-remedy.ts";

describe("blocked tool calls say what to do next", () => {
  it("answers each family of refusal with a different instruction", () => {
    const cases = [
      "Command touches protected path: .env matches **/.env",
      "Blocked read write to read-only path from path: backend/x.ts matches backend/**",
      "Blocked read read outside resolved filesystem scope from path: /etc/hosts",
      "Task t1 cannot mutate paths outside its declared scope: src/other.ts.",
      "Permission profile read-only blocked bash: shell execution is disabled.",
      "Task lifecycle control blocks tool start while state is paused.",
      "path traverses symbolic link: src/link.ts",
      "Tool is not registered in piagent tool registry."
    ];
    const remedies = cases.map((reason) => remedyForReason(reason));
    for (const [index, remedy] of remedies.entries()) {
      assert.ok(remedy, `no remedy for: ${cases[index]}`);
    }
    // Different families must not collapse onto one generic sentence, or the
    // advice stops being advice.
    assert.equal(new Set(remedies).size >= 6, true, "refusal families share too few remedies");
  });

  it("answers the composed strings an operator actually sees, not just the templates", () => {
    // The guard builds most refusals as `Blocked ${tool}: ${detail}`, so the
    // family lives in the interpolated half. Matching only the template shape
    // would leave the real message unanswered.
    const runtime = [
      "Blocked bash: Command touches protected path: .env matches **/.env",
      "Blocked grep glob targeting protected path: .env* can match .env via **/.env",
      "Blocked find pattern targeting protected path: .env* can match .env via **/.env",
      // The whole session is refused here; this one must never be silent.
      "Blocked every tool call: repository MCP servers await approval",
      "Task t1 is read-only; this shell command is not in the read-only inspection allowlist.",
      "Context budget blocked editing large file src/big.ts: 900000 chars > 400000",
      "Approval became stale before tool start; the action was blocked."
    ];
    for (const reason of runtime) {
      assert.ok(remedyForReason(reason), `no remedy for the message an operator sees: ${reason}`);
    }
    // Having *a* remedy is not enough for the refusal that stops the whole
    // session: the generic MCP advice tells the reader to approve one server,
    // when what they need to know is that nothing runs until the config is
    // fixed, and which command shows them why.
    const sessionWide = remedyForReason("Blocked every tool call: repository MCP servers await approval");
    assert.match(sessionWide, /every tool call is refused/i);
    assert.match(sessionWide, /piagent-mcp doctor/);
  });

  it("appends the remedy to the reason the operator actually sees", () => {
    const decision = withRemedy({ block: true, reason: "Command touches protected path: .env matches **/.env" });
    assert.match(decision.reason, /matches \*\*\/\.env → /);
    assert.match(decision.reason, /piagent-context/);
    assert.equal(decision.block, true);
  });

  it("does not repeat guidance a refusal already carries", () => {
    // This one ends by telling the reader what to do, so it must not be given
    // a second instruction in the same line.
    const already = "Capability lock is missing. Reapply the project profile.";
    assert.equal(withRemedy({ block: true, reason: already }).reason, already);
  });

  it("leaves a refusal it has no advice for exactly as written", () => {
    const unknown = "Blocked for a reason this map has never seen.";
    assert.equal(remedyForReason(unknown), undefined);
    assert.equal(withRemedy({ block: true, reason: unknown }).reason, unknown);
    assert.equal(remedyForReason(""), undefined);
  });

  it("is idempotent, so a decision passed twice is not answered twice", () => {
    const once = withRemedy({ block: true, reason: "Command touches protected path: .env matches **/.env" });
    assert.equal(withRemedy(once).reason, once.reason);
  });
});
