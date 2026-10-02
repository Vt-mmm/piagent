import { createHmac } from "node:crypto";
import { webUiTaskRevision } from "../../piagent-core/runtime/inspection/webui-snapshot.ts";
import { activeSessionTask } from "../../piagent-core/extensions/task-state.js";
import { inspectTaskControlState } from "../../piagent-core/runtime/inspection/task-control-journal.ts";
import { projectRefForCwd } from "./session-catalog.ts";
import type { ApprovalAuthority } from "../../piagent-core/runtime/inspection/approval-broker.ts";
import type { ActiveRuntime } from "./session-runtime-state.ts";

export function sessionApprovalAuthority(key: Buffer, sessionRef: string, active: ActiveRuntime): ApprovalAuthority {
      if (!active.operationRef || active.lease.state !== "gateway-owned" || !active.lease.revision) return null;
      const task = activeSessionTask(active.info.cwd, active.info.id);
      const synthetic = (namespace: string) => `${namespace}_${createHmac("sha256", key)
        .update(`${sessionRef}\0${namespace}`).digest("base64url").slice(0, 43)}`;
      const control = task ? inspectTaskControlState(active.info.cwd, task) : null;
      return {
        identity: {
          projectRef: projectRefForCwd(key, active.info.cwd), runtimeInstanceId: active.lease.runtimeInstanceRef!, sessionRef,
          taskId: task?.taskId ?? synthetic("task"), taskRunId: task?.taskRunId ?? synthetic("task_run"),
          agentOperationId: active.operationRef
        },
        revisions: {
          runtimeRevision: active.lease.revision,
          taskRevision: task ? webUiTaskRevision(task) : synthetic("task_rev"),
          controlRevision: control?.controlRevision ?? synthetic("control_rev")
        },
        taskState: control?.state === "terminal" ? "terminal" : "active"
      };
    }
