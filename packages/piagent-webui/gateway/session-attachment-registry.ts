import type { PiagentWebUICanonicalSnapshotV1 } from "../contracts/generated/snapshot-v1.ts";
import { AttachmentStore, type DiscardReceipt, type PreparedAttachments,
  type StageReceipt } from "../../piagent-core/runtime/input/attachment-store.ts";
import type { AttachmentReservation } from "../../piagent-core/runtime/input/attachment-reservation.ts";
import type { BridgeIdentity, BridgeSnapshot } from "../../piagent-core/runtime/inspection/session-identity.ts";

// Attachments for sessions the Gateway drives.
//
// The in-session WebUI stages attachments against a live `SameSessionPiBridge`,
// which knows the identity and revisions of the session it is bound to. The
// Gateway has no such bridge: it owns many sessions and reads each one through
// an inspection provider. What it does have is the exact snapshot the browser
// was given, and that snapshot carries the same identity and revisions the
// browser will quote back in a stage command.
//
// So the bridge the store needs is synthesised from that snapshot, immediately
// before the store reads it. The store's identity and revision checks then
// compare the browser's claim against the same projection the browser was
// answering, which is the property those checks exist to enforce — a command
// aimed at a session that has since changed is refused rather than applied to
// whatever the session became.

const MAX_SESSION_STORES = 16;

function bridgeIdentity(snapshot: PiagentWebUICanonicalSnapshotV1): BridgeIdentity {
  const identity = snapshot.identity;
  return { projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId, sessionRef: identity.sessionRef,
    taskId: identity.taskId ?? null, taskRunId: identity.taskRunId ?? null, agentOperationId: identity.agentOperationId ?? null,
    toolCallId: null };
}

function bridgeSnapshotOf(snapshot: PiagentWebUICanonicalSnapshotV1): BridgeSnapshot {
  const revision = snapshot.revision;
  // A terminal session refuses staging inside the store. Everything else the
  // Gateway can answer for is a session the operator may still attach to.
  const controlState = snapshot.session.controlState;
  return {
    state: "ready",
    identity: bridgeIdentity(snapshot),
    revisions: { runtimeRevision: revision.runtimeRevision, taskRevision: revision.taskRevision ?? null,
      controlRevision: revision.controlRevision ?? null, workspaceRevision: revision.workspaceRevision ?? null,
      indexRevision: revision.indexRevision ?? null, approvalRevision: revision.approvalRevision ?? null,
      sessionOptionRevision: revision.sessionOptionRevision ?? null, queueRevision: revision.queueRevision ?? null },
    liveness: snapshot.session.operation.liveness === "running" ? "running" : "idle",
    taskState: controlState === "terminal" ? "terminal" : controlState === "active" ? "active" : "unknown",
    eventSequence: 0
  };
}

function supportsImages(snapshot: PiagentWebUICanonicalSnapshotV1): boolean {
  const model = snapshot.session.model;
  // The contract types this as a tuple union to bound its length, which leaves
  // includes() narrowed to never. The runtime value is a list of strings.
  const capabilities = model.value?.inputCapabilities as readonly string[] | undefined;
  return model.state === "known" && Boolean(capabilities?.includes("image"));
}

type Slot = { store: AttachmentStore; current: BridgeSnapshot; images: boolean };

export class SessionAttachmentRegistry {
  readonly #slots = new Map<string, Slot>();
  readonly #inspect: (sessionRef: string) => Promise<PiagentWebUICanonicalSnapshotV1>;
  readonly #tempRoot: string | undefined;
  readonly #now: (() => Date) | undefined;
  #closed = false;

  constructor(options: { inspect: (sessionRef: string) => Promise<PiagentWebUICanonicalSnapshotV1>; tempRoot?: string; now?: () => Date }) {
    this.#inspect = options.inspect;
    this.#tempRoot = options.tempRoot;
    this.#now = options.now;
  }

