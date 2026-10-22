import type { SourceRevertAuthority } from "../../piagent-core/runtime/inspection/source-action-contract.ts";
import { appendSourceMutationEvidence, readSourceMutationEvidence } from "../../piagent-core/runtime/inspection/source-mutation-store.ts";
import { SourceRevertController as SharedSourceRevertController } from "../server/source-revert-controller.ts";

export type { SourceRevertReceipt } from "../server/source-revert-controller.ts";

// The legacy extension retains its task evidence store; Gateway supplies its own binding.
export class SourceRevertController extends SharedSourceRevertController {
  constructor(options: Omit<ConstructorParameters<typeof SharedSourceRevertController<SourceRevertAuthority>>[0], "evidence" | "allowSessionReverts">) {
    super({ ...options, allowSessionReverts: false, evidence: {
      read: (root, run) => run ? readSourceMutationEvidence(root, run) : { records: [], corruptions: ["active-task-required"] },
      append: value => {
        if (!value.taskId || !value.taskRunId) throw new Error("active-task-required");
        return appendSourceMutationEvidence({ ...value, taskId: value.taskId, taskRunId: value.taskRunId });
      }
    } });
  }
}
