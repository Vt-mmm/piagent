import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { WebSocketServer } from "ws";

import {
  benchmarkBootstrapEnvironment,
  cleanupBenchmarkExecutionSnapshot,
  createBenchmarkExecutionSnapshot
} from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import {
  acceptedJourneyTaskStatuses,
  boundedForensicDeadline,
  durableTurnPosition,
  eventSummary,
  GatewayJourneyClient,
  launchCapability,
  recoverOperationFromEvents,
  terminalLifecycleOutcome
} from "../scripts/benchmark-webui-journey.mjs";
import { candidateOutcomeFailureReason, persistedJourneyReceipt } from "../scripts/benchmark-session.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("production WebUI journey extracts only the fragment bootstrap capability", () => {
  assert.deepEqual(launchCapability("http://127.0.0.1:4040/#bootstrap=private-capability&ignored=value"), {
    origin: "http://127.0.0.1:4040",
    capability: "private-capability"
  });
  assert.throws(() => launchCapability("http://127.0.0.1:4040/"), /bootstrap-capability-missing/);
});

test("production WebUI journey attributes file and failed-tool telemetry to one operation", () => {
  const events = [
    { sequence: 1, kind: "tool.started", payload: { operationRef: "operation-a", fileLabel: "auth.ts" } },
    { sequence: 2, kind: "tool.completed", payload: { operationRef: "operation-a", fileLabel: "auth.ts", isError: false } },
    { sequence: 3, kind: "tool.started", payload: { operationRef: "operation-b", fileLabel: "unrelated.ts" } },
    { sequence: 4, kind: "tool.started", payload: { operationRef: "operation-a", fileLabel: "refresh.test.ts" } },
    { sequence: 5, kind: "tool.completed", payload: { operationRef: "operation-a", fileLabel: "refresh.test.ts", isError: true } },
    { sequence: 6, kind: "operation.settled", payload: { operationRef: "operation-a", settlement: "completed" } }
  ];
  assert.deepEqual(eventSummary(events, "operation-a"), {
    firstSequence: 1,
    lastSequence: 6,
    kinds: ["tool.started", "tool.completed", "tool.started", "tool.completed", "operation.settled"],
    fileLabels: ["auth.ts", "refresh.test.ts"],
    toolCalls: 2,
    failedToolCalls: 1
  });
});

test("mismatch transcript evidence cannot consume the remaining scenario deadline", () => {
  assert.equal(boundedForensicDeadline(50_000, 10_000), 11_000);
  assert.equal(boundedForensicDeadline(10_500, 10_000), 10_500);
});

test("uncertain send discards an observed response instead of exposing its command receipt", async (t) => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  server.on("connection", (socket) => socket.on("message", (body) => {
    const value = JSON.parse(body.toString());
    if (value.messageType === "connect") {
      socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "hello" }));
    } else if (value.messageType === "request" && value.method === "sessions.command") {
      socket.send(JSON.stringify({ schemaVersion: 1, version: "piagent-gateway-protocol-v1", messageType: "response",
        requestId: value.requestId, ok: true, result: { operationRef: "must-not-be-observed-by-caller" } }));
    }
  }));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new GatewayJourneyClient({ origin: `http://127.0.0.1:${address.port}`, cookie: "session=private" });
  await client.connect(Date.now() + 2_000, null);
  const discarded = await client.requestAndDiscardResponse("sessions.command", { command: {} }, Date.now() + 2_000);
  assert.deepEqual(Object.keys(discarded).toSorted(), ["requestId", "responseDiscarded", "responseObserved"]);
  assert.equal(discarded.responseObserved, true);
  assert.equal(discarded.responseDiscarded, true);
  assert.equal(JSON.stringify(discarded).includes("must-not-be-observed-by-caller"), false);
  await assert.rejects(client.requestAndDiscardResponse("ignored", {}, Date.now() + 25), /timeout/);
  client.drop();
});

test("uncertain send recovers one operation by message correlation and rejects resend ambiguity", () => {
  const events = [
    { sequence: 8, kind: "runtime.changed", payload: { sessionRef: "session-a", messageRequestId: "message-a",
      operationRef: "operation-a", liveState: "running" } },
    { sequence: 12, kind: "operation.settled", payload: { sessionRef: "session-a", messageRequestId: "message-a",
      operationRef: "operation-a", settlement: "completed" } }
  ];
  assert.deepEqual(recoverOperationFromEvents(events, "session-a", "message-a"), {
    operationRef: "operation-a", recoveredFromKind: "runtime.changed", recoveredAtSequence: 8
  });
  assert.throws(() => recoverOperationFromEvents([...events, {
    sequence: 13, kind: "operation.settled", payload: { sessionRef: "session-a", messageRequestId: "message-a",
      operationRef: "operation-b", settlement: "completed" }
  }], "session-a", "message-a"), /correlation-ambiguous/);
});

