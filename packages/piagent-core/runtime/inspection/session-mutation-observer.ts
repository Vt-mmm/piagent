import { createHash } from "node:crypto";
import path from "node:path";
import { inspectWorkspaceFile, type WorkspacePolicy } from "../../extensions/workspace-inspection.ts";
import { expectedModelMutationProof } from "../quality/model-mutation-proof.ts";

type FileImage = { content: string; digest: string };
export type SessionMutationObservation = {
  path: string; baseline: FileImage; currentDigest: string; toolCallId: string; evidenceRef: string;
};
type Pending = { toolName: string; files: Map<string, { before: FileImage; expected: string[] }> };
type Session = { pending: Map<string, Pending>; files: Map<string, SessionMutationObservation> };
const MAX_SESSIONS = 64, MAX_FILES = 32, MAX_PENDING = 8, MAX_BYTES = 256 * 1024;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

// This observation proves the exact tool result, not authorship of every line
// in the file. A member edit breaks the chain and becomes the next baseline.
export class SessionMutationObserver {
  readonly #sessions = new Map<string, Session>();
  #key(cwd: string, sessionId: string) { return `${path.resolve(cwd)}\0${sessionId}`; }
  #session(cwd: string, sessionId: string): Session {
    const key = this.#key(cwd, sessionId);
    let state = this.#sessions.get(key);
    if (!state) {
      state = { pending: new Map(), files: new Map() }; this.#sessions.set(key, state);
      while (this.#sessions.size > MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value!);
    }
    return state;
  }
  #trim(): void {
    let bytes = 0;
    for (const state of [...this.#sessions.values()].reverse()) {
      for (const item of state.files.values()) bytes += Buffer.byteLength(item.baseline.content);
      for (const pending of state.pending.values()) for (const item of pending.files.values()) bytes += Buffer.byteLength(item.before.content);
    }
    while (bytes > 8 * 1024 * 1024 && this.#sessions.size) {
      const key = this.#sessions.keys().next().value!, state = this.#sessions.get(key)!;
      for (const item of state.files.values()) bytes -= Buffer.byteLength(item.baseline.content);
      for (const pending of state.pending.values()) for (const item of pending.files.values()) bytes -= Buffer.byteLength(item.before.content);
      this.#sessions.delete(key);
    }
  }
  #read(cwd: string, file: string, policy: WorkspacePolicy, allowAbsent = false): FileImage | null {
    try {
      const value = inspectWorkspaceFile(cwd, file, policy);
      if (value.protected || value.content === null || !value.digest || Buffer.byteLength(value.content) > MAX_BYTES) return null;
      return { content: value.content, digest: value.digest };
    } catch (error) {
      return allowAbsent && (error as NodeJS.ErrnoException).code === "ENOENT" ? { content: "", digest: "absent" } : null;
    }
  }
  begin(cwd: string, sessionId: string, toolCallId: string, toolName: string,
    input: Record<string, unknown>, targets: string[], policy: WorkspacePolicy): void {
    const state = this.#session(cwd, sessionId);
    state.pending.delete(toolCallId);
    if (!["write", "edit", "apply_patch"].includes(toolName) || targets.length > MAX_FILES) return;
    const before = new Map<string, FileImage>();
    for (const target of new Set(targets)) {
      const file = path.relative(cwd, path.resolve(cwd, target)).split(path.sep).join("/");
      const image = this.#read(cwd, file, policy, true);
      // Only validated paths may enter the legacy exact-replacement prover.
      if (image) before.set(file, image);
    }
    const proof = expectedModelMutationProof(cwd, toolName, input, [...before.keys()], (_root, file) => this.#read(cwd, file, policy) ?? undefined);
    const files: Pending["files"] = new Map();
    for (const [file, image] of before) {
      const expected = proof.expectedContentDigests[file];
      if (expected?.length && this.#read(cwd, file, policy, true)?.digest === image.digest
        && (!proof.preContentDigests[file] || proof.preContentDigests[file] === image.digest)) {
        files.set(file, { before: image, expected });
      } else state.files.delete(file);
    }
    if (files.size) state.pending.set(toolCallId, { toolName, files });
    while (state.pending.size > MAX_PENDING) state.pending.delete(state.pending.keys().next().value!);
    this.#trim();
  }
  finish(cwd: string, sessionId: string, toolCallId: string, toolName: string, successful: boolean, policy: WorkspacePolicy): void {
    const state = this.#sessions.get(this.#key(cwd, sessionId)), pending = state?.pending.get(toolCallId);
    if (!state || !pending) return;
    state.pending.delete(toolCallId);
    for (const [file, candidate] of pending.files) {
      const current = successful && toolName === pending.toolName ? this.#read(cwd, file, policy) : null;
      const previous = state.files.get(file); state.files.delete(file);
      if (!current || current.digest === candidate.before.digest || !candidate.expected.includes(current.digest)) continue;
      const baseline = previous?.currentDigest === candidate.before.digest ? previous.baseline : candidate.before;
      if (baseline.digest === current.digest) continue;
      const evidenceRef = `session-mutation.${hash(JSON.stringify([sessionId, toolCallId, file, baseline.digest, current.digest]))}`;
      state.files.set(file, { path: file, baseline, currentDigest: current.digest, toolCallId, evidenceRef });
    }
    while (state.files.size > MAX_FILES) state.files.delete(state.files.keys().next().value!);
    this.#trim();
  }
  // Called only with the digest of bytes committed by the guarded executor.
  reverted(cwd: string, sessionId: string, file: string, beforeDigest: string, committedDigest: string, policy: WorkspacePolicy): void {
    const state = this.#sessions.get(this.#key(cwd, sessionId)), prior = state?.files.get(file);
    if (!state || !prior) return;
    state.files.delete(file);
    const current = this.#read(cwd, file, policy);
    if (prior.currentDigest !== beforeDigest || current?.digest !== committedDigest || current.digest === prior.baseline.digest) return;
    state.files.set(file, { ...prior, currentDigest: current.digest,
      evidenceRef: `session-mutation.${hash(JSON.stringify([prior.evidenceRef, "revert", current.digest]))}` });
  }
  current(cwd: string, sessionId: string, file: string, policy: WorkspacePolicy): SessionMutationObservation | null {
    const state = this.#sessions.get(this.#key(cwd, sessionId)), observation = state?.files.get(file);
    if (!observation) return null;
    if (this.#read(cwd, file, policy)?.digest !== observation.currentDigest) { state!.files.delete(file); return null; }
    return structuredClone(observation);
  }
  // Only the trusted runtime may restore this between sandbox invocations.
  // Revalidate the path policy and live digest before the next tool starts.
  restore(cwd: string, sessionId: string, file: string, value: unknown, policy: WorkspacePolicy): void {
    const item = value as SessionMutationObservation | null;
    if (!item || item.path !== file || typeof item.baseline?.content !== "string"
      || Buffer.byteLength(item.baseline.content) > MAX_BYTES
      || (item.baseline.digest === "absent" ? item.baseline.content !== "" : hash(item.baseline.content) !== item.baseline.digest)
      || !/^[a-f0-9]{64}$/.test(item.currentDigest) || typeof item.toolCallId !== "string" || item.toolCallId.length > 256
      || !/^session-mutation\.[a-f0-9]{64}$/.test(item.evidenceRef)
      || this.#read(cwd, file, policy)?.digest !== item.currentDigest) return;
    this.#session(cwd, sessionId).files.set(file, structuredClone(item)); this.#trim();
  }
  clear(cwd: string, sessionId: string): void { this.#sessions.delete(this.#key(cwd, sessionId)); }
}

const KEY = Symbol.for("piagent.session-mutation-observer.v1");
const shared = globalThis as typeof globalThis & { [KEY]?: SessionMutationObserver };
export const sessionMutationObserver = shared[KEY] ??= new SessionMutationObserver();
