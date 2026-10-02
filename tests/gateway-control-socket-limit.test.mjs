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
