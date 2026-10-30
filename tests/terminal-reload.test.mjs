import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readReloadRequest, requestTerminalReload, watchTerminalReload } from "../packages/piagent-core/runtime/update/terminal-reload.mjs";

// `piagent reload` and a finished update reach every open Terminal; each
// reloads only when nothing would be lost, and a running task finishes first.
test.beforeEach(() => { delete process.env.PIAGENT_RELOAD_APPLIED_AT; });
function fakePi() {
  const handlers = new Map();
  return { handlers, on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    emit: async (name, ctx) => { for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx); } };
}
function fakeCtx(state) {
  const statuses = [], notices = [];
  return { statuses, notices, hasUI: true, mode: "tui", isIdle: () => !state.running, hasPendingMessages: () => Boolean(state.queued),
    ui: { getEditorText: () => state.typed ?? "", setStatus: (key, text) => statuses.push([key, text]), notify: (text) => notices.push(text) } };
}

test("a reload request is written once and read back; an unreadable one is none", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-reload-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(readReloadRequest(home), null);
  requestTerminalReload({ home, version: "1.48.2", piHost: "1.3.0", now: 42 });
  assert.deepEqual(readReloadRequest(home), { at: 42, version: "1.48.2", piHost: "1.3.0" });
  assert.equal((fs.statSync(path.join(home, ".pi", "piagent-reload.json")).mode & 0o777), 0o600);
  fs.writeFileSync(path.join(home, ".pi", "piagent-reload.json"), "{");
  assert.equal(readReloadRequest(home), null);
});

test("an idle Terminal reloads once; a running, queued or typed one waits and says so", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-reload-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pi = fakePi(), state = { running: true }, ctx = fakeCtx(state), applied = [];
  const watcher = watchTerminalReload(pi, { home, startedAt: 100, pollMs: 60_000, quietMs: 0, apply: async (_ctx, request) => { applied.push(request.version); } });
  await pi.emit("session_start", ctx);
  t.after(() => pi.emit("session_shutdown", ctx));
  // A request from before this Terminal started is not for it.
  requestTerminalReload({ home, version: "old", now: 50 });
  await watcher.check();
  assert.deepEqual(applied, []);
  requestTerminalReload({ home, version: "1.48.2", now: 200 });
  for (const busy of [{ running: true }, { queued: true }, { typed: "half a sentence" }]) {
    Object.assign(state, { running: false, queued: false, typed: "" }, busy);
    await watcher.check();
    assert.deepEqual(applied, [], JSON.stringify(busy));
  }
  assert.deepEqual(ctx.statuses[0], ["piagent-reload", "⟳ Nạp Piagent 1.48.2 khi rảnh"]);
  Object.assign(state, { running: false, queued: false, typed: "" });
  await watcher.check();
  await watcher.check();
  assert.deepEqual(applied, ["1.48.2"], "applied exactly once");
  assert.deepEqual(ctx.statuses.at(-1), ["piagent-reload", undefined]);
});

test("a reload that fails is said and tried again on the next check", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-reload-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pi = fakePi(), ctx = fakeCtx({}); let attempts = 0;
  const watcher = watchTerminalReload(pi, { home, startedAt: 0, pollMs: 60_000, quietMs: 0, apply: async () => { attempts += 1; if (attempts === 1) throw Error("disk busy"); } });
  await pi.emit("session_start", ctx);
  t.after(() => pi.emit("session_shutdown", ctx));
  requestTerminalReload({ home, version: "1.48.2", now: 10 });
  await watcher.check();
  assert.match(ctx.notices[0], /Chưa nạp được Piagent mới: disk busy/);
  await watcher.check();
  assert.equal(attempts, 2);
});

test("after a run stops the Terminal stays quiet before it reloads: the member's next message is not lost", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-reload-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const pi = fakePi(), ctx = fakeCtx({}), applied = [];
  const watcher = watchTerminalReload(pi, { home, startedAt: 0, pollMs: 60_000, quietMs: 40, apply: async () => { applied.push(1); } });
  await pi.emit("session_start", ctx);
  requestTerminalReload({ home, version: "1.48.3", now: 10 });
  await pi.emit("agent_settled", ctx);
  await watcher.check();
  assert.deepEqual(applied, [], "right after Esc");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await watcher.check();
  assert.deepEqual(applied, [1]);
  await pi.emit("session_shutdown", ctx);
});

test("a request sent before /reload is still taken by the new runtime, and a taken one is not taken twice", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-reload-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  requestTerminalReload({ home, version: "1.48.3", now: Date.now() });
  const applied = [], ctx = fakeCtx({});
  for (let runtime = 0; runtime < 2; runtime += 1) {
    const pi = fakePi(), watcher = watchTerminalReload(pi, { home, pollMs: 60_000, quietMs: 0, apply: async () => { applied.push(runtime); } });
    await pi.emit("session_start", ctx);
    await watcher.check();
    await pi.emit("session_shutdown", ctx);
  }
  assert.deepEqual(applied, [0]);
});

test("a ctx left from a replaced runtime makes a check do nothing instead of rejecting", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-reload-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  requestTerminalReload({ home, version: "1.48.3", now: Date.now() });
  const pi = fakePi(), stale = new Proxy({}, { get() { throw Error("stale"); } });
  const watcher = watchTerminalReload(pi, { home, pollMs: 60_000, quietMs: 0, apply: async () => assert.fail("not applied") });
  await pi.emit("session_start", stale);
  await watcher.check();
  await pi.emit("session_shutdown", stale);
});

test("the launcher starts the company Terminal again on its restart code with the saved arguments", () => {
  const cli = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "piagent-cli.mjs"), "utf8");
  const studio = fs.readFileSync(path.join(import.meta.dirname, "..", "scripts", "piagent-studio.mjs"), "utf8");
  assert.match(cli, /const RESTART_CODE = 75;/);
  assert.match(studio, /const RESTART_CODE = 75,/);
  assert.match(cli, /"piagent-reload": "scripts\/terminal-reload\.mjs"/);
  // Only a file the launcher named, under ~/.pi/piagent-restart, is written.
  assert.match(studio, /\\\/\\\.pi\\\/piagent-restart\\\/\\d\+\\\.json\$/);
});
