import path from "node:path";
import { inspectWorkspaceFile, workspacePathFlags, type WorkspacePolicy } from "../../extensions/workspace-inspection.ts";
import { redactSensitiveText } from "../../extensions/redaction-core.js";
import { PiSourceMutationGuard } from "../policy/source-mutation-guard.ts";
import { collectSourceChangeViews } from "./source-change-projection.ts";
import { collectSessionFileDiff } from "./session-diff-projection.ts";
import { collectSourceRevertPreview, validateSourceRevertTarget } from "./source-revert-projection.ts";
import { SessionMutationObserver } from "./session-mutation-observer.ts";
import { sessionAuthoredHunkRefs } from "./session-hunk-provenance.ts";
import { canonicalReviewValue } from "./review-state-contract.ts";
import type { SourceRevertTarget, WebUiIdentity } from "./source-action-contract.ts";

// Construct only inside the sandbox. Identity, observations and confirmation key
// come from the owning runtime; the browser supplies only a selected target.
export type ManagedSourceContext = {
  cwd: string; rawSessionId: string; identity: WebUiIdentity; confirmationKey: Buffer;
  controlRevision: string; idle(): boolean; policy(): WorkspacePolicy;
  observation(file: string): unknown;
};
export function createManagedSourceRevert(context: ManagedSourceContext) {
  const { cwd, identity } = context;
  if (identity.taskId !== null || identity.taskRunId !== null) throw new Error("source-session-binding-required");
  const relative = (root: string, file: string) => path.relative(cwd, path.resolve(root, file)).split(path.sep).join("/");
  const blocked = (root: string, file: string, writing = true) => {
    const name = relative(root, file);
    if (!name || name === ".." || name.startsWith("../") || path.isAbsolute(name)) return true;
    const flags = workspacePathFlags(name, context.policy());
    return flags.protected || writing && flags.readOnly;
  };
  const observer = new SessionMutationObserver(), loaded = new Set<string>();
  const observation = (file: string) => {
    const policy = context.policy();
    if (!loaded.has(file)) { observer.restore(cwd, context.rawSessionId, file, context.observation(file), policy); loaded.add(file); }
    return observer.current(cwd, context.rawSessionId, file, policy);
  };
  const readBlocked = (root: string, file: string) => blocked(root, file, false);
  const sources = () => collectSourceChangeViews({ cwd, identity, taskRevision: null, isProtectedPath: readBlocked });
  const detail = async (fileRef: string) => {
    const views = await sources(), source = views.workingTree;
    const file = source.files.find(item => item.fileRef === fileRef);
    if (!file) throw new Error("source-file-unavailable");
    const diff = await collectSessionFileDiff({ cwd, identity, sourceView: source, fileRef, taskRevision: null, sessionObservation: observation,
      isProtectedPath: readBlocked, redactLine: redactSensitiveText, revalidationMode: "selected-file",
      selectedRepoPaths: file.pathDisplay === "exact-safe" ? [String(file.path)] : undefined,
      precondition: { expectedViewRevision: source.viewRevision, expectedFileRevision: String(file.fileRevision),
        expectedBaseDigest: file.baseDigest as string | null, expectedCurrentDigest: file.currentDigest as string | null } });
    return { views, source, file, diff };
  };
  const resolve = async (fileRef: string, hunkRefs: string[]) => {
    const { views, source, file, diff } = await detail(fileRef);
    return collectSourceRevertPreview({ cwd, identity, sourceView: source, taskView: null, diff, taskRevision: null,
      workspaceRevision: source.viewRevision, indexRevision: views.staged.viewRevision, selectedHunkRefs: hunkRefs,
      sessionObservation: file.pathDisplay === "exact-safe" ? observation(String(file.path)) ?? undefined : undefined,
      confirmationKey: context.confirmationKey, guardAvailable: context.idle() && context.policy().readOnly !== true,
      isProtectedPath: blocked });
  };
  return {
    sources, observation,
    async diff(fileRef: string) { return (await detail(fileRef)).diff; },
    async preview(fileRef: string, hunkRefs: string[]) { return (await resolve(fileRef, hunkRefs)).projection; },
    async execute(value: unknown) {
      const target: SourceRevertTarget = validateSourceRevertTarget(value);
      if (Date.now() > Date.parse(target.expiresAt)) throw new Error("source-revert-preview-expired");
      const { authority } = await resolve(target.fileRef, target.hunkRefs);
      // The time window is checked separately; every content and identity binding
      // must match the newly constructed, keyed preview before execution.
      if (!authority || canonicalReviewValue({ ...authority.target, expiresAt: target.expiresAt }) !== canonicalReviewValue(target))
        throw new Error("source-revert-preview-stale");
      authority.target.expiresAt = target.expiresAt;
      const guard = new PiSourceMutationGuard();
      const unbind = guard.bind({ cwd, rawSessionId: context.rawSessionId, guardInstanceId: identity.runtimeInstanceId,
        facts: () => ({ taskId: null, taskRunId: null, taskRevision: null, taskState: "none", sessionBound: true,
          writable: context.policy().readOnly !== true, idle: context.idle(), controlRevision: context.controlRevision,
          sessionObservation: observation,
          sessionReverted: (candidate, before, committed) => observer.reverted(cwd, context.rawSessionId,
            relative(candidate.repoRoot, candidate.repoPath), before, committed, context.policy()),
          isProtectedPath: file => blocked(cwd, file), sessionHunkRefs: candidate => {
            const file = relative(candidate.repoRoot, candidate.repoPath), observed = observation(file);
            const current = inspectWorkspaceFile(cwd, file, context.policy());
            return observed && current.content !== null ? sessionAuthoredHunkRefs(observed, current.content, candidate.patchAuthority) : [];
          } }) });
      try {
        return await guard.executeRevert({ cwd, rawSessionId: context.rawSessionId, identity, action: "source.revert",
          expectedTaskRevision: null, expectedControlRevision: context.controlRevision,
          expectedIndexPreimage: target.indexPreimage, expectedWorkspacePreimage: target.workspacePreimage,
          previewRef: target.previewRef, confirmedPreviewDigest: target.confirmedPreviewDigest, authority });
      } finally { unbind(); }
    }
  };
}
