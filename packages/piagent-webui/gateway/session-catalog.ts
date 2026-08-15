import { createHmac } from "node:crypto";
import path from "node:path";

import { redactSensitiveText } from "../../piagent-core/security/sensitive-data.js";
import type { Catalog, SessionRow } from "../contracts/generated/session-catalog-v1.ts";
import type { MetadataSnapshot, SessionMetadata } from "./session-metadata-store.ts";
import { projectRefForCwd, sessionRefForPath } from "../ownership/session-refs.ts";

export { projectRefForCwd, sessionRefForPath } from "../ownership/session-refs.ts";

export type PiSessionInfo = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
};

function catalogRef(key: Buffer, namespace: string, value: string): string {
  return `${namespace}_${createHmac("sha256", key).update(value).digest("base64url").slice(0, 43)}`;
}

export type SessionOwnerProjection = Pick<SessionRow, "state" | "liveState" | "composerAvailable" | "needsAttention" | "owner" | "reasonCode">;
export type SessionOptionProjection = Pick<SessionRow, "modelLabel" | "thinkingLevel">;

function display(value: unknown, maximum: number, fallback: string): string {
  const clean = redactSensitiveText(String(value ?? "")).text
    .replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (clean || fallback).slice(0, maximum);
}

function revision(key: Buffer, value: unknown): string {
  return `rev_${createHmac("sha256", key).update(JSON.stringify(value)).digest("hex")}`;
}

function row(key: Buffer, info: PiSessionInfo, metadata: SessionMetadata | undefined, metadataReason: string | null,
  ownership?: SessionOwnerProjection, sessionOptions?: SessionOptionProjection): SessionRow {
  const projectLabel = display(info.cwd ? path.basename(info.cwd) : "", 120, "Unknown project");
  const first = info.firstMessage === "(no messages)" ? "" : info.firstMessage;
  const suppliedName = display(info.name, 500, "").replace(/^pi:\s*/i, "");
  const normalizedName = suppliedName.toLowerCase();
  const genericName = !suppliedName || normalizedName === projectLabel.toLowerCase()
    || ["working", "pi agent platform", "new conversation"].includes(normalizedName);
  const title = display(genericName && first ? first : suppliedName || first, 500, "New conversation").replace(/^pi:\s*/i, "") || "New conversation";
  return {
    sessionRef: sessionRefForPath(key, info.path),
    projectRef: projectRefForCwd(key, info.cwd),
    title,
    projectLabel,
    preview: display(first, 280, "No messages yet"),
    createdAt: info.created.toISOString(),
    updatedAt: info.modified.toISOString(),
    state: metadata?.archived ? "archived" : ownership?.state ?? "offline",
    liveState: metadata?.archived ? "offline" : ownership?.liveState ?? "offline",
    pinned: metadata?.pinned ?? false,
    archived: metadata?.archived ?? false,
    unread: metadata?.unread ?? false,
    composerAvailable: metadata?.archived ? false : ownership?.composerAvailable ?? false,
    needsAttention: metadata?.archived ? false : ownership?.needsAttention ?? false,
    modelLabel: sessionOptions?.modelLabel ?? null,
    thinkingLevel: sessionOptions?.thinkingLevel ?? "unknown",
    contextUsage: { usedTokens: null, contextWindow: null, ratio: null, state: "unknown" },
    task: null,
    owner: metadata?.archived
      ? { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "released" }
      : ownership?.owner ?? { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "unknown" },
    sessionRevision: revision(key, [info.path, info.modified.toISOString(), info.messageCount, info.name ?? null, metadata?.revision ?? null,
      sessionOptions?.modelLabel ?? null, sessionOptions?.thinkingLevel ?? "unknown",
      metadata?.archived ? "archived" : ownership ? [ownership.state, ownership.liveState, ownership.owner.kind,
        ownership.owner.ownerEpoch, ownership.owner.runtimeInstanceRef, ownership.reasonCode] : "offline"]),
    reasonCode: metadata?.archived ? metadataReason : ownership?.reasonCode ?? metadataReason
  };
}

export async function buildSessionCatalog(options: {
  gatewayInstanceRef: string;
  key: Buffer;
  listSessions(): Promise<PiSessionInfo[]>;
  readMetadata?(): MetadataSnapshot;
  readOwnership?(sessionRef: string): SessionOwnerProjection;
  readSessionOptions?(info: PiSessionInfo): SessionOptionProjection;
  limit?: number;
}): Promise<Catalog> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 200));
  try {
    const found = await options.listSessions();
    const metadata = options.readMetadata?.() ?? { state: "ready", revision: null, sessions: new Map(), reasonCode: null };
    const sessions = found.map((info) => {
      const sessionRef = sessionRefForPath(options.key, info.path);
      return row(options.key, info, metadata.sessions.get(sessionRef), metadata.reasonCode, options.readOwnership?.(sessionRef),
        options.readSessionOptions?.(info));
    }).sort((left, right) => Number(right.pinned) - Number(left.pinned)
      || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)).slice(0, limit);
    return {
      schemaVersion: 1,
      version: "piagent-session-catalog-v1",
      generatedAt: new Date().toISOString(),
      gatewayInstanceRef: options.gatewayInstanceRef,
      state: "ready",
      catalogRevision: revision(options.key, [metadata.revision, sessions.map((item) => [item.sessionRef, item.sessionRevision])]),
      sessions,
      page: {
        limit,
        returned: sessions.length,
        total: Math.min(1_000_000, found.length),
        nextCursor: found.length > sessions.length ? catalogRef(options.key, "cursor", sessions.at(-1)?.sessionRef ?? "empty") : null,
        truncated: found.length > sessions.length
      },
      reasonCode: null
    };
  } catch {
    return {
      schemaVersion: 1,
      version: "piagent-session-catalog-v1",
      generatedAt: new Date().toISOString(),
      gatewayInstanceRef: options.gatewayInstanceRef,
      state: "unavailable",
      catalogRevision: null,
      sessions: [],
      page: { limit, returned: 0, total: 0, nextCursor: null, truncated: false },
      reasonCode: "catalog-read-failed"
    };
  }
}
