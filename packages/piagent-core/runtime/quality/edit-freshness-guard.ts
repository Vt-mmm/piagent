import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { currentFileContentDigests } from "./model-mutation-proof.ts";

export type EditFreshnessMode = "off" | "observe" | "enforce";
export type EditFreshnessSource = "read" | "mutation";
export type EditFreshnessEvaluation = {
  decision: "off" | "unobserved" | "current" | "stale";
  checkedPaths: string[];
  stalePaths: string[];
  enforce: boolean;
};

type SessionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;
type Snapshot = { digest: string; taskRunId: string; source: EditFreshnessSource; recordedAt: string };
type SessionState = { identity: string; snapshots: Map<string, Snapshot> };

const MAX_SNAPSHOTS_PER_SESSION = 256;

function normalizeProjectPath(cwd: string, candidate: string): string | undefined {
  if (!candidate || candidate.includes("\0")) return undefined;
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate);
  const relative = path.relative(cwd, absolute).split(path.sep).join("/");
  return relative && relative !== "." && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative)
    ? relative
    : undefined;
}

export function editFreshnessModeFromEnvironment(value: unknown): EditFreshnessMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return "off";
  if (["observe", "shadow", "advisory"].includes(normalized)) return "observe";
  return "enforce";
}

/**
 * Binds an edit to the complete file version last delivered by a successful
 * read (or produced by a successful Piagent mutation). Files that have no
 * observed snapshot retain the host tool's existing exact-anchor policy; the
 * pilot only rejects proven drift, so it cannot invent a read requirement.
 */
export class EditFreshnessGuard {
  readonly #mode: EditFreshnessMode;
  readonly #sessions = new WeakMap<SessionContext["sessionManager"], SessionState>();

  constructor(mode: EditFreshnessMode = "enforce") { this.#mode = mode; }

  #identity(ctx: SessionContext): string {
    return `${path.resolve(ctx.cwd)}\0${ctx.sessionManager.getSessionId()}`;
  }

  #session(ctx: SessionContext): SessionState {
    const identity = this.#identity(ctx), existing = this.#sessions.get(ctx.sessionManager);
    if (existing?.identity === identity) return existing;
    const created = { identity, snapshots: new Map<string, Snapshot>() };
    this.#sessions.set(ctx.sessionManager, created);
    return created;
  }

  observe(
    ctx: SessionContext,
    taskRunId: string | undefined,
    targetPaths: string[],
    source: EditFreshnessSource,
    recordedAt = new Date().toISOString()
  ): string[] {
    if (this.#mode === "off" || !taskRunId) return [];
    const normalized = [...new Set(targetPaths.map((item) => normalizeProjectPath(ctx.cwd, item)).filter(Boolean) as string[])];
    const digests = currentFileContentDigests(ctx.cwd, normalized), session = this.#session(ctx), observed: string[] = [];
    for (const file of normalized) {
      const digest = digests[file];
      if (!digest) continue;
      session.snapshots.delete(file);
      session.snapshots.set(file, { digest, taskRunId, source, recordedAt });
      observed.push(file);
    }
    while (session.snapshots.size > MAX_SNAPSHOTS_PER_SESSION) {
      session.snapshots.delete(session.snapshots.keys().next().value as string);
    }
    return observed;
  }

  evaluate(ctx: SessionContext, taskRunId: string | undefined, targetPaths: string[]): EditFreshnessEvaluation {
    if (this.#mode === "off") return { decision: "off", checkedPaths: [], stalePaths: [], enforce: false };
    if (!taskRunId) return { decision: "unobserved", checkedPaths: [], stalePaths: [], enforce: this.#mode === "enforce" };
    const session = this.#session(ctx);
    const tracked = [...new Set(targetPaths.map((item) => normalizeProjectPath(ctx.cwd, item)).filter(Boolean) as string[])]
      .filter((file) => session.snapshots.get(file)?.taskRunId === taskRunId);
    if (tracked.length === 0) return { decision: "unobserved", checkedPaths: [], stalePaths: [], enforce: this.#mode === "enforce" };
    const current = currentFileContentDigests(ctx.cwd, tracked);
    const stalePaths = tracked.filter((file) => current[file] !== session.snapshots.get(file)?.digest);
    return {
      decision: stalePaths.length > 0 ? "stale" : "current",
      checkedPaths: tracked,
      stalePaths,
      enforce: this.#mode === "enforce"
    };
  }

  clear(ctx: SessionContext): void { this.#sessions.delete(ctx.sessionManager); }
}
