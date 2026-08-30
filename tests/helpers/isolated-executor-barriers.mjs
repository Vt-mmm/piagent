import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const ownerLabel = "io.piagent.contract-execution";

export function dockerJson(socketPath, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const input = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ socketPath, method, path: requestPath,
      ...(input === undefined ? {} : { headers: { "content-type": "application/json", "content-length": Buffer.byteLength(input) } }) }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; if (text.length > 65536) request.destroy(new Error("Docker observation too large")); });
      response.on("error", reject);
      response.on("end", () => {
        try { resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error("Docker observation timeout")));
    request.on("error", reject); request.end(input);
  });
}

// Subscribe before launching the real worker. Unlike a wall-clock delay, this
// boundary proves the daemon has emitted START for this exact owned container.
export function cancelOnContainerStart(context, { dockerSocket, runId, controller }) {
  return new Promise((resolve, reject) => {
    const state = { event: null, error: null };
    const filters = encodeURIComponent(JSON.stringify({ type: ["container"], event: ["start"], label: [`${ownerLabel}=${runId}`] }));
    // Include the bounded recent buffer to cover the daemon's header/subscription
    // transition. A fresh UUID means no historical event can match this run.
    const request = http.get({ socketPath: dockerSocket, path: `/events?since=1&filters=${filters}` });
    const fail = (error) => { state.error ??= error; controller.abort(); reject(error); };
    const timer = setTimeout(() => { request.destroy(); fail(new Error("Owned worker never reached START")); }, 15000);
    context.after(() => { clearTimeout(timer); request.destroy(); });
    request.on("error", fail);
    request.on("response", (response) => {
      if (response.statusCode !== 200) { response.resume(); fail(new Error(`Docker events status ${response.statusCode}`)); return; }
      let pending = "";
      response.setEncoding("utf8"); response.on("error", fail);
      response.on("data", (chunk) => {
        pending += chunk;
        if (pending.length > 65536) { request.destroy(); fail(new Error("Docker event limit exceeded")); return; }
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            assert.equal(event.Type, "container"); assert.equal(event.Action, "start");
            assert.match(event.Actor?.ID, /^[a-f0-9]{64}$/);
            assert.equal(event.Actor.Attributes[ownerLabel], runId);
            assert.equal(event.Actor.Attributes.name, `piagent-contract-${runId}`);
            state.event = event; clearTimeout(timer); controller.abort();
          } catch (error) { fail(error); }
        }
      });
      resolve(state);
    });
  });
}

// A local transparent test proxy controls only CREATE acknowledgement timing.
// Successful daemon observations and deletion still come from the real engine.
export async function createCancellationBarrier(context, { dockerSocket, runId, imageId, phase, controller }) {
  assert.ok(["before-forward", "after-create", "after-host-settled"].includes(phase));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-x-")), socketPath = path.join(directory, "engine.sock");
  const state = { phaseReached: false, createdId: null, startRequests: 0, errors: [] };
  let delayedCreate;
  const upstreamRequests = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const create = request.method === "POST" && /\/containers\/create$/.test(url.pathname);
    if (/\/containers\/[^/]+\/(?:start|attach)$/.test(url.pathname)) {
      state.startRequests += 1; response.writeHead(409); response.end('{"message":"Unexpected execution before create acknowledgement"}'); return;
    }
    if (create && url.searchParams.get("name") !== `piagent-contract-${runId}`) {
      state.errors.push("Unexpected create identity"); response.writeHead(400); response.end(); return;
    }
    if (create && phase === "before-forward") {
      state.phaseReached = true; request.resume(); controller.abort(); return;
    }
    if (create && phase === "after-host-settled") {
      let text = ""; request.setEncoding("utf8");
      request.on("data", (chunk) => { text += chunk; });
      request.on("end", () => {
        try {
          const body = JSON.parse(text); assert.equal(body.Image, imageId); assert.equal(body.Labels[ownerLabel], runId);
          delayedCreate = { requestPath: request.url, body }; state.phaseReached = true; controller.abort();
        } catch (error) { state.errors.push(error.message); response.writeHead(502); response.end(); }
      });
      return;
    }
    const upstream = http.request({ socketPath: dockerSocket, method: request.method, path: request.url, headers: request.headers }, (observed) => {
      if (create) {
        let text = ""; observed.setEncoding("utf8");
        observed.on("data", (chunk) => { text += chunk; });
        observed.on("end", () => {
          try {
            assert.equal(observed.statusCode, 201, text);
            const { Id } = JSON.parse(text); assert.match(Id, /^[a-f0-9]{64}$/);
            state.createdId = Id; state.phaseReached = true; controller.abort();
            // Deliberately withhold the successful CREATE response from the CLI.
          } catch (error) { state.errors.push(error.message); response.writeHead(502); response.end(); }
        });
      } else { response.writeHead(observed.statusCode, observed.headers); observed.pipe(response); }
    });
    upstreamRequests.add(upstream);
    upstream.on("close", () => upstreamRequests.delete(upstream));
    upstream.on("error", (error) => { state.errors.push(error.message); if (!response.headersSent) response.writeHead(502); response.end(); });
    upstream.setTimeout(10000, () => upstream.destroy(new Error("Proxy upstream timeout")));
    request.pipe(upstream);
  });
  context.after(async () => {
    upstreamRequests.forEach((request) => request.destroy()); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (state.createdId) {
      const remaining = await dockerJson(dockerSocket, "GET", `/containers/${state.createdId}/json`);
      if (remaining.status !== 404) {
        assert.equal(remaining.status, 200); assert.equal(remaining.body.Id, state.createdId);
        assert.equal(remaining.body.Image, imageId); assert.equal(remaining.body.Config.Labels[ownerLabel], runId);
        context.diagnostic("Test cleanup found its owned created container still present");
        assert.equal((await dockerJson(dockerSocket, "DELETE", `/containers/${state.createdId}?force=true`)).status, 204);
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  return { socketPath, state, async releaseDelayedCreate() {
    assert.equal(phase, "after-host-settled"); assert.ok(delayedCreate); assert.equal(state.createdId, null);
    const captured = delayedCreate; delayedCreate = null;
    const created = await dockerJson(dockerSocket, "POST", captured.requestPath, captured.body);
    assert.equal(created.status, 201); assert.match(created.body.Id, /^[a-f0-9]{64}$/);
    state.createdId = created.body.Id; return state.createdId;
  } };
}
