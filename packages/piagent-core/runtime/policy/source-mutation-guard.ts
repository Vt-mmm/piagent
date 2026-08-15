import fs from "node:fs";
import path from "node:path";

import {
  validateSourceMutationTarget,
  type SourceMutationAction,
  type SourceMutationAuthority
} from "../inspection/source-mutation-projection.ts";
import { validateSourceRevertTarget, type SourceRevertAuthority } from "../inspection/source-revert-projection.ts";
import {
  executeGuardedSourceIndexTransaction,
  type SourceIndexTransactionResult
} from "./source-index-transaction.ts";
import { executeGuardedSourceWorktreeRevert } from "./source-worktree-transaction.ts";

const REF = /^[A-Za-z0-9][A-Za-z0-9._:@~-]{0,159}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:~-]{0,159}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const WORKSPACE = /^wt-content-v2:[a-f0-9]{64}$/;

export type SourceMutationGuardFacts = {
  taskId: string;
  taskRunId: string;
  taskRevision: string;
  controlRevision: string;
  taskState: "active" | "terminal" | "unknown";
  idle: boolean;
  isProtectedPath(projectRelativePath: string): boolean;
};

export type SourceMutationGuardRequest = {
  cwd: string;
  rawSessionId: string;
  identity: { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string };
  action: SourceMutationAction;
  expectedTaskRevision: string;
  expectedControlRevision: string;
  expectedIndexPreimage: string;
  expectedWorkspacePreimage: string;
  selectedHunkRefs: string[];
  authority: SourceMutationAuthority;
};
export type SourceRevertGuardRequest = {
  cwd: string; rawSessionId: string;
  identity: { projectRef: string; runtimeInstanceId: string; sessionRef: string; taskId: string; taskRunId: string };
  action: "source.revert"; expectedTaskRevision: string; expectedControlRevision: string; expectedIndexPreimage: string;
  expectedWorkspacePreimage: string; previewRef: string; confirmedPreviewDigest: string; authority: SourceRevertAuthority;
};

type Binding = {
  cwd: string;
  rawSessionId: string;
  guardInstanceId: string;
  facts(): SourceMutationGuardFacts | null;
};

function bindingKey(cwd: string, rawSessionId: string): string { return `${fs.realpathSync.native(cwd)}\0${rawSessionId}`; }
function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rejected(request: SourceMutationGuardRequest, reasonCode: string): SourceIndexTransactionResult {
  return { state: "rejected", reasonCode, beforeIndexPreimage: request.expectedIndexPreimage, afterIndexPreimage: null,
    beforeWorkspacePreimage: request.expectedWorkspacePreimage, afterWorkspacePreimage: null, executor: "pi-guard", directExecution: false };
}
function revertRejected(request: SourceRevertGuardRequest, reasonCode: string): SourceIndexTransactionResult {
  return { state: "rejected", reasonCode, beforeIndexPreimage: request.expectedIndexPreimage, afterIndexPreimage: null,
    beforeWorkspacePreimage: request.expectedWorkspacePreimage, afterWorkspacePreimage: null, executor: "pi-guard", directExecution: false };
}

export class PiSourceMutationGuard {
  readonly #bindings = new Map<string, Binding>();

  bind(input: Binding): () => void {
    const key = bindingKey(input.cwd, input.rawSessionId);
    this.#bindings.set(key, { ...input, cwd: fs.realpathSync.native(input.cwd) });
    return () => {
      const current = this.#bindings.get(key);
      if (current?.guardInstanceId === input.guardInstanceId) this.#bindings.delete(key);
    };
  }

  available(cwd: string, rawSessionId: string): boolean {
    try {
      const binding = this.#bindings.get(bindingKey(cwd, rawSessionId)), facts = binding?.facts();
      return Boolean(facts && facts.taskState === "active" && facts.idle);
    } catch { return false; }
  }

