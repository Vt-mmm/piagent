import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { bindSessionTask, workingTreeSnapshot, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";
import { appendContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { appendMutationProvenance } from "../packages/piagent-core/runtime/inspection/mutation-provenance-store.ts";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import { CoreInspectionProvider } from "../packages/piagent-webui/server/core-inspection-provider.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { SameSessionPiBridge } from "../packages/piagent-webui/extension/same-session-bridge.ts";
import { HeldMessageQueue } from "../packages/piagent-webui/extension/held-message-queue.ts";
import { SessionOptionsController } from "../packages/piagent-webui/extension/session-options-controller.ts";
import { AttachmentStore } from "../packages/piagent-core/runtime/input/attachment-store.ts";
import { DOCX_MIME, docx } from "./helpers/piagent-docx-fixture.mjs";
import { PiApprovalBroker } from "../packages/piagent-core/runtime/inspection/approval-broker.ts";
import { inspectTaskControlState } from "../packages/piagent-core/runtime/inspection/task-control-journal.ts";
import { buildHandoffProjection, writeHandoffProjection } from "../packages/piagent-core/runtime/recovery/handoff-projection.ts";
import { OwnedWorkBudgetController } from "../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";
import { createHelperRequest, defaultRolePolicy } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { LifecycleController } from "../packages/piagent-webui/extension/lifecycle-controller.ts";
import { ReviewController } from "../packages/piagent-webui/extension/review-controller.ts";
import { SourceMutationController } from "../packages/piagent-webui/extension/source-mutation-controller.ts";
import { SourceRevertController } from "../packages/piagent-webui/extension/source-revert-controller.ts";
import { SourceOpenController } from "../packages/piagent-webui/extension/source-open-controller.ts";
import { webUiTaskRevision } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { PiSourceMutationGuard } from "../packages/piagent-core/runtime/policy/source-mutation-guard.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const taskFixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/task-contract.valid.json"), "utf8"));
const schemaRegistry = createWebUiSchemaRegistry();
let cwd, server, provider, eventStore, currentTask;

function git(...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

class BrowserEventStore {
  cursor = "event-cursor.browser-initial";
  gapPending = true;
  replayCalls = [];
  retention() { return { eventRetentionCount: 100, eventRetentionSeconds: 3_600 }; }
  currentCursor() { return this.cursor; }
  resyncRequired() { return false; }
  replay(after) {
    this.replayCalls.push(after);
    if (this.gapPending) {
      this.gapPending = false;
      this.cursor = "event-cursor.browser-resynced";
      return { state: "resync-required", events: [], nextCursor: this.cursor, latestCursor: this.cursor, reasonCode: "event-cursor-gap" };
    }
    return { state: "current", events: [], nextCursor: this.cursor, latestCursor: this.cursor, reasonCode: null };
  }
}

async function createFixture() {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-browser-"));
  execFileSync("git", ["init", "-q", cwd]);
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Piagent Browser Test");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "example.ts"), "export const value = 'HEAD BASE';\n");
  // Documents for the document workspace: one of each rendering path, plus a
  // file whose extension the reader refuses so the listing has something to omit.
  fs.mkdirSync(path.join(cwd, "tai-lieu"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "tai-lieu", "ke-hoach.md"),
    "# Ke hoach quy ba\n\nMuc tieu la **tang truong**.\n\n- Viec mot\n- Viec hai\n");
  fs.writeFileSync(path.join(cwd, "tai-lieu", "so-lieu.csv"), 'khu vuc,ghi chu,doanh thu\n"Bac, Trung","Da ""xac minh""",120\nNam,"Hai dong\nvan la mot o",240\n');
  fs.writeFileSync(path.join(cwd, "tai-lieu", "bao-cao.docx"), docx("Bao cao quy ba.", "Doanh thu dat 360 ty."));
  fs.writeFileSync(path.join(cwd, "tai-lieu", "khong-doc-duoc.bin"), Buffer.from([0, 1, 2, 3]));
  git("add", ".");
  git("commit", "-qm", "browser fixture baseline");
  fs.writeFileSync(path.join(cwd, "src", "example.ts"), "export const value = 'DIRTY AT TASK START';\n");
  const baseline = workingTreeSnapshot(cwd);
  currentTask = {
    ...structuredClone(taskFixture), taskId: "browser-task", taskRunId: "browser-task-run-1", sessionId: "browser-session",
    sessionName: "WebUI browser session", summary: "Xác minh WebUI local trong trình duyệt thật",
    baselineChangedFiles: Object.keys(baseline), baselineFileDigests: baseline, trace: { outcome: "pending" },
    createdAt: "2026-08-13T13:00:00.000Z", updatedAt: "2026-08-13T13:00:00.000Z"
  };
  currentTask.authoritySnapshot = createBoundTaskAuthority(currentTask);
  currentTask = writeTaskContract(cwd, currentTask);
  bindSessionTask(cwd, currentTask.sessionId, currentTask.sessionName, currentTask);
  const helperPolicy = defaultRolePolicy("scout", ["src/**"]);
  const helperRequest = createHelperRequest({ policy: helperPolicy, objective: "Inspect source boundaries", taskId: currentTask.taskId,
    taskRunId: currentTask.taskRunId, sessionId: currentTask.sessionId, parentReadScope: ["src/**"], parentWriteScope: ["src/**"],
    parentAllowedTools: ["read", "grep", "find", "ls"] });
  const helperBudget = new OwnedWorkBudgetController(), reservation = helperBudget.reserve(cwd, helperRequest, "2026-08-13T13:00:30.000Z");
  helperBudget.release(cwd, helperRequest, reservation.reservationId, "succeeded", { calls: 2, tokens: 320, output: "private helper output" }, "2026-08-13T13:01:30.000Z");
  appendContextTelemetry(cwd, { sessionId: currentTask.sessionId, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
    recordedAt: "2026-08-13T13:02:00.000Z", event: "session_compact", reason: "threshold", willRetry: false, fromExtension: false });
  appendContextTelemetry(cwd, { sessionId: currentTask.sessionId, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
    recordedAt: "2026-08-13T13:03:00.000Z", event: "tool_result", toolName: "bash", compacted: true, compactedCaptures: 1,
    outputChars: 120000, outputLines: 3000 });
  await captureTaskBaselineManifest({ projectRoot: cwd, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
    sessionId: currentTask.sessionId, capturedAt: currentTask.createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  fs.writeFileSync(path.join(cwd, "src", "example.ts"), "export const value = 'AFTER TASK';\n");
  git("add", "src/example.ts");
  const currentDigests = workingTreeSnapshot(cwd), currentTreeDigest = workingTreeEvidenceDigest(currentDigests);
  const handoff = writeHandoffProjection(cwd, buildHandoffProjection(cwd, currentTask, { generatedAt: "2026-08-13T13:04:00.000Z",
    currentDigests, gate: { decision: "fail", missing: ["operator review"], missingVerifyCommands: currentTask.verifyCommands,
      currentWorkingTreeDigest: currentTreeDigest }, recovery: null }));
  appendContextTelemetry(cwd, { sessionId: currentTask.sessionId, taskId: currentTask.taskId, taskRunId: currentTask.taskRunId,
    recordedAt: "2026-08-13T13:04:00.000Z", event: "handoff_projection_written", phase: handoff.state.phase,
    completionApproved: handoff.state.completionApproved, recoveryAction: handoff.nextSafeAction.action });
  eventStore = new BrowserEventStore();
  provider = new CoreInspectionProvider({ cwd, sessionId: currentTask.sessionId, runtimeInstanceId: "runtime.browser-e2e",
    eventStore, task: () => currentTask, sessionEntries: () => [] });
  server = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await provider.snapshot()).capabilities, readModel: provider });
}

