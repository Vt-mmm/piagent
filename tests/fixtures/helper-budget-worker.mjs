import { createHelperRequest, defaultRolePolicy } from "../../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { OwnedWorkBudgetController } from "../../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";

const [cwd, role, objective] = process.argv.slice(2);
const policy = defaultRolePolicy(role, ["src/**"]);
const request = createHelperRequest({
  policy,
  objective,
  taskId: "task-1",
  taskRunId: "concurrent-run",
  sessionId: "private",
  parentReadScope: ["src/**"],
  parentWriteScope: ["src/**"],
  parentAllowedTools: ["read", "grep", "find", "ls", "bash", "contact_supervisor"],
  requestedWriteScope: [],
  singleWriterOwnership: null
});
process.stdout.write(`${JSON.stringify(new OwnedWorkBudgetController().reserve(cwd, request))}\n`);
