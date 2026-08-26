import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { WebSocket } from "ws";

import { benchmarkBootstrapMetadata } from "../packages/piagent-core/benchmark/benchmark-bootstrap.js";
import { requestGatewayControl } from "../packages/piagent-webui/gateway/control-socket.ts";
import { startPiagentGateway } from "../packages/piagent-webui/gateway/gateway-service.ts";
import { gatewayProfileState, readOrCreateCatalogKey } from "../packages/piagent-webui/gateway/profile-state.ts";
import { ProjectRegistry } from "../packages/piagent-webui/gateway/project-registry.ts";

const PROTOCOL = "piagent-gateway-protocol-v1";
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

function opaque(prefix) {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function fail(message) {
  const error = new Error(message);
  error.code = "BENCHMARK_WEBUI_JOURNEY_FAILED";
  throw error;
}

function remaining(deadline, label) {
  const value = deadline - Date.now();
  if (value <= 0) fail(`webui-journey-timeout:${label}`);
  return value;
}

function withTimeout(operation, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`webui-journey-timeout:${label}`)), timeoutMs);
    Promise.resolve(operation).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function launchCapability(launchUrl) {
  const url = new URL(launchUrl);
  const hash = new URLSearchParams(url.hash.slice(1));
  const capability = hash.get("bootstrap");
  if (!capability) fail("webui-bootstrap-capability-missing");
  return { origin: url.origin, capability };
}

async function bootstrapBrowserSession(launchUrl, deadline) {
  const { origin, capability } = launchCapability(launchUrl);
  const response = await withTimeout(fetch(`${origin}/api/v1/bootstrap`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ capability })
  }), remaining(deadline, "bootstrap"), "bootstrap");
  if (!response.ok) fail(`webui-bootstrap-${response.status}`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const session = await response.json();
  if (!cookie || session?.authenticated !== true || typeof session.csrfToken !== "string") {
    fail("webui-bootstrap-response-invalid");
  }
  return { origin, cookie, csrf: session.csrfToken };
}

async function readJson(browser, pathname, deadline) {
  const response = await withTimeout(fetch(`${browser.origin}${pathname}`, {
    headers: { Accept: "application/json", Cookie: browser.cookie, Origin: browser.origin }
  }), remaining(deadline, pathname), pathname);
  if (!response.ok) fail(`webui-read-${response.status}:${pathname}`);
  return await response.json();
}

class GatewayJourneyClient {
  constructor(browser) {
    this.browser = browser;
    this.socket = null;
    this.responses = new Map();
    this.responseWaiters = new Map();
    this.discardWaiters = new Map();
    this.events = [];
    this.eventWaiters = new Set();
    this.helloWaiters = new Set();
    this.hello = null;
    this.lastSequence = 0;
  }

