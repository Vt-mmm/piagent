import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";
import { digestZeroTurnFact, providerVisibleToolSchemaDigest, runZeroTurnConformance } from "../packages/piagent-core/runtime/inspection/zero-turn-conformance.ts";
import { CoreInspectionProvider } from "../packages/piagent-webui/server/core-inspection-provider.ts";
import { startLoopbackServer } from "../packages/piagent-webui/server/loopback-server.ts";
import { ReadModelNotFound } from "../packages/piagent-webui/server/read-model-provider.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, "..");
const registry = createWebUiSchemaRegistry();
const capabilities = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/capabilities-v1.valid.json"), "utf8"));
const runtimeEvent = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/runtime-event-v2.valid.json"), "utf8"));
const queueProjection = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/queue-v1.valid.json"), "utf8"));
const modelCatalog = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/model-catalog-v1.valid.json"), "utf8"));
const temporaryRoots = new Set(), servers = new Set();

function repository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-read-routes-")); temporaryRoots.add(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Piagent Test"]);
  fs.writeFileSync(path.join(cwd, "example.txt"), "before\n");
  execFileSync("git", ["-C", cwd, "add", "."]); execFileSync("git", ["-C", cwd, "commit", "-qm", "baseline"]);
  fs.writeFileSync(path.join(cwd, "example.txt"), "after\n");
  return cwd;
}

function staticRoot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-read-static-")); temporaryRoots.add(directory);
  fs.writeFileSync(path.join(directory, "index.html"), "<!doctype html><main>read model</main>");
  return directory;
}

function request(origin, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(pathname, origin), { method: options.method ?? "GET", headers: options.headers }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject); if (options.body) req.write(options.body); req.end();
  });
}

function bootstrapValue(launchUrl) { return new URLSearchParams(new URL(launchUrl).hash.slice(1)).get("bootstrap"); }

async function authenticate(server) {
  const response = await request(server.origin, "/api/v1/bootstrap", {
    method: "POST", headers: { Origin: server.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ capability: bootstrapValue(server.launchUrl) })
  });
  assert.equal(response.status, 200, response.body.toString());
  return response.headers["set-cookie"][0].split(";", 1)[0];
}

async function close(server) { if (servers.delete(server)) await server.close(); }
afterEach(async () => {
  await Promise.all([...servers].map(close));
  for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
  temporaryRoots.clear();
});

function observation() {
  return {
    providerRequests: 0, userMessages: 0, assistantMessages: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0 },
    continuationConsumed: 0, turnTriggers: 0, sessionRef: "session.webui", leafMessageRef: "message.stable",
    messageSetDigest: digestZeroTurnFact("messages", ["message.stable"]), taskContractDigest: null, journalHead: null,
    promptDigest: digestZeroTurnFact("prompt", { system: "stable" }),
    toolSchemaDigest: providerVisibleToolSchemaDigest([{ name: "read", description: "Read", parameters: { type: "object" } }]),
    latestCausalSequence: 0, causalEvents: []
  };
}