  async execute(request: SourceMutationGuardRequest): Promise<SourceIndexTransactionResult> {
    let binding: Binding | undefined;
    try { binding = this.#bindings.get(bindingKey(request.cwd, request.rawSessionId)); }
    catch { return rejected(request, "mutation-guard-unavailable"); }
    if (!binding || !this.#validRequest(request)) return rejected(request, binding ? "mutation-guard-request-invalid" : "mutation-guard-unavailable");
    const recheck = (): boolean => {
      try {
        const facts = binding!.facts();
        return Boolean(facts && facts.taskState === "active" && facts.idle
          && facts.taskId === request.identity.taskId && facts.taskRunId === request.identity.taskRunId
          && facts.taskRevision === request.expectedTaskRevision && facts.controlRevision === request.expectedControlRevision
          && this.#pathsAllowed(binding!, facts, request.authority));
      } catch { return false; }
    };
    if (!recheck()) return rejected(request, "mutation-guard-precondition-stale");
    return executeGuardedSourceIndexTransaction({ authority: request.authority,
      expectedIndexPreimage: request.expectedIndexPreimage, expectedWorkspacePreimage: request.expectedWorkspacePreimage,
      selectedHunkRefs: request.selectedHunkRefs, recheck });
  }

  async executeRevert(request: SourceRevertGuardRequest): Promise<SourceIndexTransactionResult> {
    let binding: Binding | undefined;
    try { binding = this.#bindings.get(bindingKey(request.cwd, request.rawSessionId)); }
    catch { return revertRejected(request, "mutation-guard-unavailable"); }
    if (!binding || !this.#validRevertRequest(request)) return revertRejected(request, binding ? "mutation-guard-request-invalid" : "mutation-guard-unavailable");
    const recheck = (): boolean => {
      try {
        const facts = binding!.facts(), target = request.authority.target;
        return Boolean(facts && facts.taskState === "active" && facts.idle && Date.now() <= Date.parse(target.expiresAt)
          && facts.taskId === request.identity.taskId && facts.taskRunId === request.identity.taskRunId
          && facts.taskRevision === request.expectedTaskRevision && facts.controlRevision === request.expectedControlRevision
          && this.#pathsAllowed(binding!, facts, { repoRoot: request.authority.repoRoot, repoPaths: [request.authority.repoPath] }));
      } catch { return false; }
    };
    if (!recheck()) return revertRejected(request, "mutation-guard-precondition-stale");
    return executeGuardedSourceWorktreeRevert({ authority: request.authority, expectedIndexPreimage: request.expectedIndexPreimage,
      expectedWorkspacePreimage: request.expectedWorkspacePreimage, recheck });
  }

  #validRequest(request: SourceMutationGuardRequest): boolean {
    try { validateSourceMutationTarget(request.authority.target); }
    catch { return false; }
    const target = request.authority.target;
    return REF.test(request.identity.projectRef) && REF.test(request.identity.runtimeInstanceId) && REF.test(request.identity.sessionRef)
      && REF.test(request.identity.taskId) && REF.test(request.identity.taskRunId)
      && REVISION.test(request.expectedTaskRevision) && REVISION.test(request.expectedControlRevision)
      && DIGEST.test(request.expectedIndexPreimage) && WORKSPACE.test(request.expectedWorkspacePreimage)
      && target.taskRevision === request.expectedTaskRevision && target.indexPreimage === request.expectedIndexPreimage
      && target.workspacePreimage === request.expectedWorkspacePreimage
      && Array.isArray(request.selectedHunkRefs) && request.selectedHunkRefs.length <= 128
      && new Set(request.selectedHunkRefs).size === request.selectedHunkRefs.length
      && request.selectedHunkRefs.every((hunkRef) => REF.test(hunkRef) && target.hunkRefs.includes(hunkRef))
      && JSON.stringify(request.selectedHunkRefs) === JSON.stringify(target.hunkRefs.filter((hunkRef) => request.selectedHunkRefs.includes(hunkRef)))
      && (request.selectedHunkRefs.length === 0 || Boolean(request.authority.patchAuthority && target.status === "M"
        && target.oldPath === null && request.authority.repoPaths.length === 1))
      && (request.action === "source.stage" && target.view === "working-tree" && target.effect === "copy-worktree-to-index"
        || request.action === "source.unstage" && target.view === "staged" && target.effect === "restore-index-from-head");
  }

  #validRevertRequest(request: SourceRevertGuardRequest): boolean {
    try { validateSourceRevertTarget(request.authority.target); } catch { return false; }
    const target = request.authority.target;
    return request.action === "source.revert" && REF.test(request.identity.projectRef) && REF.test(request.identity.runtimeInstanceId)
      && REF.test(request.identity.sessionRef) && REF.test(request.identity.taskId) && REF.test(request.identity.taskRunId)
      && REVISION.test(request.expectedTaskRevision) && REVISION.test(request.expectedControlRevision)
      && DIGEST.test(request.expectedIndexPreimage) && WORKSPACE.test(request.expectedWorkspacePreimage)
      && REF.test(request.previewRef) && DIGEST.test(request.confirmedPreviewDigest)
      && request.previewRef === target.previewRef && request.confirmedPreviewDigest === target.confirmedPreviewDigest
      && target.taskRevision === request.expectedTaskRevision && target.indexPreimage === request.expectedIndexPreimage
      && target.workspacePreimage === request.expectedWorkspacePreimage && target.view === "working-tree"
      && target.status === "M" && target.oldPath === null && target.effect === "restore-worktree-from-index"
      && request.authority.repoPath === target.path && request.authority.patchAuthority.hunks.length >= 1
      && target.hunkRefs.every((hunkRef) => request.authority.patchAuthority.hunks.some((hunk) => hunk.hunkRef === hunkRef));
  }

  #pathsAllowed(binding: Binding, facts: SourceMutationGuardFacts, authority: Pick<SourceMutationAuthority, "repoRoot" | "repoPaths">): boolean {
    const projectRoot = binding.cwd;
    let repoRoot: string;
    try { repoRoot = fs.realpathSync.native(authority.repoRoot); }
    catch { return false; }
    if (!authority.repoPaths.length || authority.repoPaths.length > 2) return false;
    return authority.repoPaths.every((repoPath) => {
      if (!repoPath || path.isAbsolute(repoPath) || repoPath.includes("\0")) return false;
      const absolute = path.resolve(repoRoot, repoPath);
      if (!inside(repoRoot, absolute) || !inside(projectRoot, absolute)) return false;
      const relative = path.relative(projectRoot, absolute).split(path.sep).join("/");
      return Boolean(relative && relative !== "." && !facts.isProtectedPath(relative));
    });
  }
}

const BROKER_KEY = Symbol.for("piagent.webui.source-mutation-guard.v1");
const root = globalThis as typeof globalThis & { [BROKER_KEY]?: PiSourceMutationGuard };
export const piSourceMutationGuard = root[BROKER_KEY] ??= new PiSourceMutationGuard();