test("uncertain send requires exactly one durable user message before its assistant", () => {
  const items = [
    { role: "user", messageRequestId: "message-a", content: { text: "Please verify" } },
    { role: "assistant", messageRequestId: "message-a", agentOperationId: "operation-a", content: { text: "Verified" } }
  ];
  assert.deepEqual(durableTurnPosition(items, "Please verify", "operation-a", "message-a", {
    requireExactCorrelation: true, requireUniqueUser: true
  }), { userIndex: 0, assistantIndex: 1, durableUserCount: 1, assistantText: "Verified" });
  assert.throws(() => durableTurnPosition([items[0], items[0], items[1]], "Please verify", "operation-a", "message-a", {
    requireExactCorrelation: true, requireUniqueUser: true
  }), /uncertain-send-was-resent/);
});

test("correlation cannot hide a whitespace-damaged multiline workflow prompt", () => {
  const message = "Inspect the workflow boundary.\n\nConstraints:\n- preserve paragraphs\n- preserve lists";
  const assistant = { role: "assistant", messageRequestId: "message-multiline", agentOperationId: "operation-multiline",
    content: { text: "Inspection complete." } };
  const exact = [
    { role: "user", messageRequestId: "message-multiline", content: { text: `/scout ${message}` } },
    assistant
  ];
  assert.deepEqual(durableTurnPosition(exact, message, "operation-multiline", "message-multiline", {
    requireExactCorrelation: true, requireUniqueUser: true
  }), { userIndex: 0, assistantIndex: 1, durableUserCount: 1, assistantText: "Inspection complete." });
  const damaged = [
    { role: "user", messageRequestId: "message-multiline", content: { text: `/scout ${message.replace(/\s+/g, " ")}` } },
    assistant
  ];
  assert.equal(durableTurnPosition(damaged, message, "operation-multiline", "message-multiline", {
    requireExactCorrelation: true, requireUniqueUser: true
  }), null);
});

test("terminal lifecycle mismatch keeps operation and task state independent", () => {
  const outcome = terminalLifecycleOutcome({ expectedOperationStatus: "completed", observedOperationStatus: "blocked",
    expectedTaskStatus: "completed", observedTaskStatus: "pending", turnIndex: 2 });
  assert.deepEqual(outcome, { schemaVersion: 2, kind: "terminal-lifecycle-mismatch",
    expectedOperationStatus: "completed", observedOperationStatus: "blocked",
    expectedTaskStatus: "completed", observedTaskStatus: "pending", turnIndex: 2 });
  assert.equal(candidateOutcomeFailureReason(outcome),
    "webui-terminal-lifecycle-operation-blocked-expected-completed-task-pending-expected-completed-turn-2");
  assert.equal(terminalLifecycleOutcome({ expectedOperationStatus: "completed", observedOperationStatus: "completed",
    expectedTaskStatus: "pending", observedTaskStatus: "pending", turnIndex: 2 }), null);
  assert.equal(terminalLifecycleOutcome({ expectedOperationStatus: "completed", observedOperationStatus: "completed",
    expectedTaskStatus: "refused", observedTaskStatus: "refused", turnIndex: 1 }), null);
  const incompleteRefusal = terminalLifecycleOutcome({ expectedOperationStatus: "completed", observedOperationStatus: "blocked",
    expectedTaskStatus: "refused", observedTaskStatus: "pending", turnIndex: 1 });
  assert.deepEqual(incompleteRefusal, { schemaVersion: 2, kind: "terminal-lifecycle-mismatch",
    expectedOperationStatus: "completed", observedOperationStatus: "blocked",
    expectedTaskStatus: "refused", observedTaskStatus: "pending", turnIndex: 1 });
  assert.equal(candidateOutcomeFailureReason(incompleteRefusal),
    "webui-terminal-lifecycle-operation-blocked-expected-completed-task-pending-expected-refused-turn-1");
  const refusedFailure = terminalLifecycleOutcome({ expectedOperationStatus: "completed", observedOperationStatus: "error",
    expectedTaskStatus: "refused", observedTaskStatus: "failed", turnIndex: 1 });
  assert.deepEqual(refusedFailure, { schemaVersion: 2, kind: "terminal-lifecycle-mismatch",
    expectedOperationStatus: "completed", observedOperationStatus: "error",
    expectedTaskStatus: "refused", observedTaskStatus: "failed", turnIndex: 1 });
  assert.equal(candidateOutcomeFailureReason(refusedFailure),
    "webui-terminal-lifecycle-operation-error-expected-completed-task-failed-expected-refused-turn-1");
  assert.throws(() => terminalLifecycleOutcome({ expectedOperationStatus: "completed", observedOperationStatus: "invalid",
    expectedTaskStatus: "completed", observedTaskStatus: "pending", turnIndex: 2 }), /outcome-invalid/);
});