async function openWorkspace(page, name) {
  await page.locator('[data-contract="snapshot-v1"]').waitFor({ state: "visible" });
  let choices = page.getByRole("button", { name, exact: true });
  for (let index = 0; index < await choices.count(); index += 1) if (await choices.nth(index).isVisible()) return choices.nth(index).click();
  await page.getByRole("button", { name: "Mở menu" }).click();
  choices = page.getByRole("button", { name, exact: true });
  for (let index = 0; index < await choices.count(); index += 1) if (await choices.nth(index).isVisible()) return choices.nth(index).click();
  throw new Error(`workspace navigation unavailable: ${name}`);
}

test.beforeAll(async () => {
  execFileSync("npm", ["run", "build", "--workspace", "@piagent/webui"], { cwd: root, stdio: "pipe" });
  await createFixture();
});

test.afterAll(async () => {
  await server?.close();
  if (cwd) fs.rmSync(cwd, { recursive: true, force: true });
});

test("renders the authenticated read-only cockpit, keeps tab diff authority, and reconnects after resync", async ({ page, context }) => {
  const pageErrors = [], diffRequests = [], timelineRequests = [], recoveryHistoryRequests = [], handoffHistoryRequests = [], subagentTreeRequests = [], releaseMonitorRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => { if (request.url().includes("/api/v1/diffs/")) diffRequests.push(request.url());
    if (request.url().includes("/api/v1/tasks/") && request.url().endsWith("/timeline")) timelineRequests.push(request.url());
    if (request.url().includes("/api/v1/tasks/") && request.url().endsWith("/recovery-history")) recoveryHistoryRequests.push(request.url()); });
  page.on("request", (request) => { if (request.url().includes("/api/v1/tasks/") && request.url().endsWith("/handoff-history")) handoffHistoryRequests.push(request.url()); });
  page.on("request", (request) => { if (request.url().includes("/api/v1/tasks/") && request.url().endsWith("/subagent-tree")) subagentTreeRequests.push(request.url()); });
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/monitoring/release") releaseMonitorRequests.push(request.url()); });
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByRole("heading", { name: currentTask.summary })).toBeVisible();
  await openWorkspace(page, "Chat & Task");
  await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Nội dung chat" })).toBeDisabled();
  await openWorkspace(page, "Lịch sử");
  await expect(page.getByRole("heading", { name: "Task và các lần chạy gần đây", exact: true })).toBeVisible();
  await expect(page.getByText("Đang hoạt động", { exact: true }).last()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Crash, resume, pause và checkpoint", exact: true })).toBeVisible();
  await expect(page.getByText(/Crash evidence:/)).toBeVisible();
  await expect.poll(() => timelineRequests.length).toBeGreaterThan(0);
  assert.match(new URL(timelineRequests[0]).pathname, /^\/api\/v1\/tasks\/run\.[a-f0-9]{48}\/timeline$/);
  await expect(page.getByRole("heading", { name: "Lịch sử rút gọn và phục hồi", exact: true })).toBeVisible();
  await expect(page.getByText("Nội dung capture được giữ trong private runtime state và không gửi vào trình duyệt.", { exact: true })).toBeVisible();
  await expect(page.getByText("Context đã được compact", { exact: true })).toBeVisible();
  await expect(page.getByText("Tool result đã được rút gọn", { exact: true })).toBeVisible();
  await expect.poll(() => recoveryHistoryRequests.length).toBeGreaterThan(0);
  assert.match(new URL(recoveryHistoryRequests[0]).pathname, /^\/api\/v1\/tasks\/run\.[a-f0-9]{48}\/recovery-history$/);
  await expect(page.getByRole("heading", { name: "Bàn giao và việc cần làm tiếp theo", exact: true })).toBeVisible();
  await expect(page.getByText("Handoff projection đã được ghi", { exact: true })).toBeVisible();
  await expect(page.getByText(/chỉ xem, không tự chạy/)).toBeVisible();
  await expect.poll(() => handoffHistoryRequests.length).toBeGreaterThan(0);
  assert.match(new URL(handoffHistoryRequests[0]).pathname, /^\/api\/v1\/tasks\/run\.[a-f0-9]{48}\/handoff-history$/);
  await expect(page.getByRole("heading", { name: "Quyền sở hữu và vòng đời helper", exact: true })).toBeVisible();
  await expect(page.getByText("Khảo sát · Chỉ đọc", { exact: true })).toBeVisible();
  await expect(page.getByText(/Cây lồng nhiều tầng: chưa có durable lineage/)).toBeVisible();
  await expect.poll(() => subagentTreeRequests.length).toBeGreaterThan(0);
  assert.match(new URL(subagentTreeRequests[0]).pathname, /^\/api\/v1\/tasks\/run\.[a-f0-9]{48}\/subagent-tree$/);
  await openWorkspace(page, "Release");
  await expect(page.getByRole("heading", { name: "Theo dõi chất lượng và mức sẵn sàng phát hành", exact: true })).toBeVisible();
  await expect(page.getByText(/không tự chạy benchmark, resume, commit, tag, publish hay push/)).toBeVisible();
  await expect.poll(() => releaseMonitorRequests.length).toBeGreaterThan(0);
  assert.equal(new URL(releaseMonitorRequests[0]).pathname, "/api/v1/monitoring/release");
  const monitorReads = releaseMonitorRequests.length; await page.getByRole("button", { name: "Làm mới" }).click();
  await expect.poll(() => releaseMonitorRequests.length).toBeGreaterThan(monitorReads);
  await expect(page.getByText("Chỉ xem", { exact: true })).toBeVisible();
  await expect.poll(() => eventStore.replayCalls.length).toBeGreaterThanOrEqual(2);
  assert.equal(eventStore.replayCalls[0], "event-cursor.browser-initial");
  assert.equal(eventStore.replayCalls[1], "event-cursor.browser-resynced");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
  const cookies = await context.cookies(server.origin);
  assert.equal(cookies.some((cookie) => cookie.name === "piagent_webui_session" && cookie.httpOnly && cookie.sameSite === "Strict"), true);

  await openWorkspace(page, "Source Changes");
  const taskTab = page.getByRole("tab", { name: /Thay đổi của task/ });
  await expect(taskTab).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: /src\/example\.ts/ }).click();
  await expect(page.getByText("export const value = 'DIRTY AT TASK START';", { exact: true })).toBeVisible();
  await taskTab.press("ArrowRight");
  const workingTreeTab = page.getByRole("tab", { name: /Toàn bộ working tree/ });
  await expect(workingTreeTab).toHaveAttribute("aria-selected", "true");
  await expect(workingTreeTab).toBeFocused();
  await page.getByRole("button", { name: /src\/example\.ts/ }).click();
  await expect(page.getByText("export const value = 'HEAD BASE';", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hai cột" }).click();
  await expect(page.getByRole("button", { name: "Hai cột" })).toHaveAttribute("aria-pressed", "true");
  await workingTreeTab.press("End");
  await expect(page.getByRole("tab", { name: /Đã chuẩn bị commit/ })).toHaveAttribute("aria-selected", "true");
  assert.equal(diffRequests.some((url) => new URL(url).searchParams.get("view") === "task"), true);
  assert.equal(diffRequests.some((url) => new URL(url).searchParams.get("view") === "working-tree"), true);

  currentTask = { ...currentTask, sessionName: "WebUI live update received", updatedAt: "2026-08-13T13:00:01.000Z" };
  eventStore.cursor = "event-cursor.browser-live";
  provider.publishObserved({ eventCursor: eventStore.cursor, kind: "runtime.phase-changed" });
  await expect(page.getByText("WebUI live update received", { exact: true }).filter({ visible: true })).toBeVisible();
  assert.deepEqual(pageErrors, []);
});