  async connect(deadline, lastEventSequence = null) {
    const socket = new WebSocket(`${this.browser.origin.replace(/^http/, "ws")}/api/v1/gateway`, "piagent.gateway.v1", {
      headers: { Cookie: this.browser.cookie, Origin: this.browser.origin }
    });
    this.socket = socket;
    socket.on("message", (body) => this.#consume(body));
    await withTimeout(new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }), remaining(deadline, "gateway-open"), "gateway-open");
    const hello = new Promise((resolve) => this.helloWaiters.add(resolve));
    socket.send(JSON.stringify({
      schemaVersion: 1,
      version: PROTOCOL,
      messageType: "connect",
      clientRef: opaque("benchmark_client"),
      minimumProtocol: 1,
      maximumProtocol: 1,
      lastEventSequence,
      catalogRevision: null
    }));
    await withTimeout(this.hello ?? hello, remaining(deadline, "gateway-hello"), "gateway-hello");
  }

  #consume(body) {
    let value;
    try { value = JSON.parse(body.toString()); }
    catch { return; }
    if (value?.messageType === "hello") {
      this.hello = value;
      for (const resolve of this.helloWaiters) resolve(value);
      this.helloWaiters.clear();
      return;
    }
    if (value?.messageType === "response" && typeof value.requestId === "string") {
      const discard = this.discardWaiters.get(value.requestId);
      if (discard) {
        this.discardWaiters.delete(value.requestId);
        discard({ requestId: value.requestId, responseObserved: true, responseDiscarded: true });
        return;
      }
      this.responses.set(value.requestId, value);
      const waiter = this.responseWaiters.get(value.requestId);
      if (waiter) { this.responseWaiters.delete(value.requestId); waiter(value); }
      return;
    }
    if (value?.messageType === "event") {
      if (Number.isSafeInteger(value.sequence)) this.lastSequence = Math.max(this.lastSequence, value.sequence);
      this.events.push(value);
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.predicate(value)) { this.eventWaiters.delete(waiter); waiter.resolve(value); }
      }
    }
  }

  async request(method, params, deadline) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) fail("webui-gateway-not-connected");
    const requestId = opaque("benchmark_request");
    this.socket.send(JSON.stringify({ schemaVersion: 1, version: PROTOCOL, messageType: "request", requestId, method, params }));
    const existing = this.responses.get(requestId);
    const response = existing ?? await withTimeout(new Promise((resolve) => this.responseWaiters.set(requestId, resolve)),
      remaining(deadline, method), method);
    this.responses.delete(requestId);
    if (response?.ok !== true) fail(`webui-gateway-${method}:${response?.error?.code ?? "unknown"}`);
    return response.result;
  }

  async requestAndDiscardResponse(method, params, deadline) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) fail("webui-gateway-not-connected");
    const requestId = opaque("benchmark_request");
    const observed = new Promise((resolve) => this.discardWaiters.set(requestId, resolve));
    this.socket.send(JSON.stringify({ schemaVersion: 1, version: PROTOCOL, messageType: "request", requestId, method, params }));
    const result = await withTimeout(observed, remaining(deadline, `${method}-discard`), `${method}-discard`);
    if (result?.responseObserved !== true || result?.responseDiscarded !== true) {
      fail(`webui-gateway-${method}-response-not-discarded`);
    }
    return result;
  }

  async waitForEvent(predicate, deadline, label) {
    const existing = this.events.find(predicate);
    if (existing) return existing;
    return await withTimeout(new Promise((resolve) => this.eventWaiters.add({ predicate, resolve })), remaining(deadline, label), label);
  }

  close() {
    this.#disconnect(false);
  }

  drop() {
    this.#disconnect(true);
  }

  #disconnect(abrupt) {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      if (abrupt) socket.terminate();
      else socket.close(1000, "benchmark-reconnect");
    } catch { socket.terminate(); }
    for (const waiter of this.responseWaiters.values()) waiter({ ok: false, error: { code: "gateway-closed" } });
    this.responseWaiters.clear();
    for (const waiter of this.discardWaiters.values()) waiter({ responseObserved: false, responseDiscarded: false });
    this.discardWaiters.clear();
    for (const waiter of this.eventWaiters) waiter.resolve({ kind: "gateway.closed" });
    this.eventWaiters.clear();
  }
}

function recoveryEvent(event, sessionRef, messageRequestId) {
  return ["runtime.changed", "operation.settled"].includes(event?.kind)
    && event?.payload?.sessionRef === sessionRef
    && event?.payload?.messageRequestId === messageRequestId
    && typeof event?.payload?.operationRef === "string"
    && OPAQUE_REF.test(event.payload.operationRef);
}

function recoverOperationFromEvents(events, sessionRef, messageRequestId) {
  const matches = events.filter((event) => recoveryEvent(event, sessionRef, messageRequestId));
  if (matches.length === 0) return null;
  const operationRefs = [...new Set(matches.map((event) => event.payload.operationRef))];
  if (operationRefs.length !== 1) fail("webui-uncertain-send-correlation-ambiguous");
  const first = matches.toSorted((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))[0];
  return { operationRef: operationRefs[0], recoveredFromKind: first.kind, recoveredAtSequence: first.sequence ?? null };
}

function modelIdentity(value) {
  const separator = String(value ?? "").indexOf("/");
  if (separator < 1) fail("webui-model-identity-invalid");
  return { provider: value.slice(0, separator), modelId: value.slice(separator + 1) };
}

