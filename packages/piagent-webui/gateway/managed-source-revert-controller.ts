import type { BridgeSnapshot, BridgeRevisions } from "../../piagent-core/runtime/inspection/session-identity.ts";
import type { SourceRevertProjection, SourceRevertTarget, SourceIndexTransactionResult } from "../../piagent-core/runtime/inspection/source-action-contract.ts";
import { SourceRevertController, type SourceRevertEvidenceStore } from "../server/source-revert-controller.ts";

export type ManagedSourceRequest = { kind: "preview"; fileRef: string; hunkRefs: string[] }
  | { kind: "execute"; target: SourceRevertTarget } | { kind: "sources" } | { kind: "diff"; fileRef: string };
export type ManagedSourceBinding = {
  identity: NonNullable<BridgeSnapshot["identity"]>; rawSessionId: string; controlRevision: string;
  current(): boolean; idle(): boolean;
};
export type ManagedSourcePort = (request: ManagedSourceRequest, binding: ManagedSourceBinding) => Promise<unknown>;

// The company Gateway owns receipts and live session checks. Only the worker
// resolves a preview into filesystem authority; no patch bytes cross this port.
export function managedSourceRevertController(options: {
  projectRoot: string; binding: ManagedSourceBinding; snapshot(): BridgeSnapshot;
  revisions(): Promise<BridgeRevisions>; evidence: SourceRevertEvidenceStore; source: ManagedSourcePort;
}) {
  const { binding, source } = options;
  const preview = async (fileRef: string, hunkRefs: string[]) => {
    if (!binding.current() || !binding.idle()) throw new Error("source-session-unavailable");
    const value = await source({ kind: "preview", fileRef, hunkRefs }, binding) as SourceRevertProjection;
    if (!value || value.version !== "piagent-webui-source-revert-v1"
      || ["projectRef", "sessionRef", "runtimeInstanceId", "taskId", "taskRunId"].some(key =>
        value.identity?.[key as keyof typeof value.identity] !== binding.identity[key as keyof typeof binding.identity]))
      throw new Error("source-preview-binding-mismatch");
    return value;
  };
  const controller = new SourceRevertController<SourceRevertTarget>({ projectRoot: options.projectRoot,
    allowSessionReverts: true, bridge: { snapshot: options.snapshot }, evidence: options.evidence, revisions: options.revisions,
    resolve: async (fileRef, hunks) => {
      const projection = await preview(fileRef, hunks);
      return { projection, authority: projection.state === "ready" ? projection.target : null };
    },
    mutate: async request => {
      const result = (state: "rejected" | "uncertain", reasonCode: string): SourceIndexTransactionResult => ({ state, reasonCode,
        beforeIndexPreimage: request.expectedIndexPreimage, beforeWorkspacePreimage: request.expectedWorkspacePreimage,
        afterIndexPreimage: null, afterWorkspacePreimage: null, executor: "pi-guard", directExecution: false });
      if (!binding.current() || !binding.idle() || request.expectedControlRevision !== binding.controlRevision)
        return result("rejected", "source-session-unavailable");
      try { return await source({ kind: "execute", target: request.authority }, binding) as SourceIndexTransactionResult; }
      catch { return result("uncertain", "source-boundary-effect-unknown"); }
    } });
  return { preview, execute: (command: unknown) => controller.execute(command) };
}