test("switches and persists English plus the docs-style light theme", async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem("piagent-webui-locale")) localStorage.setItem("piagent-webui-locale", "vi");
    if (!localStorage.getItem("piagent-webui-color-mode")) localStorage.setItem("piagent-webui-color-mode", "dark");
  });
  await page.goto(server.issueLaunchUrl());
  await page.locator('[data-contract="snapshot-v1"]').waitFor({ state: "visible" });
  await expect(page.locator("html")).toHaveAttribute("lang", "vi");
  await expect(page.locator("html")).toHaveAttribute("data-piagent-color-mode", "dark");
  await page.getByRole("button", { name: "English" }).filter({ visible: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await openWorkspace(page, "Source Changes");
  await expect(page.getByRole("heading", { name: "Project changes", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use light mode" }).filter({ visible: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-piagent-color-mode", "light");
  await page.mouse.move(1, 1); await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const result = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(result.violations.map((violation) => violation.id), [], JSON.stringify(result.violations.map((violation) => ({
    id: violation.id, help: violation.help,
    nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary }))
  })), null, 2));
  await page.reload();
  await page.locator('[data-contract="snapshot-v1"]').waitFor({ state: "visible" });
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("data-piagent-color-mode", "light");
  await expect(page.getByRole("button", { name: "Use dark mode" }).filter({ visible: true })).toBeVisible();
});

test("marks, unmarks and stales an exact selected-file review without changing Git", async ({ page }) => {
  const runtimeInstanceId = "runtime.browser-review", identity = { projectRef: "project.browser-review", runtimeInstanceId,
    sessionRef: "session.browser-review", taskId: currentTask.taskId, taskRunId: currentTask.taskRunId, agentOperationId: null, toolCallId: null };
  const revisions = { runtimeRevision: "runtime-rev.browser-review", taskRevision: webUiTaskRevision(currentTask),
    controlRevision: "control-rev.browser-review", workspaceRevision: null, indexRevision: null, approvalRevision: null,
    sessionOptionRevision: "session-option-rev.browser-review", queueRevision: "queue-rev.browser-review" };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions, liveness: "idle", taskState: "active" }) };
  const events = new BrowserEventStore(); events.gapPending = false;
  const reviewProvider = new CoreInspectionProvider({ cwd, sessionId: currentTask.sessionId, runtimeInstanceId, eventStore: events,
    task: () => currentTask, sessionEntries: () => [], chatControl: () => ({ state: "ready", liveness: "idle", taskState: "active",
      identity, revisions, heldCount: 0, queueRevision: revisions.queueRevision }) });
  const controller = new ReviewController({ bridge, projectRoot: cwd, resolve: (view, fileRef) => reviewProvider.review(view, fileRef) });
  const reviewServer = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await reviewProvider.snapshot()).capabilities, readModel: reviewProvider,
    executeControl: async (command) => { const receipt = await controller.execute(command); reviewProvider.invalidate(); return receipt; } });
  try {
    const before = fs.readFileSync(path.join(cwd, "src", "example.ts"), "utf8"), indexBefore = git("diff", "--cached", "--", "src/example.ts");
    await page.goto(reviewServer.issueLaunchUrl());
    await openWorkspace(page, "Source Changes");
    await page.getByRole("button", { name: /src\/example\.ts/ }).click();
    await expect(page.getByText("Chưa review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Đánh dấu đã review" }).click();
    await expect(page.getByText("Đã review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Bỏ dấu review" }).click();
    await expect(page.getByText("Chưa review", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Đánh dấu đã review" }).click();
    await expect(page.getByText("Đã review", { exact: true })).toBeVisible();
    assert.equal(fs.readFileSync(path.join(cwd, "src", "example.ts"), "utf8"), before);
    assert.equal(git("diff", "--cached", "--", "src/example.ts"), indexBefore);

    fs.writeFileSync(path.join(cwd, "src", "example.ts"), "export const value = 'CHANGED AFTER REVIEW';\n");
    reviewProvider.invalidate(); await page.reload(); await openWorkspace(page, "Source Changes");
    await page.getByRole("button", { name: /src\/example\.ts/ }).click();
    await expect(page.getByText("Review đã cũ", { exact: true })).toBeVisible();
  } finally { await reviewServer.close(); }
});

