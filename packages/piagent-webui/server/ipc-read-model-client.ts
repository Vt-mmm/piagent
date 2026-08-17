import { randomUUID } from "node:crypto";

import type { SourceView, StreamEvent, StreamReplay, WebUiReadModelProvider } from "./read-model-provider.ts";

type ResponseMessage = { channel: "piagent-webui"; type: "response"; requestId: string; ok: boolean; value?: unknown; error?: string };
type EventMessage = { channel: "piagent-webui"; type: "event"; event: StreamEvent };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

export class IpcReadModelClient implements WebUiReadModelProvider {
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<(event: StreamEvent) => void>();
  readonly #timeoutMs: number;

  constructor(timeoutMs = 30_000) {
    if (typeof process.send !== "function") throw new Error("webui-sidecar-ipc-unavailable");
    this.#timeoutMs = timeoutMs;
    process.on("message", this.#onMessage);
    process.once("disconnect", this.close);
  }

  readonly #onMessage = (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.channel !== "piagent-webui") return;
    if (value.type === "event" && value.event && typeof value.event === "object") {
      for (const listener of this.#listeners) listener(value.event as StreamEvent);
      return;
    }
    if (value.type !== "response" || typeof value.requestId !== "string") return;
    const pending = this.#pending.get(value.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(value.requestId);
    if (value.ok) pending.resolve(value.value);
    else pending.reject(new Error(typeof value.error === "string" ? value.error : "webui-parent-request-failed"));
  };

  #request(method: string, args: unknown[] = []): Promise<any> {
    const requestId = `request.${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("webui-parent-request-timeout"));
      }, this.#timeoutMs);
      timer.unref();
      this.#pending.set(requestId, { resolve, reject, timer });
      process.send?.({ channel: "piagent-webui", type: "request", requestId, method, args });
    });
  }

  capabilities(): Promise<unknown> { return this.#request("capabilities"); }
  snapshot(): Promise<unknown> { return this.#request("snapshot"); }
  sourceChanges(view: SourceView): Promise<unknown> { return this.#request("sourceChanges", [view]); }
  diff(view: SourceView, fileRef: string): Promise<unknown> { return this.#request("diff", [view, fileRef]); }
  review(view: SourceView, fileRef: string): Promise<unknown> { return this.#request("review", [view, fileRef]); }
  sourceMutation(action: "source.stage" | "source.unstage", fileRef: string): Promise<unknown> { return this.#request("sourceMutation", [action, fileRef]); }
  sourceRevert(fileRef: string, hunkRef: string | null): Promise<unknown> { return this.#request("sourceRevert", [fileRef, hunkRef]); }
  commitSummary(): Promise<unknown> { return this.#request("commitSummary"); }
  taskIndex(): Promise<unknown> { return this.#request("taskIndex"); }
  taskTimeline(runRef: string): Promise<unknown> { return this.#request("taskTimeline", [runRef]); }
  recoveryHistory(runRef: string): Promise<unknown> { return this.#request("recoveryHistory", [runRef]); }
  handoffHistory(runRef: string): Promise<unknown> { return this.#request("handoffHistory", [runRef]); }
  subagentTree(runRef: string): Promise<unknown> { return this.#request("subagentTree", [runRef]); }
  releaseMonitor(): Promise<unknown> { return this.#request("releaseMonitor"); }
  documents(): Promise<unknown> { return this.#request("documents"); }
  document(documentRef: string): Promise<unknown> { return this.#request("document", [documentRef]); }
  activity(): Promise<unknown> { return this.#request("activity"); }
  logPreview(activityRef: string): Promise<unknown> { return this.#request("logPreview", [activityRef]); }
  transcript(beforeCursor: string | null, limit: number): Promise<unknown> { return this.#request("transcript", [beforeCursor, limit]); }
  queue(): Promise<unknown> { return this.#request("queue"); }
  modelCatalog(): Promise<unknown> { return this.#request("modelCatalog"); }
  approval(approvalRef: string): Promise<unknown> { return this.#request("approval", [approvalRef]); }
  executeControl(command: unknown): Promise<unknown> { return this.#request("control", [command]); }
  executeAttachment(command: unknown): Promise<unknown> { return this.#request("attachment", [command]); }
  executeApproval(approvalRef: string, decision: unknown): Promise<unknown> { return this.#request("approvalDecision", [approvalRef, decision]); }
  replay(after: string | null, limit: number): Promise<StreamReplay> { return this.#request("replay", [after, limit]); }
  subscribe(listener: (event: StreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close = (): void => {
    process.off("message", this.#onMessage);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("webui-parent-disconnected"));
    }
    this.#pending.clear();
    this.#listeners.clear();
  };
}
