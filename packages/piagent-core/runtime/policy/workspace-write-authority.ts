import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BasePolicy, ProjectProfile } from "../../extensions/guard-types.js";
import type { WorkspacePolicy } from "../../extensions/workspace-inspection.ts";
import { WorkspaceWriteError, writeWorkspaceFile, type WorkspaceWriteInput } from "../../extensions/workspace-write.ts";

type Binding = { owner: string; policy(): WorkspacePolicy };
const key = (cwd: string, sessionId: string) => `${fs.realpathSync(cwd)}\0${sessionId}`;

// Gateway writes use the live guard's permission resolver, including its
// environment/session overrides. A persisted UI message is not authority.
export class WorkspaceWriteAuthority {
  readonly #bindings = new Map<string, Binding>();
  bind(cwd: string, sessionId: string, binding: Binding): () => void {
    const identity = key(cwd, sessionId); this.#bindings.set(identity, binding);
    return () => { if (this.#bindings.get(identity)?.owner === binding.owner) this.#bindings.delete(identity); };
  }
  writable(cwd: string, sessionId: string): boolean {
    try { const policy = this.#bindings.get(key(cwd, sessionId))?.policy(); return !!policy && !policy.readOnly; }
    catch { return false; }
  }
  write(cwd: string, sessionId: string, input: WorkspaceWriteInput) {
    const policy = this.#bindings.get(key(cwd, sessionId))?.policy();
    if (!policy || policy.readOnly) throw new WorkspaceWriteError("read-only");
    return writeWorkspaceFile(cwd, input, policy);
  }
}
// Pi loads extensions through its TS loader, while Gateway uses native ESM.
// Share the live binding across those module instances, as source mutation does.
const AUTHORITY_KEY = Symbol.for("piagent.webui.workspace-write-authority.v1");
const root = globalThis as typeof globalThis & { [AUTHORITY_KEY]?: WorkspaceWriteAuthority };
export const workspaceWriteAuthority = root[AUTHORITY_KEY] ??= new WorkspaceWriteAuthority();

export function createWorkspaceWriteAuthorityBindings(policy: BasePolicy, loadProfile: (ctx: ExtensionContext) => ProjectProfile,
  writable: (ctx: ExtensionContext, profile: ProjectProfile) => boolean) {
  const owner = randomUUID(), bindings = new Map<string, () => void>();
  return {
    bind(ctx: ExtensionContext) {
      const sessionId = ctx.sessionManager.getSessionId(), identity = key(ctx.cwd, sessionId);
      bindings.get(identity)?.();
      bindings.set(identity, workspaceWriteAuthority.bind(ctx.cwd, sessionId, { owner, policy: () => {
        const profile = loadProfile(ctx);
        return { policy: policy as unknown as Record<string, unknown>, profile: profile as unknown as Record<string, unknown>, readOnly: !writable(ctx, profile) };
      } }));
    },
    unbind(ctx: ExtensionContext) {
      const identity = key(ctx.cwd, ctx.sessionManager.getSessionId()); bindings.get(identity)?.(); bindings.delete(identity);
    }
  };
}
