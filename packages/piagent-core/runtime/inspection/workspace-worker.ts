import { createManagedSourceRevert, type ManagedSourceContext } from "./managed-source-revert.ts";
import path from "node:path";
import { SessionMutationObserver } from "./session-mutation-observer.ts";
import { writeWorkspaceFile, WorkspaceWriteError, type WorkspaceWriteInput } from "../../extensions/workspace-write.ts";
import { searchWorkspace } from "../../extensions/workspace-search.ts";
import { loadProjectContextIndexPolicy } from "../../extensions/workspace-policy.js";
import { inspectWorkspaceFile, inspectWorkspaceTree, inspectWorkspacePaths } from "../../extensions/workspace-inspection.ts";
import { inspectWorkspaceEntry } from "../../security/workspace-file-reader.ts";
import { managedCheckpointOperation } from "../checkpoints/checkpoint-worker.ts";

// Bundled with its policy assets under managed/dist. The worker runs only
// after the tool boundary has entered the conversation's sandbox.
export async function inspectManagedWorkspace(cwd: string, assets: string, request: unknown, readOnly = false) {
  const input = request as { kind?: unknown; path?: unknown; payload?: unknown } | null;
  if (input?.kind === "checkpoint") return managedCheckpointOperation(cwd, () => managedWorkspacePolicy(cwd, assets, readOnly), request);
  const writing = input?.kind === "write", state = input?.kind === "write-state";
  if (!input || (!writing && !state && (!["tree", "file", "paths", "search"].includes(String(input.kind)) || typeof input.path !== "string"))
    || Object.keys(input).some(key => key !== "kind" && key !== (writing ? "payload" : state ? "kind" : "path"))) throw new Error("workspace-request-invalid");
  const context = managedWorkspacePolicy(cwd, assets, readOnly);
  if (state) return { writable: !context.readOnly };
  if (writing) {
    try { return { state: "saved", ...writeWorkspaceFile(cwd, input.payload as WorkspaceWriteInput, context) }; }
    catch (error) {
      if (error instanceof WorkspaceWriteError) return { state: "rejected", code: error.code, currentDigest: error.currentDigest };
      throw error;
    }
  }
  const relative = input.path as string;
  return input.kind === "search" ? await searchWorkspace(cwd, relative, context) : input.kind === "paths" ? await inspectWorkspacePaths(cwd, relative, context) : input.kind === "tree" ? inspectWorkspaceTree(cwd, relative, context) : inspectWorkspaceFile(cwd, relative, context);
}

function managedWorkspacePolicy(cwd: string, assets: string, readOnly: boolean) {
  try {
    const stat = inspectWorkspaceEntry(cwd, ".pi/piagent-profile.json");
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("workspace-policy-unavailable");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const { policy, profile } = loadProjectContextIndexPolicy(assets, cwd);
  return { policy, profile, readOnly: readOnly || profile.permissionProfile === "read-only" };
}

export function beginManagedMutationObservation(cwd: string, assets: string, request: {
  toolName: string; args: Record<string, unknown>; sessionId: string; toolCallId: string; prior: unknown;
}, readOnly: boolean) {
  const observer = new SessionMutationObserver();
  if (!["edit", "write"].includes(request.toolName) || typeof request.args.path !== "string") return () => null;
  const file = path.relative(cwd, path.resolve(cwd, request.args.path)).split(path.sep).join("/");
  const policy = managedWorkspacePolicy(cwd, assets, readOnly);
  observer.restore(cwd, request.sessionId, file, request.prior, policy);
  observer.begin(cwd, request.sessionId, request.toolCallId, request.toolName, request.args, [file], policy);
  return () => {
    // Profile changes during execution must also take effect before disclosure.
    const currentPolicy = managedWorkspacePolicy(cwd, assets, readOnly);
    observer.finish(cwd, request.sessionId, request.toolCallId, request.toolName, true, currentPolicy);
    return observer.current(cwd, request.sessionId, file, currentPolicy);
  };
}

export function managedSourceRevert(cwd: string, assets: string, context: Omit<ManagedSourceContext, "cwd" | "policy">, readOnly: boolean) {
  return createManagedSourceRevert({ ...context, cwd, policy: () => managedWorkspacePolicy(cwd, assets, readOnly) });
}

// Only tool-worker supplies this context, separately from model/browser args.
export async function inspectManagedSource(cwd: string, assets: string, request: any, trusted: any, readOnly: boolean) {
  if (!trusted || !/^[a-f0-9]{64}$/.test(trusted.confirmationKey) || !Array.isArray(trusted.observations)
    || trusted.observations.length > 32) throw new Error("source-boundary-authority-required");
  const observations = new Map<string, unknown>(trusted.observations);
  const adapter = managedSourceRevert(cwd, assets, { identity: trusted.identity, rawSessionId: trusted.rawSessionId,
    controlRevision: trusted.controlRevision, confirmationKey: Buffer.from(trusted.confirmationKey, "hex"),
    idle: () => true, observation: file => observations.get(file) }, readOnly);
  if (request?.kind === "diff" && typeof request.fileRef === "string") return { result: await adapter.diff(request.fileRef) };
  if (request?.kind === "sources") return { result: await adapter.sources() };
  if (request?.kind === "preview" && typeof request.fileRef === "string" && Array.isArray(request.hunkRefs))
    return { result: await adapter.preview(request.fileRef, request.hunkRefs) };
  if (request?.kind === "execute") {
    const result = await adapter.execute(request.target);
    return { result, sourceObservation: { path: request.target.path, observation: adapter.observation(request.target.path) } };
  }
  throw new Error("source-request-invalid");
}
