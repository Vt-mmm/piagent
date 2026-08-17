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
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
  allMessagesText: string;
};

const DELEGATED_TASK_MARKERS = [
  "Task: You are a delegated subagent running from a fork of the parent session.",
  "Task: You are reviving a previous subagent conversation."
] as const;
const INTERNAL_HELPER_NAME = /^(?:subagent(?:-|$)|piagent-(?:planner|worker|scout|reviewer|oracle)(?:-|$))/i;

export function isUserConversationSession(info: PiSessionInfo): boolean {
  const segments = path.resolve(info.path).split(path.sep);
  const sessionsIndex = segments.lastIndexOf("sessions");
  if (sessionsIndex >= 0 && segments[sessionsIndex + 1] === "subagent") return false;
  const internalName = INTERNAL_HELPER_NAME.test(String(info.name ?? "").trim());
  const hasParent = typeof info.parentSessionPath === "string" && info.parentSessionPath.length > 0;
  const messages = typeof info.allMessagesText === "string" ? info.allMessagesText : "";
  const internalPrompt = DELEGATED_TASK_MARKERS.some((marker) => messages.includes(marker));
  // User-created forks also carry parentSessionPath, so lineage alone is not enough. A helper identity or the
  // runtime-only delegation prompt plus lineage is high-confidence internal evidence. Keep this classification
  // at the gateway boundary so catalog, read models, commands and live streams all fail closed together.
  return !((internalName && (hasParent || internalPrompt)) || (hasParent && internalPrompt));
}

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

const INTERNAL_FRESH_TRANSITION = /(?:^|\b)(?:\/fresh\s+(?:task|scout|be-to-fe)|(?:task|scout|be-to-fe):)\b[\s\S]{0,180}\bRead task intake from \.pi\/task-inbox\//i;

function atWordBoundary(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  const slice = value.slice(0, maximum + 1), boundary = slice.lastIndexOf(" ");
  return `${slice.slice(0, boundary >= Math.floor(maximum * .6) ? boundary : maximum).trim()}…`;
}

// Session titles are a local deterministic projection. Asking a model to name
// every chat would spend a turn and make opening the catalog non-deterministic.
// Runtime routing commands are control-plane text, so they must never become a
// title or preview merely because Pi records them as the first user entry.
export function projectedSessionTitle(info: Pick<PiSessionInfo, "name" | "firstMessage" | "cwd">): { title: string; preview: string } {
  const projectLabel = display(info.cwd ? path.basename(info.cwd) : "", 120, "Unknown project");
  const first = info.firstMessage === "(no messages)" ? "" : display(info.firstMessage, 500, "");
  const rawName = display(info.name, 500, ""), generatedName = /^pi:/i.test(rawName);
  const suppliedName = rawName.replace(/^pi:\s*/i, "");
  const normalizedName = suppliedName.toLowerCase();
  const genericName = !suppliedName || normalizedName === projectLabel.toLowerCase()
    || ["working", "pi agent platform", "new conversation"].includes(normalizedName);
  const source = generatedName ? suppliedName || first : genericName ? first || suppliedName : suppliedName;
  const internal = INTERNAL_FRESH_TRANSITION.test(source) || INTERNAL_FRESH_TRANSITION.test(first)
    || /\.pi\/task-inbox\//i.test(source);
  const cleaned = display(source, 500, "")
    .replace(/^\/(?:fresh\s+)?(?:task|scout|be-to-fe)\s+/i, "")
    .replace(/^(?:task|scout|be-to-fe):\s*/i, "")
    .replace(/^[-#*>\s]+/, "")
    // Keep underscores: the shared redactor deliberately emits
    // [REDACTED_SECRET], and title cleanup must not mutate that proof marker.
    .replace(/[`*~]+/g, "")
    .trim();
  const title = internal ? "Continued task" : atWordBoundary(cleaned || "New conversation", 72);
  const preview = INTERNAL_FRESH_TRANSITION.test(first) || /\.pi\/task-inbox\//i.test(first)
    ? "Continued in a fresh session" : atWordBoundary(first || title, 180);
  return { title, preview };
}

function revision(key: Buffer, value: unknown): string {
  return `rev_${createHmac("sha256", key).update(JSON.stringify(value)).digest("hex")}`;
}

function row(key: Buffer, info: PiSessionInfo, metadata: SessionMetadata | undefined, metadataReason: string | null,
  ownership?: SessionOwnerProjection, sessionOptions?: SessionOptionProjection): SessionRow {
  const projectLabel = display(info.cwd ? path.basename(info.cwd) : "", 120, "Unknown project");
  const projected = projectedSessionTitle(info);
  return {
    sessionRef: sessionRefForPath(key, info.path),
    projectRef: projectRefForCwd(key, info.cwd),
    title: projected.title,
    projectLabel,
    preview: projected.preview,
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
    const found = (await options.listSessions()).filter(isUserConversationSession);
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
