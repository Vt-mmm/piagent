import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { GatewayProtocolService } from "../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { SessionAttachmentRegistry } from "../packages/piagent-webui/gateway/session-attachment-registry.ts";
import { COMPANY_MODEL_REF } from "../packages/piagent-webui/gateway/company-relay.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { suggestPaths } from "../packages/piagent-webui/gateway/path-suggestions.ts";
import { listBranches, switchBranch } from "../packages/piagent-webui/gateway/git-branches.ts";
import { listAgentCommands } from "../packages/piagent-core/runtime/resources/agent-resources.mjs";
import { WEBUI_WORKFLOW_OPTIONS } from "../packages/piagent-core/runtime/workflows/webui-workflow.ts";
import { DOCX_MIME, docx } from "./helpers/piagent-docx-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
let server, protocol;
let persistedBrowserConversation = false;
let sessionCreateAttempts = 0, sessionCreateEffects = 0, createdSessionCounter = 0;
let sessionSendAttempts = 0, sessionSendEffects = 0;
let nextCreateUncertain = false, nextSendRejected = false, nextSendUnconfirmed = false;
let liveStateUnavailable = false, liveStateReadCount = 0;
let attachments, lastSendPayload = null, dispatchedContent = null;
let lastCreatePayload = null;
let processTranscript = [];
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
      dispatchedContent = value.payload.attachmentRefs?.length
        ? (await attachments.claim(value.sessionRef, value.payload.attachmentRefs, value.payload.messageRequestId, value.payload.message)).content
        : null;
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
  protocol = new GatewayProtocolService({ capabilities: () => capabilities, catalog: async () => catalog, command });
  // The real registry, so staging exercises the same extraction and the same
  // identity and revision checks the Gateway applies in production.
  attachments = new SessionAttachmentRegistry({ inspect: async () => inspectionSnapshot });
  const inspectionProvider = {
    snapshot: () => inspectionSnapshot,
    sourceChanges: (view) => ({ ...sourceFixture, view, bases: view === "task"
      ? { taskBaselineDigest: "sha256:" + "a".repeat(64), headOid: null, indexDigest: null, workingTreeDigest: null }
      : sourceFixture.bases }),
    diff: () => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/diff-v1.valid.json"), "utf8")),
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
    transcript: () => (transcriptReads += 1, transcriptUnavailable) ? Promise.reject(new Error("company-gateway-stopped")) : ({ ...transcriptFixture, items: [
      { ...transcriptFixture.items[0], messageRef: "message_history_user", content: { ...transcriptFixture.items[0].content,
        text: "Open the persisted release checklist", textChars: 36 } },
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
    staticRoot: path.join(root, "packages/piagent-webui/dist/client"), mode: "gateway",
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
    listBranches: async (projectRef) => {
      if (!branchRepo || projectRef !== "project_session_release_prep") return null;
      const list = await listBranches(branchRepo);
      return list ? { ...list, running: branchRunning } : { repository: false, running: branchRunning };
    },
    switchBranch: async (projectRef, request) => {
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
  await expect(list.getByRole("option")).toHaveCount(3);
  await expect(list.getByRole("option", { name: /\/review.*\[focus\].*Review the staged changes.*\.claude/ })).toBeVisible();
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

test("a tab that lost its browser session says how to open Piagent again and stops polling", async ({ page }) => {
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByText("Review source changes", { exact: true }).filter({ visible: true })).toBeVisible();
  // The Gateway restarted or another launch replaced the cookie: every read is now refused.
  await page.context().clearCookies();
  await page.getByRole("button", { name: "Làm mới" }).click();
  await expect(page.getByRole("heading", { name: "Tab này đã hết phiên đăng nhập" })).toBeVisible();
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