function commandBase(action, catalogRevision, sessionRef, sessionRevision) {
  const now = new Date();
  return {
    schemaVersion: 1,
    version: "piagent-session-command-v1",
    messageType: "command",
    commandId: opaque("benchmark_command"),
    idempotencyKey: opaque("benchmark_idempotency"),
    action,
    requestedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    sessionRef,
    expectedCatalogRevision: catalogRevision,
    expectedSessionRevision: sessionRevision
  };
}

async function catalog(client, deadline) {
  return await client.request("sessions.list", { cursor: null, limit: 200, filter: "active", query: null, projectRef: null }, deadline);
}

function successfulReceipt(receipt) {
  return receipt?.phase === "settled" && ["started", "queued", "steered", "created"].includes(receipt.resultCode);
}

function durableTurnPosition(items, message, operationRef, messageRequestId,
  { allowBlockedAssistant = false, requireExactCorrelation = false, requireUniqueUser = false } = {}) {
  const correlatedUsers = items.some((item) => item?.role === "user" && typeof item?.messageRequestId === "string");
  const userMatches = items.flatMap((item, index) => item?.role === "user"
    && String(item?.content?.text ?? "").trim().endsWith(message.trim())
    && (requireExactCorrelation ? item.messageRequestId === messageRequestId
      : !correlatedUsers || item.messageRequestId === messageRequestId) ? [index] : []);
  if (requireUniqueUser && userMatches.length > 1) fail("webui-uncertain-send-was-resent");
  const userIndex = userMatches.at(-1) ?? -1;
  if (userIndex < 0) return null;
  const assistantIndex = items.findIndex((item, index) => index > userIndex && item?.role === "assistant"
    && (requireExactCorrelation ? item.messageRequestId === messageRequestId
      : !correlatedUsers || item.messageRequestId === messageRequestId)
    && (!operationRef || !item.agentOperationId || item.agentOperationId === operationRef)
    && (typeof item?.content?.text === "string" && item.content.text.trim()
      || allowBlockedAssistant && ["assistant-completion-continuing", "assistant-completion-not-approved"]
        .includes(item?.content?.reasonCode)));
  if (assistantIndex <= userIndex) return null;
  return { userIndex, assistantIndex, durableUserCount: userMatches.length,
    assistantText: typeof items[assistantIndex].content.text === "string" ? items[assistantIndex].content.text : "" };
}

