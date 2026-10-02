import assert from "node:assert/strict";
import test from "node:test";

import { approvalConsequenceText, approvalKindText, approvalReasonText, approvalScopeText } from "../packages/piagent-webui/client/src/approval-text.ts";
import { evaluateExecPolicyCore } from "../packages/piagent-core/extensions/policy-core.js";

// The approval card speaks the member's language: the runtime's reasons and
// consequences are shown in Vietnamese when known, never as policy jargon.
test("a push needing approval reads as plain Vietnamese, unknown text stays as written", () => {
  const decision = evaluateExecPolicyCore("git push origin main", { policy: { requireConfirmationPatterns: ["git push"] } });
  const reason = decision.reasons.find((value) => /git push/.test(value));
  assert.equal(reason, "Confirmation required: the command runs git push");
  assert.equal(approvalReasonText(reason, "vi"), "Lệnh có git push nên cần bạn duyệt trước khi chạy.");
  assert.equal(approvalReasonText(reason, "en"), reason);
  assert.equal(approvalReasonText("Cài left-pad làm dependency", "vi"), "Cài left-pad làm dependency");
  assert.equal(approvalKindText({ kind: "external-provider-action" }, "vi"), "Tác động ra bên ngoài");
  assert.equal(approvalScopeText({ requestedScope: "network-command-once" }, "vi"), "Đúng một lệnh, có mạng");
  assert.equal(approvalConsequenceText("The command does not run; the agent is told you declined.", "vi"), "Lệnh không chạy; agent được báo là bạn đã từ chối.");
  assert.equal(approvalConsequenceText("The command does not run; the agent is told you declined.", "en"), "The command does not run; the agent is told you declined.");
  assert.equal(approvalConsequenceText("Run this exact command once, with internet access; a server it starts accepts connections while it runs.", "vi"), "Chạy đúng lệnh này một lần, có mạng; server mà lệnh mở nhận kết nối trong lúc chạy.");
  assert.equal(approvalConsequenceText("Something new.", "vi"), "Something new.");
});
