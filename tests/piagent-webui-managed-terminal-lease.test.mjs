import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { holdManagedSession } from "../packages/piagent-webui/ownership/managed-terminal-lease.ts";
import { gatewayProfileState, readOrCreateCatalogKey } from "../packages/piagent-webui/ownership/profile-state.ts";
import { sessionRefForPath } from "../packages/piagent-webui/ownership/session-refs.ts";
import { SessionLeaseStore } from "../packages/piagent-webui/ownership/session-lease-store.ts";
import { projectSessionRuntimeOwnership } from "../packages/piagent-webui/gateway/session-runtime-ownership.ts";

// A company conversation run by the company Terminal, `--prompt` or a script
// shows in the WebUI as running elsewhere (no send, no "continue"); a crashed
// one needs recovery instead of looking busy forever; the Gateway's own
// conversation is never written by a second process.
test("company conversations run outside the Gateway hold its lease", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-lease-")), file = path.join(agentDir, "sessions", "a.jsonl");
  try {
    const state = gatewayProfileState(agentDir), key = readOrCreateCatalogKey(state), leases = new SessionLeaseStore(state.root, key);
    const ref = sessionRefForPath(key, file), project = (lease) => projectSessionRuntimeOwnership({ lease, gatewayInstanceRef: "gateway_1_x", key });
    const hold = holdManagedSession(agentDir, file);
    assert.equal(hold.sessionRef, ref);
    const running = project(leases.inspect(ref));
    assert.deepEqual([running.state, running.composerAvailable, running.reasonCode], ["terminal-owned", false, "terminal-owner-active"]);
    // A second runner (another Terminal, the WebUI) is refused while it runs.
    assert.throws(() => holdManagedSession(agentDir, file), /session-owner-conflict/);
    hold.release(); hold.release();
    assert.equal(leases.inspect(ref).state, "released");
    // The Gateway runs it: the Terminal may not.
    const gateway = leases.acquire(ref, "gateway_1_fixture", "runtime_fixture");
    assert.throws(() => holdManagedSession(agentDir, file), /session-owner-conflict/);
    leases.release(ref, gateway.ownerEpoch, "gateway_1_fixture", "runtime_fixture");
    // A Terminal that died with the lease: recovery, then the next runner takes it.
    leases.acquireTerminal(ref, "terminal_999999_crashed", "runtime_crashed");
    const stale = project(leases.inspect(ref));
    assert.deepEqual([stale.state, stale.needsAttention, stale.reasonCode], ["recovery-required", true, "terminal-owner-process-exited"]);
    const again = holdManagedSession(agentDir, file);
    assert.equal(project(leases.inspect(ref)).state, "terminal-owned");
    again.release();
  } finally { fs.rmSync(agentDir, { recursive: true, force: true }); }
});
