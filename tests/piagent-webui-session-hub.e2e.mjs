import { attachTerminalMentions } from "../packages/piagent-webui/gateway/terminal-mentions.ts";
import { PersonalTerminalSessions } from "../packages/piagent-webui/gateway/personal-terminal-sessions.ts";
import { sessionRefForPath } from "../packages/piagent-webui/gateway/session-catalog.ts";
let browserTerminals = null;
import { WorkspaceWriteController } from '../packages/piagent-webui/server/workspace-write-controller.ts';
import { writeWorkspaceFile } from '../packages/piagent-core/extensions/workspace-write.ts';
let workspaceWritable = false;
const workspaceControllers = new Map();
function workspaceController(sessionRef) {
  if (workspaceControllers.has(sessionRef)) return workspaceControllers.get(sessionRef);
  const journal = [];
  const controller = new WorkspaceWriteController({
    facts: () => ({ identity: { ...inspectionSnapshot.identity, sessionRef }, writable: workspaceWritable, agentRunning: workspaceWritable }),
    history: () => journal, append: receipt => journal.push(receipt),
    write: payload => ({ state: 'saved', ...writeWorkspaceFile(mentionProject, payload, { policy: {}, profile: {}, readOnly: !workspaceWritable }) })
  });
  workspaceControllers.set(sessionRef, controller); return controller;
}
import { personalWorkspaceReader } from "../packages/piagent-webui/server/workspace-reader.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { GatewayProtocolService } from "../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { SessionAttachmentRegistry } from "../packages/piagent-webui/gateway/session-attachment-registry.ts";
import { COMPANY_MODEL_REF } from "../packages/piagent-webui/gateway/company-relay.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { suggestPaths } from "../packages/piagent-webui/gateway/path-suggestions.ts";
import { listBranches, switchBranch } from "../packages/piagent-webui/gateway/git-branches.ts";
import { childRepositories, childRepositoryFolder } from "../packages/piagent-webui/gateway/git-repositories.ts";
import { listAgentCommands } from "../packages/piagent-core/runtime/resources/agent-resources.mjs";
import { WEBUI_WORKFLOW_OPTIONS } from "../packages/piagent-core/runtime/workflows/webui-workflow.ts";
import { DOCX_MIME, docx } from "./helpers/piagent-docx-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
let server, protocol;
let workspaceMention = "";
test.afterEach(() => { workspaceMention = ""; });
let persistedBrowserConversation = false;
let sessionCreateAttempts = 0, sessionCreateEffects = 0, createdSessionCounter = 0;
let sessionSendAttempts = 0, sessionSendEffects = 0;
let nextCreateUncertain = false, nextSendRejected = false, nextSendUnconfirmed = false;
let liveStateUnavailable = false, liveStateReadCount = 0;
let attachments, lastSendPayload = null, dispatchedContent = null, historyImage = false, sourceChangeReads = 0;
let lastCreatePayload = null;
let processTranscript = [];
// A long history served a page at a time, as the Gateway does: `before` is the
// index the page ends at, and each page holds `limit` turns.
let pagedHistory = null; const historyReads = [];
let companyState = "unavailable", companyConnects = 0, transcriptUnavailable = false, transcriptReads = 0;
const companyModel = { modelRef: COMPANY_MODEL_REF, provider: "agent_watch_managed", modelId: "agent-watch-auto",
  displayName: "agent-watch-auto", reasoning: true, imageInput: true, thinkingLevels: ["low", "medium", "high"] };
const observedSessionActions = [];
// Piagent's own update, as the Gateway reports it: 1.11.0 is out, Pi stays on
// the version it pins while a newer Pi is not qualified.
const freshUpdate = () => ({ schemaVersion: 1, version: "piagent-update-status-v1", installable: true, reason: null,
  checkedAt: new Date(Date.now() - 5 * 60_000).toISOString(), checking: false, checkEveryHours: 1,
  piagent: { installed: "1.10.0", latest: "1.11.0", updateAvailable: true },
  pi: { installed: "0.87.1", required: "0.87.1", latest: "1.0.2", updateAvailable: false, newerUntested: true },
  updateAvailable: true, runningConversations: 0, job: null });
// Other tests run on a machine that is up to date: the offer dialog would cover them.
const upToDate = () => ({ ...freshUpdate(), piagent: { installed: "1.11.0", latest: "1.11.0", updateAvailable: false }, updateAvailable: false });
let updateState = upToDate();
// The project of "Release preparation" is a real Git repository in the branch test.
let branchRepo = null, branchRunning = 0;
// The project of "Review source changes" is a folder holding two repositories in the multi-repository test.
let workspaceFolder = null;
// A second changed file, for the line review test.
let secondSourceFile = false;
const updateApplies = [];
// What an @ in a composer walks: a project (a git repository, so the search
// runs the same without fd) and a home folder with another project inside.
const mentionBase = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "piagent-mentions-")));
const mentionProject = path.join(mentionBase, "project"), mentionHome = path.join(mentionBase, "home");
for (const [file, text] of [["project/src/pricing.js", "export const vat = 0.1;\n"], ["project/src/cart.js", "export {};\n"],
  ["project/docs/notes.md", "# Notes\n"], ["home/Documents/old shop/notes.md", "# Old shop\n"], ["home/Documents/old shop/src/app.js", "\n"],
  ["home/.ssh/config", "Host *\n"], ["project/.claude/commands/review.md", "---\ndescription: Review the staged changes\nargument-hint: \"[focus]\"\n---\nReview $1.\n"],
  ["project/.claude/skills/deploy/SKILL.md", "---\nname: deploy\ndescription: Deploy the shop.\n---\nShip.\n"],
  ["home/.codex/skills/pdf/SKILL.md", "---\nname: pdf\ndescription: Read PDF files.\n---\n"], ["project/src/a-very-long-folder-name-for-the-checkout-and-payment-flow/Tài liệu đặc tả thanh toán phiên bản mới nhất.md", "x"]]) {
  fs.mkdirSync(path.dirname(path.join(mentionBase, file)), { recursive: true }); fs.writeFileSync(path.join(mentionBase, file), text);
}
execFileSync("git", ["init", "-q", mentionProject]); execFileSync("git", ["-C", mentionProject, "add", "-A"]);
const observedRuntimeActions = [];
const inspectionSnapshot = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/snapshot-v1.valid.json"), "utf8"));
// The Gateway publishes what the host will accept as an attachment, so the hub
// composer only offers a file picker when this is available. Text formats need
// no host tool, so the fixture claims exactly those.
inspectionSnapshot.capabilities.capabilities.attachments = { status: "available", version: 1, reason: null,
  kinds: ["file", "document"],
  mimeTypes: ["application/json", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/yaml", "text/csv", "text/markdown", "text/plain", "text/tab-separated-values"] };
Object.assign(inspectionSnapshot.capabilities.limits, { maxRequestBodyBytes: 11_250_000, maxAttachmentCount: 4,
  maxAttachmentFileBytes: 8_388_608, maxAttachmentTotalBytes: 16_777_216 });
inspectionSnapshot.activity.recent = [{
  activityRef: "activity_browser_read", kind: "tool", state: "passed", label: "read passed", preview: "src/example.ts",
  toolCallId: "tool_browser_read", toolName: "read", commandDigest: null, logRef: null, exitCode: null, exitCodeExact: false,
  startedAt: "2026-08-13T14:00:00.000Z", finishedAt: "2026-08-13T14:00:01.000Z"
}];
Object.assign(inspectionSnapshot.activity.page, { total: 1, returned: 1 });
const sourceFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/source-change-v1.valid.json"), "utf8"));
// A 2x2 PNG: the bytes behind the history message's image card.
const HISTORY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==";
const transcriptFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/transcript-v1.valid.json"), "utf8"));

function session(sessionRef, title, projectLabel, updatedAt, overrides = {}) {
  return {
    sessionRef, projectRef: `project_${sessionRef}`, title, projectLabel,
    preview: "A durable local conversation", createdAt: "2026-08-13T08:00:00.000Z", updatedAt,
    state: "offline", liveState: "offline", pinned: false, archived: false, unread: false,
    composerAvailable: true, needsAttention: false, modelLabel: null, thinkingLevel: "unknown",
    contextUsage: { usedTokens: null, contextWindow: null, ratio: null, state: "unknown" }, task: null,
    owner: { kind: "none", ownerEpoch: null, gatewayInstanceRef: null, runtimeInstanceRef: null, continuity: "unknown" },
    sessionRevision: `revision_${sessionRef}`, reasonCode: null, ...overrides
  };
}

const catalog = {
  schemaVersion: 1, version: "piagent-session-catalog-v1", generatedAt: "2026-08-14T05:00:00.000Z",
  gatewayInstanceRef: "gateway_browser_session_hub", state: "ready", catalogRevision: "revision_catalog_browser",
  sessions: [
    session("session_release_prep", "Release preparation", "pi-company-platform", "2026-08-14T04:59:00.000Z", { pinned: true }),
    session("session_source_review", "Review source changes", "sample-project", "2026-08-13T10:00:00.000Z"),
    session("session_archived", "Archived planning", "sample-project", "2026-08-12T10:00:00.000Z",
      { state: "archived", archived: true, composerAvailable: false })
  ],
  page: { limit: 200, returned: 3, total: 3, nextCursor: null, truncated: false }, reasonCode: null
};

test.beforeAll(async () => {
  execFileSync("npm", ["run", "build", "--workspace", "@piagent/webui"], { cwd: root, stdio: "pipe" });
  const capabilities = { schemaVersion: 1, version: "piagent-gateway-capabilities-v1", generatedAt: "2026-08-14T05:00:00.000Z",
    gatewayInstanceRef: catalog.gatewayInstanceRef, protocol: { minimum: 1, maximum: 1, selected: 1, compatibility: "ready" }, mode: "full",
    capabilities: { catalog: { status: "available", version: 1, reasonCode: null }, events: { status: "available", version: 1, reasonCode: null },
      terminalAdapter: { status: "unavailable", version: null, reasonCode: "not-enabled" },
      sessionRuntime: { status: "available", version: 1, reasonCode: null }, sessionActions: Object.fromEntries(
        ["create", "send", "abort", "setModel", "setThinking", "setPermission", "rename", "pin", "archive", "unarchive", "fork", "acquire", "release"].map((name) =>
          [name, { status: "available", version: 1, reasonCode: null }])) }, reasonCode: null };
  const command = { async execute(value) {
    observedSessionActions.push(value.action);
    if (value.action === "session.create") sessionCreateAttempts += 1;
    if (value.action === "session.create") lastCreatePayload = structuredClone(value.payload);
    const currentRow = value.sessionRef ? catalog.sessions.find((item) => item.sessionRef === value.sessionRef) : null;
    if (value.action === "session.send") {
      sessionSendAttempts += 1;
      lastSendPayload = structuredClone(value.payload);
      if (nextSendRejected) {
        nextSendRejected = false;
        return { schemaVersion: 1, version: "piagent-session-receipt-v1", messageType: "receipt", commandId: value.commandId,
          idempotencyKeyDigest: `sha256:${"a".repeat(64)}`, action: value.action, phase: "rejected", resultCode: "unavailable",
          requestedAt: value.requestedAt, settledAt: new Date().toISOString(), sessionRef: value.sessionRef, operationRef: null,
          catalogRevisionAfter: catalog.catalogRevision, sessionRevisionAfter: currentRow?.sessionRevision ?? null, deduplicated: false,
          evidenceRef: null, error: { code: "fixture-send-rejected", message: "The session command was rejected." } };
      }
      if (nextSendUnconfirmed) {
        nextSendUnconfirmed = false;
        return { schemaVersion: 1, version: "piagent-session-receipt-v1", messageType: "receipt", commandId: value.commandId,
          idempotencyKeyDigest: `sha256:${"a".repeat(64)}`, action: value.action, phase: "uncertain", resultCode: "effect-unknown",
          requestedAt: value.requestedAt, settledAt: new Date().toISOString(), sessionRef: value.sessionRef, operationRef: null,
          catalogRevisionAfter: catalog.catalogRevision, sessionRevisionAfter: currentRow?.sessionRevision ?? null, deduplicated: false,
          evidenceRef: null, error: { code: "session-command-effect-unknown",
            message: "The command effect cannot be proven. It will not be replayed automatically." } };
      }
      // Claim exactly as the runtime supervisor does, so what the assertions see
      // is what a real session would have been prompted with.
      const preparedMessage = attachTerminalMentions(value.sessionRef, value.payload.message, browserTerminals);
      dispatchedContent = value.payload.attachmentRefs?.length
        ? (await attachments.claim(value.sessionRef, value.payload.attachmentRefs, value.payload.messageRequestId, preparedMessage)).content
        : browserTerminals ? [{ type: "text", text: preparedMessage }] : null;
    }
    const stale = value.expectedCatalogRevision !== catalog.catalogRevision || (value.action === "session.create"
      ? value.expectedSessionRevision !== null : !currentRow || value.expectedSessionRevision !== currentRow.sessionRevision);
    if (stale) return { schemaVersion: 1, version: "piagent-session-receipt-v1", messageType: "receipt", commandId: value.commandId,
      idempotencyKeyDigest: `sha256:${"a".repeat(64)}`, action: value.action, phase: "rejected", resultCode: "stale-revision",
      requestedAt: value.requestedAt, settledAt: new Date().toISOString(), sessionRef: value.sessionRef, operationRef: null,
      catalogRevisionAfter: catalog.catalogRevision, sessionRevisionAfter: currentRow?.sessionRevision ?? null, deduplicated: false,
      evidenceRef: null, error: { code: "session-revision-stale", message: "The session command was rejected." } };
    let targetSessionRef = value.sessionRef, targetSessionRevision = currentRow?.sessionRevision ?? null;
    const deferredCreate = value.action === "session.create" && value.payload.deferInitialMessage === true;
    const operationRef = value.action === "session.send" ? "operation_browser_send_01"
      : value.action === "session.create" && !deferredCreate ? `operation_browser_create_${createdSessionCounter + 1}` : null;
    if (value.action === "session.create") {
      createdSessionCounter += 1; sessionCreateEffects += 1;
      targetSessionRef = `session_browser_created_${createdSessionCounter}`;
      const created = session(targetSessionRef, "Browser retry session", "pi-company-platform", new Date().toISOString(), {
        projectRef: value.payload.projectRef, state: "active", liveState: deferredCreate ? "idle" : "running"
      });
      targetSessionRevision = created.sessionRevision; catalog.sessions.unshift(created);
      catalog.page.returned = catalog.sessions.length; catalog.page.total = catalog.sessions.length;
      catalog.catalogRevision = `revision_catalog_created_${createdSessionCounter}`;
      if (!deferredCreate) {
        const messageRef = `message_browser_create_${createdSessionCounter}`;
        protocol.events.publish("message.completed", { sessionRef: targetSessionRef, operationRef,
          messageRef, sessionRevision: targetSessionRevision, truncated: false });
        protocol.events.publish("operation.settled", { sessionRef: targetSessionRef, operationRef, messageRef,
          sessionRevision: targetSessionRevision, settlement: "completed", reasonCode: null });
      }
    }
    if (value.action === "session.send") {
      sessionSendEffects += 1;
      const messageRef = "message_browser_send_01";
      protocol.events.publish("runtime.changed", { sessionRef: value.sessionRef, sessionRevision: value.expectedSessionRevision,
        liveState: "running", operationRef, reasonCode: null });
      protocol.events.publish("tool.started", { sessionRef: value.sessionRef, operationRef,
        toolCallRef: "tool_browser_read_01", toolLabel: "read_file", fileLabel: "use-auth-refresh.ts",
        isError: null, reasonCode: null });
      await new Promise((resolve) => setTimeout(resolve, 700));
      protocol.events.publish("tool.completed", { sessionRef: value.sessionRef, operationRef,
        toolCallRef: "tool_browser_read_01", toolLabel: "read_file", fileLabel: "use-auth-refresh.ts",
        isError: false, reasonCode: null });
      protocol.events.publish("message.delta", { sessionRef: value.sessionRef, operationRef, messageRef, messageSequence: 0,
        delta: "A streamed Gateway reply." });
      protocol.events.publish("message.completed", { sessionRef: value.sessionRef, operationRef, messageRef,
        sessionRevision: value.expectedSessionRevision, truncated: false });
      protocol.events.publish("operation.settled", { sessionRef: value.sessionRef, operationRef, messageRef,
        sessionRevision: value.expectedSessionRevision, settlement: "completed", reasonCode: null });
      persistedBrowserConversation = true;
    }
    if (value.action === "session.create" && nextCreateUncertain) {
      nextCreateUncertain = false;
      return { schemaVersion: 1, version: "piagent-session-receipt-v1", messageType: "receipt", commandId: value.commandId,
        idempotencyKeyDigest: `sha256:${"a".repeat(64)}`, action: value.action, phase: "uncertain", resultCode: "effect-unknown",
        requestedAt: value.requestedAt, settledAt: new Date().toISOString(), sessionRef: targetSessionRef, operationRef: null,
        catalogRevisionAfter: catalog.catalogRevision, sessionRevisionAfter: targetSessionRevision, deduplicated: false,
        evidenceRef: null, error: { code: "session-command-effect-unknown",
          message: "The command effect cannot be proven. It will not be replayed automatically." } };
    }
    const resultCode = value.action === "session.rename" ? "renamed" : value.action === "session.pin"
      ? value.payload.pinned ? "pinned" : "unpinned" : value.action === "session.archive" ? "archived"
        : value.action === "session.unarchive" ? "unarchived" : value.action === "session.fork" ? "forked"
          : deferredCreate ? "created" : "started";
    return { schemaVersion: 1, version: "piagent-session-receipt-v1", messageType: "receipt", commandId: value.commandId,
      idempotencyKeyDigest: `sha256:${"a".repeat(64)}`, action: value.action, phase: "settled", resultCode,
      requestedAt: value.requestedAt, settledAt: new Date().toISOString(), sessionRef: targetSessionRef, operationRef,
      catalogRevisionAfter: catalog.catalogRevision, sessionRevisionAfter: targetSessionRevision, deduplicated: false,
      evidenceRef: "evidence_browser_send_01", error: null };
  } };
  protocol = new GatewayProtocolService({ capabilities: () => capabilities, catalog: async () => catalog, command,
    terminals: { state: ref => browserTerminals.state(ref), execute: command => browserTerminals.execute(command) },
    terminalEvents: { subscribe: (ref, listener) => browserTerminals.subscribe(ref, listener), replay: ref => browserTerminals.replay(ref) } });
  // The real registry, so staging exercises the same extraction and the same
  // identity and revision checks the Gateway applies in production.
  attachments = new SessionAttachmentRegistry({ inspect: async () => inspectionSnapshot });
  const inspectionProvider = {
    workspace: personalWorkspaceReader({ cwd: mentionProject, packageRoot: root, identity: () => inspectionSnapshot.identity }),
    snapshot: () => inspectionSnapshot,
    sourceChanges: (view) => (sourceChangeReads += 1, { ...sourceFixture, view, bases: view === "task"
      ? { taskBaselineDigest: "sha256:" + "a".repeat(64), headOid: null, indexDigest: null, workingTreeDigest: null }
      : sourceFixture.bases, ...(secondSourceFile ? { files: [...sourceFixture.files, { ...sourceFixture.files[0], fileRef: "file_02", path: "api/refund.go" }] } : {}) }),
    diff: (_view, fileRef) => {
      const value = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/diff-v1.valid.json"), "utf8"));
      if (fileRef !== "file_02") return value;
      const added = value.hunks[0].lines[1];
      return { ...value, file: { ...value.file, fileRef: "file_02", path: "api/refund.go" }, hunks: [{ ...value.hunks[0], lines: [
        { ...added, lineRef: "line_02_1", newLineNumber: 1, text: "func refund(c int64) {" },
        { ...added, lineRef: "line_02_2", newLineNumber: 2, text: "\tamount := float64(c) / 100" }] }] };
    },
    review: () => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/review-state-v1.valid.json"), "utf8")),
    sourceMutation: () => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/source-mutation-v1.valid.json"), "utf8")),
    sourceRevert: () => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/source-revert-v1.valid.json"), "utf8")),
    commitSummary: () => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/commit-summary-v1.valid.json"), "utf8")),
    documents: () => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/document-workspace-v1.valid.json"), "utf8")),
    document: (documentRef) => ({ schemaVersion: 1, version: "piagent-webui-document-workspace-v1", messageType: "document",
      generatedAt: "2026-08-17T09:00:00.000Z", documentRef, state: "ready", name: "ke-hoach.md",
      relativePath: "tai-lieu/ke-hoach.md", rootRef: "document-root_01", format: "text",
      text: "# Ke hoach quy ba\n\nMuc tieu la **tang truong**.\n", sizeBytes: 4096,
      truncated: false, redacted: false, reasonCode: null }),
    activity: () => inspectionSnapshot.activity,
    transcriptImage: (messageRef, index) => messageRef === "message_history_user" && index === 0
      ? { messageRef, index, state: "available", mimeType: "image/png", dataBase64: HISTORY_PNG } : Promise.reject(new Error("missing")),
    transcript: (before, limit) => pagedHistory ? historyPage(before, limit) : (transcriptReads += 1, transcriptUnavailable) ? Promise.reject(new Error("company-gateway-stopped")) : ({ ...transcriptFixture, items: [
      { ...transcriptFixture.items[0], messageRef: "message_history_user", content: { ...transcriptFixture.items[0].content,
        text: "Open the persisted release checklist" + workspaceMention, textChars: 36 + workspaceMention.length },
        ...(historyImage ? { attachments: [{ displayName: "Image", kind: "image", mimeType: "image/png", truncated: false }] } : {}) },
      { ...transcriptFixture.items[0], messageRef: "message_history_assistant", parentMessageRef: "message_history_user", role: "assistant",
        recordedAt: "2026-08-13T14:00:00.000Z", content: { ...transcriptFixture.items[0].content,
          text: "## Implementation result\n\n**Status:** ready.\n\nThe durable transcript is available.\n\n- Session isolation\n- Formatted output\n\n| Gate | State |\n| --- | --- |\n| Chromium | Pass |\n\n![remote preview](https://example.invalid/track.png) [unsafe](javascript:alert(1))",
          textChars: 258 },
        toolCalls: [] },
      { ...transcriptFixture.items[0], messageRef: "message_history_tool", parentMessageRef: "message_history_assistant", role: "tool-result",
        recordedAt: "2026-08-13T14:00:01.000Z", content: { ...transcriptFixture.items[0].content, state: "unavailable", text: null,
          textChars: null, digest: null, reasonCode: "tool-output-in-activity-preview" }, toolCalls: [] },
      { ...transcriptFixture.items[0], messageRef: "message_history_auth_error", parentMessageRef: "message_history_user", role: "assistant",
        recordedAt: "2026-08-13T14:00:02.000Z", content: { ...transcriptFixture.items[0].content, state: "unavailable", text: null,
          textChars: null, digest: null, truncated: false, redacted: false, imageCount: 0, reasonCode: "provider-auth-expired" }, toolCalls: [] }
    ].concat(persistedBrowserConversation ? [
      { ...transcriptFixture.items[0], messageRef: "message_browser_user", role: "user", agentOperationId: "operation_browser_send_01",
        recordedAt: "2026-08-14T05:00:00.000Z",
        content: { ...transcriptFixture.items[0].content, text: "Continue from the browser", textChars: 25 }, toolCalls: [] },
      { ...transcriptFixture.items[0], messageRef: "message_browser_assistant", parentMessageRef: "message_browser_user", role: "assistant",
        agentOperationId: "operation_browser_send_01",
        recordedAt: "2026-08-14T05:00:01.000Z", content: { ...transcriptFixture.items[0].content,
          text: "A streamed Gateway reply.", textChars: 25 }, toolCalls: [] }
    ] : []).concat(processTranscript) }),
    logPreview: () => ({ state: "unavailable", preview: null, truncated: false, reasonCode: "no-log" })
  };
  // Every test opens fresh pages from one address; the suite outgrows the
  // 120 requests a minute a page may make before it signs in.
  server = await startLoopbackServer({ anonymousRequestsPerMinute: 1_000,
    workspaceWrite: { state: ref => workspaceController(ref).state(), execute: (ref, command) => workspaceController(ref).execute(command) },
    staticRoot: process.env.PIAGENT_WEBUI_STATIC_ROOT ?? path.join(root, "packages/piagent-webui/dist/client"), mode: "gateway",
    readCapabilities: () => capabilities, readSessionCatalog: () => catalog,
    readSessionLiveState: () => {
      liveStateReadCount += 1;
      if (liveStateUnavailable) throw new Error("fixture-session-live-state-unavailable");
      return { schemaVersion: 1, version: "piagent-session-live-state-v1", generatedAt: new Date().toISOString(),
        gatewayInstanceRef: catalog.gatewayInstanceRef, eventSequence: protocol.events.stateVersion, state: "ready",
        operations: [], settlements: protocol.events.recentOperationSettlements(), reasonCode: null };
    },
    gatewayProtocol: protocol,
    readSessionCreationOptions: () => ({ schemaVersion: 1, version: "piagent-session-creation-options-v1",
      generatedAt: new Date().toISOString(), projects: [{ projectRef: "project_session_release_prep",
        placeRef: "project_session_release_prep", label: "pi-company-platform" }],
      models: [...(companyState === "ready" ? [companyModel] : []), { modelRef: "model_openai_codex_sol", provider: "openai-codex", modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol", reasoning: true, imageInput: true, thinkingLevels: ["off", "medium", "high", "xhigh"] },
      { modelRef: "model_fixture_reasoning", provider: "fixture", modelId: "reasoning",
        displayName: "Fixture Reasoning", reasoning: true, imageInput: true, thinkingLevels: ["off", "medium", "high"] }],
      defaultModelRef: "model_openai_codex_sol", defaultThinkingLevel: "high",
      profiles: [{ id: "node-typescript", displayName: "Node TypeScript Project", permissionMode: "workspace-write" }],
      workflows: WEBUI_WORKFLOW_OPTIONS,
      webSearch: { state: "configured", route: "codex-first", provider: "openai-codex", fallbackProvider: "exa",
        integration: { name: "pi-web-access", version: "0.17.0" }, reasonCode: null },
      projectImport: { status: "available", reasonCode: null }, reasonCode: null }),
    readCompanyStatus: () => ({ schemaVersion: 1, version: "piagent-company-status-v1", model: "agent-watch-auto", available: true, state: companyState,
      reasonCode: companyState === "ready" ? null : "managed-keychain-approval-required" }),
    executeCompanyConnect: () => { companyConnects += 1; companyState = "ready";
      return { schemaVersion: 1, version: "piagent-company-status-v1", model: "agent-watch-auto", available: true, state: "ready", reasonCode: null }; },
    executeProjectImport: () => ({ schemaVersion: 1, version: "piagent-project-import-result-v1", importedAt: new Date().toISOString(),
      project: { projectRef: "project_imported_browser", placeRef: "project_imported_browser", label: "imported-project" } }),
    readSessionModel: () => inspectionProvider,
    suggestPaths: (_projectRef, query) => suggestPaths({ root: mentionProject, query, home: mentionHome, fd: null }),
    listCommands: () => ({ commands: listAgentCommands({ cwd: mentionProject, home: mentionHome }) }),
    listBranches: async (projectRef, repository) => {
      if (workspaceFolder && projectRef === "project_session_source_review") {
        if (repository === null) return { repository: false, running: 0, repositories: await Promise.all(childRepositories(workspaceFolder).map(async (child) =>
          ({ name: child.name, head: child.head, changedFiles: (await listBranches(path.join(workspaceFolder, child.name)))?.changedFiles ?? 0 }))) };
        const folder = childRepositoryFolder(workspaceFolder, repository);
        if (!folder) throw new Error("not-a-git-repository");
        return { ...(await listBranches(folder)), running: 0, name: repository };
      }
      if (!branchRepo || projectRef !== "project_session_release_prep") return null;
      const list = await listBranches(branchRepo);
      return list ? { ...list, running: branchRunning } : { repository: false, running: branchRunning };
    },
    switchBranch: async (projectRef, request) => {
      if (workspaceFolder && projectRef === "project_session_source_review") {
        const folder = childRepositoryFolder(workspaceFolder, request.repository);
        if (!folder) throw new Error("not-a-git-repository");
        const head = await switchBranch(folder, request);
        const row = catalog.sessions.find((item) => item.sessionRef === "session_source_review");
        row.gitRepositories = childRepositories(workspaceFolder).map((child) => ({ name: child.name, branch: child.head }));
        row.sessionRevision = `revision_source_review_${request.repository}_${head.name}`; catalog.catalogRevision = `revision_catalog_ws_${head.name}`;
        return { head };
      }
      if (!branchRepo || projectRef !== "project_session_release_prep") return null;
      if (branchRunning > 0) throw new Error("branch-switch-blocked-running");
      const head = await switchBranch(branchRepo, request);
      const row = catalog.sessions.find((item) => item.sessionRef === "session_release_prep");
      row.gitBranch = head; row.sessionRevision = `revision_release_prep_${head.name}`;
      catalog.catalogRevision = `revision_catalog_branch_${head.name}`;
      return { head };
    },
    updates: { status: () => updateState, check: () => ({ ...updateState, checkedAt: new Date().toISOString() }),
      apply: (request) => {
        updateApplies.push(request);
        if (request?.version !== updateState.piagent.latest) throw new Error("update-version-changed");
        updateState = { ...updateState, job: { state: "running", from: "1.10.0", to: "1.11.0", startedAt: new Date().toISOString() } };
        return { job: updateState.job };
      } },
    executeSessionAttachment: (sessionRef, value) => attachments.execute(sessionRef, value),
    readSessionConnections: (sessionRef) => ({ schemaVersion: 1, version: "piagent-session-connections-v1",
      generatedAt: new Date().toISOString(), sessionRef, state: "ready", summary: { configured: 1, connected: null, approvalRequired: 0 },
      connections: [{ connectionRef: "mcp_context7", name: "context7", kind: "mcp", scope: "global", origin: "global",
        transport: "stdio", state: "configured", requiresApproval: false, oauthSupported: false, authState: "unavailable",
        toggleSupported: true }], truncated: false, reasonCode: null }),
    readProviderAuthCatalog: () => ({ schemaVersion: 1, version: "piagent-provider-auth-catalog-v1", generatedAt: new Date().toISOString(),
      state: "ready", providers: [{ providerRef: "provider.openai", name: "OpenAI Codex", method: "oauth", state: "connected" },
        { providerRef: "provider.github", name: "GitHub Copilot", method: "oauth", state: "not-connected" }], reasonCode: null }),
    readProviderAuthJob: () => { throw new Error("not-found"); },
    executeProviderAuth: (command) => ({ schemaVersion: 1, version: "piagent-provider-auth-job-v1", generatedAt: new Date().toISOString(),
      jobRef: "authjob.browser", providerRef: command.providerRef, providerName: "GitHub Copilot", startedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), state: "completed", events: [], prompt: null, reasonCode: null }),
    executeRuntimeCommand: (command) => {
      observedRuntimeActions.push(command.action);
      return { schemaVersion: 1, version: "piagent-runtime-receipt-v1", messageType: "receipt", requestId: command.requestId,
        sessionRef: command.sessionRef, action: command.action, state: "settled", resultCode: "completed", effect: "read-only",
        modelCallObserved: false, outputs: [{ customType: "piagent-status", content: "runtime: ready\nprofile: node-typescript",
          truncated: false, redacted: false }], sessionRevisionAfter: command.expectedSessionRevision, reasonCode: null };
    }
  });
});

test.afterAll(async () => { await server?.close(); attachments?.close(); fs.rmSync(mentionBase, { recursive: true, force: true }); });

test("waits for canonical live state on bootstrap and after a replay gap", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    window.__piagentTestSockets = [];
    window.__piagentTestFrames = [];
    window.__piagentTestReceived = [];
    window.__piagentTestCloses = [];
    window.__piagentTestCloseCalls = [];
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args); window.__piagentTestSockets.push(this);
        this.addEventListener("message", (event) => window.__piagentTestReceived.push(String(event.data)));
        this.addEventListener("close", (event) => window.__piagentTestCloses.push({ code: event.code, reason: event.reason }));
      }
      send(value) { window.__piagentTestFrames.push(String(value)); return super.send(value); }
      close(code, reason) { window.__piagentTestCloseCalls.push({ code, reason }); return super.close(code, reason); }
    };
  });
  const bootstrapReadsBefore = liveStateReadCount; liveStateUnavailable = true;
  try {
    await page.goto(server.issueLaunchUrl());
    await expect.poll(() => liveStateReadCount - bootstrapReadsBefore).toBeGreaterThanOrEqual(1);
    await expect(page.getByText("Gateway live", { exact: true })).toHaveCount(0);
    await expect(page.getByText("reconnecting", { exact: true })).toBeVisible();
    liveStateUnavailable = false;
    await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
    expect(liveStateReadCount - bootstrapReadsBefore).toBeGreaterThanOrEqual(2);

    const resyncReadsBefore = liveStateReadCount; liveStateUnavailable = true;
    await page.evaluate(() => new Promise((resolve) => {
      const socket = window.__piagentTestSockets.at(-1);
      socket.addEventListener("close", resolve, { once: true }); socket.close(1000, "fixture-replay-gap");
    }));
    await expect(page.getByText("reconnecting", { exact: true })).toBeVisible();
    for (let index = 0; index < 1_002; index += 1) {
      protocol.events.publish("catalog.changed", { catalogRevision: `revision_gap_${index}` });
    }
    await expect.poll(() => page.evaluate(() => window.__piagentTestSockets.length)).toBeGreaterThanOrEqual(2);
    const connectFrames = await page.evaluate(() => window.__piagentTestFrames.map((value) => JSON.parse(value))
      .filter((value) => value.messageType === "connect"));
    assert.equal(connectFrames.length >= 2, true);
    assert.equal(connectFrames.at(-1).lastEventSequence, 0);
    await expect.poll(() => page.evaluate(() => window.__piagentTestReceived.map((value) => JSON.parse(value))
      .some((value) => value.kind === "resync.required"))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__piagentTestCloseCalls
      .some((value) => value.reason === "canonical-resync-required"))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__piagentTestCloses.length)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => liveStateReadCount - resyncReadsBefore).toBeGreaterThanOrEqual(1);
    await expect(page.getByText("Gateway live", { exact: true })).toHaveCount(0);
    await expect(page.getByText("reconnecting", { exact: true })).toBeVisible();
    liveStateUnavailable = false;
    await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  } finally { liveStateUnavailable = false; }
});