  // Every entry point refreshes the synthesised bridge first. A store that kept
  // the snapshot it was created with would accept a command aimed at a revision
  // the session has already moved past.
  async #slot(sessionRef: string): Promise<Slot> {
    if (this.#closed) throw new Error("session-attachment-registry-closed");
    const snapshot = await this.#inspect(sessionRef);
    const existing = this.#slots.get(sessionRef);
    if (existing) {
      existing.current = bridgeSnapshotOf(snapshot);
      existing.images = supportsImages(snapshot);
      // Refresh recency so the cap evicts the least recently used session.
      this.#slots.delete(sessionRef); this.#slots.set(sessionRef, existing);
      return existing;
    }
    const slot: Slot = { current: bridgeSnapshotOf(snapshot), images: supportsImages(snapshot), store: null as unknown as AttachmentStore };
    slot.store = new AttachmentStore({
      runtimeInstanceId: snapshot.identity.runtimeInstanceId,
      bridgeSnapshot: () => slot.current,
      modelSupportsImages: () => slot.images,
      tempRoot: this.#tempRoot,
      now: this.#now
    });
    this.#slots.set(sessionRef, slot);
    // Each store owns a private directory and staged bytes, so an unbounded map
    // is unbounded disk. The evicted store deletes what it held.
    while (this.#slots.size > MAX_SESSION_STORES) {
      const oldest = this.#slots.keys().next().value as string;
      if (oldest === sessionRef) break;
      this.#slots.get(oldest)?.store.close();
      this.#slots.delete(oldest);
    }
    return slot;
  }

  async execute(sessionRef: string, command: unknown): Promise<StageReceipt | DiscardReceipt> {
    return (await this.#slot(sessionRef)).store.execute(command);
  }

  async capability(sessionRef: string): Promise<{ kinds: Array<"file" | "image" | "document">; mimeTypes: string[] }> {
    return (await this.#slot(sessionRef)).store.capability();
  }

  // Claimed at dispatch, from the send path, which already holds the identity it
  // is sending under. Refs are one-shot: a claim consumes them.
  async claim(sessionRef: string, refs: string[], messageRequestId: string, text: string): Promise<PreparedAttachments> {
    const slot = await this.#slot(sessionRef);
    if (!slot.current.identity) throw new Error("session-attachment-identity-unavailable");
    return slot.store.claim(refs, messageRequestId, slot.current.identity, text);
  }

  async reserve(sessionRef: string, refs: string[], messageRequestId: string, text: string): Promise<AttachmentReservation<PreparedAttachments>> {
    const slot = await this.#slot(sessionRef);
    if (!slot.current.identity) throw new Error("session-attachment-identity-unavailable");
    return slot.store.reserve(refs, messageRequestId, slot.current.identity, text);
  }

  // The shape the host prompt takes. Documents and text files were already
  // turned into text when they were staged, so they join the prompt string;
  // images ride the host's own `images` channel. Split here rather than in the
  // supervisor so the knowledge of what a claim returns stays next to the store
  // that produced it.
  async claimForPrompt(sessionRef: string, refs: string[], messageRequestId: string, message: string):
  Promise<{ text: string; images: unknown[] }> {
    if (refs.length === 0) return { text: message, images: [] };
    const prepared = await this.claim(sessionRef, refs, messageRequestId, message);
    const parts = Array.isArray(prepared.content) ? prepared.content : [{ type: "text" as const, text: message }];
    return {
      text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      images: parts.filter((part) => part.type === "image")
    };
  }


  async reserveForPrompt(sessionRef: string, refs: string[], messageRequestId: string, message: string):
  Promise<{ text: string; images: unknown[]; commit(): void; release(): void }> {
    if (refs.length === 0) return { text: message, images: [], commit() {}, release() {} };
    const reservation = await this.reserve(sessionRef, refs, messageRequestId, message);
    const parts = Array.isArray(reservation.prepared.content) ? reservation.prepared.content
      : [{ type: "text" as const, text: message }];
    return {
      text: parts.filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      images: parts.filter((part) => part.type === "image"),
      commit: reservation.commit,
      release: reservation.release
    };
  }

  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) slot.store.close();
    this.#slots.clear();
  }
}
