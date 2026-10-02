import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requestGatewayControl, startGatewayControlSocket } from "../packages/piagent-webui/gateway/control-socket.ts";

// A company runtime that has seen many projects answers project.paths with
// far more than one small control message; other answers stay small.
test("project.paths may answer with many folders while other control answers stay bounded", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pgc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const folders = Array.from({ length: 400 }, (_, index) => ({ projectRef: `project_${"x".repeat(43)}${index}`, cwd: `/Users/member/Documents/work/harness-edge-cases/case-${index}` }));
  const server = await startGatewayControlSocket({ socketPath: path.join(directory, "c.sock"), handle: () => ({ ok: true, value: folders }) });
  t.after(() => server.close());
  const socket = path.join(directory, "c.sock");
  const answer = await requestGatewayControl(socket, { action: "project.paths" });
  assert.equal(answer.ok, true);
  assert.equal(answer.value.length, 400);
  await assert.rejects(() => requestGatewayControl(socket, { action: "health" }), /gateway-control-response-limit/);
});

// A busy Gateway (a large catalog on a loaded machine) takes the connection
// but answers late. Its socket used to be taken as stale: a second Gateway
// started beside it and the first ran on unreachable, still serving its pages.
test("a Gateway that answers late keeps its socket; only one nobody listens on is replaced", async (t) => {
  const net = await import("node:net");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pgc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = path.join(directory, "c.sock");
  const held = new Set(), busy = net.createServer((connection) => { held.add(connection); /* accepts, never answers */ });
  await new Promise((resolve) => busy.listen(socket, resolve));
  await assert.rejects(() => startGatewayControlSocket({ socketPath: socket, handle: () => ({ ok: true, value: {} }) }), /gateway-already-running/);
  assert.equal(fs.statSync(socket).isSocket(), true, "the busy Gateway keeps its socket");
  for (const connection of held) connection.destroy();
  await new Promise((resolve) => busy.close(resolve));
  // Left behind by a Gateway that is gone: nothing accepts, so it is replaced.
  const { spawnSync } = await import("node:child_process");
  spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`]);
  assert.equal(fs.statSync(socket).isSocket(), true);
  const server = await startGatewayControlSocket({ socketPath: socket, handle: () => ({ ok: true, value: { state: "ready" } }) });
  t.after(() => server.close());
  assert.deepEqual(await requestGatewayControl(socket, { action: "health" }), { ok: true, value: { state: "ready" } });
});

// Closing a server removes the path it was bound to. An old Gateway that
// exited after another had taken the path used to remove the running
// Gateway's socket: `piagent dashboard restart` then could not stop it.
test("an old Gateway that exits leaves the running Gateway's socket in place", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pgc-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socket = path.join(directory, "c.sock");
  const old = await startGatewayControlSocket({ socketPath: socket, handle: () => ({ ok: true, value: "old" }) });
  fs.unlinkSync(socket); // taken over, as a release before this one did
  const current = await startGatewayControlSocket({ socketPath: socket, handle: () => ({ ok: true, value: "current" }) });
  t.after(() => current.close());
  await old.close();
  assert.deepEqual(await requestGatewayControl(socket, { action: "health" }), { ok: true, value: "current" });
  assert.deepEqual(fs.readdirSync(directory), ["c.sock"], "no private socket name is left behind");
  await current.close();
  assert.deepEqual(fs.readdirSync(directory), [], "the running Gateway removes its own socket when it stops");
});