test("stages and unstages one exact file while preserving worktree content", async ({ page }) => {
  test.setTimeout(60_000);
  let snapshotReads = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/v1/snapshot") snapshotReads += 1; });
  const mutationCwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-browser-mutation-"));
  const runGit = (...args) => execFileSync("git", ["-C", mutationCwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", mutationCwd]); runGit("config", "user.email", "test@example.com"); runGit("config", "user.name", "Piagent Browser Test");
  fs.writeFileSync(path.join(mutationCwd, "selected.txt"), "BASE\n"); runGit("add", "selected.txt"); runGit("commit", "-qm", "mutation baseline");
  const baseline = workingTreeSnapshot(mutationCwd), task = { ...structuredClone(taskFixture), taskId: "browser-mutation-task",
    taskRunId: "browser-mutation-run", sessionId: "browser-mutation-session", sessionName: "Browser mutation",
    summary: "Stage và unstage file an toàn", baselineChangedFiles: [], baselineFileDigests: baseline, trace: { outcome: "pending" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  task.authoritySnapshot = createBoundTaskAuthority(task);
  await captureTaskBaselineManifest({ projectRoot: mutationCwd, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
    capturedAt: task.createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  const expected = "OPERATOR PREVIEWED THIS\n"; fs.writeFileSync(path.join(mutationCwd, "selected.txt"), expected);
  const changedSnapshot = workingTreeSnapshot(mutationCwd);
  assert.ok(appendMutationProvenance({ projectRoot: mutationCwd, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
    toolCallId: "tool.browser-runtime-write", toolName: "write", recordedAt: new Date(Date.parse(task.createdAt) + 1_000).toISOString(),
    beforeSnapshot: baseline, afterSnapshot: changedSnapshot, changedPaths: ["selected.txt"],
    recordedDigests: { "selected.txt": changedSnapshot["selected.txt"] },
    recordedContentDigests: { "selected.txt": createHash("sha256").update(expected).digest("hex") },
    proofModes: { "selected.txt": "full-content" }, protectedPaths: [] }));
  const runtimeInstanceId = "runtime.browser-mutation", identity = { projectRef: "project.browser-mutation", runtimeInstanceId,
    sessionRef: "session.browser-mutation", taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  const revisions = { runtimeRevision: "runtime-rev.browser-mutation", taskRevision: webUiTaskRevision(task),
    controlRevision: "control-rev.browser-mutation", workspaceRevision: null, indexRevision: null, approvalRevision: null,
    sessionOptionRevision: null, queueRevision: "queue-rev.browser-mutation" };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions, liveness: "idle", taskState: "active" }) };
  const mutationGuard = new PiSourceMutationGuard();
  const unbindMutationGuard = mutationGuard.bind({ cwd: mutationCwd, rawSessionId: task.sessionId,
    guardInstanceId: "guard.browser-mutation", facts: () => ({ taskId: task.taskId, taskRunId: task.taskRunId,
      taskRevision: revisions.taskRevision, controlRevision: revisions.controlRevision, taskState: "active", idle: true,
      isProtectedPath: () => false }) });
  const events = new BrowserEventStore(); events.gapPending = false;
  let openedInVSCode = 0; const modelSummaryPrompts = [];
  const mutationProvider = new CoreInspectionProvider({ cwd: mutationCwd, sessionId: task.sessionId, runtimeInstanceId, eventStore: events,
    task: () => task, sessionEntries: () => [], chatControl: () => ({ state: "ready", liveness: "idle", taskState: "active", identity,
      revisions, heldCount: 0, queueRevision: revisions.queueRevision }),
    sourceMutationGuardAvailable: () => mutationGuard.available(mutationCwd, task.sessionId), sourceOpenAvailable: () => true });
  const controller = new SourceMutationController({ bridge, projectRoot: mutationCwd,
    resolve: (action, fileRef) => mutationProvider.sourceMutationAuthority(action, fileRef), revisions: () => mutationProvider.canonicalRevisions(),
    mutate: (input) => mutationGuard.execute({ cwd: mutationCwd, rawSessionId: task.sessionId, ...input }) });
  const revertController = new SourceRevertController({ bridge, projectRoot: mutationCwd,
    resolve: (fileRef, hunkRefs) => mutationProvider.sourceRevertAuthority(fileRef, hunkRefs), revisions: () => mutationProvider.canonicalRevisions(),
    mutate: (input) => mutationGuard.executeRevert({ cwd: mutationCwd, rawSessionId: task.sessionId, ...input }) });
  const openController = new SourceOpenController({ bridge, projectRoot: mutationCwd,
    resolve: (fileRef) => mutationProvider.sourceOpenAuthority(fileRef),
    open: async (absolutePath) => { openedInVSCode += 1; assert.equal(absolutePath, fs.realpathSync.native(path.join(mutationCwd, "selected.txt")));
      return { state: "settled", reasonCode: null }; } });
  const mutationServer = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await mutationProvider.snapshot()).capabilities, readModel: mutationProvider,
    executeControl: async (command) => { const receipt = command?.action === "source.revert" ? await revertController.execute(command)
      : command?.action === "source.open-in-vscode" ? await openController.execute(command)
        : command?.action === "chat.send" ? (modelSummaryPrompts.push(command.payload.text), { phase: "settled", resultCode: "dispatch-observed", error: null })
          : await controller.execute(command);
      mutationProvider.invalidate(); return receipt; } });
  try {
    await page.goto(mutationServer.issueLaunchUrl());
    await openWorkspace(page, "Source Changes");
    await page.getByRole("tab", { name: /Toàn bộ working tree/ }).click();
    await page.getByRole("button", { name: /selected\.txt/ }).click();
    await expect(page.getByText("Chuẩn bị đúng thay đổi file này để commit", { exact: true })).toBeVisible({ timeout: 10_000 });
    const openResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-handoffs") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Mở trong VS Code" }).click();
    assert.equal((await (await openResponse).json()).resultCode, "opened");
    await expect(page.getByText("VS Code đã nhận yêu cầu mở file.", { exact: true })).toBeVisible();
    assert.equal(openedInVSCode, 1);
    const snapshotsBeforeStage = snapshotReads;
    const stageResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-mutations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Stage file" }).click();
    assert.equal((await (await stageResponse).json()).resultCode, "staged");
    await expect.poll(() => snapshotReads).toBeGreaterThan(snapshotsBeforeStage);
    await page.getByRole("button", { name: /selected\.txt/ }).click();
    await expect(page.getByRole("button", { name: "Stage file" })).toHaveCount(0);
    assert.equal(fs.readFileSync(path.join(mutationCwd, "selected.txt"), "utf8"), expected);
    const stagedText = runGit("show", ":selected.txt");
    if (stagedText !== expected) throw new Error(`staged content mismatch ${JSON.stringify({ stagedText, expected })}`);

    await page.getByRole("tab", { name: /Đã chuẩn bị commit/ }).click();
    await expect(page.getByRole("heading", { name: "Tóm tắt phần đã stage" })).toBeVisible();
    await page.getByRole("button", { name: "Tạo summary · 0 token" }).click();
    await expect(page.getByText("Update selected.txt", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Nhờ Pi viết lại · tốn model token" }).click();
    const modelDialog = page.getByRole("alertdialog", { name: "Nhờ Pi viết lại commit summary?" });
    await expect(modelDialog.getByText(/bắt đầu một Pi operation và tiêu token/)).toBeVisible();
    const modelResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/chat/messages") && response.request().method() === "POST");
    await modelDialog.getByRole("button", { name: "Xác nhận và gửi sang Pi" }).click();
    assert.equal((await (await modelResponse).json()).resultCode, "dispatch-observed");
    await expect(page.getByText(/Đã gửi yêu cầu sang Chat/)).toBeVisible();
    assert.equal(modelSummaryPrompts.length, 1); assert.match(modelSummaryPrompts[0], /Index revision:/);
    assert.doesNotMatch(modelSummaryPrompts[0], /OPERATOR PREVIEWED THIS/);
    await page.getByRole("button", { name: /selected\.txt/ }).click();
    await expect(page.getByText("Bỏ khỏi vùng commit; giữ nguyên file đang làm việc", { exact: true })).toBeVisible();
    const unstageResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-mutations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Unstage file" }).click();
    assert.equal((await (await unstageResponse).json()).resultCode, "unstaged");
    await expect(page.getByText("Không có thay đổi trong view này.", { exact: true })).toBeVisible();
    assert.equal(runGit("diff", "--cached", "--", "selected.txt"), "");
    assert.equal(fs.readFileSync(path.join(mutationCwd, "selected.txt"), "utf8"), expected);

    await page.getByRole("tab", { name: /Toàn bộ working tree/ }).click();
    await page.getByRole("button", { name: /selected\.txt/ }).click();
    await expect(page.getByRole("button", { name: "Revert file" })).toBeVisible();
    await page.getByRole("button", { name: "Revert file" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Revert file?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/OPERATOR PREVIEWED THIS/)).toBeVisible();
    await expect(dialog.getByText(/BASE/)).toBeVisible();
    await expect(dialog.getByText("Phần đã stage được giữ nguyên.", { exact: true })).toBeVisible();
    const snapshotsBeforeRevert = snapshotReads;
    const revertResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-mutations") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Xác nhận revert" }).click();
    const revertReceipt = await (await revertResponse).json();
    assert.equal(revertReceipt.resultCode, "reverted", JSON.stringify(revertReceipt));
    await expect.poll(() => snapshotReads).toBeGreaterThan(snapshotsBeforeRevert);
    assert.equal(fs.readFileSync(path.join(mutationCwd, "selected.txt"), "utf8"), "BASE\n");
    assert.equal(runGit("show", ":selected.txt"), "BASE\n");
  } finally { await mutationServer.close(); unbindMutationGuard(); fs.rmSync(mutationCwd, { recursive: true, force: true }); }
});

