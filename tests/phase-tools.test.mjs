import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PIAGENT_TOOL_ORDER } from "../packages/piagent-core/runtime/tools/tool-groups.ts";
import {
  PHASE_TOOL_GROUPS,
  PIAGENT_DIAGNOSTIC_TOOLS,
  PIAGENT_MUTATION_CAPABLE_TOOLS,
  PIAGENT_OPERATOR_TOOLS,
  PIAGENT_PRIMARY_TOOL_GROUP,
  phaseToolPolicy,
  phaseToolPolicyErrors
} from "../packages/piagent-core/runtime/tools/phase-tools.ts";

describe("phase-aware tool policy", () => {
  it("classifies every registered Piagent tool exactly once into every required primary group", () => {
    assert.deepEqual(phaseToolPolicyErrors(), []);
    assert.equal(Object.keys(PIAGENT_PRIMARY_TOOL_GROUP).length, PIAGENT_TOOL_ORDER.length);
    assert.deepEqual(new Set(Object.values(PIAGENT_PRIMARY_TOOL_GROUP)), new Set(PHASE_TOOL_GROUPS));
  });

  it("keeps operator and diagnostic surfaces separate from model-visible phase tools", () => {
    for (const phase of ["intake", "scout", "plan", "execute", "verify", "repair", "review", "handoff", "terminal"]) {
      const policy = phaseToolPolicy(phase, "source-change");
      assert.equal(policy.modelVisiblePiagentTools.some((tool) => PIAGENT_OPERATOR_TOOLS.has(tool)), false);
      assert.equal(policy.modelVisiblePiagentTools.some((tool) => PIAGENT_DIAGNOSTIC_TOOLS.has(tool)), false);
      assert.deepEqual(policy.operatorTools, PIAGENT_TOOL_ORDER.filter((tool) => PIAGENT_OPERATOR_TOOLS.has(tool)));
    }
  });

  it("exposes no direct mutator while retaining carrier-checked shell inspection in review", () => {
    for (const phase of ["intake", "scout", "review", "handoff", "terminal"]) {
      const policy = phaseToolPolicy(phase, "read-only");
      assert.equal(policy.modelVisiblePiagentTools.some((tool) => PIAGENT_MUTATION_CAPABLE_TOOLS.has(tool)), false);
      assert.equal(policy.requiredHostTools.some((tool) => ["edit", "write", "apply_patch"].includes(tool)), false);
    }
    const review = phaseToolPolicy("review", "source-change");
    assert.equal(review.modelVisiblePiagentTools.some((tool) => PIAGENT_MUTATION_CAPABLE_TOOLS.has(tool)), false);
    assert.equal(review.requiredHostTools.includes("bash"), true);
  });

  it("keeps runtime-owned evidence tools hidden while retaining host verification", () => {
    const verify = phaseToolPolicy("verify", "source-change");
    assert.deepEqual(verify.modelVisiblePiagentTools, []);
    assert.deepEqual(verify.requiredHostTools, ["read", "bash"]);
    for (const phase of ["verify", "repair", "review", "handoff"]) {
      const visible = phaseToolPolicy(phase, "source-change").modelVisiblePiagentTools;
      assert.equal(visible.some((tool) => ["piagent_context_record", "piagent_verify_record", "piagent_task_gate_check", "piagent_trace_record"].includes(tool)), false);
    }
  });

  it("keeps terminal model visibility empty while operator commands remain a separate surface", () => {
    const terminal = phaseToolPolicy("terminal", "source-change");
    assert.deepEqual(terminal.modelVisiblePiagentTools, []);
    assert.deepEqual(terminal.requiredHostTools, []);
    assert.ok(terminal.operatorTools.includes("piagent_permission_status"));
    assert.ok(terminal.operatorTools.includes("piagent_profile_apply"));
  });
});