async function waitForDurableTurn(browser, sessionRef, message, operationRef, messageRequestId, deadline,
  options = {}) {
  let last = null;
  while (Date.now() < deadline) {
    last = await readJson(browser, `/api/v1/sessions/${encodeURIComponent(sessionRef)}/inspection/transcript?limit=100`, deadline);
    const items = Array.isArray(last?.items) ? last.items : [];
    const position = durableTurnPosition(items, message, operationRef, messageRequestId, options);
    if (position) return { transcript: last, ...position };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  fail(`webui-durable-turn-missing:${operationRef ?? "unknown"}`);
}

function eventSummary(events, operationRef) {
  const selected = events.filter((event) => event?.payload?.operationRef === operationRef);
  const fileLabels = selected.flatMap((event) => typeof event?.payload?.fileLabel === "string" ? [event.payload.fileLabel] : []);
  return {
    firstSequence: selected[0]?.sequence ?? null,
    lastSequence: selected.at(-1)?.sequence ?? null,
    kinds: selected.map((event) => event.kind),
    fileLabels: [...new Set(fileLabels)],
    toolCalls: selected.filter((event) => event.kind === "tool.started").length,
    failedToolCalls: selected.filter((event) => event.kind === "tool.completed" && event.payload?.isError === true).length
  };
}

export async function runPiagentWebUiJourney(options) {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const deadline = started + timeoutMs;
  const turns = options.turns ?? [];
  if (!Array.isArray(turns) || turns.length === 0) fail("webui-journey-turns-missing");
  const manifest = JSON.parse(fs.readFileSync(path.join(options.packageRoot, "package.json"), "utf8"));
  const expectedPiVersion = manifest.peerDependencies?.["@earendil-works/pi-coding-agent"];
  if (typeof expectedPiVersion !== "string") fail("webui-pi-version-missing");
  const bootstrap = benchmarkBootstrapMetadata();
  const staticRoot = bootstrap?.webUiAssets?.root;
  if (typeof staticRoot !== "string") fail("webui-frozen-assets-missing");
  const state = gatewayProfileState(options.agentDir);
  const key = readOrCreateCatalogKey(state);
  const project = new ProjectRegistry(state.root, key).register(options.workspace);
  let gateway = null;
  let client = null;
  const receipt = {
    schemaVersion: 1,
    channel: "webui-gateway",
    model: options.model,
    thinking: options.thinking,
    sessionRef: null,
    turns: [],
    reconnects: 0,
    completed: false
  };
  const scopedEnvironment = { ...(options.environment ?? {}), PI_CODING_AGENT_DIR: options.agentDir };
  const priorEnvironment = new Map(Object.keys(scopedEnvironment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(scopedEnvironment)) {
    if (typeof value === "string") process.env[key] = value;
  }
  try {
    gateway = await withTimeout(startPiagentGateway({ packageRoot: options.packageRoot, expectedPiVersion,
      agentDir: options.agentDir, staticRoot }), remaining(deadline, "gateway-start"), "gateway-start");
    const launch = await requestGatewayControl(state.controlSocket, { action: "issue-launch-url" }, remaining(deadline, "launch-url"));
    const launchUrl = launch.ok && launch.value && typeof launch.value === "object" ? launch.value.launchUrl : null;
    if (typeof launchUrl !== "string") fail("webui-launch-url-unavailable");
    const browser = await bootstrapBrowserSession(launchUrl, deadline);
    client = new GatewayJourneyClient(browser);
    await client.connect(deadline, null);
    const creation = await readJson(browser, "/api/v1/session-creation-options", deadline);
    const identity = modelIdentity(options.model);
    const model = creation.models?.find((item) => item.provider === identity.provider && item.modelId === identity.modelId);
    if (!model?.modelRef) fail(`webui-model-unavailable:${options.model}`);

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (turn.reconnectBefore && receipt.sessionRef) {
        const sequence = client.lastSequence;
        client.close();
        client = new GatewayJourneyClient(browser);
        await client.connect(deadline, sequence);
        receipt.reconnects += 1;
      }
      const before = await catalog(client, deadline);
      if (!before?.catalogRevision) fail("webui-catalog-revision-missing");
      const messageRequestId = opaque("benchmark_message");
      let command;
      if (!receipt.sessionRef) {
        command = {
          ...commandBase("session.create", before.catalogRevision, null, null),
          payload: {
            projectRef: project.projectRef,
            placeRef: project.placeRef,
            modelRef: model.modelRef,
            thinkingLevel: options.thinking,
            permissionMode: "workspace-write",
            ...(turn.workflow ? { workflow: turn.workflow } : {}),
            message: turn.message,
            messageRequestId
          }
        };
      } else {
        const row = before.sessions.find((item) => item.sessionRef === receipt.sessionRef);
        if (!row) fail("webui-session-disappeared");
        command = {
          ...commandBase("session.send", before.catalogRevision, receipt.sessionRef, row.sessionRevision),
          payload: {
            delivery: "new-operation",
            message: turn.message,
            messageRequestId,
            expectedOperationRef: null,
            attachmentRefs: [],
            ...(turn.workflow ? { workflow: turn.workflow } : {})
          }
        };
      }
      const submittedAt = new Date().toISOString();
      let commandReceipt = null;
      let operationRef = null;
      let recovery = null;
      if (turn.receiptUncertain === true) {
        if (!receipt.sessionRef) fail("webui-uncertain-send-requires-existing-session");
        const replayCursor = client.lastSequence;
        const discarded = await client.requestAndDiscardResponse("sessions.command", { command }, deadline);
        if (discarded.responseObserved !== true || discarded.responseDiscarded !== true) {
          fail("webui-uncertain-send-response-not-discarded");
        }
        client.drop();
        client = new GatewayJourneyClient(browser);
        await client.connect(deadline, replayCursor);
        receipt.reconnects += 1;
        await client.waitForEvent((event) => recoveryEvent(event, receipt.sessionRef, messageRequestId), deadline,
          `turn-${index + 1}-uncertain-correlation`);
        const recovered = recoverOperationFromEvents(client.events, receipt.sessionRef, messageRequestId);
        if (!recovered) fail("webui-uncertain-send-operation-not-recovered");
        operationRef = recovered.operationRef;
        recovery = {
          responseObserved: true,
          responseDiscarded: true,
          connectionDropped: true,
          replayCursor,
          recoveredFromKind: recovered.recoveredFromKind,
          recoveredAtSequence: recovered.recoveredAtSequence,
          correlatedByMessageRequestId: true,
          sendAttempts: 1
        };
      } else {
        commandReceipt = await client.request("sessions.command", { command }, deadline);
        if (!successfulReceipt(commandReceipt) || !commandReceipt.sessionRef || !commandReceipt.operationRef) {
          fail(`webui-command-not-started:${commandReceipt?.phase ?? "unknown"}:${commandReceipt?.resultCode ?? "unknown"}`);
        }
        receipt.sessionRef ??= commandReceipt.sessionRef;
        if (receipt.sessionRef !== commandReceipt.sessionRef) fail("webui-session-identity-changed");
        operationRef = commandReceipt.operationRef;
      }
      const settlement = await client.waitForEvent((event) => event.kind === "operation.settled"
        && event.payload?.sessionRef === receipt.sessionRef
        && event.payload?.messageRequestId === messageRequestId
        && event.payload?.operationRef === operationRef, deadline, `turn-${index + 1}-settlement`);
      const expectedSettlement = turn.expectedSettlement
        ?? (index === turns.length - 1 ? options.expectedTerminalSettlement : "completed")
        ?? "completed";
      const expectedProtocolSettlement = expectedSettlement === "refused" ? "blocked" : expectedSettlement;
      if (settlement.payload?.settlement !== expectedProtocolSettlement) {
        fail(`webui-turn-${index + 1}-${settlement.payload?.settlement ?? "unknown"}-expected-${expectedSettlement}`);
      }
      const durable = await waitForDurableTurn(browser, receipt.sessionRef, turn.message, operationRef,
        messageRequestId, deadline, { allowBlockedAssistant: expectedProtocolSettlement === "blocked",
          requireExactCorrelation: turn.receiptUncertain === true, requireUniqueUser: turn.receiptUncertain === true });
      if (recovery) recovery.durableUserCopies = durable.durableUserCount;
      receipt.turns.push({
        index: index + 1,
        messageRequestId,
        operationRef,
        submittedAt,
        receiptPhase: commandReceipt?.phase ?? null,
        receiptResult: commandReceipt?.resultCode ?? null,
        receiptUncertain: turn.receiptUncertain === true,
        ...(recovery ? { recovery } : {}),
        settlement: settlement.payload.settlement,
        durableUserIndex: durable.userIndex,
        durableAssistantIndex: durable.assistantIndex,
        assistantText: durable.assistantText,
        ...eventSummary(client.events, operationRef)
      });
    }
    receipt.completed = true;
    const stdout = receipt.turns.map((turn) => turn.assistantText).join("\n\n");
    return { code: 0, signal: null, timedOut: false, stdout, stderr: "", durationSeconds: (Date.now() - started) / 1000,
      journeyReceipt: receipt, forbiddenHits: [], requiredHits: [] };
  } catch (error) {
    const timedOut = String(error?.message ?? "").includes("webui-journey-timeout");
    return { code: 1, signal: null, timedOut, stdout: "", stderr: error instanceof Error ? error.message : String(error),
      durationSeconds: (Date.now() - started) / 1000, journeyReceipt: receipt, forbiddenHits: [], requiredHits: [] };
  } finally {
    client?.close();
    await gateway?.close().catch(() => undefined);
    for (const [key, value] of priorEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export {
  GatewayJourneyClient,
  bootstrapBrowserSession,
  durableTurnPosition,
  eventSummary,
  launchCapability,
  recoverOperationFromEvents
};