test("multi-turn lifecycle accepts a completed bounded intermediate task without weakening the final turn", () => {
  const intermediate = acceptedJourneyTaskStatuses({
    expectedSettlement: "completed", turnIndex: 1, turnCount: 3
  });
  assert.deepEqual(intermediate, ["pending", "completed"]);
  for (const observedTaskStatus of intermediate) {
    assert.equal(terminalLifecycleOutcome({
      expectedOperationStatus: "completed",
      observedOperationStatus: "completed",
      expectedTaskStatus: intermediate[0],
      acceptedTaskStatuses: intermediate,
      observedTaskStatus,
      turnIndex: 1
    }), null);
  }
  for (const observedTaskStatus of ["refused", "failed", "unknown"]) {
    assert.equal(terminalLifecycleOutcome({
      expectedOperationStatus: "completed",
      observedOperationStatus: "completed",
      expectedTaskStatus: intermediate[0],
      acceptedTaskStatuses: intermediate,
      observedTaskStatus,
      turnIndex: 1
    })?.kind, "terminal-lifecycle-mismatch");
  }
  assert.deepEqual(acceptedJourneyTaskStatuses({
    expectedSettlement: "completed", turnIndex: 3, turnCount: 3
  }), ["completed"]);
  assert.deepEqual(acceptedJourneyTaskStatuses({
    expectedSettlement: "refused", turnIndex: 1, turnCount: 1
  }), ["refused"]);
});

test("persisted uncertain-send recovery keeps only bounded privacy-safe evidence", () => {
  const persisted = persistedJourneyReceipt({
    channel: "webui-gateway", completed: true, sessionRef: "private-session", reconnects: 2,
    turns: [{ index: 2, messageRequestId: "private-message", operationRef: "private-operation", receiptUncertain: true,
      expectedSettlement: "refused",
      expectedOperationStatus: "completed", expectedTaskStatus: "refused", operationStatus: "blocked", taskStatus: "pending",
      outcome: { schemaVersion: 2, kind: "terminal-lifecycle-mismatch", expectedOperationStatus: "completed",
        observedOperationStatus: "blocked", expectedTaskStatus: "refused", observedTaskStatus: "pending",
        turnIndex: 2, rawReason: "must-also-not-persist" },
      recovery: { responseObserved: true, responseDiscarded: true, connectionDropped: true, replayCursor: 7,
        recoveredFromKind: "runtime.changed", recoveredAtSequence: 8, correlatedByMessageRequestId: true,
        sendAttempts: 1, durableUserCopies: 1, rawResponse: "must-not-persist" } }]
  });
  assert.deepEqual(persisted.turns[0].recovery, {
    responseObserved: true, responseDiscarded: true, connectionDropped: true, replayCursor: 7,
    recoveredFromKind: "runtime.changed", recoveredAtSequence: 8, correlatedByMessageRequestId: true,
    sendAttempts: 1, durableUserCopies: 1
  });
  assert.deepEqual(persisted.turns[0].outcome, { schemaVersion: 2, kind: "terminal-lifecycle-mismatch",
    expectedOperationStatus: "completed", observedOperationStatus: "blocked",
    expectedTaskStatus: "refused", observedTaskStatus: "pending", turnIndex: 2 });
  assert.equal(persisted.turns[0].expectedSettlement, "refused");
  assert.equal(persisted.turns[0].operationStatus, "blocked");
  assert.equal(persisted.turns[0].taskStatus, "pending");
  assert.equal(JSON.stringify(persisted).includes("must-not-persist"), false);
  assert.equal(JSON.stringify(persisted).includes("must-also-not-persist"), false);
  assert.equal(JSON.stringify(persisted).includes("private-message"), false);
  assert.equal(JSON.stringify(persisted).includes("private-operation"), false);
  assert.equal(JSON.stringify(persisted).includes("assistantText"), false);
});

