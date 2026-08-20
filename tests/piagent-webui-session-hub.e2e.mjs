import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { GatewayProtocolService } from "../packages/piagent-webui/gateway/gateway-protocol-service.ts";
import { SessionAttachmentRegistry } from "../packages/piagent-webui/gateway/session-attachment-registry.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { DOCX_MIME, docx } from "./helpers/piagent-docx-fixture.mjs";

const root = path.resolve(import.meta.dirname, "..");
let server;
let persistedBrowserConversation = false;
let sessionCreateAttempts = 0, sessionCreateEffects = 0, createdSessionCounter = 0;
let sessionSendAttempts = 0, sessionSendEffects = 0;
let attachments, lastSendPayload = null, dispatchedContent = null;
let lastCreatePayload = null;
const observedSessionActions = [];
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
  let protocol;
  const command = { async execute(value) {
    observedSessionActions.push(value.action);
    if (value.action === "session.create") sessionCreateAttempts += 1;
    if (value.action === "session.create") lastCreatePayload = structuredClone(value.payload);
    if (value.action === "session.send") {
      sessionSendAttempts += 1;
      // Claim exactly as the runtime supervisor does, so what the assertions see
      // is what a real session would have been prompted with.
      lastSendPayload = structuredClone(value.payload);
      dispatchedContent = value.payload.attachmentRefs?.length
        ? (await attachments.claim(value.sessionRef, value.payload.attachmentRefs, value.payload.messageRequestId, value.payload.message)).content
        : null;
    }
    const currentRow = value.sessionRef ? catalog.sessions.find((item) => item.sessionRef === value.sessionRef) : null;
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
      if (!deferredCreate) protocol.events.publish("message.completed", { sessionRef: targetSessionRef, operationRef,
        messageRef: `message_browser_create_${createdSessionCounter}`, sessionRevision: targetSessionRevision, truncated: false });
    }
    if (value.action === "session.send") {
      sessionSendEffects += 1;
      const messageRef = "message_browser_send_01";
      protocol.events.publish("runtime.changed", { sessionRef: value.sessionRef, sessionRevision: value.expectedSessionRevision,
        liveState: "running", operationRef, reasonCode: null });
      protocol.events.publish("tool.started", { sessionRef: value.sessionRef, operationRef,
        toolCallRef: "tool_browser_read_01", toolLabel: "read_file", isError: null });
      await new Promise((resolve) => setTimeout(resolve, 400));
      protocol.events.publish("tool.completed", { sessionRef: value.sessionRef, operationRef,
        toolCallRef: "tool_browser_read_01", toolLabel: "read_file", isError: false });
      protocol.events.publish("message.delta", { sessionRef: value.sessionRef, operationRef, messageRef, messageSequence: 0,
        delta: "A streamed Gateway reply." });
      protocol.events.publish("message.completed", { sessionRef: value.sessionRef, operationRef, messageRef,
        sessionRevision: value.expectedSessionRevision, truncated: false });
      persistedBrowserConversation = true;
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
    transcript: () => ({ ...transcriptFixture, items: [
      { ...transcriptFixture.items[0], messageRef: "message_history_user", content: { ...transcriptFixture.items[0].content,
        text: "Open the persisted release checklist", textChars: 36 } },
      { ...transcriptFixture.items[0], messageRef: "message_history_assistant", parentMessageRef: "message_history_user", role: "assistant",
        recordedAt: "2026-08-13T14:00:00.000Z", content: { ...transcriptFixture.items[0].content,
          text: "## Implementation result\n\n**Status:** ready.\n\nThe durable transcript is available.\n\n- Session isolation\n- Formatted output\n\n| Gate | State |\n| --- | --- |\n| Chromium | Pass |\n\n![remote preview](https://example.invalid/track.png) [unsafe](javascript:alert(1))",
          textChars: 258 },
        toolCalls: [{ toolCallRef: "tool_history_read", toolName: "read_file", state: "completed" }] },
      { ...transcriptFixture.items[0], messageRef: "message_history_tool", parentMessageRef: "message_history_assistant", role: "tool-result",
        recordedAt: "2026-08-13T14:00:01.000Z", content: { ...transcriptFixture.items[0].content, state: "unavailable", text: null,
          textChars: null, digest: null, reasonCode: "tool-output-in-activity-preview" }, toolCalls: [] },
      { ...transcriptFixture.items[0], messageRef: "message_history_auth_error", parentMessageRef: "message_history_user", role: "assistant",
        recordedAt: "2026-08-13T14:00:02.000Z", content: { ...transcriptFixture.items[0].content, state: "unavailable", text: null,
          textChars: null, digest: null, truncated: false, redacted: false, imageCount: 0, reasonCode: "provider-auth-expired" }, toolCalls: [] }
    ].concat(persistedBrowserConversation ? [
      { ...transcriptFixture.items[0], messageRef: "message_browser_user", role: "user", recordedAt: "2026-08-14T05:00:00.000Z",
        content: { ...transcriptFixture.items[0].content, text: "Continue from the browser", textChars: 25 }, toolCalls: [] },
      { ...transcriptFixture.items[0], messageRef: "message_browser_assistant", parentMessageRef: "message_browser_user", role: "assistant",
        recordedAt: "2026-08-14T05:00:01.000Z", content: { ...transcriptFixture.items[0].content,
          text: "A streamed Gateway reply.", textChars: 25 }, toolCalls: [] }
    ] : []) }),
    logPreview: () => ({ state: "unavailable", preview: null, truncated: false, reasonCode: "no-log" })
  };
  server = await startLoopbackServer({
    staticRoot: path.join(root, "packages/piagent-webui/dist/client"), mode: "gateway",
    readCapabilities: () => capabilities, readSessionCatalog: () => catalog, gatewayProtocol: protocol,
    readSessionCreationOptions: () => ({ schemaVersion: 1, version: "piagent-session-creation-options-v1",
      generatedAt: new Date().toISOString(), projects: [{ projectRef: "project_session_release_prep",
        placeRef: "project_session_release_prep", label: "pi-company-platform" }],
      models: [{ modelRef: "model_openai_codex_sol", provider: "openai-codex", modelId: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol", reasoning: true, imageInput: true, thinkingLevels: ["off", "medium", "high", "xhigh"] },
      { modelRef: "model_fixture_reasoning", provider: "fixture", modelId: "reasoning",
        displayName: "Fixture Reasoning", reasoning: true, imageInput: true, thinkingLevels: ["off", "medium", "high"] }],
      defaultModelRef: "model_openai_codex_sol", defaultThinkingLevel: "high",
      profiles: [{ id: "node-typescript", displayName: "Node TypeScript Project", permissionMode: "workspace-write" }],
      webSearch: { state: "configured", route: "codex-first", provider: "openai-codex", fallbackProvider: "exa",
        integration: { name: "pi-web-access", version: "0.17.0" }, reasonCode: null },
      projectImport: { status: "available", reasonCode: null }, reasonCode: null }),
    executeProjectImport: () => ({ schemaVersion: 1, version: "piagent-project-import-result-v1", importedAt: new Date().toISOString(),
      project: { projectRef: "project_imported_browser", placeRef: "project_imported_browser", label: "imported-project" } }),
    readSessionModel: () => inspectionProvider,
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

test.afterAll(async () => { await server?.close(); attachments?.close(); });

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
  await expect(page.getByText("Phiên đăng nhập model đã hết hạn. Mở Cài đặt → Nhà cung cấp & model để kết nối lại.", { exact: true })).toBeVisible();
  const persistedActivity = page.getByRole("button", { name: /Đã đọc file/ });
  await expect(persistedActivity).toBeVisible();
  await persistedActivity.click();
  await expect(page.getByText("read_file", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Mở Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  await expect(page.getByRole("heading", { name: "Anh muốn làm gì?" })).toBeVisible();
  await page.getByRole("button", { name: /pi-company-platform/ }).click();
  await page.getByRole("menuitem", { name: "Thêm một hoặc nhiều folder" }).click();
  await expect(page.getByRole("button", { name: /imported-project/ })).toBeVisible();
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
  await page.getByRole("combobox", { name: "Workflow cho tin nhắn này" }).click();
  await page.getByRole("option", { name: "Review", exact: true }).click();
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Continue from the browser");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.getByText("Continue from the browser", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Đang đọc file/ })).toBeVisible();
  await expect(page.getByText("A streamed Gateway reply.", { exact: true })).toBeVisible();
  assert.equal(lastSendPayload?.workflow, "review");
  await page.waitForTimeout(250);
  await expect(page.getByText("A streamed Gateway reply.", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("combobox", { name: "Workflow cho tin nhắn này" })).toHaveText(/Tự do · không workflow/);
  await page.getByPlaceholder("Nhắn cho Piagent…").fill("Start a different piece of work in this session");
  await page.getByRole("button", { name: "Gửi" }).click();
  await expect(page.getByText("Start a different piece of work in this session", { exact: true })).toBeVisible();
  await expect.poll(() => lastSendPayload?.message).toBe("Start a different piece of work in this session");
  assert.equal(Object.hasOwn(lastSendPayload, "workflow"), false);
  await page.getByRole("button", { name: "Mở Source Changes Inspector" }).click();
  await expect(page.getByText("Agent Inspector", { exact: true })).toBeVisible();
  await expect(page.getByText("Open the persisted release checklist", { exact: true })).toBeVisible();
  await expect(page.locator(".MuiBackdrop-root")).toHaveCount(0);
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
    await expect(page.getByRole("heading", { name: "Anh muốn làm gì?" })).toBeVisible();
    await page.getByRole("button", { name: "Thêm tùy chọn" }).click();
    await page.getByRole("button", { name: "Thực hiện task", exact: true }).click();
    await page.getByRole("menuitem", { name: /Khảo sát chỉ đọc/ }).click();
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
    assert.equal(lastCreatePayload?.workflow, "scout");
    assert.equal(lastCreatePayload?.permissionMode, "read-only");
    assert.equal(lastSendPayload?.attachmentRefs?.length, 1);
    assert.match((dispatchedContent ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
      /Build the Linux import flow safely/);

    const created = catalog.sessions.find((item) => item.title === "Browser retry session");
    assert.ok(created);
    created.sessionRevision = "revision_session_changed_before_send";
    catalog.catalogRevision = "revision_catalog_changed_before_send";
    await page.getByPlaceholder("Nhắn cho Piagent…").fill("Send after a concurrent session update");
    await page.getByRole("button", { name: "Gửi" }).click();
    await expect(page.getByText("A streamed Gateway reply.", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("session-revision-stale", { exact: true })).toHaveCount(0);
    // One initial send carries the staged file. The next message first goes
    // stale and is retried once, so the total is three attempts / two effects.
    assert.equal(sessionSendAttempts - sendAttemptsBefore, 3);
    assert.equal(sessionSendEffects - sendEffectsBefore, 2);
  } finally {
    catalog.catalogRevision = originalRevision; catalog.sessions.splice(0, catalog.sessions.length, ...originalSessions);
    Object.assign(catalog.page, originalPage);
  }
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
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  await expect(page.getByRole("heading", { name: "Anh muốn làm gì?" })).toBeVisible();

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