test("stages and unstages one selected hunk through the guarded WebUI", async ({ page }) => {
  const hunkCwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-browser-hunk-"));
  const runGit = (...args) => execFileSync("git", ["-C", hunkCwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", hunkCwd]); runGit("config", "user.email", "test@example.com"); runGit("config", "user.name", "Piagent Browser Test");
  const baseLines = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`), changedLines = [...baseLines];
  fs.writeFileSync(path.join(hunkCwd, "selected.txt"), `${baseLines.join("\n")}\n`); runGit("add", "selected.txt"); runGit("commit", "-qm", "hunk baseline");
  const baseline = workingTreeSnapshot(hunkCwd), task = { ...structuredClone(taskFixture), taskId: "browser-hunk-task",
    taskRunId: "browser-hunk-run", sessionId: "browser-hunk-session", sessionName: "Browser hunk",
    summary: "Stage và unstage từng hunk", baselineChangedFiles: [], baselineFileDigests: baseline, trace: { outcome: "pending" },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  task.authoritySnapshot = createBoundTaskAuthority(task);
  await captureTaskBaselineManifest({ projectRoot: hunkCwd, taskId: task.taskId, taskRunId: task.taskRunId, sessionId: task.sessionId,
    capturedAt: task.createdAt, baselineTreeDigest: workingTreeEvidenceDigest(baseline) });
  changedLines[1] = "line 2 changed"; changedLines[20] = "line 21 changed";
  const worktree = `${changedLines.join("\n")}\n`; fs.writeFileSync(path.join(hunkCwd, "selected.txt"), worktree);
  const runtimeInstanceId = "runtime.browser-hunk", identity = { projectRef: "project.browser-hunk", runtimeInstanceId,
    sessionRef: "session.browser-hunk", taskId: task.taskId, taskRunId: task.taskRunId, agentOperationId: null, toolCallId: null };
  const revisions = { runtimeRevision: "runtime-rev.browser-hunk", taskRevision: webUiTaskRevision(task),
    controlRevision: "control-rev.browser-hunk", workspaceRevision: null, indexRevision: null, approvalRevision: null,
    sessionOptionRevision: null, queueRevision: "queue-rev.browser-hunk" };
  const bridge = { snapshot: () => ({ state: "ready", identity, revisions, liveness: "idle", taskState: "active" }) };
  const mutationGuard = new PiSourceMutationGuard(), unbind = mutationGuard.bind({ cwd: hunkCwd, rawSessionId: task.sessionId,
    guardInstanceId: "guard.browser-hunk", facts: () => ({ taskId: task.taskId, taskRunId: task.taskRunId,
      taskRevision: revisions.taskRevision, controlRevision: revisions.controlRevision, taskState: "active", idle: true, isProtectedPath: () => false }) });
  const events = new BrowserEventStore(); events.gapPending = false;
  const hunkProvider = new CoreInspectionProvider({ cwd: hunkCwd, sessionId: task.sessionId, runtimeInstanceId, eventStore: events,
    task: () => task, sessionEntries: () => [], chatControl: () => ({ state: "ready", liveness: "idle", taskState: "active", identity,
      revisions, heldCount: 0, queueRevision: revisions.queueRevision }), sourceMutationGuardAvailable: () => mutationGuard.available(hunkCwd, task.sessionId) });
  const controller = new SourceMutationController({ bridge, projectRoot: hunkCwd,
    resolve: (action, fileRef) => hunkProvider.sourceMutationAuthority(action, fileRef), revisions: () => hunkProvider.canonicalRevisions(),
    mutate: (input) => mutationGuard.execute({ cwd: hunkCwd, rawSessionId: task.sessionId, ...input }) });
  const hunkServer = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await hunkProvider.snapshot()).capabilities, readModel: hunkProvider,
    executeControl: async (command) => { const receipt = await controller.execute(command); hunkProvider.invalidate(); return receipt; } });
  try {
    await page.goto(hunkServer.issueLaunchUrl()); await openWorkspace(page, "Source Changes"); await page.getByRole("tab", { name: /Toàn bộ working tree/ }).click();
    await page.getByRole("button", { name: /selected\.txt/ }).click(); await expect(page.getByRole("button", { name: "Stage hunk" })).toHaveCount(2);
    const firstStageResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-mutations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Stage hunk" }).first().click(); assert.equal((await (await firstStageResponse).json()).resultCode, "staged");
    await page.getByRole("button", { name: /selected\.txt/ }).click(); await expect(page.getByRole("button", { name: "Stage hunk" })).toHaveCount(1);
    const firstOnly = [...baseLines]; firstOnly[1] = changedLines[1];
    assert.equal(runGit("show", ":selected.txt"), `${firstOnly.join("\n")}\n`); assert.equal(fs.readFileSync(path.join(hunkCwd, "selected.txt"), "utf8"), worktree);
    const secondStageResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-mutations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Stage hunk" }).click(); assert.equal((await (await secondStageResponse).json()).resultCode, "staged");
    await page.getByRole("tab", { name: /Đã chuẩn bị commit/ }).click();
    await page.getByRole("button", { name: /selected\.txt/ }).click(); await expect(page.getByRole("button", { name: "Unstage hunk" })).toHaveCount(2);
    const unstageResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/source-mutations") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Unstage hunk" }).first().click(); assert.equal((await (await unstageResponse).json()).resultCode, "unstaged");
    const secondOnly = [...baseLines]; secondOnly[20] = changedLines[20];
    assert.equal(runGit("show", ":selected.txt"), `${secondOnly.join("\n")}\n`); assert.equal(fs.readFileSync(path.join(hunkCwd, "selected.txt"), "utf8"), worktree);
  } finally { await hunkServer.close(); unbind(); fs.rmSync(hunkCwd, { recursive: true, force: true }); }
});

test("passes rendered accessibility checks and stays inside a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.issueLaunchUrl());
  await expect(page.getByRole("heading", { name: currentTask.summary })).toBeVisible();
  await page.locator("body").press("Tab");
  const firstFocus = await page.evaluate(() => document.activeElement?.outerHTML ?? "none");
  assert.match(firstFocus, /class="skip-link"/, `first keyboard focus was ${firstFocus}`);
  const overflow = await page.evaluate(() => ({ body: document.body.scrollWidth - document.body.clientWidth, html: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
  assert.ok(overflow.body <= 1 && overflow.html <= 1, `mobile page overflowed horizontally: ${JSON.stringify(overflow)}`);
  const result = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(result.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.length })), [], JSON.stringify(
    result.violations.map((violation) => ({ id: violation.id, help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary })) })), null, 2
  ));
  const aria = await page.getByRole("main").ariaSnapshot();
  assert.match(aria, /heading "Xác minh WebUI local trong trình duyệt thật"/);
  await openWorkspace(page, "Source Changes");
  await expect(page.getByRole("tablist", { name: "Nguồn thay đổi" })).toBeVisible();
  await openWorkspace(page, "Activity");
  await expect(page.getByRole("heading", { name: "Tool, command và kết quả lượt chạy" })).toBeVisible();
  // The document workspace renders its own list and viewer, so it needs its own
  // pass — the sweep above only ever saw the overview.
  await openWorkspace(page, "Tài liệu");
  await page.getByRole("button", { name: /ke-hoach\.md/ }).click();
  await expect(page.getByRole("heading", { name: "Ke hoach quy ba" })).toBeVisible();
  const documents = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(documents.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.length })), [], JSON.stringify(
    documents.violations.map((violation) => ({ id: violation.id, help: violation.help,
      nodes: violation.nodes.map((node) => ({ target: node.target, html: node.html, failureSummary: node.failureSummary })) })), null, 2
  ));
});

test("opens markdown, tabular and .docx documents from the project as a read-only workspace", async ({ page }) => {
  await page.goto(server.issueLaunchUrl());
  await openWorkspace(page, "Tài liệu");
  // Levelled because the app bar titles the workspace with the same words.
  await expect(page.getByRole("heading", { level: 2, name: "Tài liệu" })).toBeVisible();

  // Only what the reader can turn into text is offered, and the project root is
  // named as the source it came from.
  await expect(page.getByRole("button", { name: /ke-hoach\.md/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /so-lieu\.csv/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /bao-cao\.docx/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /khong-doc-duoc\.bin/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /example\.ts/ })).toHaveCount(0);

  // Markdown renders as markdown rather than as its own source.
  await page.getByRole("button", { name: /ke-hoach\.md/ }).click();
  await expect(page.getByRole("heading", { name: "Ke hoach quy ba" })).toBeVisible();
  await expect(page.getByText("tang truong", { exact: true })).toBeVisible();
  await expect(page.getByText("# Ke hoach quy ba", { exact: true })).toHaveCount(0);

  // A .csv is a table, not a wall of commas.
  await page.getByRole("button", { name: /so-lieu\.csv/ }).click();
  await expect(page.getByRole("columnheader", { name: "doanh thu" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Bac, Trung" })).toBeVisible();
  await expect(page.getByRole("cell", { name: 'Da "xac minh"' })).toBeVisible();
  await expect(page.getByRole("cell", { name: /Hai dong\s+van la mot o/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "240" })).toBeVisible();

  // The .docx opens as the prose inside it; the archive never reaches the page.
  await page.getByRole("button", { name: /bao-cao\.docx/ }).click();
  await expect(page.getByText("Bao cao quy ba.")).toBeVisible();
  await expect(page.getByText("Doanh thu dat 360 ty.")).toBeVisible();
  assert.equal((await page.locator("body").innerText()).includes("word/document.xml"), false);

  // The filter narrows the list without refetching the document.
  await page.getByLabel("Lọc tài liệu").fill("csv");
  await expect(page.getByRole("button", { name: /so-lieu\.csv/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /ke-hoach\.md/ })).toHaveCount(0);
});

test("renders and resolves the exact Pi-owned approval card without direct execution", async ({ page }) => {
  const broker = new PiApprovalBroker(), runtimeInstanceId = "runtime.browser-approval", sessionId = currentTask.sessionId;
  const identity = { projectRef: "project.browser-approval", runtimeInstanceId, sessionRef: "session.browser-approval",
    taskId: currentTask.taskId, taskRunId: currentTask.taskRunId, agentOperationId: "operation.browser-approval" };
  const revisions = { runtimeRevision: "runtime-rev.browser-approval", taskRevision: "task-rev.browser-approval", controlRevision: "control-rev.browser-approval" };
  broker.bind({ cwd, rawSessionId: sessionId, runtimeInstanceId, authority: () => ({ identity, revisions, taskState: "active" }) });
  const approvalEvents = new BrowserEventStore(); approvalEvents.gapPending = false;
  const approvalProvider = new CoreInspectionProvider({ cwd, sessionId, runtimeInstanceId, eventStore: approvalEvents, task: () => currentTask,
    approvalProjection: () => broker.projection(cwd, sessionId), approvalDetail: (approvalRef) => broker.detail(cwd, sessionId, approvalRef),
    chatControl: () => ({ state: "ready", liveness: "running", taskState: "active", identity: { ...identity, toolCallId: null },
      revisions: { ...revisions, workspaceRevision: null, indexRevision: null, approvalRevision: broker.projection(cwd, sessionId).revision,
        sessionOptionRevision: null, queueRevision: "queue-rev.browser-approval" }, heldCount: 0, queueRevision: "queue-rev.browser-approval" }) });
  const approvalServer = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await approvalProvider.snapshot()).capabilities, readModel: approvalProvider,
    executeApproval: async (approvalRef, decision) => { const receipt = await broker.decide(cwd, sessionId, approvalRef, decision); approvalProvider.invalidate(); return receipt; } });
  let resolveTerminal; const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
  const action = { kind: "external-provider-action", preconditionClass: "runtime-only", toolName: "mcp__github__create_issue",
    rawAction: { owner: "org", repo: "repo", title: "Release" }, commandPreview: null, parameterPreview: "Create one issue",
    targetPaths: [], targetSummaries: [], provider: "github", urlOrigin: "https://github.com", requestedScope: "one-external-action",
    reason: "Tạo issue cần xác nhận", riskClass: "high", allowConsequence: "Tạo đúng một issue", denyConsequence: "Không gửi dữ liệu ra ngoài" };
  try {
    const deniedPromise = broker.request({ cwd, rawSessionId: sessionId, toolCallId: "tool.browser-deny", action,
      expectedTask: { taskId: currentTask.taskId, taskRunId: currentTask.taskRunId }, terminalConfirm: () => terminal });
    await new Promise((resolve) => setImmediate(resolve));
    const approvalSnapshot = await approvalProvider.snapshot(), snapshotValidation = validateFixture(schemaRegistry, "snapshot-v1", approvalSnapshot);
    assert.equal(snapshotValidation.valid, true, snapshotValidation.errors);
    approvalProvider.invalidate(); await page.goto(approvalServer.issueLaunchUrl());
    await expect(page.getByRole("heading", { name: "mcp__github__create_issue" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cho phép đúng 1 lần" })).toBeVisible();
    await page.getByRole("button", { name: "Từ chối" }).click(); assert.equal((await deniedPromise).allowed, false);
    await expect(page.getByRole("heading", { name: "mcp__github__create_issue" })).not.toBeVisible();

    const allowedPromise = broker.request({ cwd, rawSessionId: sessionId, toolCallId: "tool.browser-allow", action,
      expectedTask: { taskId: currentTask.taskId, taskRunId: currentTask.taskRunId }, terminalConfirm: () => terminal });
    const consumed = allowedPromise.then((guard) => ({ allowed: guard.allowed, consumed: guard.consume() }));
    approvalProvider.invalidate(); approvalEvents.cursor = "event-cursor.browser-approval";
    approvalProvider.publishObserved({ eventCursor: approvalEvents.cursor, kind: "approval.requested" });
    await expect(page.getByRole("heading", { name: "mcp__github__create_issue" })).toBeVisible();
    await page.getByRole("button", { name: "Cho phép đúng 1 lần" }).click();
    assert.deepEqual(await consumed, { allowed: true, consumed: true });
    await expect(page.getByRole("heading", { name: "mcp__github__create_issue" })).not.toBeVisible();
  } finally { resolveTerminal(false); await approvalServer.close(); }
});

test("pauses at a safe point, resumes without a model turn, and stops only after settlement", async ({ page }) => {
  const controlCwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-browser-lifecycle-"));
  execFileSync("git", ["init", "-q", controlCwd]); execFileSync("git", ["-C", controlCwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", controlCwd, "config", "user.name", "Piagent Browser Test"]); fs.writeFileSync(path.join(controlCwd, "tracked.txt"), "base\n");
  execFileSync("git", ["-C", controlCwd, "add", "tracked.txt"]); execFileSync("git", ["-C", controlCwd, "commit", "-qm", "lifecycle fixture"]);
  const taskInput = { ...structuredClone(taskFixture), taskId: "browser-lifecycle-task",
    taskRunId: "task-20260814000000-browser01", sessionId: "browser-lifecycle-session", sessionName: "TASK browser lifecycle",
    summary: "Kiểm tra điều khiển task", baselineChangedFiles: [], baselineFileDigests: {}, trace: { outcome: "pending" },
    createdAt: "2026-08-14T00:00:00.000Z", updatedAt: "2026-08-14T00:00:00.000Z" };
  taskInput.authoritySnapshot = createBoundTaskAuthority(taskInput);
  const task = writeTaskContract(controlCwd, taskInput);
  bindSessionTask(controlCwd, task.sessionId, task.sessionName, task);
  const entries = []; let idle = false, aborts = 0, sends = 0, bridge;
  const ctx = { cwd: controlCwd, isIdle: () => idle, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => task.sessionId, getBranch: () => structuredClone(entries),
      getLeafId: () => entries.at(-1)?.id ?? null, getLeafEntry: () => structuredClone(entries.at(-1) ?? null) }, abort() { aborts += 1; } };
  const pi = { appendEntry(customType, data) { entries.push({ id: `lifecycle_${entries.length + 1}`, type: "custom", customType, data }); },
    sendUserMessage(text) { sends += 1; const parentId = entries.at(-1)?.id ?? null, message = { role: "user", content: text };
      entries.push({ id: `lifecycle_${entries.length + 1}`, parentId, type: "message", message });
      bridge.observeInput({ source: "extension", text }, ctx); idle = false; bridge.observeAgentStart(ctx); } };
  const taskFacts = () => { const control = inspectTaskControlState(controlCwd, task); return { taskId: task.taskId, taskRunId: task.taskRunId,
    taskRevision: "task-rev.browser-lifecycle", controlRevision: control.controlRevision, controlState: control.state }; };
  bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime.browser-lifecycle", taskFacts }); bridge.bind(ctx); bridge.observeAgentStart(ctx);
  const lifecycle = new LifecycleController({ bridge, runtimeInstanceId: "runtime.browser-lifecycle", task: () => task,
    abort: () => { aborts += 1; }, cancelApprovals: () => undefined,
    treeDigest: () => workingTreeEvidenceDigest(workingTreeSnapshot(controlCwd)) });
  lifecycle.bind(ctx); lifecycle.observeAgentStart(ctx); lifecycle.observeToolStart(ctx);
  const lifecycleEvents = new BrowserEventStore(); lifecycleEvents.gapPending = false;
  const lifecycleProvider = new CoreInspectionProvider({ cwd: controlCwd, sessionId: task.sessionId, runtimeInstanceId: "runtime.browser-lifecycle",
    eventStore: lifecycleEvents, task: () => task, sessionEntries: () => structuredClone(entries), lifecycleControl: () => lifecycle.snapshot(),
    chatControl: () => { const value = bridge.snapshot(); return { ...value, heldCount: 0, queueRevision: value.revisions?.queueRevision ?? null }; } });
  const lifecycleServer = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await lifecycleProvider.snapshot()).capabilities, readModel: lifecycleProvider,
    executeControl: async (value) => {
      const operation = bridge.snapshot().identity?.agentOperationId ?? null, receiptPromise = lifecycle.execute(value);
      if (value?.action === "lifecycle.stop") setTimeout(() => { lifecycle.observeToolEnd(ctx); bridge.observeAgentSettled(ctx); idle = true;
        lifecycle.observeAgentSettled(ctx, operation); lifecycleProvider.invalidate(); }, 20);
      const receipt = await receiptPromise; lifecycleProvider.invalidate(); return receipt;
    } });
  try {
    await page.goto(lifecycleServer.issueLaunchUrl());
    await openWorkspace(page, "Chat & Task");
    await expect(page.getByRole("heading", { name: "Stop, pause & resume" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Dừng lượt hiện tại" })).toBeEnabled();
    await page.getByRole("button", { name: "Tạm dừng task" }).click();
    await expect(page.getByText("Đang chờ tool hiện tại kết thúc tại điểm an toàn.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tiếp tục task" })).toBeEnabled();
    await page.getByRole("button", { name: "Tiếp tục task" }).click();
    await expect(page.getByText("Đã hủy yêu cầu tạm dừng; chưa gọi model.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Dừng lượt hiện tại" }).click();
    await expect(page.getByText("Đã dừng lượt Pi hiện tại; task vẫn được giữ lại.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Tạm dừng task" }).click();
    await expect(page.getByText("Task đã tạm dừng an toàn.", { exact: true })).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Nội dung chat" });
    await composer.fill("Tiếp tục đúng một lần từ checkpoint đã xác minh.");
    await expect(page.getByRole("button", { name: "Tiếp tục & gửi" })).toBeEnabled();
    await page.getByRole("button", { name: "Tiếp tục & gửi" }).click();
    await expect(page.getByText("Đã gửi vào Pi session", { exact: true })).toBeVisible();
    assert.equal(aborts, 1); assert.equal(sends, 1); assert.equal(task.trace.outcome, "pending");
    assert.equal(entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").length, 1);
  } finally { await lifecycleServer.close(); fs.rmSync(controlCwd, { recursive: true, force: true }); }
});

test("holds, edits, dispatches and deletes messages through the authenticated current-session composer", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const browserModels = [
    { provider: "browser-provider", id: "browser-model-a", name: "Model Browser A", reasoning: true, input: ["text", "image"],
      thinkingLevelMap: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
      contextWindow: 200_000, maxTokens: 32_000 },
    { provider: "browser-provider", id: "browser-model-b", name: "Model Browser B", reasoning: true, input: ["text"],
      thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
      contextWindow: 100_000, maxTokens: 16_000 }
  ];
  const entries = []; let idle = true, sequence = 0, sends = 0, bridge, attachmentStore, activeModel = browserModels[0], thinking = "medium";
  let armDelayedCatalog = false, catalogReadsAfterThinking = 0, resolveDelayedCatalogStarted, releaseDelayedCatalogResponse;
  const delayedCatalogStarted = new Promise((resolve) => { resolveDelayedCatalogStarted = resolve; });
  const delayedCatalogResponse = new Promise((resolve) => { releaseDelayedCatalogResponse = resolve; });
  const sentContents = [];
  const append = (entry) => {
    const value = { id: `control_entry_${++sequence}`, parentId: entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(), ...structuredClone(entry) };
    entries.push(value); return value;
  };
  const context = {
    cwd, isIdle: () => idle, get model() { return activeModel; }, get thinkingLevel() { return thinking; }, scopedModels: [],
    modelRegistry: { getAvailable: () => structuredClone(browserModels) },
    sessionManager: { getSessionId: () => "browser-control-session", getBranch: () => structuredClone(entries),
      getLeafId: () => entries.at(-1)?.id ?? null, getLeafEntry: () => structuredClone(entries.at(-1) ?? null) }
  };
  const pi = {
    appendEntry(customType, data) { append({ type: "custom", customType, data }); },
    sendUserMessage(content) {
      sends += 1; sentContents.push(structuredClone(content)); idle = false;
      const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
      const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      bridge.observeInput({ source: "extension", text }, context);
      append({ type: "message", message: { role: "user", content: parts } });
      queueMicrotask(() => bridge.observeAgentStart(context));
    },
    async setModel(model) { activeModel = model; return true; },
    setThinkingLevel(level) { thinking = level; }, getThinkingLevel() { return thinking; }
  };
  bridge = new SameSessionPiBridge(pi, { runtimeInstanceId: "runtime.browser-control",
    prepareAttachments: (refs, request, identity, text) => attachmentStore.claim(refs, request, identity, text) });
  bridge.bind(context);
  attachmentStore = new AttachmentStore({ runtimeInstanceId: "runtime.browser-control", bridgeSnapshot: () => bridge.snapshot(),
    modelSupportsImages: () => activeModel.input.includes("image") });
  const heldQueue = new HeldMessageQueue({ bridge, appendEntry: pi.appendEntry });
  const sessionOptions = new SessionOptionsController({ pi, bridge }); sessionOptions.bind(context);
  const controlEvents = new BrowserEventStore(); controlEvents.gapPending = false;
  const controlProvider = new CoreInspectionProvider({ cwd, sessionId: "browser-control-session", runtimeInstanceId: "runtime.browser-control",
    eventStore: controlEvents, sessionEntries: () => structuredClone(entries), queueProjection: () => heldQueue.projection(),
    model: () => activeModel, thinkingLevel: () => thinking, modelCatalog: () => sessionOptions.catalog(),
    attachmentCapability: () => attachmentStore.capability(),
    chatControl: () => { const state = bridge.snapshot(), queueState = heldQueue.snapshot();
      return { ...state, heldCount: queueState.heldCount, queueRevision: queueState.queueRevision }; } });
  const delayedReadModel = new Proxy(controlProvider, { get(target, property) {
    if (property === "modelCatalog") return async () => {
      const value = await target.modelCatalog();
      if (armDelayedCatalog && ++catalogReadsAfterThinking === 2) {
        armDelayedCatalog = false; resolveDelayedCatalogStarted(); await delayedCatalogResponse;
      }
      return value;
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const controlServer = await startLoopbackServer({ staticRoot: path.join(root, "packages/piagent-webui/dist/client"),
    readCapabilities: async () => (await controlProvider.snapshot()).capabilities, readModel: delayedReadModel,
    executeControl: async (command) => { const receipt = String(command?.action ?? "").startsWith("session-options.")
      ? await sessionOptions.execute(command) : await heldQueue.execute(command);
      if (command?.action === "session-options.set-thinking") { armDelayedCatalog = true; catalogReadsAfterThinking = 0; }
      controlProvider.invalidate(); return receipt; },
    executeAttachment: async (command) => attachmentStore.execute(command) });
  try {
    await page.goto(controlServer.issueLaunchUrl());
    await expect(page.getByText("Chat bật", { exact: true })).toBeVisible();
    await openWorkspace(page, "Source Changes");
    await expect(page.getByRole("tab", { name: /Thay đổi của task/ })).toBeDisabled();
    await expect(page.getByRole("tab", { name: /Toàn bộ working tree/ })).toHaveAttribute("aria-selected", "true");
    await openWorkspace(page, "Chat & Task");
    await expect(page.getByRole("heading", { name: "Thiết lập cho Pi session" })).toBeVisible();
    const fileInput = page.getByLabel(/Đính kèm/);
    await fileInput.setInputFiles({ name: "browser-notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Browser attachment\nExact bounded content.\n") });
    await expect(page.getByText("browser-notes.md", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Bỏ browser-notes.md" }).click();
    await expect(page.getByText("browser-notes.md", { exact: true })).not.toBeVisible(); assert.equal(sends, 0);

    // Dropping a .docx onto the panel: the format the picker never accepted,
    // arriving the way the browser used to answer by navigating away from the
    // session. What Pi receives is the prose, not the archive.
    const dropped = docx("Chot ngan sach Q3.", "Doi tac ky ngay 12/09.");
    const dataTransfer = await page.evaluateHandle(([base64, name, type]) => {
      const binary = atob(base64), bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type }));
      return transfer;
    }, [dropped.toString("base64"), "ke-hoach.docx", DOCX_MIME]);
    const chatPanel = page.locator("section.chat-panel");
    await chatPanel.dispatchEvent("dragenter", { dataTransfer });
    await expect(page.getByText("Thả tài liệu vào đây")).toBeVisible();
    await chatPanel.dispatchEvent("drop", { dataTransfer });
    await expect(page.getByText("ke-hoach.docx", { exact: true })).toBeVisible();
    await expect(page.getByText("Thả tài liệu vào đây")).not.toBeVisible();
    // The chip reports the archive it came from and the text Pi will actually read.
    await expect(page.getByText(/^Tài liệu · .+ → .+ văn bản$/)).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Nội dung chat" });
    await composer.fill("Đọc file đính kèm");
    await page.getByRole("button", { name: "Gửi", exact: true }).click();
    await expect(page.getByText("ke-hoach.docx", { exact: true })).not.toBeVisible();
    await expect(fileInput).toBeEnabled();
    assert.equal(sends, 1);
    assert.match(sentContents[0][1].text, /Chot ngan sach Q3\./);
    assert.match(sentContents[0][1].text, /Doi tac ky ngay 12\/09\./);
    // No .docx bytes reach Pi, and the data region is fenced by a marker the
    // document could not have contained.
    assert.equal(sentContents[0][1].text.includes("word/document.xml"), false);
    assert.match(sentContents[0][1].text, /BEGIN PIAGENT-ATTACHMENT-[0-9a-f-]{36}/);
    idle = true; bridge.observeAgentSettled(context); assert.equal(bridge.snapshot().liveness, "idle");
    controlEvents.cursor = "event-cursor.browser-control-settled";
    controlProvider.publishObserved({ eventCursor: controlEvents.cursor, kind: "agent-operation.settled" });
    const effectAck = page.getByRole("checkbox", { name: /áp dụng cho session và mặc định người dùng/ });
    await expect(page.getByLabel("Chọn thinking")).toBeEnabled();
    await page.getByLabel("Chọn thinking").selectOption("high");
    await expect(page.getByRole("button", { name: "Đổi thinking" })).toBeDisabled();
    await effectAck.check(); await page.getByRole("button", { name: "Đổi thinking" }).click();
    await expect(page.getByText("Đã cập nhật trong Pi và mặc định người dùng", { exact: true })).toBeVisible();
    assert.equal(thinking, "high");
    await delayedCatalogStarted;
    await expect(page.getByLabel("Chọn model")).toBeEnabled();
    await page.getByLabel("Chọn model").selectOption({ label: "Model Browser B · browser-provider" });
    const selectedModelRef = await page.getByLabel("Chọn model").inputValue();
    const delayedResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/session-options/models"));
    releaseDelayedCatalogResponse(); await delayedResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByLabel("Chọn model")).toHaveValue(selectedModelRef);
    // Changing the selection clears the effect acknowledgement while the stale
    // background catalog response above must leave the new model choice intact.
    await expect(page.getByRole("button", { name: "Đổi model" })).toBeDisabled();
    await effectAck.check(); await page.getByRole("button", { name: "Đổi model" }).click();
    await expect(page.getByText("Đã cập nhật trong Pi và mặc định người dùng", { exact: true })).toBeVisible();
    assert.equal(activeModel.id, "browser-model-b");
    await composer.fill("Tin nhắn giữ ban đầu");
    await page.getByRole("button", { name: "Giữ lại" }).click();
    await expect(page.getByText("Tin nhắn giữ ban đầu", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sửa" }).click();
    const editor = page.getByRole("textbox", { name: "Sửa tin nhắn đang giữ" });
    await editor.fill("Tin nhắn đã sửa");
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText("Tin nhắn đã sửa", { exact: true })).toBeVisible();
    await page.getByRole("region", { name: "Tin nhắn đang giữ" }).getByRole("button", { name: "Gửi", exact: true }).click();
    await expect(page.getByText("Tin nhắn đã sửa", { exact: true })).not.toBeVisible();
    assert.equal(sends, 2);

    await composer.fill("Xóa em khỏi hàng đợi");
    await page.getByRole("button", { name: "Giữ lại" }).click();
    await expect(page.getByText("Xóa em khỏi hàng đợi", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Xóa" }).click();
    await expect(page.getByText("Xóa em khỏi hàng đợi", { exact: true })).not.toBeVisible();
    assert.equal(sends, 2);
    assert.deepEqual(pageErrors, []);
  } finally { attachmentStore.close(); await controlServer.close(); }
});