test("production-v2 candidate resolves its bound ws runtime for dry-run and an in-process Gateway", () => {
  const dryRun = spawnSync(process.execPath, [path.join(root, "scripts", "benchmark-runner.mjs"),
    "--suite", "production-v2", "--dry-run"], { cwd: root, encoding: "utf8" });
  assert.equal(dryRun.status, 0, `${dryRun.stdout}\n${dryRun.stderr}`);
  assert.match(dryRun.stdout, /DRY RUN: no model session started/);
  assert.doesNotMatch(dryRun.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package 'ws'/);

  const snapshot = createBenchmarkExecutionSnapshot({
    liveRoot: root,
    argv: ["--suite", "production-v2", "--dry-run"],
    cwd: root
  });
  try {
    assert.ok(snapshot.metadata.webUiAssets);
    assert.deepEqual(benchmarkTreeIdentity(snapshot.metadata.webUiAssets.root, { rejectSymlinks: true }),
      snapshot.metadata.webUiAssets.tree);
    assert.equal(fs.statSync(snapshot.metadata.webUiAssets.root).mode & 0o222, 0);
    const service = pathToFileURL(path.join(snapshot.candidateRoot,
      "packages", "piagent-webui", "gateway", "gateway-service.ts")).href;
    const control = pathToFileURL(path.join(snapshot.candidateRoot,
      "packages", "piagent-webui", "gateway", "control-socket.ts")).href;
    const journey = pathToFileURL(path.join(snapshot.candidateRoot, "scripts", "benchmark-webui-journey.mjs")).href;
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshot.candidateRoot, "package.json"), "utf8"));
    const source = [
      'import fs from "node:fs";',
      'import os from "node:os";',
      'import path from "node:path";',
      'const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-gateway-agent-"));',
      "let gateway = null; let client = null;",
      "try {",
      `  const { startPiagentGateway } = await import(${JSON.stringify(service)});`,
      `  const { requestGatewayControl } = await import(${JSON.stringify(control)});`,
      `  const { GatewayJourneyClient, bootstrapBrowserSession } = await import(${JSON.stringify(journey)});`,
      "  gateway = await startPiagentGateway({",
      `    packageRoot: ${JSON.stringify(snapshot.candidateRoot)},`,
      `    expectedPiVersion: ${JSON.stringify(manifest.peerDependencies["@earendil-works/pi-coding-agent"])},`,
      `    agentDir, staticRoot: ${JSON.stringify(snapshot.metadata.webUiAssets.root)}`,
      "  });",
      '  const launch = await requestGatewayControl(gateway.descriptor.controlSocket, { action: "issue-launch-url" });',
      '  if (!launch.ok || typeof launch.value?.launchUrl !== "string") throw new Error("launch-unavailable");',
      "  const deadline = Date.now() + 10_000;",
      "  const browser = await bootstrapBrowserSession(launch.value.launchUrl, deadline);",
      "  client = new GatewayJourneyClient(browser); await client.connect(deadline, null);",
      '  const health = await client.request("gateway.health", {}, deadline);',
      '  if (health?.mode !== "full") throw new Error("gateway-health-not-ready");',
      "  const index = await fetch(browser.origin);",
      '  if (!index.ok || !(await index.text()).includes("piagent-webui-mode")) throw new Error("production-assets-not-served");',
      '  process.stdout.write(`gateway-started:${gateway.descriptor.origin}\\n`);',
      "} finally {",
      "  client?.close(); await gateway?.close();",
      '  const gatewayState = fs.lstatSync(path.join(agentDir, "piagent-gateway"));',
      '  if (!gatewayState.isDirectory() || gatewayState.isSymbolicLink()) throw new Error("gateway-home-state-not-a-directory");',
      '  process.stdout.write("gateway-home-state:directory\\n");',
      "  fs.rmSync(agentDir, { recursive: true, force: true });",
      "}"
    ].join("\n");
    const gateway = spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--import", path.join(snapshot.candidateRoot, "scripts", "register-typescript-loader.mjs"),
      "--input-type=module", "--eval", source
    ], {
      cwd: root,
      encoding: "utf8",
      env: benchmarkBootstrapEnvironment(snapshot.metadata)
    });
    assert.equal(gateway.status, 0, `${gateway.stdout}\n${gateway.stderr}`);
    assert.match(gateway.stdout, /^gateway-started:http:\/\/127\.0\.0\.1:\d+$/m);
    assert.match(gateway.stdout, /^gateway-home-state:directory$/m);
    assert.doesNotMatch(gateway.stderr, /ERR_MODULE_NOT_FOUND|Cannot find package 'ws'/);
  } finally {
    cleanupBenchmarkExecutionSnapshot(snapshot.temporaryRoot, snapshot.runtimeParent, snapshot.metadata.piAgentHome);
  }
});