class MemoryProvider {
  listeners = new Set();
  after = undefined;
  replayState = "current";
  replayEvents = [];
  duringReplay = undefined;
  snapshot() { return { version: "snapshot" }; }
  sourceChanges(view) { return { view }; }
  diff(view, ref) { if (ref === "missing") throw new ReadModelNotFound(); return { view, ref }; }
  review(view, ref) { return { view, ref }; }
  sourceMutation(action, ref) { return { action, ref }; }
  sourceRevert(ref, hunkRef) { return { action: "source.revert", ref, hunkRef }; }
  commitSummary() { return { version: "commit-summary" }; }
  activity() { return { running: [], recent: [] }; }
  logPreview(ref) { return { ref, state: "unavailable" }; }
  transcript(before, limit) { return { before, limit }; }
  queue() { return queueProjection; }
  modelCatalog() { return modelCatalog; }
  async replay(after) {
    this.after = after;
    const result = { state: this.replayState, events: this.replayEvents, nextCursor: "cursor.next", latestCursor: "cursor.latest", reasonCode: this.replayState === "current" ? null : "event-cursor-gap" };
    await this.duringReplay?.();
    return result;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
}

describe("Piagent WebUI canonical read routes", () => {
  it("binds source mutation previews to a closed action and opaque file ref", async () => {
    const provider = new MemoryProvider(), server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => capabilities, readModel: provider });
    servers.add(server); const cookie = await authenticate(server), headers = { Cookie: cookie, Origin: server.origin };
    const accepted = await request(server.origin, "/api/v1/source-mutations/file_01?action=source.stage", { headers });
    assert.equal(accepted.status, 200); assert.deepEqual(JSON.parse(accepted.body), { action: "source.stage", ref: "file_01" });
    assert.equal((await request(server.origin, "/api/v1/source-mutations/file_01?action=source.revert", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/source-mutations/%2Fetc%2Fpasswd?action=source.stage", { headers })).status, 400);
    const revert = await request(server.origin, "/api/v1/source-reverts/file_01?hunkRef=hunk_01", { headers });
    assert.equal(revert.status, 200); assert.deepEqual(JSON.parse(revert.body), { action: "source.revert", ref: "file_01", hunkRef: "hunk_01" });
    assert.equal((await request(server.origin, "/api/v1/source-reverts/file_01?hunkRef=bad%2Fref", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/source-reverts/%2Fetc%2Fpasswd", { headers })).status, 400);
    const summary = await request(server.origin, "/api/v1/commit-summary", { headers });
    assert.equal(summary.status, 200); assert.deepEqual(JSON.parse(summary.body), { version: "commit-summary" });
    assert.equal((await request(server.origin, "/api/v1/commit-summary?path=bad", { headers })).status, 400);
  });

  it("serves schema-valid core snapshot/source/diff models through opaque refs with zero model turns", async () => {
    const cwd = repository();
    const eventStore = new RuntimeEventStore({ projectRoot: cwd, projectRef: "project.webui", runtimeInstanceId: "runtime.webui", sessionRef: "session.webui" });
    const provider = new CoreInspectionProvider({ cwd, sessionId: "private-session", runtimeInstanceId: "runtime.webui", eventStore,
      sessionEntries: () => [{ id: "entry_1", type: "message", timestamp: "2026-08-13T09:04:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Inspect this exact session." }] } }],
      activityEvents: () => [{ event: "tool_call", sessionId: "private-session", toolCallId: "tool.activity", toolName: "bash", command: "\u001b[31mnpm test OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz", recordedAt: "2026-08-13T09:05:00.000Z" }],
      queueProjection: () => queueProjection, modelCatalog: () => modelCatalog
    });
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => capabilities, readModel: provider }); servers.add(server);
    const cookie = await authenticate(server), headers = { Cookie: cookie, Origin: server.origin };
    let selectedFileRef;
    const state = observation(), observe = () => structuredClone(state);
    const report = await runZeroTurnConformance({ action: "http-read-model", commandId: "command.http-read-model", concurrency: "quiescent", mutationClass: "view" }, observe, async () => {
      const snapshotResponse = await request(server.origin, "/api/v1/snapshot", { headers });
      assert.equal(snapshotResponse.status, 200); const snapshot = JSON.parse(snapshotResponse.body);
      assert.equal(validateFixture(registry, "snapshot-v1", snapshot).valid, true);
      const sourceResponse = await request(server.origin, "/api/v1/source-changes?view=working-tree", { headers });
      assert.equal(sourceResponse.status, 200); const source = JSON.parse(sourceResponse.body);
      assert.equal(validateFixture(registry, "source-change-v1", source).valid, true);
      const file = source.files.find((candidate) => candidate.path === "example.txt"); assert.ok(file);
      selectedFileRef = file.fileRef;
      const diffResponse = await request(server.origin, `/api/v1/diffs/${file.fileRef}?view=working-tree`, { headers });
      assert.equal(diffResponse.status, 200); assert.equal(validateFixture(registry, "diff-v1", JSON.parse(diffResponse.body)).valid, true);
      const activityResponse = await request(server.origin, "/api/v1/activity", { headers });
      assert.equal(activityResponse.status, 200);
      const activity = JSON.parse(activityResponse.body);
      assert.equal(activity.running.length, 1);
      const logResponse = await request(server.origin, `/api/v1/log-previews/${activity.running[0].activityRef}`, { headers });
      assert.equal(logResponse.status, 200);
      const log = JSON.parse(logResponse.body);
      assert.equal(log.state, "available");
      assert.equal(log.preview.includes("\u001b"), false);
      assert.equal(log.preview.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), false);
      const transcriptResponse = await request(server.origin, "/api/v1/transcript?limit=50", { headers });
      assert.equal(transcriptResponse.status, 200);
      assert.equal(validateFixture(registry, "transcript-v1", JSON.parse(transcriptResponse.body)).valid, true);
      const queueResponse = await request(server.origin, "/api/v1/chat/queue", { headers });
      assert.equal(queueResponse.status, 200);
      assert.equal(validateFixture(registry, "queue-v1", JSON.parse(queueResponse.body)).valid, true);
      const modelsResponse = await request(server.origin, "/api/v1/session-options/models", { headers });
      assert.equal(modelsResponse.status, 200);
      assert.equal(validateFixture(registry, "model-catalog-v1", JSON.parse(modelsResponse.body)).valid, true);
      return snapshot.revision.runtimeRevision;
    });
    assert.equal(report.passed, true, report.violations.join(", "));
    assert.equal((await request(server.origin, "/api/v1/source-changes?view=invalid", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/diffs/%2Fetc%2Fpasswd?view=working-tree", { headers })).status, 400);
    assert.equal((await request(server.origin, `/api/v1/diffs/${selectedFileRef}`, { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/log-previews/activity.unknown", { headers })).status, 404);
    assert.equal((await request(server.origin, "/api/v1/transcript?limit=0", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/transcript?before=bad%0Acursor", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/snapshot")).status, 401);
  });
});

describe("Piagent WebUI SSE replay and resync", () => {
  it("replays ordered events, honors Last-Event-ID and streams live events", async () => {
    const provider = new MemoryProvider();
    provider.replayEvents = [{ cursor: runtimeEvent.eventCursor, value: runtimeEvent }];
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => capabilities, readModel: provider }); servers.add(server);
    const cookie = await authenticate(server);
    const received = await new Promise((resolve, reject) => {
      const req = http.request(new URL("/api/v1/events", server.origin), { headers: { Cookie: cookie, Origin: server.origin, "Last-Event-ID": "cursor.previous" } });
      req.on("response", (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("retry: 2000")) provider.emit({ cursor: "cursor.live", value: { kind: "live" } });
          if (text.includes("id: cursor.live")) { req.destroy(); resolve(text); }
        });
      });
      req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); }); req.end();
    });
    assert.equal(provider.after, "cursor.previous");
    assert.match(received, new RegExp(`id: ${runtimeEvent.eventCursor.replaceAll(".", "\\.")}`));
    assert.match(received, /event: runtime-event/);
    assert.match(received, /id: cursor\.live/);
  });

  it("emits resync-required for a replay gap and rejects ambiguous or unsafe cursors", async () => {
    const provider = new MemoryProvider(); provider.replayState = "resync-required";
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => capabilities, readModel: provider }); servers.add(server);
    const cookie = await authenticate(server), headers = { Cookie: cookie, Origin: server.origin };
    const gap = await request(server.origin, "/api/v1/events?after=cursor.missing", { headers });
    assert.equal(gap.status, 200); assert.match(gap.body.toString(), /event: resync-required/); assert.match(gap.body.toString(), /event-cursor-gap/);
    assert.equal((await request(server.origin, "/api/v1/events?after=", { headers })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/events?after=cursor.one", { headers: { ...headers, "Last-Event-ID": "cursor.two" } })).status, 400);
    assert.equal((await request(server.origin, "/api/v1/events?after=bad%0Acursor", { headers })).status, 400);
  });

  it("does not lose an event emitted during the replay-to-live handoff", async () => {
    const provider = new MemoryProvider();
    provider.duringReplay = () => provider.emit({ cursor: "cursor.handoff", value: { kind: "message.completed" } });
    const server = await startLoopbackServer({ staticRoot: staticRoot(), readCapabilities: () => capabilities, readModel: provider }); servers.add(server);
    const cookie = await authenticate(server);
    const received = await new Promise((resolve, reject) => {
      const req = http.request(new URL("/api/v1/events", server.origin), { headers: { Cookie: cookie, Origin: server.origin } });
      req.on("response", (response) => {
        let text = "";
        response.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("id: cursor.handoff")) { req.destroy(); resolve(text); }
        });
      });
      req.on("error", (error) => { if (error.code !== "ECONNRESET") reject(error); }); req.end();
    });
    assert.match(received, /id: cursor\.handoff/);
    assert.match(received, /message\.completed/);
  });
});