test("keeps session B authoritative when a delayed session A snapshot resolves last", async ({ page }) => {
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      if (!url.pathname.endsWith("/inspection/snapshot") || !init?.signal) return nativeFetch(input, init);
      const { signal: _signal, ...withoutSignal } = init;
      return nativeFetch(input, withoutSignal);
    };
  });
  const boundSnapshot = (sessionRef, suffix, percent, sourceFiles, permission) => {
    const value = structuredClone(inspectionSnapshot);
    value.identity = { ...value.identity, projectRef: `project_${sessionRef}`, runtimeInstanceId: `runtime_${suffix}`, sessionRef };
    value.session.displayName = `Inspection ${suffix}`;
    value.session.permissionProfile = { state: "known", value: permission, evidence: "observed", reasonCode: null };
    value.session.context = { ...value.session.context, tokens: percent * 1_000, contextWindow: 100_000, percent };
    value.usage.context = { ...value.usage.context, tokens: percent * 1_000, contextWindow: 100_000, percent };
    value.revision.runtimeRevision = `runtime_rev_${suffix}`;
    value.revision.workspaceRevision = `workspace_rev_${suffix}`;
    value.revision.indexRevision = `index_rev_${suffix}`;
    value.sourceChanges.workingTree.revision = value.revision.workspaceRevision;
    value.sourceChanges.staged.revision = value.revision.indexRevision;
    Object.assign(value.sourceChanges.workingTree.counts, { files: sourceFiles, added: 0, modified: sourceFiles,
      deleted: 0, renamed: 0, untracked: 0, conflicted: 0, additions: sourceFiles, deletions: 0 });
    return value;
  };
  const snapshotA = boundSnapshot("session_release_prep", "A", 11, 11, "trusted-full-access");
  const snapshotB = boundSnapshot("session_source_review", "B", 22, 22, "read-only");
  const sourceB = (view) => {
    const value = structuredClone(sourceFixture);
    value.identity = structuredClone(snapshotB.identity); value.view = view;
    if (view === "task") {
      value.viewRevision = "task_unavailable_B"; value.files = [];
      value.page = { ...value.page, total: 0, returned: 0 };
      value.availability = { state: "unavailable", reasonCode: "no-active-task", message: "No active task baseline exists." };
      value.bases = { taskBaselineDigest: `sha256:${"a".repeat(64)}`, headOid: null, indexDigest: null, workingTreeDigest: null };
      return value;
    }
    value.viewRevision = view === "working-tree" ? snapshotB.revision.workspaceRevision : snapshotB.revision.indexRevision;
    value.files[0] = { ...value.files[0], fileRef: "file_session_B", fileRevision: "file_rev_session_B",
      path: "src/b-session-only.ts" };
    return value;
  };
  let signalAStarted, releaseA, signalAReleased;
  const aStarted = new Promise((resolve) => { signalAStarted = resolve; });
  const aRelease = new Promise((resolve) => { releaseA = resolve; });
  const aReleased = new Promise((resolve) => { signalAReleased = resolve; });
  const snapshotRoute = async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.includes("/sessions/session_release_prep/")) {
      signalAStarted(); await aRelease;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshotA) });
      signalAReleased(); return;
    }
    if (pathname.includes("/sessions/session_source_review/")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(snapshotB) }); return;
    }
    await route.continue();
  };
  const sourceRoute = async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes("/sessions/session_source_review/")) return route.continue();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(sourceB(url.searchParams.get("view"))) });
  };
  const isSnapshotRoute = (url) => url.pathname.endsWith("/inspection/snapshot");
  const isSourceRoute = (url) => url.pathname.endsWith("/inspection/source-changes");
  await page.route(isSnapshotRoute, snapshotRoute);
  await page.route(isSourceRoute, sourceRoute);
  try {
    await page.goto(server.issueLaunchUrl()); await aStarted;
    await page.getByText("Review source changes", { exact: true }).filter({ visible: true }).click();
    await expect(page.getByRole("heading", { name: "Review source changes" })).toBeVisible();
    await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
    await expect(page.getByRole("button", { name: "Context · 22%" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Source Changes · 22" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Đổi quyền truy cập" })).toContainText("Chỉ đọc");
    await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
    await page.getByRole("tab", { name: /Toàn bộ working tree/ }).click();
    await expect(page.getByRole("button", { name: /b-session-only\.ts/ })).toBeVisible();
    await page.getByRole("button", { name: "Đóng Inspector" }).click();

    releaseA(); await aReleased; await page.waitForTimeout(150);
    await expect(page.getByRole("heading", { name: "Review source changes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Release preparation" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Context · 22%" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Context · 11%" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Source Changes · 22" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Source Changes · 11" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Đổi quyền truy cập" })).toContainText("Chỉ đọc");
    await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
    await page.getByRole("tab", { name: /Toàn bộ working tree/ }).click();
    await expect(page.getByRole("button", { name: /b-session-only\.ts/ })).toBeVisible();
  } finally {
    releaseA?.();
    await page.unroute(isSnapshotRoute, snapshotRoute);
    await page.unroute(isSourceRoute, sourceRoute);
  }
});

test("renders the session-first hub, compact New chat, popovers, modal Settings, and a split Agent Inspector", async ({ page }) => {
  persistedBrowserConversation = false;
  observedSessionActions.length = 0;
  const errors = [], nativeDialogs = []; page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", async (dialog) => { nativeDialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
  await expect(page.getByText("Open the persisted release checklist", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Implementation result" })).toBeVisible();
  await expect(page.getByText("The durable transcript is available.", { exact: true })).toBeVisible();
  await expect(page.getByText("Session isolation", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pass" })).toBeVisible();
  await expect(page.locator('img[alt="remote preview"]')).toHaveCount(0);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.getByText("Phiên đăng nhập model đã hết hạn. Mở Cài đặt → Nhà cung cấp & model để kết nối lại.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Đã đọc file/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: /pi-company-platform/ }).click();
  await page.getByRole("menuitem", { name: "Thêm một hoặc nhiều folder" }).click();
  await expect(page.getByRole("main").getByRole("button", { name: /imported-project/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Model: GPT-5.6 Sol" })).toContainText("GPT-5.6 Sol · mặc định");
  await page.getByRole("button", { name: "Model: GPT-5.6 Sol" }).click();
  await page.getByRole("menuitem", { name: /Fixture Reasoning/ }).click();
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  await page.getByRole("button", { name: "Cao" }).click();
  await page.getByRole("menuitem", { name: "Trung bình" }).click();
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Start a durable WebUI session");
  await expect(page.getByRole("button", { name: "Gửi" })).toBeEnabled();
  await page.getByRole("button", { name: "Quay lại" }).click();
  await expect(page.getByPlaceholder("Tìm cuộc trò chuyện").filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("navigation").getByText("pi-company-platform", { exact: true })).toBeVisible();
  await page.getByText("Review source changes", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { name: "Review source changes" })).toBeVisible();
  const options = page.getByRole("button", { name: "Tùy chọn cuộc trò chuyện" });
  await options.nth(1).click(); await page.getByRole("menuitem", { name: "Đổi tên" }).click();
  await expect(page.getByRole("dialog").getByText("Đổi tên cuộc trò chuyện", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByLabel("Tên").fill("Renamed in browser");
  await page.getByRole("dialog").getByRole("button", { name: "Xác nhận" }).click();
  await expect.poll(() => observedSessionActions.includes("session.rename")).toBe(true);
  await options.nth(1).click(); await page.getByRole("menuitem", { name: "Ghim" }).click();
  await expect.poll(() => observedSessionActions.includes("session.pin")).toBe(true);
  await options.nth(1).click(); await page.getByRole("menuitem", { name: "Tạo nhánh" }).click();
  await expect(page.getByRole("dialog").getByText("Tạo nhánh cuộc trò chuyện", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Xác nhận" }).click();
  await expect.poll(() => observedSessionActions.includes("session.fork")).toBe(true);
  await options.nth(1).click(); await page.getByRole("menuitem", { name: "Lưu trữ" }).click();
  await expect(page.getByRole("dialog").getByText("Lưu trữ cuộc trò chuyện", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Xác nhận" }).click();
  await expect.poll(() => observedSessionActions.includes("session.archive")).toBe(true);
  await page.getByRole("button", { name: "Đổi quyền truy cập" }).click();
  await page.getByRole("button", { name: "Ghi trong project" }).click();
  await page.getByRole("button", { name: "Toàn quyền" }).click();
  await expect(page.getByRole("dialog").getByText("Bật toàn quyền?", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Bật toàn quyền" })).toBeVisible();
  // The safe choice holds focus. This dialog only ever asks whether to grant
  // full access, so a reflex Enter must dismiss it rather than grant it.
  await expect(page.getByRole("dialog").getByRole("button", { name: "Hủy" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toBeHidden();
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  await page.getByRole("button", { name: "MCP & kết nối · 1" }).click();
  await expect(page.getByText("context7", { exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Tắt context7" })).toBeChecked();
  await page.keyboard.press("Escape");
  // The session catalog intentionally has no usage totals. The composer must
  // use the canonical inspection snapshot instead of showing empty metrics.
  await page.getByRole("button", { name: "Context · 1%" }).click();
  await expect(page.getByText("1.000", { exact: true })).toBeVisible();
  await expect(page.getByText("200.000", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Source Changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Mở Source Changes" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Workflows are retired: messages are freeform (no workflow picker).
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Continue from the browser");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.locator("p").filter({ hasText: /^Continue from the browser$/ })).toBeVisible();
  await expect(page.getByText("Piagent đang đọc mã nguồn…", { exact: true })).toBeVisible();
  await expect(page.getByText(/use-auth-refresh\.ts · (Tiến trình vừa cập nhật|Cập nhật \d+ giây trước)/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Đang đọc file/ })).toHaveCount(0);
  await expect(page.getByText("A streamed Gateway reply.", { exact: true })).toBeVisible();
  await page.waitForTimeout(250);
  await expect(page.getByText("A streamed Gateway reply.", { exact: true })).toHaveCount(1);
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Start a different piece of work in this session");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.locator("p").filter({ hasText: /^Start a different piece of work in this session$/ })).toBeVisible();
  await expect.poll(() => lastSendPayload?.message).toBe("Start a different piece of work in this session");
  assert.equal(Object.hasOwn(lastSendPayload, "workflow"), false);
  await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
  await expect(page.getByText("Agent Inspector", { exact: true })).toBeVisible();
  await expect(page.getByText("Open the persisted release checklist", { exact: true })).toBeVisible();
  // Below the xl split-layout breakpoint, Inspector is modal so the
  // conversation and header never collapse underneath it.
  await expect(page.locator(".MuiBackdrop-root")).toHaveCount(1);
  await page.getByRole("tab", { name: /Task/ }).click();
  await expect(page.getByText("Model", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Verifier, usage và handoff", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /Source Changes/ }).click();
  await expect(page.getByRole("tab", { name: /Toàn bộ working tree/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Đã chuẩn bị commit/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Toàn bộ working tree/ }).getByText("1", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /src\/example\.ts/ })).toHaveAttribute("aria-pressed", "true");
  // The document workspace has to be reachable from the dashboard, not only from
  // the in-session WebUI: this tab is the only way in.
  await page.getByRole("tab", { name: /Tài liệu/ }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Tài liệu" })).toBeVisible();
  // Both the project and the directory granted through the profile are listed.
  await expect(page.getByText("Project", { exact: true })).toBeVisible();
  await expect(page.getByText("Thư mục đã cấp quyền", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /vendor-spec\.pdf/ })).toBeVisible();
  await page.getByRole("button", { name: /ke-hoach\.md/ }).click();
  await expect(page.getByRole("heading", { name: "Ke hoach quy ba" })).toBeVisible();
  await expect(page.getByText("tang truong", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  await expect(page.getByText("read passed", { exact: true })).toBeVisible();
  await expect(page.getByText("src/example.ts", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Đóng Inspector" }).click();
  await page.getByRole("button", { name: "Cài đặt" }).click();
  await expect(page.getByRole("dialog").getByText("Cài đặt", { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder("Tìm cuộc trò chuyện")).toBeVisible();
  await page.getByText("Nhà cung cấp & model", { exact: true }).click();
  await expect(page.getByText("GPT-5.6", { exact: true })).toBeVisible();
  await expect(page.getByText("Codex Web Search", { exact: true })).toBeVisible();
  await expect(page.getByText("Ưu tiên Codex", { exact: true })).toBeVisible();
  await expect(page.getByText("Vision của model", { exact: true })).toBeVisible();
  await expect(page.getByText("Đang dùng", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("OpenAI Codex", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Kết nối lại", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Kết nối", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Đã kết nối", { exact: true })).toBeVisible();
  await page.getByRole("dialog").filter({ hasText: "Đã kết nối" }).getByRole("button", { name: "Đóng", exact: true }).click();
  await page.getByText("MCP & kết nối", { exact: true }).click();
  await expect(page.getByText("context7", { exact: true })).toBeVisible();
  await page.getByText("Điều khiển project", { exact: true }).click();
  await expect(page.getByText("Cùng logic với Terminal:", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Pi status", exact: true }).click();
  await expect(page.getByText("0 model token", { exact: true })).toBeVisible();
  await expect(page.getByText("runtime: ready", { exact: false })).toBeVisible();
  await expect.poll(() => observedRuntimeActions.includes("runtime.status")).toBe(true);
  await page.getByText("Quyền truy cập", { exact: true }).click();
  await page.getByRole("button", { name: "Toàn quyền" }).click();
  await expect(page.getByRole("dialog").getByText("Bật toàn quyền?", { exact: true })).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Hủy" }).click();
  await page.getByText("Giao diện", { exact: true }).click();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-piagent-color-mode", "light");
  await page.mouse.move(1, 1); await page.waitForTimeout(300);
  const result = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(result.violations.map((violation) => violation.id), [], JSON.stringify(result.violations.map((violation) => ({
    id: violation.id, nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
  }))));
  assert.deepEqual(errors, []);
  assert.deepEqual(nativeDialogs, []);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Archived (1)" }).click();
  await page.getByText("Archived planning", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Archived planning" })).toBeVisible();
  await page.getByRole("button", { name: "Back to chats" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-piagent-color-mode", "light");
});

test("resyncs and retries a new chat or send once when its revision changes before submit", async ({ page }) => {
  const originalRevision = catalog.catalogRevision, originalSessions = [...catalog.sessions];
  const originalPage = { ...catalog.page }, attemptsBefore = sessionCreateAttempts, effectsBefore = sessionCreateEffects;
  const sendAttemptsBefore = sessionSendAttempts, sendEffectsBefore = sessionSendEffects;
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();
    await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
    await page.getByRole("button", { name: "Quyền theo profile", exact: true }).click();
    await page.getByRole("menuitem", { name: "Chỉ đọc", exact: true }).click();

    // Simulate another session changing after this tab rendered its catalog.
    // The first command must be rejected before any effect; the client then
    // refreshes both revisions from one snapshot and retries exactly once.
    catalog.catalogRevision = "revision_catalog_changed_before_create";
    await page.getByRole("button", { name: "Thêm file (0/4)" }).locator('input[type="file"]').setInputFiles({ name: "brief.md", mimeType: "text/markdown",
      buffer: Buffer.from("# Brief\n\nBuild the Linux import flow safely.\n") });
    await expect(page.getByText(/brief\.md · /)).toBeVisible();
    await page.getByPlaceholder("Nhắn cho Piagent…").fill("Create after a concurrent catalog update");
    await page.getByRole("button", { name: "Gửi" }).click();

    await expect(page.getByRole("heading", { name: "Browser retry session" })).toBeVisible();
    await expect(page.getByText("Create after a concurrent catalog update", { exact: true })).toBeVisible();
    await expect(page.getByText("session-revision-stale", { exact: true })).toHaveCount(0);
    assert.equal(sessionCreateAttempts - attemptsBefore, 2);
    assert.equal(sessionCreateEffects - effectsBefore, 1);
    assert.equal(Object.hasOwn(lastCreatePayload ?? {}, "workflow"), false);
    assert.equal(lastCreatePayload?.permissionMode, "read-only");
    assert.equal(lastSendPayload?.attachmentRefs?.length, 1);
    assert.match((dispatchedContent ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      /Build the Linux import flow safely/);

    const created = catalog.sessions.find((item) => item.title === "Browser retry session");
    assert.ok(created);
    // Live events refresh the lists in coalesced batches (150 ms); let them
    // settle so this tab still holds the old revision when it sends.
    await page.waitForTimeout(600);
    created.sessionRevision = "revision_session_changed_before_send";
    catalog.catalogRevision = "revision_catalog_changed_before_send";
    await page.getByPlaceholder("Nhắn cho Piagent…").fill("Send after a concurrent session update");
    await page.getByRole("button", { name: "Gửi" }).click();
    await expect(page.getByText("A streamed Gateway reply.", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("session-revision-stale", { exact: true })).toHaveCount(0);
    // One initial send carries the staged file. The next message first goes
    // stale and is retried once, so the total is three attempts / two effects.
    await expect.poll(() => sessionSendAttempts - sendAttemptsBefore).toBe(3);
    await expect.poll(() => sessionSendEffects - sendEffectsBefore).toBe(2);
  } finally {
    catalog.catalogRevision = originalRevision; catalog.sessions.splice(0, catalog.sessions.length, ...originalSessions);
    Object.assign(catalog.page, originalPage);
  }
});

test("opens a known created session instead of exposing an internal uncertainty code", async ({ page }) => {
  const originalRevision = catalog.catalogRevision, originalSessions = [...catalog.sessions], originalPage = { ...catalog.page };
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();
    await page.getByPlaceholder("Nhắn cho Piagent…").fill("Recover a created session without a duplicate run");
    nextCreateUncertain = true;
    await page.getByRole("button", { name: "Gửi" }).click();

    await expect(page.getByRole("dialog").getByText("Session đã được tạo", { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog").getByText(/Không gửi lại để tránh chạy trùng/)).toBeVisible();
    await expect(page.getByText("session-command-effect-unknown", { exact: true })).toHaveCount(0);
    await page.getByRole("dialog").getByRole("button", { name: "Đóng" }).click();
    await expect(page.getByRole("heading", { name: "Browser retry session" })).toBeVisible();
  } finally {
    nextCreateUncertain = false; catalog.catalogRevision = originalRevision;
    catalog.sessions.splice(0, catalog.sessions.length, ...originalSessions); Object.assign(catalog.page, originalPage);
  }
});

test("preserves the composer draft and staged file when send admission is rejected", async ({ page }) => {
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles({
    name: "retry-brief.md", mimeType: "text/markdown", buffer: Buffer.from("# Retry brief\n\nKeep this staged.\n")
  });
  await expect(page.getByText(/retry-brief\.md · /)).toBeVisible();
  const composer = page.getByPlaceholder("Nhắn cho Piagent…");
  await composer.fill("Preserve this rejected draft");
  nextSendRejected = true;
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(composer).toHaveValue("Preserve this rejected draft");
  await expect(page.getByText(/retry-brief\.md · /)).toBeVisible();
  await expect(page.getByText(/Nội dung và file vẫn được giữ/)).toBeVisible();
  await expect(page.locator("p").filter({ hasText: /^Preserve this rejected draft$/ })).toHaveCount(0);
});

test("keeps an unconfirmed send visible, never resends it, and consumes one-shot attachments only after operation evidence", async ({ page }) => {
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles({
    name: "uncertain-brief.md", mimeType: "text/markdown", buffer: Buffer.from("# One-shot\n\nDo not dispatch twice.\n")
  });
  const composer = page.getByPlaceholder("Nhắn cho Piagent…"), attemptsBefore = sessionSendAttempts;
  await composer.fill("Keep this single uncertain dispatch"); nextSendUnconfirmed = true;
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.locator("p").filter({ hasText: /^Keep this single uncertain dispatch$/ })).toBeVisible();
  await expect(composer).toHaveValue("Keep this single uncertain dispatch");
  await expect(composer).toBeDisabled();
  await expect(page.getByText(/đừng gửi lại để tránh chạy trùng/)).toBeVisible();
  assert.equal(sessionSendAttempts - attemptsBefore, 1);
  const firstRequestId = lastSendPayload.messageRequestId;

  const operationRef = "operation_late_confirmation";
  protocol.events.publish("runtime.changed", { sessionRef: "session_release_prep",
    sessionRevision: "revision_session_release_prep", liveState: "running", operationRef, reasonCode: null });
  await expect(composer).toHaveValue("");
  await expect(page.getByText(/đừng gửi lại để tránh chạy trùng/)).toHaveCount(0);
  await expect(page.getByText(/uncertain-brief\.md · /)).toHaveCount(0);
  assert.equal(sessionSendAttempts - attemptsBefore, 1, "live confirmation must not replay the command");

  protocol.events.publish("message.completed", { sessionRef: "session_release_prep", operationRef,
    messageRef: "message_late_confirmation", sessionRevision: "revision_session_release_prep", truncated: false });
  protocol.events.publish("operation.settled", { sessionRef: "session_release_prep", operationRef,
    messageRef: "message_late_confirmation", sessionRevision: "revision_session_release_prep", settlement: "completed", reasonCode: null });
  await composer.fill("Fresh message after reconciliation");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect.poll(() => lastSendPayload?.message).toBe("Fresh message after reconciliation");
  assert.notEqual(lastSendPayload.messageRequestId, firstRequestId, "a consumed attachment request id must never be reused");
});

test("keeps the session sidebar usable on a phone viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.issueLaunchUrl());
  const navigation = page.getByRole("button", { name: "Mở điều hướng" });
  await expect(navigation).toBeVisible(); await navigation.click({ force: true });
  await expect(page.getByPlaceholder("Tìm cuộc trò chuyện").filter({ visible: true })).toBeVisible();
  await page.getByText("Review source changes", { exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("heading", { name: "Review source changes" })).toBeVisible();
  assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth));
});

test("attaches a .docx in the dashboard composer and sends its prose to the session", async ({ page }) => {
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  await expect(page.getByRole("button", { name: /Đính kèm/ })).toBeEnabled();

  const dropped = docx("Chot ngan sach Q3.", "Doi tac ky ngay 12/09.");
  await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles(
    { name: "ke-hoach.docx", mimeType: DOCX_MIME, buffer: dropped });

  // The chip reports the archive it came from and the text the session will read.
  await expect(page.getByText(/ke-hoach\.docx · Tài liệu · .+ → .+ văn bản/)).toBeVisible();

  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Đọc file đính kèm");
  await page.getByRole("button", { name: "Gửi" }).click();
  // Sending clears the composer reservation, but the conversation keeps a
  // durable-looking file card instead of making the attachment disappear.
  await expect(page.getByLabel("File đã gửi").getByText("ke-hoach.docx", { exact: true })).toBeVisible();

  await expect.poll(() => lastSendPayload?.attachmentRefs?.length ?? 0).toBe(1);
  const parts = dispatchedContent ?? [];
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /Đọc file đính kèm/);
  assert.match(text, /Chot ngan sach Q3\./);
  assert.match(text, /Doi tac ky ngay 12\/09\./);
  // Only the prose crosses over, fenced by a marker the document could not hold.
  assert.equal(text.includes("word/document.xml"), false);
  assert.match(text, /BEGIN PIAGENT-ATTACHMENT-[0-9a-f-]{36}/);
});

test("attaches source files such as .html like a coding agent does, and says why a binary cannot go in", async ({ page }) => {
  lastSendPayload = null; dispatchedContent = null;
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  const input = page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]');
  // The picker offers every file: code has hundreds of extensions.
  assert.ok(!(await input.getAttribute("accept")), "no accept filter");
  await input.setInputFiles({ name: "build.zip", mimeType: "application/zip", buffer: Buffer.from("PK\u0003\u0004binary") });
  await expect(page.getByText(/build\.zip: file nhị phân không gửi vào chat được/)).toBeVisible();
  await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles({ name: "budget.xls", mimeType: "application/octet-stream", buffer: Buffer.from("PK") });
  await expect(page.getByText(/budget\.xls: định dạng bảng tính này chưa đọc trực tiếp được; hãy lưu sang \.xlsx hoặc \.csv/)).toBeVisible();
  // An unknown extension is tried as text; the host refuses bytes that are not.
  await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles({ name: "blob.dat", mimeType: "application/octet-stream", buffer: Buffer.from([0, 159, 146, 150, 0, 255, 254, 0]) });
  await expect(page.getByText(/blob\.dat: Nội dung file không phải văn bản/)).toBeVisible();
  await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles([
    { name: "index.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><title>Landing</title><h1 id=hero>Xin chao</h1>\n") },
    { name: "Dockerfile", mimeType: "", buffer: Buffer.from("FROM node:22-alpine\nCMD [\"node\", \"server.js\"]\n") }]);
  await expect(page.getByText(/index\.html · File · /)).toBeVisible();
  await expect(page.getByText(/Dockerfile · File · /)).toBeVisible();
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Sửa tiêu đề trang");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect.poll(() => lastSendPayload?.attachmentRefs?.length ?? 0).toBe(2);
  const text = (dispatchedContent ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /attached file: "index\.html"/);
  assert.match(text, /<h1 id=hero>Xin chao<\/h1>/);
  assert.match(text, /attached file: "Dockerfile"/);
  assert.match(text, /FROM node:22-alpine/);
});

test("drops a document onto the new chat composer and carries it into the created session", async ({ page }) => {
  // Cleared first: an earlier test leaves its own dispatch here, and polling on a
  // stale value passes before this test has sent anything at all.
  lastSendPayload = null; dispatchedContent = null;
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();

  const dropped = docx("Ke hoach onboarding.", "Ban giao ngay 30/09.");
  const dataTransfer = await page.evaluateHandle(([base64, name, type]) => {
    const binary = atob(base64), bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], name, { type }));
    return transfer;
  }, [dropped.toString("base64"), "onboarding.docx", DOCX_MIME]);

  const composer = page.getByPlaceholder("Nhắn cho Piagent…").locator("xpath=ancestor::div[contains(@class,'MuiBox-root')][1]");
  await composer.dispatchEvent("dragenter", { dataTransfer });
  await expect(page.getByText("Thả tài liệu vào đây")).toBeVisible();
  await composer.dispatchEvent("drop", { dataTransfer });
  await expect(page.getByText(/onboarding\.docx · /)).toBeVisible();
  await expect(page.getByText("Thả tài liệu vào đây")).not.toBeVisible();

  // A dropped file has to travel the same road as a picked one: the session is
  // created first, the bytes are staged against it, and only then is the first
  // message sent carrying the refs.
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Doc file dinh kem");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.getByText("Doc file dinh kem", { exact: true })).toBeVisible();

  await expect.poll(() => lastSendPayload?.attachmentRefs?.length ?? 0).toBe(1);
  const text = (dispatchedContent ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  assert.match(text, /Ke hoach onboarding\./);
  assert.match(text, /Ban giao ngay 30\/09\./);
  assert.equal(text.includes("word/document.xml"), false);
});

test("chooses the company model in the dashboard and creates the session through the same command", async ({ page }) => {
  const createsBefore = sessionCreateAttempts; lastCreatePayload = null;
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();
  await page.getByRole("button", { name: /^Model:/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("Công ty", { exact: true })).toBeVisible();
  await expect(menu.getByText("Cá nhân", { exact: true })).toBeVisible();
  // Not connected yet: the entry says why and connects on selection.
  await expect(menu.getByText("macOS chưa cho Agent Watch đọc key. Chọn “Luôn cho phép” khi được hỏi rồi kết nối lại.")).toBeVisible();
  await menu.getByRole("menuitem", { name: /agent-watch-auto/ }).click();
  await expect(page.getByRole("button", { name: "Model: Công ty · agent-watch-auto" })).toBeVisible();
  assert.equal(companyConnects, 1);
  await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
  await expect(page.getByText("Model và quyền theo Harness công ty; thinking chọn ở đây.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Quyền theo profile" })).toHaveCount(0);
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Rà soát module thanh toán");
  await page.getByRole("button", { name: "Gửi", exact: true }).click();
  await expect.poll(() => sessionCreateAttempts).toBe(createsBefore + 1);
  assert.equal(lastCreatePayload?.modelRef, COMPANY_MODEL_REF);
  assert.equal(lastCreatePayload?.message, "Rà soát module thanh toán");
  assert.equal(lastCreatePayload?.permissionMode, undefined);
});

test("shows the agent's plan, each time the harness sent the agent back, and how the turn ended", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target };
  Object.assign(target, { modelLabel: "agent-watch-auto", sessionRevision: "revision_session_source_review_process",
    managedPlan: { steps: [{ step: "Đọc cart.js và test hiện có", status: "completed" }, { step: "Sửa cách tính tổng khi giỏ hàng có mã giảm giá áp dụng cho nhiều sản phẩm cùng lúc", status: "in_progress" }, { step: "Chạy npm test", status: "pending" }] },
    managedProcess: { outcome: "blocking_open", verified: true, reviewed: true, blockingOpen: 1 } });
  const base = transcriptFixture.items[0], text = (value) => ({ ...base.content, text: value, textChars: value.length });
  processTranscript = [
    { ...base, messageRef: "message_process_user", role: "user", recordedAt: "2026-08-14T06:00:00.000Z", content: text("Sửa tổng tiền giỏ hàng"), toolCalls: [] },
    { ...base, messageRef: "message_process_done", parentMessageRef: "message_process_user", role: "assistant", recordedAt: "2026-08-14T06:00:01.000Z", content: text("Đã sửa."), toolCalls: [] },
    { ...base, messageRef: "message_process_verify", parentMessageRef: "message_process_user", role: "custom", recordedAt: "2026-08-14T06:00:02.000Z", content: text("Harness process check"), toolCalls: [],
      process: { phase: "verify", loop: 1, maxLoops: 2 } },
    { ...base, messageRef: "message_process_review", parentMessageRef: "message_process_user", role: "custom", recordedAt: "2026-08-14T06:00:03.000Z", content: text("Harness review"), toolCalls: [],
      process: { phase: "review", loop: 2, maxLoops: 2, findings: [{ severity: "blocking", file: "packages/shop/src/very/long/path/to/cart-total-calculation.js", line: 3, issue: "Giảm giá bị trừ hai lần khi giỏ có nhiều sản phẩm cùng mã" }] } },
    { ...base, messageRef: "message_process_answer", parentMessageRef: "message_process_user", role: "assistant", recordedAt: "2026-08-14T06:00:04.000Z", content: text("Đã sửa phần lớn, còn một lỗi chưa xử lý."), toolCalls: [] },
    { ...base, messageRef: "message_process_final", parentMessageRef: "message_process_user", role: "custom", recordedAt: "2026-08-14T06:00:05.000Z", content: text("Process status"), toolCalls: [],
      process: { phase: "final", outcome: "blocking_open", verified: true, reviewed: true, blockingOpen: 1, verifyPolicy: "require", reviewPolicy: "require" } }];
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
      await page.goto(server.issueLaunchUrl());
      if (width < 1200) { await page.getByRole("button", { name: "Mở điều hướng" }).click({ force: true }); }
      await page.getByText("Review source changes", { exact: true }).filter({ visible: true }).click();
      await expect(page.getByText("Harness: chưa có check nào pass trên code hiện tại, yêu cầu agent chạy check (vòng 1/2)")).toBeVisible();
      await expect(page.getByText("Harness: review tìm thấy 1 lỗi blocking, gửi lại agent để fix hoặc giải thích (vòng 2/2)")).toBeVisible();
      await expect(page.getByText("Giảm giá bị trừ hai lần", { exact: false })).toBeVisible();
      await expect(page.getByRole("status", { name: "Tiến trình của lượt" })).toHaveText("Check đã pass trên code cuối · Còn 1 lỗi blocking chưa fix");
      if (width < 1200) await page.getByRole("button", { name: "Khung Workspace" }).click();
      const plan = page.getByRole("list", { name: "Plan của agent" }).filter({ visible: true });
      await expect(plan.getByRole("listitem")).toHaveCount(3);
      await expect(page.getByText("Plan · 1/3").filter({ visible: true })).toBeVisible();
      await expect(page.getByText("Lượt sửa code gần nhất: Check đã pass trên code cuối · Còn 1 lỗi blocking chưa fix").filter({ visible: true })).toBeVisible();
      assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: path.join(root, `.tmp/playwright-webui/harness-process-${width}.png`) });
      await page.close();
    }
  } finally {
    processTranscript = [];
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

test("says whether a company task is finished: harness rounds on an open checklist, then how the turn ended", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target };
  Object.assign(target, { modelLabel: "agent-watch-auto", sessionRevision: "revision_session_source_review_turn_end",
    managedTurnEnd: { state: "midway", planSteps: 22, planDone: 6, reason: "idle" } });
  const base = transcriptFixture.items[0], text = (value) => ({ ...base.content, text: value, textChars: value.length });
  processTranscript = [
    { ...base, messageRef: "message_end_user", role: "user", recordedAt: "2026-08-14T08:00:00.000Z", content: text("Làm hết STEP01 đến STEP22 trong docs/plans"), toolCalls: [] },
    { ...base, messageRef: "message_end_first", parentMessageRef: "message_end_user", role: "assistant", recordedAt: "2026-08-14T08:00:01.000Z", content: text("Xong STEP01, tiếp theo STEP02."), toolCalls: [] },
    { ...base, messageRef: "message_end_continue", parentMessageRef: "message_end_user", role: "custom", recordedAt: "2026-08-14T08:00:02.000Z", content: text("Harness: your checklist still has 21 open step(s)"), toolCalls: [],
      process: { phase: "continue", round: 1, maxRounds: 30, planOpen: 21, planDone: 1, planSteps: 22 } },
    { ...base, messageRef: "message_end_answer", parentMessageRef: "message_end_user", role: "assistant", recordedAt: "2026-08-14T08:00:03.000Z", content: text("STEP07 cần database staging đang tắt nên em dừng ở đây."), toolCalls: [] },
    { ...base, messageRef: "message_end_line", parentMessageRef: "message_end_user", role: "custom", recordedAt: "2026-08-14T08:00:04.000Z", content: text(""), toolCalls: [],
      turnEnd: { state: "midway", planSteps: 22, planDone: 6, rounds: 2, reason: "idle" } }];
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
      await page.goto(server.issueLaunchUrl());
      if (width < 1200) { await page.getByRole("button", { name: "Mở điều hướng" }).click({ force: true }); }
      // The conversation list says it before the conversation is opened.
      await expect(page.getByText("Dừng giữa chừng 6/22").filter({ visible: true })).toBeVisible();
      await page.getByText("Review source changes", { exact: true }).filter({ visible: true }).click();
      await expect(page.getByText("Harness: checklist còn 21 bước (1/22 xong), cho main agent làm tiếp · vòng 1")).toBeVisible();
      const ending = page.getByRole("status", { name: "Kết quả của lượt" });
      await expect(ending).toContainText("Dừng giữa chừng · còn 16/22 bước");
      await expect(ending).toContainText("Main agent dừng 2 vòng liên tiếp");
      await expect(ending.getByRole("button", { name: "Tiếp tục" })).toBeVisible();
      assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: path.join(root, `.tmp/playwright-webui/turn-end-${width}.png`) });
      await page.close();
    }
  } finally {
    processTranscript = [];
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

test("shows a helper's objection to the brief and a disagreement the member has to decide", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target };
  Object.assign(target, { modelLabel: "agent-watch-auto", sessionRevision: "revision_session_source_review_dispute",
    managedProcess: { outcome: "disputed", verified: true, reviewed: true, blockingOpen: 1 } });
  const base = transcriptFixture.items[0], text = (value) => ({ ...base.content, text: value, textChars: value.length });
  const step = (ref, at, process, value = "Harness") => ({ ...base, messageRef: ref, parentMessageRef: "message_dispute_user", role: "custom", recordedAt: at, content: text(value), toolCalls: [], process });
  processTranscript = [
    { ...base, messageRef: "message_dispute_user", role: "user", recordedAt: "2026-08-14T07:00:00.000Z", content: text("Thêm giảm giá theo mã cho giỏ hàng, giữ nguyên API công khai"), toolCalls: [] },
    step("message_dispute_objection", "2026-08-14T07:00:01.000Z", { phase: "objection", role: "scout", by: "main",
      issues: [{ kind: "conflicts_with_request", detail: "Brief yêu cầu đổi chữ ký hàm total(items) thành total(items, coupon) trong packages/shop/src/very/long/path/to/cart-total-calculation.js, trái với yêu cầu giữ nguyên API công khai" }] }),
    { ...base, messageRef: "message_dispute_main", parentMessageRef: "message_dispute_user", role: "assistant", recordedAt: "2026-08-14T07:00:02.000Z", content: text("Đã thêm applyCoupon và giữ nguyên total()."), toolCalls: [] },
    step("message_dispute_rejudge", "2026-08-14T07:00:03.000Z", { phase: "rejudge", role: "review" }),
    step("message_dispute_dispute", "2026-08-14T07:00:04.000Z", { phase: "dispute", role: "review",
      findings: [{ severity: "blocking", file: "packages/shop/src/very/long/path/to/cart-total-calculation.js", line: 42, issue: "Mã giảm giá hết hạn vẫn được áp dụng" }] }),
    step("message_dispute_final", "2026-08-14T07:00:05.000Z", { phase: "final", outcome: "disputed", disputes: 1, verified: true, reviewed: true, blockingOpen: 1, verifyPolicy: "require", reviewPolicy: "require" })];
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
      await page.goto(server.issueLaunchUrl());
      if (width < 1200) { await page.getByRole("button", { name: "Mở điều hướng" }).click({ force: true }); }
      await expect(page.getByText("Cần bạn quyết", { exact: false }).filter({ visible: true }).first()).toBeVisible();
      await page.getByText("Review source changes", { exact: true }).filter({ visible: true }).click();
      await expect(page.getByText("Subagent scout phản biện brief của main agent")).toBeVisible();
      await expect(page.getByText("[conflict với yêu cầu]", { exact: false })).toBeVisible();
      await expect(page.getByText("Harness: main agent giải thích thay vì fix, Subagent review xem xét lại lời giải thích")).toBeVisible();
      await expect(page.getByText("Main agent và Subagent review vẫn conflict sau 2 lượt, bạn quyết định")).toBeVisible();
      await expect(page.getByText("Mã giảm giá hết hạn vẫn được áp dụng", { exact: false })).toBeVisible();
      await expect(page.getByText("Lượt này chưa có câu trả lời", { exact: false })).toHaveCount(0);
      await expect(page.getByRole("status", { name: "Tiến trình của lượt" })).toHaveText("Main agent và subagent conflict, bạn quyết định · Check đã pass trên code cuối · Còn 1 lỗi blocking chưa fix");
      assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: path.join(root, `.tmp/playwright-webui/harness-dispute-${width}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    processTranscript = [];
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

test("keeps many conversations readable: running first, filter by kind, folding groups that show their newest five", async ({ browser }) => {
  const added = Array.from({ length: 8 }, (_, index) => session(`session_many_${index}`, `Kịch bản ${index + 1}`, "harness-edge-cases",
    `2026-08-14T04:${String(50 - index).padStart(2, "0")}:00.000Z`, { modelLabel: "agent-watch-auto", projectRef: "project_harness_cases",
      ...(index === 0 ? { liveState: "running", state: "owned" } : {}),
      ...(index === 2 ? { managedProcess: { outcome: "blocking_open", verified: true, reviewed: true, blockingOpen: 1 } } : {}),
      ...(index === 3 ? { managedProcess: { outcome: "clean", verified: true, reviewed: true, blockingOpen: 0 } } : {}) }));
  catalog.sessions.push(...added);
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
  try {
    await page.goto(server.issueLaunchUrl());
    const sidebar = page.getByRole("complementary").or(page.locator("nav")).first();
    await expect(page.getByRole("button", { name: "Công ty · 8" })).toBeVisible();
    const running = page.getByRole("region", { name: "Đang chạy hoặc cần chú ý" });
    await expect(running.getByText("Kịch bản 1")).toBeVisible(); await expect(running.getByText("harness-edge-cases", { exact: false })).toBeVisible();
    const group = page.getByRole("region", { name: "harness-edge-cases" });
    await expect(group.getByText(/^Kịch bản \d$/)).toHaveCount(5);
    await expect(group.getByText("Còn lỗi blocking", { exact: false })).toBeVisible(); await expect(group.getByText("Đủ bước", { exact: false })).toBeVisible();
    await group.getByRole("button", { name: "Xem thêm 3" }).click(); await expect(group.getByText(/^Kịch bản \d$/)).toHaveCount(8);
    await group.getByRole("button", { name: "Thu gọn" }).click(); await expect(group.getByText(/^Kịch bản \d$/)).toHaveCount(5);
    // A folded group stays folded after a reload.
    await group.getByRole("button", { name: /harness-edge-cases/ }).click(); await expect(group.getByText(/^Kịch bản \d$/)).toHaveCount(0);
    await page.reload(); await expect(page.getByRole("region", { name: "harness-edge-cases" }).getByText(/^Kịch bản \d$/)).toHaveCount(0);
    await page.getByRole("region", { name: "harness-edge-cases" }).getByRole("button", { name: /harness-edge-cases/ }).click();
    // Company only: personal conversations leave the list.
    await page.getByRole("button", { name: "Công ty · 8" }).click();
    await expect(page.getByText("Review source changes", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: /^Cá nhân/ }).click(); await expect(page.getByRole("region", { name: "harness-edge-cases" })).toHaveCount(0);
    await page.getByRole("button", { name: "Tất cả" }).click();
    await page.screenshot({ path: path.join(root, ".tmp/playwright-webui/sidebar-organized.png") });
    void sidebar;
  } finally {
    await page.close();
    catalog.sessions.splice(catalog.sessions.length - added.length, added.length);
  }
});

test("shows the Git branch a conversation's project stands on, and a detached HEAD as a warning", async ({ browser }) => {
  const release = catalog.sessions.find((row) => row.sessionRef === "session_release_prep");
  const review = catalog.sessions.find((row) => row.sessionRef === "session_source_review");
  const saved = [release.gitBranch, review.gitBranch];
  release.gitBranch = { name: "feature/show-the-git-branch-in-the-dashboard-header-and-status-bar", detached: false };
  review.gitBranch = { name: "3f6edf8", detached: true };
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
      try {
        await page.goto(server.issueLaunchUrl());
        // Earlier tests may leave a newer chat selected; open this one by name.
        if (width < 900) await page.getByRole("button", { name: "Mở điều hướng" }).click();
        await page.getByRole("button", { name: /^Release preparation/ }).filter({ visible: true }).first().click();
        const header = page.getByRole("banner");
        await expect(header.getByRole("heading", { name: "Release preparation" })).toBeVisible();
        const branch = header.getByRole("button", { name: /Đổi nhánh Git của pi-company-platform \(đang ở feature\/show-the-git-branch/ });
        await expect(branch).toBeVisible();
        const box = await branch.boundingBox(), headerBox = await header.boundingBox();
        expect(box.x + box.width).toBeLessThanOrEqual(headerBox.x + headerBox.width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const bar = page.getByRole("contentinfo", { name: "Thanh trạng thái" });
        if (width >= 900) {
          await expect(bar.getByRole("button", { name: /đang ở feature\/show/ })).toBeVisible();
          await expect(page.getByRole("navigation").getByLabel(/Nhánh Git của project: feature\/show/)).toBeVisible();
          await page.getByRole("navigation").getByText("Review source changes", { exact: true }).click();
          await expect(header.getByRole("button", { name: "Đổi nhánh Git của sample-project (detached HEAD tại 3f6edf8)" })).toBeVisible();
          await expect(bar.getByText("3f6edf8", { exact: true })).toBeVisible();
        } else await expect(bar).toHaveCount(0);
        await page.screenshot({ path: path.join(root, `.tmp/playwright-webui/git-branch-${width}.png`) });
      } finally { await page.close(); }
    }
  } finally {
    [release.gitBranch, review.gitBranch] = saved;
    if (!release.gitBranch) delete release.gitBranch;
    if (!review.gitBranch) delete review.gitBranch;
  }
});

test("switches the project's Git branch from the header: an existing one, a new one, never while a conversation runs, and Git's refusal in its words", async ({ browser }) => {
  const scratch = fs.mkdtempSync(path.join(root, ".tmp", "branch-switch-"));
  const git = (...args) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: scratch, stdio: "pipe" }).toString();
  git("init", "-q"); fs.writeFileSync(path.join(scratch, "a.txt"), "one\n"); git("add", "a.txt"); git("commit", "-q", "-m", "first");
  git("branch", "release/1.18");
  git("checkout", "-q", "-b", "edit-a"); fs.writeFileSync(path.join(scratch, "a.txt"), "edited\n"); git("commit", "-q", "-am", "edit"); git("checkout", "-q", "main");
  branchRepo = scratch; branchRunning = 0;
  const row = catalog.sessions.find((item) => item.sessionRef === "session_release_prep");
  const saved = { gitBranch: row.gitBranch, sessionRevision: row.sessionRevision, catalogRevision: catalog.catalogRevision };
  row.gitBranch = { name: "main", detached: false };
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
  try {
    await page.goto(server.issueLaunchUrl());
    await page.getByRole("button", { name: /^Release preparation/ }).filter({ visible: true }).first().click();
    const header = page.getByRole("banner");
    await header.getByRole("button", { name: /Đổi nhánh Git của pi-company-platform \(đang ở main\)/ }).click();
    const menu = page.getByRole("dialog", { name: "Nhánh Git" });
    await expect(menu.getByRole("button", { name: /^release\/1\.18/ })).toBeVisible();
    await page.screenshot({ path: path.join(root, ".tmp/playwright-webui/git-branch-menu.png") });
    await menu.getByRole("button", { name: /^release\/1\.18/ }).click();
    await expect(menu).toHaveCount(0);
    expect(git("branch", "--show-current").trim()).toBe("release/1.18");
    await expect(header.getByRole("button", { name: /đang ở release\/1\.18/ })).toBeVisible();

    // A new branch from what is typed, with Enter.
    await header.getByRole("button", { name: /đang ở release\/1\.18/ }).click();
    // The search field takes typing as soon as the branches are there.
    await expect(menu.getByRole("textbox", { name: "Tìm nhánh" })).toBeFocused();
    await page.keyboard.type("feature/branch-menu");
    await expect(menu.getByRole("button", { name: /Tạo nhánh mới “feature\/branch-menu”/ })).toBeVisible();
    await menu.getByRole("textbox", { name: "Tìm nhánh" }).press("Enter");
    await expect(menu).toHaveCount(0);
    expect(git("branch", "--show-current").trim()).toBe("feature/branch-menu");

    // Git refuses to overwrite an uncommitted change; the menu says so in Git's words and the file stays.
    fs.writeFileSync(path.join(scratch, "a.txt"), "uncommitted\n");
    await header.getByRole("button", { name: /đang ở feature\/branch-menu/ }).click();
    await expect(menu.getByText(/1 file đang sửa dở sẽ đi theo/)).toBeVisible();
    await menu.getByRole("button", { name: /^edit-a/ }).click();
    await expect(menu.getByText(/thay đổi chưa commit sẽ bị ghi đè/)).toBeVisible();
    await expect(menu.getByText(/would be overwritten by checkout/)).toBeVisible();
    expect(fs.readFileSync(path.join(scratch, "a.txt"), "utf8")).toBe("uncommitted\n");
    await page.keyboard.press("Escape");

    // While a conversation in the folder runs, nothing switches.
    branchRunning = 1;
    await header.getByRole("button", { name: /đang ở feature\/branch-menu/ }).click();
    await expect(menu.getByText(/1 cuộc trò chuyện đang chạy trong folder này/)).toBeVisible();
    await expect(menu.getByRole("button", { name: /^main/ })).toBeDisabled();
    await page.screenshot({ path: path.join(root, ".tmp/playwright-webui/git-branch-blocked.png") });
    await page.keyboard.press("Escape");

    // The status bar opens the same menu.
    branchRunning = 0;
    await page.getByRole("contentinfo", { name: "Thanh trạng thái" }).getByRole("button", { name: /Đổi nhánh Git/ }).click();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    for (const width of [390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.getByRole("banner").getByRole("button", { name: /Đổi nhánh Git/ }).click();
      await expect(menu.getByRole("button", { name: /^main/ })).toBeEnabled();
      await expect(menu.getByText(/đang chạy trong folder này/)).toHaveCount(0);
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      await page.screenshot({ path: path.join(root, `.tmp/playwright-webui/git-branch-menu-${width}.png`) });
      await page.keyboard.press("Escape");
    }
  } finally {
    await page.close();
    branchRepo = null; branchRunning = 0;
    if (saved.gitBranch) row.gitBranch = saved.gitBranch; else delete row.gitBranch;
    row.sessionRevision = saved.sessionRevision; catalog.catalogRevision = saved.catalogRevision;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a folder holding several repositories shows them with their branches and switches one, as an editor's source control does", async ({ browser }) => {
  // Outside this repository: a folder inside one is that repository.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-workspace-")));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "init.defaultBranch=main", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe" }).toString();
  for (const name of ["FE", "BE", "docs"]) fs.mkdirSync(path.join(scratch, name));
  for (const name of ["FE", "BE"]) { git(path.join(scratch, name), "init", "-q"); git(path.join(scratch, name), "commit", "-q", "--allow-empty", "-m", "first"); }
  git(path.join(scratch, "FE"), "branch", "feature/login"); git(path.join(scratch, "BE"), "checkout", "-q", "-b", "develop");
  workspaceFolder = scratch;
  const row = catalog.sessions.find((item) => item.sessionRef === "session_source_review");
  const saved = { gitRepositories: row.gitRepositories, sessionRevision: row.sessionRevision, catalogRevision: catalog.catalogRevision };
  row.gitRepositories = childRepositories(scratch).map((child) => ({ name: child.name, branch: child.head }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
  try {
    await page.goto(server.issueLaunchUrl());
    await page.getByRole("button", { name: /^Review source changes/ }).filter({ visible: true }).first().click();
    const header = page.getByRole("banner");
    const chip = header.getByRole("button", { name: "2 repo Git trong sample-project" });
    await expect(chip).toHaveText(/2 repo/);
    await expect(page.getByRole("navigation").getByText("2 repo", { exact: true }).first()).toBeVisible();
    await chip.click();
    const menu = page.getByRole("dialog", { name: "Nhánh Git" });
    await expect(menu.getByText("Repo Git", { exact: true })).toBeVisible();
    const repos = menu.getByRole("list", { name: "Repo trong folder" });
    await expect(repos.getByRole("button")).toHaveCount(2);
    await expect(repos.getByRole("button", { name: /^BE/ })).toContainText("develop");
    await expect(repos.getByRole("button", { name: /^FE/ })).toContainText("main");
    await page.screenshot({ path: path.join(root, ".tmp/playwright-webui/multi-repo-menu.png") });
    // One repository: its branches, a way back, and a switch in that repository only.
    await repos.getByRole("button", { name: /^FE/ }).click();
    await expect(menu.getByText("sample-project / FE", { exact: true })).toBeVisible();
    await expect(menu.getByRole("button", { name: /^feature\/login/ })).toBeVisible();
    await page.screenshot({ path: path.join(root, ".tmp/playwright-webui/multi-repo-branches.png") });
    await menu.getByRole("button", { name: "Về danh sách repo" }).click();
    await expect(menu.getByRole("list", { name: "Repo trong folder" })).toBeVisible();
    await menu.getByRole("list", { name: "Repo trong folder" }).getByRole("button", { name: /^FE/ }).click();
    await menu.getByRole("button", { name: /^feature\/login/ }).click();
    await expect(menu).toHaveCount(0);
    expect(git(path.join(scratch, "FE"), "branch", "--show-current").trim()).toBe("feature/login");
    expect(git(path.join(scratch, "BE"), "branch", "--show-current").trim()).toBe("develop");
    await expect(header.getByRole("button", { name: "2 repo Git trong sample-project" })).toBeVisible();
    for (const width of [390]) {
      await page.setViewportSize({ width, height: 800 });
      await header.getByRole("button", { name: "2 repo Git trong sample-project" }).click();
      const box = await menu.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
      await expect(menu.getByRole("list", { name: "Repo trong folder" }).getByRole("button", { name: /^FE/ })).toContainText("feature/login");
      await page.screenshot({ path: path.join(root, `.tmp/playwright-webui/multi-repo-menu-${width}.png`) });
      await page.keyboard.press("Escape");
    }
  } finally {
    await page.close(); workspaceFolder = null;
    if (saved.gitRepositories) row.gitRepositories = saved.gitRepositories; else delete row.gitRepositories;
    row.sessionRevision = saved.sessionRevision; catalog.catalogRevision = saved.catalogRevision;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test("a conversation running in the company Terminal is followed, not continued, from the WebUI", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target };
  Object.assign(target, { modelLabel: "agent-watch-auto", state: "terminal-owned", liveState: "uncertain", composerAvailable: false, reasonCode: "terminal-owner-active",
    sessionRevision: "revision_session_source_review_terminal" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "vi-VN", colorScheme: "dark", reducedMotion: "reduce" });
  try {
    await page.goto(server.issueLaunchUrl());
    const running = page.getByRole("region", { name: "Đang chạy hoặc cần chú ý" });
    await expect(running.getByText("Đang chạy ở nơi khác", { exact: false })).toBeVisible();
    await running.getByText("Review source changes", { exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "đang chạy trong Terminal hoặc một tiến trình Piagent khác" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tiếp tục" })).toHaveCount(0);
    await expect(page.getByPlaceholder("Nhắn cho Piagent…")).toBeDisabled();
  } finally {
    await page.close();
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

// Fast mode: offered on the new chat page only where the team's Harness allows
// it, off by default, carried by the create command so the first message
// already runs on it; in the header it stands out while it is on.
const FAST_SCREENSHOTS = process.env.PIAGENT_FAST_SCREENSHOT_DIR ?? null;
test("offers Fast on the new chat page only where the Harness allows it, and shows it on in the header", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target };
  companyState = "ready"; companyModel.managedFast = true; lastCreatePayload = null;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "vi-VN" });
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();
    // A personal model: no Fast.
    await expect(page.getByRole("button", { name: /^Fast:/ })).toHaveCount(0);
    await page.getByRole("button", { name: /^Model:/ }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: /agent-watch-auto/ }).click();
    const fast = page.getByRole("button", { name: /^Fast: tắt/ });
    await expect(fast).toBeVisible();
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    if (FAST_SCREENSHOTS) await page.screenshot({ path: path.join(FAST_SCREENSHOTS, "fast-new-chat-off.png") });
    await fast.click();
    const on = page.getByRole("button", { name: /^Fast: bật/ });
    await expect(on).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("token tính vào quota gấp 2,5 lần", { exact: false }).first()).toBeVisible();
    await page.getByPlaceholder("Nhắn cho Piagent…").fill("Rà soát module thanh toán");
    if (FAST_SCREENSHOTS) await page.screenshot({ path: path.join(FAST_SCREENSHOTS, "fast-new-chat.png") });
    await page.getByRole("button", { name: "Gửi", exact: true }).click();
    await expect.poll(() => lastCreatePayload?.fast).toBe(true);
    assert.equal(lastCreatePayload?.modelRef, COMPANY_MODEL_REF);

    // The Harness does not allow Fast: nothing is offered.
    companyModel.managedFast = false; lastCreatePayload = null;
    await page.goto(server.issueLaunchUrl());
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await page.getByRole("button", { name: /^Model:/ }).click();
    await page.getByRole("menu").getByRole("menuitem", { name: /agent-watch-auto/ }).click();
    await expect(page.getByRole("button", { name: "Model: Công ty · agent-watch-auto" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Fast:/ })).toHaveCount(0);

    // A company conversation on Fast: the header says so.
    Object.assign(target, { modelLabel: "agent-watch-auto", managedFast: "on", sessionRevision: "revision_session_source_review_fast_on" });
    catalog.catalogRevision = "revision_catalog_fast_on";
    protocol.events.publish("catalog.changed", { catalogRevision: catalog.catalogRevision });
    await page.getByText("Review source changes", { exact: true }).first().click();
    const header = page.getByRole("button", { name: /^Fast đang bật/ });
    await expect(header).toBeVisible();
    await expect(header).toContainText("Fast: bật");
    if (FAST_SCREENSHOTS) await page.screenshot({ path: path.join(FAST_SCREENSHOTS, "fast-header.png") });
  } finally {
    companyState = "unavailable"; delete companyModel.managedFast;
    await page.close();
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

test("a company conversation opened while company mode is off says so and reconnects in place", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target }, connectsBefore = companyConnects;
  Object.assign(target, { modelLabel: "agent-watch-auto", composerAvailable: false, sessionRevision: "revision_session_source_review_company_off" });
  companyState = "unavailable";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "vi-VN" });
  try {
    await page.goto(server.issueLaunchUrl());
    // The conversation read before stays its own: a failed read of the next one shows no history, never the previous one's.
    await page.getByText("Release preparation", { exact: true }).first().click();
    await expect(page.getByText("Open the persisted release checklist").first()).toBeVisible();
    transcriptUnavailable = true;
    await page.getByText("Review source changes", { exact: true }).first().click();
    await expect(page.getByText("Chưa tải được lịch sử cuộc trò chuyện", { exact: false })).toBeVisible();
    await expect(page.getByText("Open the persisted release checklist")).toHaveCount(0);
    transcriptUnavailable = false;
    const notice = page.getByRole("status").filter({ hasText: "Chế độ công ty đang tắt" });
    await expect(notice).toBeVisible();
    await expect(notice.getByText("macOS chưa cho Agent Watch đọc key", { exact: false })).toBeVisible();
    await notice.getByRole("button", { name: "Kết nối lại" }).click();
    await expect.poll(() => companyConnects).toBe(connectsBefore + 1);
    await expect(notice).toHaveCount(0);
    // Once connected the conversation is read again.
    await expect(page.getByText("Open the persisted release checklist").first()).toBeVisible();
  } finally {
    transcriptUnavailable = false;
    await page.close();
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

// A company conversation that cannot take a message while company mode runs
// (a turn just started) shows no reconnect banner and does not read its
// history again: before, the banner's first "ready" reloaded the whole
// transcript, the page lost its height and jumped to the top.
test("a running company conversation keeps its history and scroll position", async ({ browser }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_source_review"), saved = { ...target };
  Object.assign(target, { modelLabel: "agent-watch-auto", composerAvailable: true, sessionRevision: "revision_session_source_review_company_ready" });
  companyState = "ready";
  const page = await browser.newPage({ viewport: { width: 1440, height: 500 }, locale: "vi-VN" });
  try {
    await page.goto(server.issueLaunchUrl());
    await page.getByText("Review source changes", { exact: true }).first().click();
    await expect(page.getByText("Open the persisted release checklist").first()).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const bottom = await page.evaluate(() => window.scrollY);
    expect(bottom).toBeGreaterThan(0);
    // Every frame from here on: is the history on the page, and where is it scrolled?
    await page.evaluate(() => {
      window.__frames = [];
      const tick = () => { window.__frames.push({ history: document.body.innerText.includes("Open the persisted release checklist"), y: window.scrollY });
        if (window.__frames.length < 2_000) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    // A turn starts: the conversation cannot take another message for now.
    Object.assign(target, { composerAvailable: false, sessionRevision: "revision_session_source_review_company_busy" });
    catalog.catalogRevision = "revision_catalog_company_turn_started";
    protocol.events.publish("catalog.changed", { catalogRevision: catalog.catalogRevision });
    await expect(page.getByPlaceholder("Nhắn cho Piagent…")).toBeDisabled();
    // The banner polls the company status every 5 s: wait past one poll.
    await page.waitForTimeout(6_000);
    await expect(page.getByRole("status").filter({ hasText: "Chế độ công ty đang tắt" })).toHaveCount(0);
    const frames = await page.evaluate(() => window.__frames);
    expect(frames.length).toBeGreaterThan(100);
    expect(frames.filter((frame) => !frame.history).length, "frames without the history").toBe(0);
    expect(Math.min(...frames.map((frame) => frame.y)), "lowest scroll position").toBe(bottom);
  } finally {
    companyState = "unavailable";
    await page.close();
    for (const key of Object.keys(target)) if (!(key in saved)) delete target[key];
    Object.assign(target, saved);
  }
});

// Switching conversations used to scroll every one back to its first message,
// and the agent's notes between tool calls showed their markdown as text.
test("a conversation opens at its newest message, keeps its place across switching, and renders notes as markdown", async ({ page }) => {
  const base = transcriptFixture.items[0], text = (value) => ({ ...base.content, text: value, textChars: value.length });
  const note = "**Bước 1** đọc `cart.js`:\n\n- tính tổng\n- áp mã giảm giá";
  processTranscript = Array.from({ length: 12 }, (_, index) => [
    { ...base, messageRef: `message_scroll_user_${index}`, role: "user", recordedAt: `2026-08-14T08:${String(index).padStart(2, "0")}:00.000Z`,
      content: text(`Câu hỏi số ${index}: ${"giải thích thêm phần này. ".repeat(12)}`), toolCalls: [] },
    { ...base, messageRef: `message_scroll_note_${index}`, parentMessageRef: `message_scroll_user_${index}`, role: "assistant",
      recordedAt: `2026-08-14T08:${String(index).padStart(2, "0")}:01.000Z`, content: text(note), toolCalls: [] },
    { ...base, messageRef: `message_scroll_answer_${index}`, parentMessageRef: `message_scroll_user_${index}`, role: "assistant",
      recordedAt: `2026-08-14T08:${String(index).padStart(2, "0")}:02.000Z`, content: text(`Trả lời số ${index}. ${"Nội dung dài. ".repeat(30)}`), toolCalls: [] }
  ]).flat();
  await page.setViewportSize({ width: 1440, height: 700 });
  try {
    await page.goto(server.issueLaunchUrl());
    const open = (title) => page.getByText(title, { exact: true }).filter({ visible: true }).first().click();
    const place = () => page.evaluate(() => ({ y: Math.round(window.scrollY), bottom: document.documentElement.scrollHeight - window.innerHeight }));
    await open("Review source changes");
    await expect(page.getByText("Trả lời số 11.", { exact: false })).toBeVisible();
    await expect.poll(async () => { const now = await place(); return now.bottom - now.y; }).toBeLessThanOrEqual(2);
    // A note between tools is markdown: bold, code and a list, no literal asterisks.
    const notes = page.locator(".markdown-message").filter({ hasText: "Bước 1" });
    await expect(notes.first().locator("strong")).toHaveText("Bước 1");
    await expect(notes.first().locator("li")).toHaveCount(2);
    await expect(page.getByText("**Bước 1**", { exact: false })).toHaveCount(0);
    // Leave this conversation half way up, open another, then come back.
    const middle = Math.round((await place()).bottom / 2);
    await page.evaluate((y) => window.scrollTo(0, y), middle);
    await expect.poll(async () => (await place()).y).toBe(middle);
    await open("Release preparation");
    await expect.poll(async () => { const now = await place(); return now.bottom - now.y; }).toBeLessThanOrEqual(2);
    await open("Review source changes");
    await expect(page.getByText("Trả lời số 11.", { exact: false })).toBeAttached();
    await expect.poll(async () => (await place()).y).toBe(middle);
    // A conversation left at its newest message opens there again.
    await open("Release preparation");
    await expect.poll(async () => { const now = await place(); return now.bottom - now.y; }).toBeLessThanOrEqual(2);
  } finally { processTranscript = []; }
});

// An Enter that commits Vietnamese (or any input-method) text only finishes
// the word; Enter pressed twice before the page re-renders creates one
// conversation and sends one message. A member saw two identical
// conversations created two seconds apart.
test("an input-method Enter never sends, and a double Enter creates and sends once", async ({ page }) => {
  const originalSessions = [...catalog.sessions], originalRevision = catalog.catalogRevision, originalPage = { ...catalog.page };
  const createsBefore = sessionCreateAttempts, sendsBefore = sessionSendAttempts;
  // Two keydowns in the same task, as a fast double Enter reaches React before it re-renders.
  const enter = (locator, init = {}) => locator.evaluate((element, extra) => {
    for (let index = 0; index < (extra.times ?? 1); index += 1)
      element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...extra.init }));
  }, init);
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(page.getByRole("heading", { name: "Hôm nay làm gì?" })).toBeVisible();
    const draft = page.getByPlaceholder("Nhắn cho Piagent…");
    await draft.fill("Chào em, em là ai");
    await enter(draft, { init: { isComposing: true } });
    await enter(draft, { init: { keyCode: 229 } });
    await page.waitForTimeout(500);
    expect(sessionCreateAttempts - createsBefore, "an input-method Enter created a conversation").toBe(0);
    await enter(draft, { times: 2 });
    await expect(page.getByText("Chào em, em là ai", { exact: true }).first()).toBeVisible();
    await page.waitForTimeout(800);
    expect(sessionCreateAttempts - createsBefore, "conversations created").toBe(1);
    const composer = page.getByPlaceholder("Nhắn cho Piagent…");
    await expect(composer).toBeEnabled();
    await composer.fill("Tin nhắn thứ hai");
    const sendsAfterCreate = sessionSendAttempts;
    await enter(composer, { init: { isComposing: true } });
    await page.waitForTimeout(500);
    expect(sessionSendAttempts - sendsAfterCreate, "an input-method Enter sent a message").toBe(0);
    await enter(composer, { times: 2 });
    await expect.poll(() => sessionSendAttempts - sendsAfterCreate).toBeGreaterThanOrEqual(1);
    await page.waitForTimeout(800);
    expect(sessionSendAttempts - sendsAfterCreate, "messages sent").toBe(1);
    expect(sendsBefore).toBeLessThanOrEqual(sessionSendAttempts);
  } finally {
    catalog.sessions.splice(0, catalog.sessions.length, ...originalSessions);
    catalog.catalogRevision = originalRevision; Object.assign(catalog.page, originalPage);
  }
});

test("the status bar offers the update, Settings explains it, and the palette and shortcuts reach every setting", async ({ browser }) => {
  updateState = freshUpdate(); updateApplies.length = 0;
  test.setTimeout(90_000);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "vi-VN" });
  try {
    await page.goto(server.issueLaunchUrl());
    const bar = page.getByRole("contentinfo", { name: "Thanh trạng thái" });
    // A new release is announced in a dialog, not only by the status bar icon.
    const offer = page.getByRole("dialog", { name: "Có bản Piagent mới: 1.11.0" });
    await expect(offer.getByText("Piagent 1.10.0 → 1.11.0", { exact: true })).toBeVisible();
    await offer.getByRole("button", { name: "Xem chi tiết" }).click();
    await expect(offer).toHaveCount(0);
    await page.getByRole("dialog", { name: "Cài đặt" }).press("Escape");
    await expect(bar.getByText("Gateway live", { exact: true })).toBeVisible();
    await bar.getByRole("button", { name: /Cập nhật Piagent 1\.11\.0/ }).click();
    const settings = page.getByRole("dialog", { name: "Cài đặt" });
    await expect(settings.getByRole("heading", { name: "Cập nhật" })).toBeVisible();
    await expect(settings.getByText("Đang dùng 1.10.0", { exact: true })).toBeVisible();
    await expect(settings.getByText("Có bản 1.11.0", { exact: true })).toBeVisible();
    await expect(settings.getByText(/Pi đã có bản 1\.0\.2.*chưa tương thích/)).toBeVisible();
    await expect(settings.getByText(/Kiểm tra lần cuối: 5 phút trước · tự kiểm tra mỗi giờ/)).toBeVisible();
    // Settings search finds a setting by what it does, with or without accents.
    const search = settings.getByRole("textbox", { name: "Tìm cài đặt" });
    await search.fill("chu de");
    await expect(settings.getByRole("navigation").getByRole("button", { name: "Giao diện" })).toBeVisible();
    await expect(settings.getByRole("navigation").getByRole("button", { name: "Cập nhật" })).toHaveCount(0);
    await search.press("Enter");
    await expect(settings.getByRole("heading", { name: "Giao diện" })).toBeVisible();
    await expect(settings.getByText("Sáng hoặc tối, lưu trên trình duyệt này.", { exact: true })).toBeVisible();
    await search.fill("");
    await settings.getByRole("navigation").getByRole("button", { name: /^Cập nhật/ }).click();
    // While a conversation runs, the update waits for it.
    updateState = { ...updateState, runningConversations: 1 };
    await settings.getByRole("button", { name: "Kiểm tra ngay" }).click();
    await expect(settings.getByRole("button", { name: "Cập nhật lên Piagent 1.11.0" })).toBeDisabled();
    await expect(settings.getByText("1 cuộc trò chuyện đang chạy; nút mở lại khi chúng xong.", { exact: true })).toBeVisible();
    updateState = { ...updateState, runningConversations: 0 };
    await settings.getByRole("button", { name: "Kiểm tra ngay" }).click();
    await settings.getByRole("button", { name: "Cập nhật lên Piagent 1.11.0" }).click();
    // The member reads what will change before it starts; the request names the version seen.
    const confirm = page.getByRole("dialog", { name: "Cập nhật Piagent?" });
    await expect(confirm.getByText("Piagent 1.10.0 → 1.11.0", { exact: true })).toBeVisible();
    await expect(confirm.getByText(/Dashboard khởi động lại và mở trong tab mới/)).toBeVisible();
    await confirm.getByRole("button", { name: "Cập nhật", exact: true }).click();
    await expect.poll(() => updateApplies.length).toBe(1);
    expect(updateApplies[0]).toEqual({ version: "1.11.0" });
    await expect(settings.getByText(/Đang cập nhật lên Piagent 1\.11\.0… Xong, dashboard mở lại trong tab mới/)).toBeVisible();
    // Focus stays in Settings when the button goes away, so Escape still closes it.
    await page.keyboard.press("Escape");
    await expect(settings).toHaveCount(0);
    await expect(bar.getByText("Đang cập nhật lên 1.11.0…", { exact: true })).toBeVisible();
    // Ctrl+K: the palette reaches settings and conversations by name, accents optional.
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "Bảng lệnh" });
    const input = palette.getByRole("combobox", { name: "Tìm lệnh" });
    await input.fill("phim tat");
    await expect(palette.getByRole("option").first()).toContainText("Cài đặt: Phím tắt");
    await input.press("Enter");
    await expect(page.getByRole("dialog", { name: "Cài đặt" }).getByRole("heading", { name: "Phím tắt" })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await input.fill("release prep");
    await expect(palette.getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Escape");
    // Ctrl+, opens Settings.
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog", { name: "Cài đặt" })).toBeVisible();
    await page.keyboard.press("Escape");
    // A narrow screen has no status bar: the Settings button carries the update.
    updateState = freshUpdate();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    // "Later" puts the offer off for an hour, across a reload.
    const again = page.getByRole("dialog", { name: "Có bản Piagent mới: 1.11.0" });
    await again.getByRole("button", { name: /Để sau/ }).click();
    await expect(again).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "Mở điều hướng" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Có bản Piagent mới: 1.11.0" })).toHaveCount(0);
    await expect(page.getByRole("contentinfo", { name: "Thanh trạng thái" })).toHaveCount(0);
    await page.getByRole("button", { name: "Mở điều hướng" }).click();
    await expect(page.getByRole("img", { name: "Có bản cập nhật" })).toBeVisible();
    await page.getByRole("button", { name: /^Cài đặt/ }).click();
    await expect(page.getByRole("dialog", { name: "Cài đặt" }).getByRole("heading", { name: "Cập nhật" })).toBeVisible();
  } finally { updateState = upToDate(); await page.close(); }
});

test("@ in a composer offers the project's files and folders, then any folder on the Mac, and writes the path", async ({ page }) => {
  const sendsBefore = sessionSendAttempts;
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  const composer = page.getByPlaceholder("Nhắn cho Piagent…"), list = page.getByRole("listbox", { name: "File và folder" });
  await composer.fill("");
  await composer.pressSequentially("Xem @pric");
  await expect(list.getByRole("option", { name: /pricing\.js/ })).toBeVisible();
  await expect(composer).toHaveAttribute("aria-activedescendant", /.+/);
  await page.waitForTimeout(200);
  // The menu and the composer it belongs to (the transcript has its own audit).
  const audit = await new AxeBuilder({ page }).include("[role=listbox]").include("textarea[aria-autocomplete]").analyze();
  assert.deepEqual(audit.violations.map((violation) => violation.id), [], JSON.stringify(audit.violations.map((violation) => ({
    id: violation.id, nodes: violation.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })) }))));
  // Enter picks the suggestion instead of sending.
  await composer.press("Enter");
  await expect(composer).toHaveValue("Xem @src/pricing.js ");
  await expect(list).toHaveCount(0);
  expect(sessionSendAttempts).toBe(sendsBefore);
  // ~/ walks the Mac: hidden folders only when asked for, folders stay open.
  await composer.pressSequentially("và @~/");
  await expect(list.getByRole("option", { name: /Documents\// })).toBeVisible();
  await expect(list.getByRole("option", { name: /\.ssh/ })).toHaveCount(0);
  await list.getByRole("option", { name: /Documents\// }).click();
  await expect(composer).toHaveValue("Xem @src/pricing.js và @~/Documents/");
  await expect(list.getByRole("option", { name: /old shop\// })).toBeVisible();
  await composer.press("Tab");
  await expect(composer).toHaveValue('Xem @src/pricing.js và @"~/Documents/old shop/"');
  await expect(list.getByRole("option", { name: /notes\.md/ })).toBeVisible();
  await list.getByRole("option", { name: /notes\.md/ }).click();
  await expect(composer).toHaveValue('Xem @src/pricing.js và @"~/Documents/old shop/notes.md" ');
  // An email address never opens the menu; Escape closes it.
  await composer.pressSequentially("hỏi an@example.com");
  await page.waitForTimeout(300);
  await expect(list).toHaveCount(0);
  await composer.pressSequentially(" @");
  await expect(list.getByRole("option", { name: /src\// })).toBeVisible();
  await composer.press("Escape");
  await expect(list).toHaveCount(0);
  expect(sessionSendAttempts).toBe(sendsBefore);
  // The new chat composer offers the chosen project's files too.
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  const draft = page.getByPlaceholder("Nhắn cho Piagent…");
  await draft.pressSequentially("Đọc @docs/");
  await expect(list.getByRole("option", { name: /notes\.md/ })).toBeVisible();
  await draft.press("Enter");
  await expect(draft).toHaveValue("Đọc @docs/notes.md ");
});

test("an unsent message stays in its conversation and in the new chat, across switching and a reload, until it is sent", async ({ page }) => {
  const originalSessions = [...catalog.sessions], originalRevision = catalog.catalogRevision, originalPage = { ...catalog.page };
  const open = async (title) => {
    await page.getByText(title, { exact: true }).filter({ visible: true }).first().click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  };
  try {
    await page.goto(server.issueLaunchUrl());
    const composer = page.getByPlaceholder("Nhắn cho Piagent…");
    await open("Release preparation");
    await composer.fill("Nháp ở Release preparation");
    await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
    await page.getByRole("button", { name: /Đính kèm/ }).locator('input[type="file"]').setInputFiles({
      name: "kept-brief.md", mimeType: "text/markdown", buffer: Buffer.from("# Kept brief\n") });
    await expect(page.getByText(/kept-brief\.md · /)).toBeVisible();
    await open("Review source changes");
    await expect(composer).toHaveValue("");
    await composer.fill("Nháp ở Review source changes");
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    const newChat = page.getByPlaceholder("Nhắn cho Piagent…");
    await expect(newChat).toHaveValue("");
    await newChat.fill("Nháp cho chat mới");
    await page.getByRole("button", { name: "Quay lại" }).click();
    await open("Release preparation");
    await expect(composer).toHaveValue("Nháp ở Release preparation");
    await expect(page.getByText(/kept-brief\.md · /)).toBeVisible();
    await open("Review source changes");
    await expect(composer).toHaveValue("Nháp ở Review source changes");
    await expect(page.getByText(/kept-brief\.md · /)).toHaveCount(0);
    // The text survives a reload of the page (staged files belong to the page).
    await page.reload();
    await open("Release preparation");
    await expect(composer).toHaveValue("Nháp ở Release preparation");
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(newChat).toHaveValue("Nháp cho chat mới");
    await page.getByRole("button", { name: "Quay lại" }).click();
    // A sent message leaves an empty composer that stays empty.
    await open("Review source changes");
    await expect(composer).toHaveValue("Nháp ở Review source changes");
    const sendsBefore = sessionSendAttempts;
    await page.getByRole("button", { name: "Gửi" }).click();
    await expect.poll(() => sessionSendAttempts).toBe(sendsBefore + 1);
    await expect(composer).toHaveValue("");
    await open("Release preparation");
    await open("Review source changes");
    await expect(composer).toHaveValue("");
    await page.reload();
    await open("Review source changes");
    await expect(composer).toHaveValue("");
    // Creating the chat takes its draft: the next new chat starts empty.
    const createsBefore = sessionCreateAttempts;
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(newChat).toHaveValue("Nháp cho chat mới");
    await newChat.press("Enter");
    await expect.poll(() => sessionCreateAttempts).toBe(createsBefore + 1);
    await expect(page.getByText("Nháp cho chat mới", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
    await expect(newChat).toHaveValue("");
  } finally {
    catalog.sessions.splice(0, catalog.sessions.length, ...originalSessions);
    catalog.catalogRevision = originalRevision; Object.assign(catalog.page, originalPage);
  }
});

test("/ at the start of a message offers the project's and the member's commands and skills", async ({ page }) => {
  const sendsBefore = sessionSendAttempts;
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  const composer = page.getByPlaceholder("Nhắn cho Piagent…"), list = page.getByRole("listbox", { name: "Lệnh và skill" });
  await composer.fill("");
  await composer.pressSequentially("/");
  // The project's and the member's commands and skills, with the conversation's own (Piagent) commands.
  await expect(list.getByRole("option", { name: /\/review.*\[focus\].*Review the staged changes.*\.claude/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /\/model.*Đổi model.*Piagent/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /^\/undo/ })).toHaveCount(0);
  await expect(list.getByRole("option", { name: /\/skill:pdf.*~\/\.codex/ })).toBeVisible();
  await composer.pressSequentially("dep");
  await expect(list.getByRole("option")).toHaveCount(1);
  await composer.press("Enter");
  await expect(composer).toHaveValue("/skill:deploy ");
  expect(sessionSendAttempts).toBe(sendsBefore);
  await composer.fill("");
  await composer.pressSequentially("/rev");
  await composer.press("Tab");
  await expect(composer).toHaveValue("/review ");
  // Mid-message, a / is text: no menu.
  await composer.pressSequentially("checkout /tmp");
  await expect(list).toHaveCount(0);
  await composer.fill("");
});

test("a company conversation offers its own /undo among the commands; a personal one does not", async ({ page }) => {
  const target = catalog.sessions.find((item) => item.sessionRef === "session_release_prep"), saved = { ...target };
  Object.assign(target, { modelLabel: "agent-watch-auto", sessionRevision: "revision_session_release_prep_undo" });
  try {
    const sendsBefore = sessionSendAttempts;
    await page.goto(server.issueLaunchUrl());
    await page.getByRole("button", { name: /Release prep/ }).first().click();
    const composer = page.getByPlaceholder("Nhắn cho Piagent…"), list = page.getByRole("listbox", { name: "Lệnh và skill" });
    await composer.fill("");
    await composer.pressSequentially("/");
    await expect(list.getByRole("option", { name: /\/undo.*Hoàn tác file mà lượt trước của agent đã sửa.*Piagent/ })).toBeVisible();
    await expect(list.getByRole("option", { name: /^\/model/ })).toHaveCount(0);
    await composer.pressSequentially("und");
    await expect(list.getByRole("option")).toHaveCount(1);
    await composer.press("Enter");
    await expect(composer).toHaveValue("/undo ");
    expect(sessionSendAttempts).toBe(sendsBefore);
    await composer.fill("");
  } finally { Object.assign(target, saved); }
});

test("a / command runs in the conversation without a model request; /help lists the shortcuts; ⌘⇧O opens a new chat", async ({ page }) => {
  const sendsBefore = sessionSendAttempts, renamesBefore = observedSessionActions.filter((action) => action === "session.rename").length;
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  const composer = page.getByPlaceholder("Nhắn cho Piagent…");
  await composer.fill("/name Chuẩn bị phát hành");
  await composer.press("Escape"); // closes the suggestions; Enter then runs the command
  await composer.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Đã đổi tên thành “Chuẩn bị phát hành”." })).toBeVisible();
  await expect.poll(() => observedSessionActions.filter((action) => action === "session.rename").length).toBe(renamesBefore + 1);
  await expect(composer).toHaveValue("");
  // A usage note keeps what was typed.
  await composer.fill("/thinking nhanh");
  await composer.press("Escape"); await composer.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "Cách dùng: /thinking" })).toBeVisible();
  await expect(composer).toHaveValue("/thinking nhanh");
  await composer.fill("/help");
  await composer.press("Escape"); await composer.press("Enter");
  const help = page.getByRole("alert").filter({ hasText: "/help — Danh sách lệnh / và phím tắt" });
  await expect(help).toContainText("⌘⇧O — Cuộc trò chuyện mới");
  await expect(help).toContainText("Esc — Dừng lượt đang chạy");
  expect(sessionSendAttempts).toBe(sendsBefore);
  const newChat = page.getByRole("heading", { name: /Cuộc trò chuyện mới|New chat/ });
  await expect(newChat).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(newChat.first()).toBeVisible();
});

test("a tab that lost its browser session says how to open Piagent again and stops polling", async ({ page }) => {
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Review source changes", { exact: true }).filter({ visible: true })).toBeVisible();
  // The Gateway restarted or another launch replaced the cookie: every read is now refused.
  await page.context().clearCookies();
  // A background poll may be refused first and replace the page (and the
  // button) with the expired screen: either way ends there.
  const expired = page.getByRole("heading", { name: "Tab này đã hết phiên đăng nhập" });
  const clicked = page.getByRole("button", { name: "Làm mới" }).click().catch(() => undefined);
  await Promise.race([expired.waitFor(), clicked]);
  await expect(expired).toBeVisible();
  await expect(page.getByText("piagent dashboard", { exact: true })).toBeVisible();
  const reads = [];
  page.on("request", (request) => { if (request.url().includes("/api/v1/")) reads.push(request.url()); });
  await page.waitForTimeout(4_500);
  assert.deepEqual(reads, []);
  assert.ok(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth));
});

test("the update dialog waits for running conversations, then updates in one click and shows the progress", async ({ browser }) => {
  updateState = { ...freshUpdate(), runningConversations: 1 }; updateApplies.length = 0;
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "vi-VN" });
  try {
    await page.goto(server.issueLaunchUrl());
    const offer = page.getByRole("dialog", { name: "Có bản Piagent mới: 1.11.0" });
    await expect(offer.getByText(/1 cuộc trò chuyện đang chạy/)).toBeVisible();
    await expect(offer.getByRole("button", { name: "Cập nhật ngay" })).toBeDisabled();
    updateState = freshUpdate();
    await page.reload();
    await page.getByRole("dialog", { name: "Có bản Piagent mới: 1.11.0" }).getByRole("button", { name: "Cập nhật ngay" }).click();
    await expect.poll(() => updateApplies.length).toBe(1);
    expect(updateApplies[0]).toEqual({ version: "1.11.0" });
    await expect(page.getByRole("dialog", { name: "Cài đặt" }).getByText(/Đang cập nhật lên Piagent 1\.11\.0…/)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Có bản Piagent mới: 1.11.0" })).toHaveCount(0);
  } finally { updateState = upToDate(); await page.close(); }
});

test("comments lines of two files on the diff, shows the review helper's findings inline, and sends the comments as one message", async ({ page }) => {
  const row = catalog.sessions.find((item) => item.sessionRef === "session_release_prep");
  row.managedReview = { stale: false, findings: [
    { severity: "blocking", file: "./src/example.ts", line: 1, issue: "The value changed without a test." },
    { severity: "minor", file: "api/refund.go", line: null, issue: "Name the cents constant." }] };
  row.sessionRevision = "revision_release_prep_review"; catalog.catalogRevision = "revision_catalog_line_review"; secondSourceFile = true;
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.issueLaunchUrl());
    // Earlier tests add conversations; open this one from the sidebar.
    await page.getByRole("navigation").getByText("Release preparation", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
    await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
    await page.getByRole("tab", { name: /Source Changes/ }).click();
    await expect(page.getByRole("button", { name: /src\/example\.ts/ })).toHaveAttribute("aria-pressed", "true");
    // The review helper's finding sits under the line it names.
    const finding = page.getByRole("note").filter({ hasText: "The value changed without a test." });
    await expect(finding).toContainText("Review · Chặn");
    await page.getByRole("button", { name: "Comment dòng 1" }).last().click();
    await page.getByRole("textbox", { name: "Comment cho dòng này" }).fill("Keep the old value or add a test.");
    await page.getByRole("button", { name: "Lưu comment" }).click();
    await expect(page.locator(".line-comment").filter({ hasText: "Keep the old value or add a test." })).toBeVisible();
    await page.getByRole("button", { name: /api\/refund\.go/ }).click();
    // A finding without a line is shown for the whole file.
    await expect(page.getByRole("note").filter({ hasText: "Name the cents constant." })).toBeVisible();
    await page.getByRole("button", { name: "Comment dòng 2" }).click();
    await page.getByRole("textbox", { name: "Comment cho dòng này" }).fill("Money must stay in integer cents.");
    await page.getByRole("button", { name: "Lưu comment" }).click();
    const bar = page.getByRole("region", { name: "Comment chờ gửi" });
    await expect(bar).toContainText("2 comment chờ gửi");
    if (process.env.PIAGENT_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.PIAGENT_SHOTS_DIR, "webui-line-review.png") });
    await bar.getByRole("button", { name: "Đưa vào ô chat" }).click();
    const expected = ["Review comment trên diff (2). Xử lý từng comment đúng file và dòng:",
      "1. api/refund.go:2\n```\n\tamount := float64(c) / 100\n```\nMoney must stay in integer cents.",
      "2. src/example.ts:1\n```\nexport const value = 2;\n```\nKeep the old value or add a test."].join("\n\n");
    const composer = page.getByPlaceholder("Nhắn cho Piagent…");
    await expect(composer).toHaveValue(expected);
    await expect(composer).toBeFocused();
    await expect(page.getByText("Agent Inspector", { exact: true })).toBeHidden();
    if (process.env.PIAGENT_SHOTS_DIR) await page.screenshot({ path: path.join(process.env.PIAGENT_SHOTS_DIR, "webui-line-review-composer.png") });
    await page.getByRole("button", { name: "Gửi" }).click();
    await expect.poll(() => lastSendPayload?.message).toBe(expected);
    // Sent comments are gone from the review.
    await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
    await page.getByRole("tab", { name: /Source Changes/ }).click();
    await expect(page.getByRole("region", { name: "Comment chờ gửi" })).toHaveCount(0);
    assert.deepEqual(errors, []);
  } finally {
    delete row.managedReview; secondSourceFile = false;
  }
});

test("workspace explorer opens real files in nonce-styled read-only tabs and locks protected files", async ({ page }) => {
  workspaceMention = " @src/search.md:3";
  fs.writeFileSync(path.join(mentionProject, "src/example.ts"), "export const fromDiff = true;\n");
  fs.writeFileSync(path.join(mentionProject, "src/search.md"), "first line\nsecond line\n  needle third line\n");
  fs.writeFileSync(path.join(mentionProject, ".env"), "EXPLORER_TEST_SECRET=never-render\n");
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /Content Security Policy/.test(message.text())) errors.push(message.text()); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("navigation").getByText("Release preparation", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
  await page.getByRole("button", { name: /^(Tệp|Files)$/ }).click();
  await expect(page.getByRole("button", { name: /\.env.*(được bảo vệ|protected)/ })).toBeDisabled();
  await page.getByRole("button", { name: "src", exact: true }).click();
  await page.getByRole("button", { name: "pricing.js", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("export const vat = 0.1;");
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "false");
  await page.getByRole("button", { name: "cart.js", exact: true }).click();
  await expect(page.getByRole("tab", { name: "src/pricing.js", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "src/cart.js", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "src/pricing.js", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("export const vat = 0.1;");
  await page.keyboard.press("Control+p");
  const quick = page.getByRole("dialog");
  await expect(quick).toBeVisible();
  await quick.getByRole("textbox", { name: /Tên tệp|File name/ }).fill("cart");
  await quick.getByRole("button", { name: "src/cart.js", exact: true }).click();
  await expect(quick).not.toBeVisible();
  await expect(page.locator(".cm-content")).toContainText("export {};");
  await page.getByRole("tab", { name: /^(Tìm kiếm|Search)$/ }).click();
  await page.getByRole("textbox", { name: /Tìm nội dung|Search contents/ }).fill("needle");
  await page.getByRole("button", { name: /src\/search.md:3:3/ }).click();
  await expect(page.locator(".cm-content")).toContainText("needle third line");
  await expect(page.locator(".cm-activeLineGutter")).toHaveText("3");
  await page.getByRole("button", { name: "@src/search.md:3", exact: true }).click();
  await expect(page.locator(".cm-activeLineGutter")).toHaveText("3");
  await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
  await page.getByRole("tab", { name: /Source Changes/ }).click();
  await page.getByRole("button", { name: /Mở trong editor|Open in editor/ }).last().click();
  await expect(page.locator(".cm-content")).toContainText("export const fromDiff = true;");
  assert.equal(await page.locator("body").innerText().then(text => text.includes("never-render")), false);
  assert.deepEqual(errors, []);
});

for (const width of [390, 1000]) {
  test(`workspace files and search remain usable in a drawer at ${width}px`, async ({ page }) => {
    fs.writeFileSync(path.join(mentionProject, "src/narrow.md"), "first\nneedle narrow\n");
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(server.issueLaunchUrl());
    await page.getByRole("navigation").getByText("Release preparation", { exact: true }).click();
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
    await page.getByRole("button", { name: /^(Tệp|Files)$/ }).click();
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "narrow.md", exact: true }).click();
    await expect(page.locator(".cm-content")).toContainText("needle narrow");
    await page.getByRole("tab", { name: /^(Tìm kiếm|Search)$/ }).click();
    await page.getByRole("textbox", { name: /Tìm nội dung|Search contents/ }).fill("needle narrow");
    await page.getByRole("button", { name: /src\/narrow.md:2:1/ }).click();
    await expect(page.locator(".cm-activeLineGutter")).toHaveText("2");
    await page.getByRole("button", { name: /^(Đóng|Close)$/ }).click();
    await expect(page.locator(".cm-content")).not.toBeVisible();
    await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
  });
}

test("tool file links open at their line and editor tabs do not leak to another session", async ({ page }) => {
  fs.writeFileSync(path.join(mentionProject, "src/tool-link.ts"), "// first\nexport const toolTarget = true;\n");
  const base = transcriptFixture.items[0];
  processTranscript = [{ ...base, messageRef: "message_workspace_tool", parentMessageRef: "message_history_user", role: "assistant",
    recordedAt: "2026-08-14T09:00:00.000Z", content: { ...base.content, text: "Read the requested source.", textChars: 26 },
    toolCalls: [{ toolCallRef: "tool_workspace_link", toolName: "read", state: "completed",
      summary: { kind: "read", target: "src/tool-link.ts", detail: "2–2" } }] }];
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("navigation").getByText("Release preparation", { exact: true }).click();
  await page.getByRole("button", { name: /Mở trong editor|Open in editor/ }).click();
  await expect(page.locator(".cm-content")).toContainText("export const toolTarget = true;");
  await expect(page.locator(".cm-activeLineGutter")).toHaveText("2");
  await page.getByRole("tab", { name: /^(Phiên|Sessions)$/ }).click();
  await page.getByText("Review source changes", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review source changes" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "src/tool-link.ts", exact: true })).toHaveCount(0);
  await expect(page.locator(".cm-content")).toHaveCount(0);
});


test("workspace editor saves with Cmd/Ctrl+S, preserves drafts and resolves digest conflicts explicitly", async ({ page }) => {
  workspaceWritable = true;
  fs.writeFileSync(path.join(mentionProject, 'src/editor.txt'), 'original text');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(server.issueLaunchUrl());
    await page.getByRole('navigation').getByText('Release preparation', { exact: true }).click();
    await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
    await page.getByRole('button', { name: 'src', exact: true }).click();
    await page.getByRole('button', { name: 'editor.txt', exact: true }).click();
    const editor = page.locator('.cm-content').first();
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await editor.fill('member edit');
    await expect(page.getByRole('tab', { name: 'src/editor.txt ●', exact: true })).toBeVisible();
    await editor.press('Control+s');
    await expect.poll(() => fs.readFileSync(path.join(mentionProject, 'src/editor.txt'), 'utf8')).toBe('member edit');
    await expect(page.getByRole('tab', { name: 'src/editor.txt', exact: true })).toBeVisible();
    await editor.fill('unsaved draft');
    await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
    await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
    await expect(editor).toContainText('unsaved draft');
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: /Đóng tệp|Close file/ }).click();
    await expect(editor).toContainText('unsaved draft');
    fs.writeFileSync(path.join(mentionProject, 'src/editor.txt'), 'agent changed');
    await editor.press('Control+s');
    const conflict = page.getByRole('dialog'); await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: /Xem khác biệt|Compare/ }).click();
    await expect(conflict).toContainText('agent changed'); await expect(conflict).toContainText('unsaved draft');
    page.once('dialog', dialog => dialog.dismiss());
    await conflict.getByRole('button', { name: /Ghi đè|Overwrite/ }).click();
    assert.equal(fs.readFileSync(path.join(mentionProject, 'src/editor.txt'), 'utf8'), 'agent changed');
    page.once('dialog', dialog => dialog.accept());
    await conflict.getByRole('button', { name: /Ghi đè|Overwrite/ }).click();
    await expect(conflict).not.toBeVisible();
    await expect.poll(() => fs.readFileSync(path.join(mentionProject, 'src/editor.txt'), 'utf8')).toBe('unsaved draft');
    await expect(page.getByText(/Agent đang chạy và có thể sửa tệp này|The agent is running and may change this file/)).toBeVisible();
    await editor.fill('discard this draft'); fs.writeFileSync(path.join(mentionProject, 'src/editor.txt'), 'latest from agent');
    await editor.press('Meta+s'); await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: /Tải lại|Reload/ }).click();
    await expect(conflict).not.toBeVisible(); await expect(editor).toContainText('latest from agent');
    await page.getByRole('button', { name: /Tệp mới|New file/, exact: true }).click();
    await page.getByRole('textbox', { name: /Đường dẫn trong project|Path in project/ }).fill('src/new-editor.txt');
    await page.getByRole('dialog').getByRole('button', { name: /^(Tạo|Create)$/ }).click();
    const retryKeys = [];
    await page.route('**/workspace/write', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      retryKeys.push(route.request().postDataJSON().idempotencyKey);
      if (retryKeys.length === 1) { await route.fetch(); await route.abort(); } else await route.continue();
    });
    await editor.fill('new file'); await editor.press('Control+s');
    await expect(page.getByText(/Chưa lưu được tệp. Bản sửa vẫn được giữ|Could not confirm the save/)).toBeVisible();
    await page.getByRole('button', { name: /^(Lưu|Save)$/ }).click();
    await expect(page.getByRole('tab', { name: 'src/new-editor.txt', exact: true })).toBeVisible();
    assert.equal(retryKeys.length, 2); assert.equal(retryKeys[0], retryKeys[1]);
    await expect.poll(() => fs.existsSync(path.join(mentionProject, 'src/new-editor.txt')) && fs.readFileSync(path.join(mentionProject, 'src/new-editor.txt'), 'utf8')).toBe('new file');
    await page.unroute('**/workspace/write');
    await page.getByRole('button', { name: /^(Đổi tên|Rename)$/ }).click();
    await page.getByRole('textbox', { name: /Đường dẫn mới trong project|New path in project/ }).fill('src/renamed/editor.txt');
    await page.getByRole('dialog').getByRole('button', { name: /^(Đổi tên|Rename)$/ }).click();
    await expect(page.getByRole('tab', { name: 'src/renamed/editor.txt', exact: true })).toBeVisible();
    assert.equal(fs.existsSync(path.join(mentionProject, 'src/new-editor.txt')), false);
    assert.equal(fs.readFileSync(path.join(mentionProject, 'src/renamed/editor.txt'), 'utf8'), 'new file');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /^(Xóa|Delete)$/ }).click();
    await expect(page.getByRole('tab', { name: 'src/renamed/editor.txt', exact: true })).toHaveCount(0);
    await expect.poll(() => fs.existsSync(path.join(mentionProject, 'src/renamed/editor.txt'))).toBe(false);
    assert.deepEqual(errors, []);
  } finally { workspaceWritable = false; }
});

test('editor shows exact agent hunks, keeps without writing and hides review when draft changes', async ({ page }) => {
  const { createHash } = await import('node:crypto');
  workspaceWritable = true;
  const content = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const filePath = path.join(mentionProject, 'src/review.txt'); fs.writeFileSync(filePath, content);
  const diff = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/diff-v1.valid.json', import.meta.url)));
  diff.file.path = 'src/review.txt'; diff.file.currentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  diff.hunks = [1, 8].map(line => ({ hunkRef: `hunk.editor.${line}`, oldStart: line, oldLineCount: 1, newStart: line, newLineCount: 1,
    header: `@@ -${line} +${line} @@`, lines: [
      { kind: 'deleted', marker: '-', lineRef: `old.${line}`, oldLineNumber: line, newLineNumber: null, text: `old line ${line}`, redacted: false },
      { kind: 'added', marker: '+', lineRef: `new.${line}`, oldLineNumber: null, newLineNumber: line, text: `line ${line}`, redacted: false }
    ] }));
  diff.agentHunkRefs = diff.hunks.map(hunk => hunk.hunkRef);
  await page.route('**/source-review', route => route.fulfill({ json: { files: [{ ...diff.file, pathDisplay: 'exact-safe' }] } }));
  await page.route('**/source-review/*', route => route.fulfill({ json: diff }));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy/.test(message.text())) errors.push(message.text()); });
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(server.issueLaunchUrl());
    await page.getByRole('navigation').getByText('Release preparation', { exact: true }).click();
    await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
    await page.getByRole('button', { name: 'src', exact: true }).click();
    await page.getByRole('button', { name: 'review.txt', exact: true }).click();
    await expect(page.locator('.cm-agent-added')).toHaveCount(2);
    await expect(page.locator('.cm-agent-deleted')).toHaveCount(2);
    await expect(page.locator('.cm-agent-marker')).toHaveCount(2);
    await expect(page.getByRole('tab', { name: 'src/review.txt (2)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^(Comment dòng đã xóa|Comment on removed line) 1$/ }).click();
    const commentDialog = page.getByRole('dialog', { name: /Comment theo dòng|Line comment/ });
    await commentDialog.getByRole('textbox', { name: /Comment cho dòng này|Comment on this line/ }).fill('Please explain this removal.');
    await commentDialog.getByRole('button', { name: /Lưu comment|Save comment/ }).click();
    const commentBar = page.getByRole('region', { name: /Comment chờ gửi|Comments to send/ });
    await commentBar.getByRole('button', { name: /Đưa vào ô chat|Put in the composer/ }).click();
    await expect(page.getByPlaceholder('Nhắn cho Piagent…')).toHaveValue(/src\/review.txt:1 \((dòng đã xóa|removed line)\)[\s\S]*old line 1[\s\S]*Please explain this removal\./);
    const editor = page.locator('.cm-content').first(); await editor.focus(); await editor.press('Alt+ArrowDown');
    await expect(page.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText('8');
    await page.getByRole('button', { name: /^(Giữ|Keep)$/ }).first().click();
    await expect(page.getByRole('tab', { name: 'src/review.txt (1)', exact: true })).toBeVisible();
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    await editor.fill('member draft');
    await expect(page.locator('.cm-agent-added')).toHaveCount(0);
    await expect(page.locator('.cm-agent-deleted')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'src/review.txt ●', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { workspaceWritable = false; }
});

test('agent events reload clean editor tabs and preserve dirty drafts in the conflict dialog', async ({ page }) => {
  workspaceWritable = true;
  const file = path.join(mentionProject, 'src/refresh.txt'); fs.writeFileSync(file, 'initial content');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(server.issueLaunchUrl());
    await page.getByRole('navigation').getByText('Release preparation', { exact: true }).click();
    await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
    await page.getByRole('button', { name: 'src', exact: true }).click();
    await page.getByRole('button', { name: 'refresh.txt', exact: true }).click();
    const editor = page.locator('.cm-content').first();
    await expect(editor).toHaveText('initial content');
    fs.writeFileSync(file, 'agent changed clean file');
    protocol.events.publish('session.changed', { sessionRef: 'session_release_prep' });
    await expect(editor).toHaveText('agent changed clean file');
    await expect(page.getByRole('tab', { name: 'src/refresh.txt', exact: true })).toBeVisible();
    await editor.fill('member unsaved draft');
    fs.writeFileSync(file, 'agent changed dirty file');
    protocol.events.publish('session.changed', { sessionRef: 'session_release_prep' });
    const dialog = page.getByRole('dialog', { name: /Tệp đã thay đổi trên đĩa|The file changed on disk/ });
    await expect(dialog).toBeVisible();
    await expect(editor).toHaveText('member unsaved draft');
    await expect(page.getByRole('tab', { name: 'src/refresh.txt ●', exact: true, includeHidden: true })).toBeVisible();
    expect(fs.readFileSync(file, 'utf8')).toBe('agent changed dirty file');
    await dialog.getByRole('button', { name: /^(Tải lại|Reload)$/ }).click();
    await expect(editor).toHaveText('agent changed dirty file');
    expect(errors).toEqual([]);
  } finally { workspaceWritable = false; }
});

test('inline revert previews one hunk and retries a lost response with the identical command', async ({ page }) => {
  const { createHash } = await import('node:crypto'); workspaceWritable = true;
  const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
  const original = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const after = original.replace('line 1\n', 'old line 1\n');
  const filePath = path.join(mentionProject, 'src/revert.txt'); fs.writeFileSync(filePath, original);
  const diff = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/diff-v1.valid.json', import.meta.url)));
  diff.file.path = 'src/revert.txt'; diff.file.currentDigest = hash(original);
  diff.hunks = [1, 8].map(line => ({ hunkRef: `hunk.revert.${line}`, oldStart: line, oldLineCount: 1, newStart: line, newLineCount: 1,
    header: `@@ -${line} +${line} @@`, lines: [
      { kind: 'deleted', marker: '-', lineRef: `old.${line}`, oldLineNumber: line, newLineNumber: null, text: `old line ${line}`, redacted: false },
      { kind: 'added', marker: '+', lineRef: `new.${line}`, oldLineNumber: null, newLineNumber: line, text: `line ${line}`, redacted: false }
    ] }));
  diff.agentHunkRefs = diff.hunks.map(hunk => hunk.hunkRef);
  const preview = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/source-revert-v1.valid.json', import.meta.url)));
  preview.target.path = diff.file.path; preview.target.fileRef = diff.file.fileRef; preview.target.fileRevision = diff.file.fileRevision;
  preview.target.hunkRefs = [diff.hunks[0].hunkRef]; preview.target.expiresAt = new Date(Date.now() + 240000).toISOString();
  preview.preview.hunks = [{ hunkRef: diff.hunks[0].hunkRef, header: diff.hunks[0].header,
    lines: diff.hunks[0].lines.map(({ kind, marker, text }) => ({ kind, marker, text })) }];
  preview.commandBinding = { runtimeRevision: 'runtime.inline', controlRevision: 'control.inline' };
  await page.route('**/source-review', route => route.fulfill({ json: { files: [{ ...diff.file, pathDisplay: 'exact-safe' }] } }));
  await page.route('**/source-review/*', route => route.fulfill({ json: diff }));
  await page.route('**/source-reverts/*', route => route.fulfill({ json: preview }));
  const commands = []; let effects = 0;
  await page.route('**/source-reverts', async route => {
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) {
      effects++; fs.writeFileSync(filePath, after);
      diff.file.currentDigest = hash(after); diff.hunks = diff.hunks.slice(1); diff.agentHunkRefs = diff.hunks.map(hunk => hunk.hunkRef);
      await route.abort('failed');
    } else await route.fulfill({ json: { phase: 'settled', resultCode: 'reverted', deduplicated: true } });
  });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto(server.issueLaunchUrl());
    await page.getByRole('navigation').getByText('Release preparation', { exact: true }).click();
    await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
    await page.getByRole('button', { name: 'src', exact: true }).click();
    await page.getByRole('button', { name: 'revert.txt', exact: true }).click();
    await page.getByRole('button', { name: /^(Hoàn tác|Revert)$/ }).first().click();
    const dialog = page.getByRole('dialog', { name: /Hoàn tác thay đổi của agent|Revert agent changes/ });
    await expect(dialog).toContainText('old line 1'); expect(commands).toHaveLength(0);
    await dialog.getByRole('button', { name: /Xác nhận hoàn tác|Confirm revert/ }).click();
    await expect(dialog).toContainText(/Chưa nhận được kết quả|No result received/);
    await dialog.getByRole('button', { name: /Kiểm tra lại|Check again/ }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.cm-content')).toContainText('old line 1');
    await expect(page.locator('.cm-agent-added')).toHaveCount(1);
    expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]); expect(effects).toBe(1);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(after); expect(errors).toEqual([]);
  } finally { workspaceWritable = false; }
});

test('editor line comments use LineReview and reach the selected agent conversation through its composer', async ({ page }) => {
  fs.writeFileSync(path.join(mentionProject, 'src/comment.txt'), 'first line\nconst amount = 2;\nlast line\n');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto(server.issueLaunchUrl());
  await page.getByRole('navigation').getByText('Release preparation', { exact: true }).click();
  const composer = page.getByPlaceholder('Nhắn cho Piagent…'); await composer.fill('Please review this too.');
  await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'comment.txt', exact: true }).click();
  await page.locator('.cm-line').filter({ hasText: 'const amount = 2;' }).click();
  await page.getByRole('button', { name: /Comment dòng hiện tại|Comment on current line/ }).click();
  const dialog = page.getByRole('dialog', { name: /Comment theo dòng|Line comment/ });
  await expect(dialog).toContainText('src/comment.txt:2');
  await dialog.getByRole('textbox', { name: /Comment cho dòng này|Comment on this line/ }).fill('Check this amount against the test.');
  await dialog.getByRole('button', { name: /Lưu comment|Save comment/ }).click();
  await expect(dialog).not.toBeVisible();
  const bar = page.getByRole('region', { name: /Comment chờ gửi|Comments to send/ });
  await expect(bar).toContainText('src/comment.txt:2');
  await bar.getByRole('button', { name: /Đưa vào ô chat|Put in the composer/ }).click();
  await expect(composer).toHaveValue(/Please review this too\.[\s\S]*src\/comment.txt:2[\s\S]*const amount = 2;[\s\S]*Check this amount against the test\./);
  const message = await composer.inputValue();
  await composer.press('Enter');
  await expect.poll(() => lastSendPayload?.message).toBe(message);
  await expect(bar).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('review counts cover inactive tabs and Keep survives closing the narrow editor drawer', async ({ page }) => {
  const { createHash } = await import('node:crypto');
  const diffs = ['first', 'second'].map((name, index) => {
    const content = `${name} agent line\n`, file = `src/${name}-review.txt`;
    fs.writeFileSync(path.join(mentionProject, file), content);
    const diff = JSON.parse(fs.readFileSync(new URL('../evals/fixtures/piagent-webui/diff-v1.valid.json', import.meta.url)));
    diff.file.path = file; diff.file.fileRef = `file.drawer.${index}`;
    diff.file.currentDigest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    diff.hunks = [{ hunkRef: `hunk.drawer.${index}`, oldStart: 1, oldLineCount: 1, newStart: 1, newLineCount: 1,
      header: '@@ -1 +1 @@', lines: [{ kind: 'added', marker: '+', lineRef: `line.drawer.${index}`, oldLineNumber: null,
        newLineNumber: 1, text: content.trim(), redacted: false }] }];
    diff.agentHunkRefs = diff.hunks.map(hunk => hunk.hunkRef); return diff;
  });
  await page.route('**/source-review', route => route.fulfill({ json: { files: diffs.map(diff => ({ ...diff.file, pathDisplay: 'exact-safe' })) } }));
  await page.route('**/source-review/*', route => route.fulfill({ json: diffs.find(diff => route.request().url().endsWith(diff.file.fileRef)) }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 900, height: 1000 }); await page.goto(server.issueLaunchUrl());
  await page.getByRole('navigation').getByRole('region', { name: 'pi-company-platform', exact: true }).getByText('Release preparation', { exact: true }).click();
  await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'first-review.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'src/first-review.txt (1)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'second-review.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'src/second-review.txt (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'src/first-review.txt (1)', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^(Giữ|Keep)$/ }).click();
  await expect(page.getByRole('tab', { name: 'src/second-review.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^(Đóng|Close)$/ }).click();
  await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
  await expect(page.getByRole('tab', { name: 'src/first-review.txt (1)', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'src/second-review.txt', exact: true })).toBeVisible();
  await expect(page.locator('.cm-agent-added')).toHaveCount(0);
  await page.getByRole('tab', { name: 'src/first-review.txt (1)', exact: true }).click();
  await expect(page.locator('.cm-agent-added')).toHaveCount(1);
  // A kept hunk stays kept after a reload in this browser.
  await page.reload();
  await page.getByRole('navigation').getByRole('region', { name: 'pi-company-platform', exact: true }).getByText('Release preparation', { exact: true }).click();
  await page.getByRole('button', { name: /^(Tệp|Files)$/ }).click();
  await page.getByRole('button', { name: 'src', exact: true }).click();
  await page.getByRole('button', { name: 'second-review.txt', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'src/second-review.txt', exact: true })).toBeVisible();
  await expect(page.locator('.cm-agent-added')).toHaveCount(0);
  expect(fs.readFileSync(path.join(mentionProject, 'src/second-review.txt'), 'utf8')).toBe('second agent line\n');
  expect(errors).toEqual([]);
});

test('personal terminal panel runs echo under CSP and reconnects after reload', async ({ page }) => {
  const key = Buffer.alloc(32, 4), info = { id: 'browser-terminal', path: path.join(mentionBase, 'terminal.jsonl'), cwd: mentionProject };
  const ref = sessionRefForPath(key, info.path), row = catalog.sessions.find(item => item.sessionRef === 'session_release_prep'), previousRef = row.sessionRef;
  const owner = { gatewayInstanceRef: catalog.gatewayInstanceRef, runtimeInstanceRef: 'runtime.browserterminal', ownerEpoch: 1, continuity: 'exact' };
  const manager = { getSessionId: () => info.id, buildSessionContext: () => ({ model: { provider: 'personal' } }) };
  browserTerminals = new PersonalTerminalSessions({ key, gatewayInstanceRef: catalog.gatewayInstanceRef, managed: false,
    runtimes: { listSessions: async () => [info], acquire: async () => ({ ...owner }), liveSessionManager: () => manager,
      ownership: () => ({ state: 'gateway-owned', owner }) } });
  row.sessionRef = ref;
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.__terminalCsp = []; document.addEventListener('securitypolicyviolation', event => window.__terminalCsp.push(event.violatedDirective)); });
  try {
    await page.setViewportSize({ width: 1600, height: 1000 }); await page.goto(server.issueLaunchUrl());
    await page.getByRole('navigation').getByText(row.title, { exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: /Mở terminal|Open terminal/ }).click();
    await expect(page.locator('.xterm-helper-textarea')).toHaveCount(1);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type("echo BROWSER_TERMINAL_READY"); await page.keyboard.press('Enter');
    await expect.poll(() => browserTerminals.forAgent(ref).text).toContain('BROWSER_TERMINAL_READY\r\n');
    await expect(page.locator('.xterm-rows')).toContainText('BROWSER_TERMINAL_READY');
    expect(await page.evaluate(() => window.__terminalCsp)).toEqual([]);
    const terminalRef = (await browserTerminals.state(ref)).terminals[0].terminalRef;
    const oldRows = (await browserTerminals.state(ref)).terminals[0].rows;
    await page.getByRole('separator', { name: /Chiều cao terminal|Terminal height/ }).focus();
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
    await expect.poll(async () => (await browserTerminals.state(ref)).terminals[0].rows).toBeGreaterThan(oldRows);
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo INTERRUPT_READY; sleep 30'); await page.keyboard.press('Enter');
    await expect.poll(() => browserTerminals.forAgent(ref).text).toContain('INTERRUPT_READY\r\n');
    await page.keyboard.press('Control+c');
    await page.keyboard.type('echo AFTER_BROWSER_INTERRUPT'); await page.keyboard.press('Enter');
    await expect.poll(() => browserTerminals.forAgent(ref).text).toContain('AFTER_BROWSER_INTERRUPT\r\n');

    await page.reload();
    await page.getByRole('navigation').getByText(row.title, { exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.locator('.xterm-rows')).toContainText('BROWSER_TERMINAL_READY');
    expect((await browserTerminals.state(ref)).terminals[0].terminalRef).toBe(terminalRef);
    await page.getByRole('button', { name: /Mở terminal|Open terminal/ }).click();
    await expect(page.getByRole('tab', { name: 'Terminal 2', exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Terminal 2', exact: true }).click();
    const secret = 'sk-' + 'a'.repeat(48), beforeSend = sessionSendEffects;
    await page.locator('.xterm-helper-textarea:visible').focus();
    await page.keyboard.type(`echo OPENAI_API_KEY=${secret}; echo SECOND_TERMINAL_OUTPUT`); await page.keyboard.press('Enter');
    await expect.poll(() => browserTerminals.forAgent(ref, 2).text).toContain('SECOND_TERMINAL_OUTPUT\r\n');
    await page.getByPlaceholder('Nhắn cho Piagent…').fill('Review @terminal and @terminal:2');
    expect(sessionSendEffects).toBe(beforeSend);
    await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect.poll(() => dispatchedContent?.[0]?.text).toContain('Terminal 2 output');
    expect(dispatchedContent[0].text).toContain('BROWSER_TERMINAL_READY');
    expect(dispatchedContent[0].text).toContain('SECOND_TERMINAL_OUTPUT');
    expect(dispatchedContent[0].text).not.toContain(secret);
    expect(dispatchedContent[0].text).toContain('REDACTED');

    await page.getByRole('button', { name: /Đóng terminal|Close terminal/ }).click();
    await expect(page.getByRole('tab', { name: 'Terminal 2', exact: true })).toHaveCount(0);
    await page.setViewportSize({ width: 640, height: 800 });
    await expect(page.getByRole('button', { name: /Ẩn terminal|Hide terminal/ })).toBeVisible();
    expect(await page.evaluate(() => window.__terminalCsp)).toEqual([]); expect(errors).toEqual([]);
  } finally { row.sessionRef = previousRef; await browserTerminals.dispose(); browserTerminals = null; }
});

for (const scenario of ['lost-response', 'member-conflict', 'storage-unavailable']) {
  test(`Timeline checkpoint previews and confirms real multi-turn restoration: ${scenario}`, async ({ page }) => {
    const { PersonalCheckpointGit } = await import('../packages/piagent-core/runtime/checkpoints/personal-git.ts');
    const { TurnCheckpointService } = await import('../packages/piagent-core/runtime/checkpoints/turn-checkpoints.mjs');
    const { CheckpointController } = await import('../packages/piagent-webui/server/checkpoint-controller.ts');
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-browser-')));
    const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
    const write = (file, value) => fs.writeFileSync(path.join(cwd, file), value);
    const read = file => fs.readFileSync(path.join(cwd, file), 'utf8');
    git('init', '-q'); write('a.txt', 'before'); write('b.txt', 'before');
    const service = new TurnCheckpointService(new PersonalCheckpointGit(cwd, () => ({ policy: {}, profile: {}, readOnly: false })));
    const turn = async (turnRef, change) => { const run = { turnRef }; await service.take(run); change(); await service.finish(run); };
    await turn('message_history_user', () => write('a.txt', 'agent first'));
    if (scenario === 'member-conflict') write('a.txt', 'member between turns');
    await turn('message_checkpoint_second', () => { write('b.txt', 'agent second'); write('new.txt', 'agent created'); });
    git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member commit');
    const head = git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(cwd, '.git/index'));
    const identity = { projectRef: 'project', runtimeInstanceId: 'runtime', sessionRef: 'session_source_review',
      taskId: null, taskRunId: null, agentOperationId: null, toolCallId: null };
    const journal = [], commands = []; let effects = 0;
    const controller = new CheckpointController({ facts: async () => { const listed = await service.list(); return {
      identity, revisions: { checkpointRevision: listed.revision }, available: true, agentRunning: false, writable: true, points: listed.points }; },
      history: () => journal, append: receipt => journal.push(receipt), restore: (target, expected) => { effects++; return service.restoreTo(target, expected); } });
    const base = transcriptFixture.items[0], content = value => ({ ...base.content, text: value, textChars: value.length });
    processTranscript = [
      { ...base, messageRef: 'message_checkpoint_second', role: 'user', recordedAt: '2026-08-14T06:00:00.000Z', content: content('Second checkpoint turn'), toolCalls: [] },
      { ...base, messageRef: 'message_checkpoint_answer', parentMessageRef: 'message_checkpoint_second', role: 'assistant', recordedAt: '2026-08-14T06:00:01.000Z', content: content('Second edit done'), toolCalls: [] },
    ];
    await page.route('**/sessions/session_source_review/checkpoints**', async route => {
      const request = route.request();
      if (request.method() === 'POST') {
        const command = request.postDataJSON(); commands.push(command);
        const receipt = await controller.execute(command);
        if (scenario === 'lost-response' && commands.length === 1) return route.abort();
        return route.fulfill({ json: receipt });
      }
      const target = new URL(request.url()).pathname.split('/checkpoints/')[1];
      if (!target) return route.fulfill({ json: await controller.state() });
      const value = await service.preview(target);
      return route.fulfill({ json: { schemaVersion: 1, version: 'piagent-webui-checkpoint-v1', messageType: 'preview', identity,
        revisions: { checkpointRevision: value.revision }, targetId: target, result: value.result, previewDigest: value.digest,
        tree: value.tree, steps: value.steps, files: value.files, conflicts: value.conflicts, stoppedAt: value.stoppedAt } });
    });
    try {
      if (scenario === 'storage-unavailable') await page.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'piagent.checkpoint.pending.v1') throw new DOMException('Quota exceeded', 'QuotaExceededError');
          return original.call(this, key, value);
        };
      });
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.goto(server.issueLaunchUrl());
      await page.getByRole('navigation').getByText('Review source changes', { exact: true }).click();
      const buttons = page.getByRole('button', { name: /Khôi phục về trước lượt này|Restore before this turn/ });
      await expect(buttons).toHaveCount(2); await buttons.first().click();
      const dialog = page.getByRole('dialog', { name: /Khôi phục về trước lượt này|Restore before this turn/ });
      await expect(dialog.getByText(/Commit và vùng stage|Commits and staged changes/)).toBeVisible();
      await expect(dialog.getByText(/new\.txt/).first()).toBeVisible();
      assert.equal(commands.length, 0); assert.equal(read('b.txt'), 'agent second');
      if (scenario === 'member-conflict') await expect(dialog.getByRole('alert')).toContainText('a.txt');
      await dialog.getByRole('button', { name: /Xác nhận khôi phục|Confirm restore/ }).click();
      if (scenario === 'storage-unavailable') {
        await expect(page.getByRole('alert').filter({ hasText: /Không đọc hoặc lưu|could not read or save/ })).toBeAttached();
        await expect(dialog.getByRole('button', { name: /Xác nhận khôi phục|Confirm restore/ })).toBeDisabled();
        assert.equal(commands.length, 0); assert.equal(effects, 0); assert.equal(read('b.txt'), 'agent second');
        return;
      }
      if (scenario === 'lost-response') {
        await expect(dialog.getByRole('alert')).toContainText(/Chưa xác nhận|unconfirmed/);
        await page.reload();
        await page.getByRole('navigation').getByText('Review source changes', { exact: true }).click();
        await expect(page.getByRole('alert').filter({ hasText: /chưa có kết quả xác nhận|awaiting a confirmed result/ })).toBeVisible();
        assert.equal(commands.length, 1, 'reload must not dispatch automatically');
        await page.getByRole('button', { name: /^(Xem kết quả|Check result)$/ }).click();
        await dialog.getByRole('button', { name: /Kiểm tra lại kết quả|Check result again/ }).click();
        await expect(dialog.getByRole('alert')).toContainText(/Đã khôi phục 2 lượt|Restored 2 turns/);
        assert.deepEqual(commands[0], commands[1]);
      } else await expect(dialog.getByRole('alert').last()).toContainText(/Đã khôi phục 1 lượt|Restored 1 turns/);
      assert.equal(effects, 1); assert.equal(read('b.txt'), 'before');
      assert.equal(read('a.txt'), scenario === 'member-conflict' ? 'member between turns' : 'before');
      assert.equal(fs.existsSync(path.join(cwd, 'new.txt')), false);
      assert.equal(git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(cwd, '.git/index')), index);
    } finally { processTranscript = []; fs.rmSync(cwd, { recursive: true, force: true }); }
  });
}

function historyPage(before, limit = 50) {
  historyReads.push(before ?? null);
  const end = before ? Number(before.replace("history_", "")) : pagedHistory.length, start = Math.max(0, end - limit * 2);
  return { ...transcriptFixture, items: pagedHistory.slice(start, end),
    page: { ...transcriptFixture.page, beforeCursor: before ?? null, nextBeforeCursor: start > 0 ? `history_${start}` : null,
      hasOlder: start > 0, limit, truncated: false } };
}

function longHistory(turns) {
  const base = transcriptFixture.items[0], text = (value) => ({ ...base.content, text: value, textChars: value.length });
  return Array.from({ length: turns }, (_, index) => {
    const at = new Date(Date.UTC(2026, 9, 1, 8, 0, index * 2)).toISOString();
    return [{ ...base, messageRef: `history_user_${index}`, role: "user", recordedAt: at, toolCalls: [], content: text(`Việc số ${index}: sửa lỗi phân trang.`) },
      { ...base, messageRef: `history_answer_${index}`, parentMessageRef: `history_user_${index}`, role: "assistant", recordedAt: at, toolCalls: [],
        content: text(index % 2 ? `Đã sửa \`src/page-${index}.ts\`.\n\n\`\`\`ts\nexport const next = (page: number) => page + 1;\n\`\`\`` : `Trả lời số ${index}. ${"Giải thích điều kiện dừng. ".repeat(1 + index % 5)}`) }];
  }).flat();
}

// Older messages load as the reader scrolls up, with no click, and the turn
// being read stays exactly where it was while a page is added above it: the
// page used to jump by the whole height of the new history.
test("older messages load on their own as the reader scrolls up, without moving the message being read", async ({ page }) => {
  pagedHistory = longHistory(120); historyReads.length = 0;
  await page.setViewportSize({ width: 1440, height: 800 });
  try {
    await page.goto(server.issueLaunchUrl());
    const turns = () => page.locator("[data-turn]").count();
    const place = () => page.evaluate(() => ({ y: Math.round(window.scrollY), bottom: document.documentElement.scrollHeight - window.innerHeight }));
    // It opens at the newest message, with one page of history.
    await expect(page.getByText("Việc số 119: sửa lỗi phân trang.", { exact: true })).toBeVisible();
    await expect.poll(async () => { const now = await place(); return now.bottom - now.y; }).toBeLessThanOrEqual(2);
    expect(await turns()).toBe(50);
    // History appears formatted from the first frame: no raw markdown that
    // reflows into a shorter message a moment later.
    await expect(page.locator("pre code").filter({ hasText: "export const next" }).first()).toBeVisible();
    expect(await page.getByText("```ts", { exact: false }).count()).toBe(0);
    // The reader scrolls up, then on into the top of the page. (Positions are
    // set directly: a wheel scrolls smoothly and would still be moving.)
    await page.evaluate(() => window.scrollTo(0, 2600));
    await expect.poll(async () => (await place()).y).toBe(2600);
    const anchor = await page.evaluate(() => {
      const turn = [...document.querySelectorAll("[data-turn]")].find((item) => item.getBoundingClientRect().top > 160);
      return { key: turn.dataset.turn, top: turn.getBoundingClientRect().top };
    });
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect.poll(turns).toBe(100);
    const topOf = () => page.evaluate((key) => document.querySelector(`[data-turn="${key}"]`).getBoundingClientRect().top, anchor.key);
    // Exactly the reader's own 1,900 px: nothing added above moved it.
    await expect.poll(async () => Math.abs(await topOf() - (anchor.top + 1_900))).toBeLessThanOrEqual(2);
    await page.waitForTimeout(600);
    expect(Math.abs(await topOf() - (anchor.top + 1_900))).toBeLessThanOrEqual(2);
    expect(historyReads.filter(Boolean)).toEqual(["history_140"]);
    // The last page arrives the same way, and the start is marked.
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(turns).toBe(120);
    await expect(page.getByText("Đầu cuộc trò chuyện", { exact: true })).toBeAttached();
    await expect(page.getByRole("button", { name: "Tải tin cũ hơn" })).toHaveCount(0);
  } finally { pagedHistory = null; }
});

// Deliver a stale observer record or suppress observer edges altogether. Both
// orderings occur when scroll intent, React layout and observer delivery race.
// Keep real scrolling/layout and API responses: no timeouts/assertions relaxed.
async function controlHistoryObserver(page, suppress) {
  await page.addInitScript(({ suppress }) => {
    const NativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback, options) {
        super((entries, observer) => callback(entries.filter(entry => !suppress || !entry.target.__historySentinel), observer), options);
        this.deliver = callback;
      }
      observe(target) {
        if (target.hasAttribute("data-history-sentinel") || /Tải tin cũ hơn|Load older messages/.test(target.querySelector("button")?.textContent ?? "")) {
          target.__historySentinel = true;
          window.__replayHistoryIntersection = () => this.deliver([{ target, isIntersecting: true }], this);
        }
        super.observe(target);
      }
    };
  }, { suppress });
}

test("a queued history intersection cannot fetch offscreen pages after anchoring", async ({ page }) => {
  pagedHistory = longHistory(120); historyReads.length = 0;
  await controlHistoryObserver(page, false);
  await page.setViewportSize({ width: 1440, height: 800 });
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Việc số 119: sửa lỗi phân trang.", { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect(page.locator("[data-turn]")).toHaveCount(100);
    // The first page has pushed the sentinel out of its 900px prefetch zone.
    await expect.poll(() => page.getByRole("button", { name: "Tải tin cũ hơn" }).evaluate(node => node.getBoundingClientRect().bottom)).toBeLessThan(-900);
    await page.evaluate(() => window.__replayHistoryIntersection());
    await page.waitForTimeout(600);
    expect(historyReads.filter(Boolean)).toEqual(["history_140"]);
    await expect(page.locator("[data-turn]")).toHaveCount(100);
  } finally { pagedHistory = null; }
});

test("upward scrolling inside the history zone loads even without a new observer edge", async ({ page }) => {
  pagedHistory = longHistory(120); historyReads.length = 0;
  await controlHistoryObserver(page, true);
  await page.setViewportSize({ width: 1440, height: 800 });
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Việc số 119: sửa lỗi phân trang.", { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 700));
    await expect(page.locator("[data-turn]")).toHaveCount(100);
    expect(historyReads.filter(Boolean)).toEqual(["history_140"]);
    await page.evaluate(() => window.scrollTo(0, 300));
    await expect(page.locator("[data-turn]")).toHaveCount(120);
    expect(historyReads.filter(Boolean)).toEqual(["history_140", "history_40"]);
  } finally { pagedHistory = null; }
});

// The page keeps a bounded window of history. When older pages fill it, the
// newest messages leave it, and the reader is offered a way back to them
// instead of finding the end of the conversation silently gone.
test("a history longer than the window says the newest messages are hidden and brings them back", async ({ page }) => {
  test.setTimeout(90_000);
  pagedHistory = longHistory(560); historyReads.length = 0;
  await page.setViewportSize({ width: 1440, height: 800 });
  try {
    await page.goto(server.issueLaunchUrl());
    await expect(page.getByText("Việc số 559: sửa lỗi phân trang.", { exact: true })).toBeVisible();
    const back = page.getByRole("button", { name: "Tin mới hơn đã ẩn · về tin mới nhất" });
    await page.evaluate(() => window.scrollTo(0, 2000));
    for (let load = 0; load < 14 && !await back.count(); load += 1) {
      const before = await page.locator("[data-turn]").count();
      await page.evaluate(() => window.scrollTo(0, 300));
      // A full window keeps its size: the page that fills it drops the newest turns instead.
      await expect.poll(async () => await back.count() > 0 || await page.locator("[data-turn]").count() !== before, { timeout: 10_000 }).toBe(true);
    }
    await expect(back).toBeAttached();
    // Each page is asked for once, even when the reader reaches the top again
    // before the previous page has rendered.
    expect(new Set(historyReads).size).toBe(historyReads.length);
    await expect(page.getByText("Việc số 559: sửa lỗi phân trang.", { exact: true })).toHaveCount(0);
    await back.scrollIntoViewIfNeeded(); await back.click();
    await expect(page.getByText("Việc số 559: sửa lỗi phân trang.", { exact: true })).toBeVisible();
    await expect(back).toHaveCount(0);
    expect(await page.locator("[data-turn]").count()).toBe(50);
    await expect.poll(async () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY)).toBeLessThanOrEqual(2);
  } finally { pagedHistory = null; }
});

test("gateway startup defers settings code until the dialog is requested", async ({ page }) => {
  const scripts = [];
  page.on("request", request => { if (request.resourceType() === "script") scripts.push(request.url()); });
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Implementation result" })).toBeVisible();
  const bytes = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter(entry => new URL(entry.name).pathname.endsWith(".js"))
    .reduce((sum, entry) => sum + entry.decodedBodySize, 0));
  console.log("PIAGENT_GATEWAY_STARTUP_JS_BYTES=" + bytes);
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThan(1_100_000);
  expect(scripts.some(url => /SettingsPage-.*\.js/.test(url))).toBe(false);
  await page.getByRole("button", { name: "Cài đặt" }).click();
  await expect(page.getByRole("dialog").getByText("Cài đặt", { exact: true })).toBeVisible();
  expect(scripts.some(url => /SettingsPage-.*\.js/.test(url))).toBe(true);
});

test("settings chunk failure remains inside the dismissible dialog", async ({ page }) => {
  await page.route("**/assets/SettingsPage-*.js", route => route.abort());
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  // Earlier cases create sessions in the shared fixture; select this one rather
  // than depending on whichever session the latest catalog chooses by default.
  await page.getByRole("navigation").getByText("Release preparation", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
  await page.getByRole("button", { name: "Cài đặt" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Không tải được giao diện");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Release preparation" })).toBeVisible();
  await page.unroute("**/assets/SettingsPage-*.js");
  await page.getByRole("button", { name: "Cài đặt" }).click();
  await page.getByRole("button", { name: "Tải lại trang", exact: true }).click();
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cài đặt" }).click();
  await expect(page.getByRole("dialog").getByText("Cài đặt", { exact: true })).toBeVisible();
});

test("gateway cold load timing sample", async ({ page }, testInfo) => {
  test.skip(process.env.PIAGENT_WEBUI_PERF !== "1", "Opt-in throttled benchmark; fixture server, no provider calls");
  const encodingRequested = process.env.PIAGENT_WEBUI_PERF_ENCODING === "paired"
    ? (testInfo.repeatEachIndex % 2 === 0 ? "identity" : "gzip") : process.env.PIAGENT_WEBUI_PERF_ENCODING;
  if (encodingRequested === "identity" || encodingRequested === "gzip")
    await page.setExtraHTTPHeaders({ "Accept-Encoding": encodingRequested });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: 200_000, uploadThroughput: 100_000 });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Gateway live", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Implementation result" })).toBeVisible({ timeout: 20_000 });
  const metrics = await page.evaluate(() => {
    const scripts = performance.getEntriesByType("resource").filter(entry => new URL(entry.name).pathname.endsWith(".js"));
    return {
      appReadyObservedMs: performance.now(),
      firstContentfulPaintMs: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
      decodedJsBytes: scripts.reduce((n, entry) => n + entry.decodedBodySize, 0),
      transferredJsBytes: scripts.reduce((n, entry) => n + entry.transferSize, 0),
      scriptRequests: scripts.length
    };
  });
  console.log("PIAGENT_LOAD_SAMPLE=" + JSON.stringify({ ...metrics, encodingRequested: encodingRequested ?? "browser-default" }));
  await testInfo.attach("load-sample.json", { body: JSON.stringify(metrics), contentType: "application/json" });
});

test("shows a sent image as a picture that opens full size, not a card that says Image", async ({ page }) => {
  historyImage = true;
  try {
    await page.goto(server.issueLaunchUrl());
    await page.getByRole("button", { name: /Release prep/ }).first().click();
    const thumbnail = page.getByRole("button", { name: "Xem ảnh Image" });
    await expect(thumbnail).toBeVisible();
    assert.equal(await thumbnail.locator("img").evaluate((image) => image.complete && image.naturalWidth), 2);
    await thumbnail.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("img")).toBeVisible();
    await dialog.getByRole("button", { name: "Đóng" }).click();
    await expect(dialog).toBeHidden();
  } finally { historyImage = false; }
});

test("shows the agent's edits while it runs, so a run going wrong can be reviewed and stopped", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.issueLaunchUrl());
  await page.getByRole("button", { name: /Release prep/ }).first().click();
  const operationRef = "operation_live_changes";
  protocol.events.publish("runtime.changed", { sessionRef: "session_release_prep",
    sessionRevision: "revision_session_release_prep", liveState: "running", operationRef, reasonCode: null });
  try {
    const panel = page.getByRole("region", { name: "Thay đổi và ngữ cảnh" });
    await expect(panel.getByText("Agent đang chạy · cập nhật trực tiếp. Thấy sai thì bấm Dừng.")).toBeVisible();
    await expect(panel.getByText("src/example.ts")).toBeVisible();
    // Re-read while the turn runs, without a new session revision.
    const reads = sourceChangeReads;
    await expect.poll(() => sourceChangeReads, { timeout: 10_000 }).toBeGreaterThan(reads);
    await panel.getByRole("button", { name: "Xem diff đầy đủ, stage hoặc hoàn tác" }).click();
    const changes = page.getByRole("dialog").getByRole("region", { name: "Thay đổi trong project" });
    await expect(changes.getByRole("button", { name: /src\/example\.ts/ })).toHaveAttribute("aria-pressed", "true");
    await expect(changes.getByRole("region", { name: "Vùng thay đổi 1" })).toBeVisible();
  } finally {
    protocol.events.publish("operation.settled", { sessionRef: "session_release_prep", operationRef,
      messageRef: "message_live_changes", sessionRevision: "revision_session_release_prep", settlement: "completed", reasonCode: null });
  }
});
