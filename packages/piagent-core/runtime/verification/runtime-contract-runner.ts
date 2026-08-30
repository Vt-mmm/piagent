import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { createDurableContractRunner } from "../../extensions/acceptance-durable-execution.js";
import { captureExecutionSnapshot } from "../../extensions/acceptance-execution-snapshot.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import type { RuntimeSessionState } from "../session/runtime-state.ts";

type ApprovedConfiguration = Omit<Parameters<typeof createDurableContractRunner>[0], "projectRoot" | "getProjectVerificationDigest">;

/**
 * Host-only bridge from actual tool hooks to the durable independent runner.
 * Configuration, contract checks, store, and source authorization must already
 * be approved by the host; none are taken from a model tool or candidate file.
 * This does not enable production contract selection or completion admission.
 */
export function createRuntimeContractRunner({ state, context, getTask, approved }: {
  state: RuntimeSessionState; context: ExtensionContext; getTask: () => TaskContract | undefined; approved: ApprovedConfiguration;
}) {
  if (!state?.projectVerification || typeof getTask !== "function") throw new TypeError("Actual runtime verification state is required");
  const cwd = context.cwd, sessionId = context.sessionManager.getSessionId();
  const sourcePath = approved.sourcePath, authorizeSourceRead = approved.authorizeSourceRead;
  return createDurableContractRunner({ ...approved, projectRoot: cwd,
    getProjectVerificationDigest(request) {
      try {
        if (context.cwd !== cwd || context.sessionManager.getSessionId() !== sessionId) return null;
        const task = getTask();
        if (!task || task.taskRunId !== request.taskRunId || task.sessionId !== sessionId || task.trace.outcome !== "pending"
          || !task.acceptanceReceipt?.criteria.some((criterion) => criterion.id === request.criterionId && criterion.hash === request.criterionHash)) return null;
        // Ignored source bytes are absent from ordinary project-verifier dirt.
        // Until approved targets are captured at tool start, do not claim they
        // were tested just because an independent execution captured them now.
        const covered = execFileSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "-C", cwd,
          "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", sourcePath],
        { encoding: "utf8", timeout: 3000, maxBuffer: 8192, stdio: ["ignore", "pipe", "pipe"] });
        if (!covered.split("\0").includes(sourcePath)) return null;
        const before = captureWorkspaceVerificationSnapshot(cwd);
        const source = captureExecutionSnapshot({ projectRoot: cwd, sourcePath, authorizeSourceRead });
        const current = captureWorkspaceVerificationSnapshot(cwd);
        if (!before.proofCapable || !current.proofCapable || before.digest !== current.digest
          || before.workspaceRevisionDigest !== current.workspaceRevisionDigest
          || source.snapshotDigest !== request.snapshotDigest || source.binding.workingTreeDigest !== current.digest) return null;
        return state.projectVerification.currentDigest(context, task, current);
      } catch { return null; }
    }
  });
}
