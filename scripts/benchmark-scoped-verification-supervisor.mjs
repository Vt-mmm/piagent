import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { executionSourceText } from "../packages/piagent-core/extensions/acceptance-executor/module-graph.mjs";
import { parseRequest, parseResponse, WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { registerScopedBrokerTransport, runScopedBrokerMcp } from "./benchmark-scoped-broker-custody.mjs";
import { SCOPED_PROJECT_VERIFICATION_RECEIPT, validateScopedProjectVerificationReceipt
} from "./benchmark-scoped-project-verifier.mjs";
import {
  SCOPED_BROKER_FROZEN_IDENTITY_VERSION, SCOPED_BROKER_IDENTITY_VERSION,
  SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION, SCOPED_TOOL_DEFINITIONS,
  scopedCommonRuntimeClosureIdentity, scopedFrozenQualificationIdentity, scopedQualificationIdentity,
  scopedToolDefinitionsSha256, validateScopedBrokerMeasurementBinding
} from "./benchmark-scoped-frozen-qualification.mjs";
export * from "./benchmark-scoped-frozen-qualification.mjs";
export * from "./benchmark-scoped-project-verifier.mjs";
export { registerScopedBrokerTransport, runScopedBrokerMcp };

export const SCOPED_VERIFICATION_PROTOCOL = "scoped-isolated-contract-v1";
export const SCOPED_VERIFICATION_RECEIPT = "scoped-verification-receipt-v1";
export const SCOPED_VERIFICATION_BRIDGE = "scoped-verification-bridge-v1";
const HASH = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const RECEIPT_FIELDS = ["version", "kind", "protocol", "verificationId", "action", "attemptId", "broker",
  "manifestSha256", "capabilityDigest", "planDigest", "requestDigest", "sourceDigest", "imageId",
  "verifierDigest", "worker", "status", "verdict", "cleanup", "evidence", "startedAtMs", "deadlineAtMs",
  "settledAtMs", "completionAllowed"];
const hash = value => createHash("sha256").update(value).digest("hex");
const validId = value => typeof value === "string" && ID.test(value);
const validHash = value => typeof value === "string" && HASH.test(value);
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const fail = code => { throw Object.assign(new Error(code), { supervisorCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };
const runPinnedIsolatedContract = async input => {
  const { runIsolatedContract } = await import("../packages/piagent-core/extensions/acceptance-isolated-executor.js");
  return runIsolatedContract(input);
};
const SUPERVISOR_REAP_GRACE_MS = 250;
const plain = value => Boolean(value && typeof value === "object" && !types.isProxy(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value)));
function exact(value, names, code = "invalid-verification-object") {
  requireThat(plain(value), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireThat(Reflect.ownKeys(descriptors).length === names.length && names.every(name => descriptors[name]?.enumerable
    && Object.hasOwn(descriptors[name], "value")), code);
}
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
function publicKey(value) {
  const key = value?.type === "public" ? value : createPublicKey(value);
  requireThat(key.asymmetricKeyType === "ed25519", "invalid-receipt-key");
  return key;
}

export function scopedVerificationReceiptKeyDigest(value) {
  return hash(publicKey(value).export({ type: "spki", format: "der" }));
}

export function scopedVerificationPlanBinding({ protocol = SCOPED_VERIFICATION_PROTOCOL, requestText,
  imageId, dockerSocket, verifierDigest, timeoutMs } = {}) {
  requireThat(protocol === SCOPED_VERIFICATION_PROTOCOL && typeof requestText === "string" && IMAGE.test(imageId)
    && typeof dockerSocket === "string" && path.isAbsolute(dockerSocket) && path.normalize(dockerSocket) === dockerSocket
    && !dockerSocket.includes("\0") && validHash(verifierDigest) && Number.isSafeInteger(timeoutMs)
    && timeoutMs >= 25 && timeoutMs <= 30000,
  "invalid-verification-plan");
  const request = parseRequest(requestText);
  const requestDigest = hash(requestText), sourceDigest = hash(executionSourceText(request));
  const dockerSocketDigest = hash(dockerSocket);
  const planDigest = hash(JSON.stringify({ protocol, requestDigest, sourceDigest, imageId, dockerSocketDigest,
    verifierDigest, timeoutMs }));
  const capabilityDigest = hash(JSON.stringify({ version: 1, protocol, planDigest, requestDigest, sourceDigest,
    imageId, dockerSocketDigest, verifierDigest, timeoutMs }));
  return deepFreeze({ protocol, planDigest, requestDigest, sourceDigest, imageId, dockerSocketDigest,
    verifierDigest, timeoutMs, capabilityDigest });
}

function validateReceipt(receipt) {
  exact(receipt, RECEIPT_FIELDS, "invalid-verification-receipt");
  exact(receipt.broker, ["identitySha256", "sourceSha256"], "invalid-verification-receipt");
  exact(receipt.worker, ["runId", "version"], "invalid-verification-receipt");
  exact(receipt.cleanup, ["confirmed"], "invalid-verification-receipt");
  exact(receipt.evidence, ["executionSha256", "observationSha256", "reason"], "invalid-verification-receipt");
  requireThat(receipt.version === 1 && receipt.kind === SCOPED_VERIFICATION_RECEIPT
    && receipt.protocol === SCOPED_VERIFICATION_PROTOCOL && validId(receipt.verificationId)
    && Number.isSafeInteger(receipt.action) && receipt.action > 0 && UUID_V4.test(receipt.attemptId)
    && validHash(receipt.broker.identitySha256) && validHash(receipt.broker.sourceSha256)
    && [receipt.manifestSha256, receipt.capabilityDigest, receipt.planDigest, receipt.requestDigest,
      receipt.sourceDigest, receipt.verifierDigest, receipt.evidence.executionSha256]
      .every(validHash)
    && IMAGE.test(receipt.imageId) && receipt.worker.runId === receipt.attemptId
    && (receipt.worker.version === null || receipt.worker.version === WORKER_VERSION)
    && ["completed", "timeout", "cancelled", "error"].includes(receipt.status)
    && ["observation-recorded", "observation-unavailable"].includes(receipt.verdict)
    && typeof receipt.cleanup.confirmed === "boolean"
    && (receipt.evidence.observationSha256 === null || validHash(receipt.evidence.observationSha256))
    && (receipt.evidence.reason === null || typeof receipt.evidence.reason === "string"
      && /^[a-z0-9-]{1,80}$/.test(receipt.evidence.reason))
    && [receipt.startedAtMs, receipt.deadlineAtMs, receipt.settledAtMs].every(validTime)
    && receipt.deadlineAtMs >= receipt.startedAtMs && receipt.settledAtMs >= receipt.startedAtMs
    && receipt.completionAllowed === false, "invalid-verification-receipt");
  const observed = receipt.status === "completed" && receipt.cleanup.confirmed
    && receipt.worker.version === WORKER_VERSION && validHash(receipt.evidence.observationSha256)
    && receipt.evidence.reason === null;
  requireThat((receipt.verdict === "observation-recorded") === observed, "invalid-verification-receipt");
}

export function verifyScopedVerificationEnvelope(envelope, receiptPublicKey) {
  exact(envelope, ["receipt", "signature"], "invalid-verification-envelope");
  if (envelope.receipt?.kind === SCOPED_PROJECT_VERIFICATION_RECEIPT)
    validateScopedProjectVerificationReceipt(envelope.receipt);
  else validateReceipt(envelope.receipt);
  requireThat(typeof envelope.signature === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature),
    "invalid-verification-envelope");
  const signature = Buffer.from(envelope.signature, "base64");
  requireThat(signature.length === 64 && signature.toString("base64") === envelope.signature
    && verify(null, Buffer.from(JSON.stringify(envelope.receipt)), publicKey(receiptPublicKey), signature),
  "invalid-verification-signature");
  return deepFreeze(structuredClone(envelope));
}

function normalizeExecution(execution, state) {
  try {
    requireThat(plain(execution) && execution.runId === state.attemptId && execution.requestDigest === state.requestDigest
      && execution.sourceDigest === state.sourceDigest && execution.imageId === state.imageId
      && ["completed", "timeout", "cancelled", "error"].includes(execution.status)
      && typeof execution.cleanupConfirmed === "boolean", "execution-binding-invalid");
    let observation = null;
    if (execution.status === "completed") {
      exact(execution, ["runId", "requestDigest", "sourceDigest", "imageId", "status", "cleanupConfirmed",
        "observation"], "execution-binding-invalid");
      requireThat(plain(execution.observation), "execution-binding-invalid");
      observation = parseResponse(JSON.stringify(execution.observation), state.request, state.requestDigest);
      requireThat(observation.status === "completed", "execution-binding-invalid");
    } else {
      exact(execution, ["runId", "requestDigest", "sourceDigest", "imageId", "status", "reason",
        "cleanupConfirmed"], "execution-binding-invalid");
      requireThat(typeof execution.reason === "string" && /^[a-z0-9-]{1,80}$/.test(execution.reason),
        "execution-binding-invalid");
    }
    const executionSha256 = hash(JSON.stringify(execution));
    return { execution, observation, executionSha256,
      observationSha256: observation ? hash(JSON.stringify(observation)) : null,
      status: execution.status, reason: execution.reason ?? null, cleanupConfirmed: execution.cleanupConfirmed,
      integrityFailure: false };
  } catch {
    return { execution: null, observation: null, executionSha256: hash("invalid-execution-result"),
      observationSha256: null, status: "error", reason: "execution-binding-invalid", cleanupConfirmed: false,
      integrityFailure: true };
  }
}

/**
 * Host-only verifier. The returned bridge exposes no request source, Docker
 * socket, signing key, image map, or verifier map. Pass only this bridge to the
 * broker process boundary; keep this supervisor in the host process.
 */
export function createScopedVerificationSupervisor({ manifestSha256, brokerIdentitySha256, brokerSourceSha256,
  receiptPrivateKey, verifications, execute = runPinnedIsolatedContract, clock = Date.now,
  createAttemptId = randomUUID } = {}) {
  requireThat(validHash(manifestSha256) && validHash(brokerIdentitySha256) && validHash(brokerSourceSha256)
    && Array.isArray(verifications) && verifications.length > 0 && verifications.length <= 32
    && typeof execute === "function" && typeof clock === "function" && typeof createAttemptId === "function",
  "invalid-supervisor-configuration");
  const privateKey = receiptPrivateKey?.type === "private" ? receiptPrivateKey : createPrivateKey(receiptPrivateKey);
  requireThat(privateKey.asymmetricKeyType === "ed25519", "invalid-receipt-key");
  const receiptPublicKey = createPublicKey(privateKey);
  const receiptPublicKeyPem = receiptPublicKey.export({ type: "spki", format: "pem" });
  const receiptKeyDigest = scopedVerificationReceiptKeyDigest(receiptPublicKey);
  const plans = new Map();
  for (const item of verifications) {
    exact(item, ["manifest", "plan"], "invalid-supervisor-configuration");
    exact(item.manifest, ["id", "protocol", "capabilityDigest", "receiptKeyDigest", "timeoutMs"],
      "invalid-supervisor-configuration");
    exact(item.plan, ["requestText", "imageId", "dockerSocket", "verifierDigest"], "invalid-supervisor-configuration");
    const entry = item.manifest, plan = item.plan;
    requireThat(validId(entry.id) && !plans.has(entry.id) && entry.protocol === SCOPED_VERIFICATION_PROTOCOL
      && validHash(entry.capabilityDigest) && entry.receiptKeyDigest === receiptKeyDigest
      && Number.isSafeInteger(entry.timeoutMs) && entry.timeoutMs >= 25 && entry.timeoutMs <= 30000,
    "invalid-supervisor-configuration");
    const binding = scopedVerificationPlanBinding({ protocol: entry.protocol, requestText: plan.requestText,
      imageId: plan.imageId, dockerSocket: plan.dockerSocket, verifierDigest: plan.verifierDigest,
      timeoutMs: entry.timeoutMs });
    requireThat(binding.capabilityDigest === entry.capabilityDigest, "verification-capability-mismatch");
    plans.set(entry.id, deepFreeze({ ...binding, id: entry.id, requestText: String(plan.requestText),
      request: parseRequest(plan.requestText), dockerSocket: String(plan.dockerSocket) }));
  }
  let active = null;
  const completed = new Map();
  function stateFor(attemptId) {
    requireThat(UUID_V4.test(attemptId) && active?.attemptId === attemptId, "verification-attempt-unavailable");
    return active;
  }
  function makeEnvelope(state, normalized, settledAtMs) {
    const receipt = {
      version: 1, kind: SCOPED_VERIFICATION_RECEIPT, protocol: SCOPED_VERIFICATION_PROTOCOL,
      verificationId: state.verificationId, action: state.action, attemptId: state.attemptId,
      broker: { identitySha256: brokerIdentitySha256, sourceSha256: brokerSourceSha256 }, manifestSha256,
      capabilityDigest: state.capabilityDigest, planDigest: state.planDigest, requestDigest: state.requestDigest,
      sourceDigest: state.sourceDigest, imageId: state.imageId, verifierDigest: state.verifierDigest,
      worker: { runId: state.attemptId, version: normalized.observation?.workerVersion ?? null },
      status: normalized.status,
      verdict: normalized.status === "completed" && normalized.cleanupConfirmed && normalized.observation
        ? "observation-recorded" : "observation-unavailable",
      cleanup: { confirmed: normalized.cleanupConfirmed },
      evidence: { executionSha256: normalized.executionSha256, observationSha256: normalized.observationSha256,
        reason: normalized.reason },
      startedAtMs: state.startedAtMs, deadlineAtMs: state.deadlineAtMs, settledAtMs, completionAllowed: false
    };
    validateReceipt(receipt);
    const signature = sign(null, Buffer.from(JSON.stringify(receipt)), privateKey).toString("base64");
    return deepFreeze({ receipt, signature });
  }
  async function settle(state) {
    if (state.promise) return state.promise;
    state.promise = (async () => {
      let execution;
      try {
        const invocation = state.controller.signal.aborted
          ? Promise.resolve({ runId: state.attemptId, requestDigest: state.requestDigest, sourceDigest: state.sourceDigest,
            imageId: state.imageId, status: "cancelled", reason: "cancelled-before-execute", cleanupConfirmed: true })
          : Promise.resolve(execute({ requestText: state.requestText, imageId: state.imageId,
            dockerSocket: state.dockerSocket, timeoutMs: state.timeoutMs, signal: state.controller.signal,
            executionRunId: state.attemptId }));
        // An injected or damaged executor may ignore AbortSignal forever. The
        // deadline gate lets the supervisor settle after one bounded reap grace;
        // the late invocation remains observed so it cannot become an unhandled
        // rejection, and its unconfirmed cleanup can never authorize completion.
        invocation.catch(() => undefined);
        execution = await Promise.race([invocation, state.deadlineGate]);
      } catch {
        execution = { runId: state.attemptId, requestDigest: state.requestDigest, sourceDigest: state.sourceDigest,
          imageId: state.imageId, status: "error", reason: "executor-threw", cleanupConfirmed: false };
      }
      const normalized = normalizeExecution(execution, state);
      const settledAtMs = clock();
      requireThat(validTime(settledAtMs) && settledAtMs >= state.startedAtMs, "invalid-supervisor-clock");
      if (state.deadlineExpired || settledAtMs >= state.deadlineAtMs) {
        normalized.observation = null; normalized.observationSha256 = null;
        normalized.status = "timeout"; normalized.reason = "supervisor-deadline";
      } else if (state.cancelRequested) {
        normalized.observation = null; normalized.observationSha256 = null;
        normalized.status = "cancelled"; normalized.reason = "supervisor-cancelled";
      }
      const envelope = makeEnvelope(state, normalized, settledAtMs);
      const result = deepFreeze({ envelope, observation: normalized.observation,
        integrityFailure: normalized.integrityFailure });
      completed.set(state.attemptId, result);
      if (completed.size > 32) completed.delete(completed.keys().next().value);
      return result;
    })().finally(() => {
      clearTimeout(state.deadlineTimer); clearTimeout(state.reapTimer);
      if (active === state) active = null;
    });
    return state.promise;
  }
  const bridge = {
    version: "scoped-verification-supervisor-v1", receiptPublicKey: receiptPublicKeyPem, receiptKeyDigest,
    begin(request) {
      exact(request, ["verificationId", "action", "brokerIdentitySha256", "brokerSourceSha256", "manifestSha256",
        "capabilityDigest"], "invalid-verification-request");
      requireThat(!active && validId(request.verificationId) && Number.isSafeInteger(request.action) && request.action > 0
        && request.brokerIdentitySha256 === brokerIdentitySha256 && request.brokerSourceSha256 === brokerSourceSha256
        && request.manifestSha256 === manifestSha256, "verification-inflight-or-binding-invalid");
      const plan = plans.get(request.verificationId);
      requireThat(plan && request.capabilityDigest === plan.capabilityDigest, "verification-denied");
      const startedAtMs = clock(), attemptId = createAttemptId();
      requireThat(validTime(startedAtMs) && Number.isSafeInteger(startedAtMs + plan.timeoutMs)
        && UUID_V4.test(attemptId), "invalid-supervisor-runtime");
      let expire;
      const deadlineGate = new Promise(resolve => { expire = resolve; });
      const state = { ...plan, verificationId: request.verificationId, action: request.action, attemptId,
        startedAtMs, deadlineAtMs: startedAtMs + plan.timeoutMs, controller: new AbortController(), promise: null,
        cancelRequested: false, deadlineExpired: false, deadlineTimer: null, reapTimer: null, deadlineGate };
      active = state;
      state.deadlineTimer = setTimeout(() => {
        state.deadlineExpired = true; state.controller.abort();
        state.reapTimer = setTimeout(() => expire({ runId: state.attemptId, requestDigest: state.requestDigest,
          sourceDigest: state.sourceDigest, imageId: state.imageId, status: "timeout",
          reason: "executor-reap-unconfirmed", cleanupConfirmed: false }), SUPERVISOR_REAP_GRACE_MS);
        void settle(state).catch(() => undefined);
      }, plan.timeoutMs);
      return deepFreeze({ attemptId, verificationId: active.verificationId, capabilityDigest: active.capabilityDigest,
        planDigest: active.planDigest, requestDigest: active.requestDigest, sourceDigest: active.sourceDigest,
        imageId: active.imageId, verifierDigest: active.verifierDigest, startedAtMs, deadlineAtMs: active.deadlineAtMs });
    },
    execute(attemptId) {
      if (completed.has(attemptId)) return Promise.resolve(completed.get(attemptId));
      return settle(stateFor(attemptId));
    },
    cancel(attemptId) {
      if (!UUID_V4.test(attemptId) || active?.attemptId !== attemptId) return false;
      if (!active.deadlineExpired) active.cancelRequested = true;
      active.controller.abort(); return true;
    },
    reconcile(attemptId) {
      if (completed.has(attemptId)) return Promise.resolve(completed.get(attemptId));
      return settle(stateFor(attemptId));
    },
    status() { return deepFreeze({ active: active ? { attemptId: active.attemptId,
      verificationId: active.verificationId, action: active.action, capabilityDigest: active.capabilityDigest,
      planDigest: active.planDigest, requestDigest: active.requestDigest, sourceDigest: active.sourceDigest,
      imageId: active.imageId, verifierDigest: active.verifierDigest, startedAtMs: active.startedAtMs,
      deadlineAtMs: active.deadlineAtMs } : null,
      completed: completed.size }); }
  };
  return deepFreeze(bridge);
}

/** Host side of a dedicated, bounded IPC channel. The transport itself is
 * supplied by the launcher so this module does not create a network listener. */
export function createScopedVerificationHostDispatcher({ supervisor, authorization } = {}) {
  exact(supervisor, ["version", "receiptPublicKey", "receiptKeyDigest", "begin", "execute", "cancel", "reconcile", "status"],
    "invalid-verification-bridge");
  requireThat(supervisor.version === "scoped-verification-supervisor-v1"
    && typeof authorization === "string" && /^[a-f0-9]{64}$/.test(authorization), "invalid-verification-bridge");
  return async message => {
    let requestId = null;
    try {
      exact(message, ["version", "authorization", "requestId", "method", "params"], "invalid-bridge-request");
      requestId = message.requestId;
      requireThat(message.version === SCOPED_VERIFICATION_BRIDGE && message.authorization === authorization
        && UUID_V4.test(requestId) && ["begin", "execute", "cancel", "reconcile", "status"].includes(message.method),
      "invalid-bridge-request");
      let result;
      if (message.method === "begin") result = await supervisor.begin(message.params);
      else if (message.method === "status") {
        exact(message.params, [], "invalid-bridge-request"); result = await supervisor.status();
      } else {
        exact(message.params, ["attemptId"], "invalid-bridge-request");
        requireThat(UUID_V4.test(message.params.attemptId), "invalid-bridge-request");
        result = await supervisor[message.method](message.params.attemptId);
      }
      return deepFreeze({ version: SCOPED_VERIFICATION_BRIDGE, requestId, ok: true, result });
    } catch (error) {
      const code = typeof error?.supervisorCode === "string" && /^[a-z0-9-]{1,80}$/.test(error.supervisorCode)
        ? error.supervisorCode : "verification-bridge-error";
      return deepFreeze({ version: SCOPED_VERIFICATION_BRIDGE, requestId, ok: false, code });
    }
  };
}

/** Child-side proxy. It contains only public receipt material plus a caller
 * supplied IPC request function; host plan/image/socket/verifier maps stay in
 * createScopedVerificationHostDispatcher's process. */
export function createScopedVerificationRemoteBridge({ receiptPublicKey, receiptKeyDigest, authorization, request } = {}) {
  const key = publicKey(receiptPublicKey), pem = key.export({ type: "spki", format: "pem" });
  requireThat(validHash(receiptKeyDigest) && scopedVerificationReceiptKeyDigest(key) === receiptKeyDigest
    && typeof authorization === "string" && /^[a-f0-9]{64}$/.test(authorization) && typeof request === "function",
  "invalid-verification-bridge");
  async function call(method, params) {
    const requestId = randomUUID();
    const response = await request(deepFreeze({ version: SCOPED_VERIFICATION_BRIDGE, authorization,
      requestId, method, params }));
    requireThat(plain(response) && response.version === SCOPED_VERIFICATION_BRIDGE
      && response.requestId === requestId && typeof response.ok === "boolean", "invalid-bridge-response");
    if (!response.ok) {
      exact(response, ["version", "requestId", "ok", "code"], "invalid-bridge-response");
      requireThat(typeof response.code === "string" && /^[a-z0-9-]{1,80}$/.test(response.code), "invalid-bridge-response");
      fail(response.code);
    }
    exact(response, ["version", "requestId", "ok", "result"], "invalid-bridge-response");
    return response.result;
  }
  return deepFreeze({ version: "scoped-verification-supervisor-v1", receiptPublicKey: pem, receiptKeyDigest,
    begin: params => call("begin", params), execute: attemptId => call("execute", { attemptId }),
    cancel: attemptId => call("cancel", { attemptId }), reconcile: attemptId => call("reconcile", { attemptId }),
    status: () => call("status", {}) });
}

const BRIDGE_REQUEST_BYTES = 64 * 1024;
const BRIDGE_RESPONSE_BYTES = 2 * 1024 * 1024;
const UNIX_SOCKET_PATH_BYTES = 103;
function privateSocketPath(socketPath) {
  requireThat(typeof socketPath === "string" && path.isAbsolute(socketPath) && path.normalize(socketPath) === socketPath
    && !socketPath.includes("\0") && Buffer.byteLength(socketPath) <= UNIX_SOCKET_PATH_BYTES,
  "invalid-bridge-socket");
  const parent = fs.lstatSync(path.dirname(socketPath));
  requireThat(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0
    && !fs.existsSync(socketPath), "invalid-bridge-socket");
}

/** A private Unix-domain transport for the host dispatcher. It accepts one
 * bounded request and emits one bounded response per connection, which lets a
 * second connection deliver cancellation while execute is pending. */
export async function listenScopedVerificationBridge({ supervisor, authorization, socketPath } = {}) {
  privateSocketPath(socketPath);
  const dispatch = createScopedVerificationHostDispatcher({ supervisor, authorization });
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (sockets.size >= 4) { socket.destroy(); return; }
    sockets.add(socket); socket.setNoDelay(true);
    let bytes = 0, chunks = [], complete = false;
    socket.on("data", chunk => {
      if (complete) { socket.destroy(); return; }
      bytes += chunk.length;
      if (bytes > BRIDGE_REQUEST_BYTES) { complete = true; socket.destroy(); return; }
      chunks.push(Buffer.from(chunk));
    });
    socket.on("end", async () => {
      if (complete) return;
      complete = true;
      const input = Buffer.concat(chunks); chunks = [];
      if (input.length < 2 || input.at(-1) !== 10 || input.subarray(0, -1).includes(10)) { socket.destroy(); return; }
      let message;
      try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, -1))); }
      catch { socket.destroy(); return; }
      const response = await dispatch(message), output = Buffer.from(JSON.stringify(response) + "\n");
      if (output.length > BRIDGE_RESPONSE_BYTES) { socket.destroy(); return; }
      socket.end(output);
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.maxConnections = 4;
  await new Promise((resolve, reject) => {
    const failed = error => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed); server.once("listening", ready); server.listen(socketPath);
  });
  let socketInfo;
  try {
    fs.chmodSync(socketPath, 0o600); socketInfo = fs.lstatSync(socketPath);
    requireThat(socketInfo.isSocket() && !socketInfo.isSymbolicLink(), "invalid-bridge-socket");
  } catch (error) {
    await new Promise(resolve => server.close(() => resolve()));
    try { const current = fs.lstatSync(socketPath); if (current.isSocket() && !current.isSymbolicLink()) fs.unlinkSync(socketPath); }
    catch {}
    throw error;
  }
  let closed = false;
  return deepFreeze({ socketPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(() => resolve()));
      if (fs.existsSync(socketPath)) {
        const current = fs.lstatSync(socketPath);
        requireThat(current.dev === socketInfo.dev && current.ino === socketInfo.ino && current.isSocket(),
          "bridge-socket-replaced");
        fs.unlinkSync(socketPath);
      }
    }
  });
}

/** Child-side request function for createScopedVerificationRemoteBridge. The
 * only host path it knows is this dedicated private bridge socket. */
export function createScopedVerificationUnixRequest({ socketPath, timeoutMs = 60000 } = {}) {
  requireThat(typeof socketPath === "string" && path.isAbsolute(socketPath) && path.normalize(socketPath) === socketPath
    && !socketPath.includes("\0") && Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60000,
  "invalid-bridge-client");
  return message => new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath), chunks = [];
    let bytes = 0, finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      if (error) reject(Object.assign(new Error("verification-bridge-unavailable"),
        { supervisorCode: "verification-bridge-unavailable", cause: error }));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("bridge-timeout")), timeoutMs);
    socket.on("connect", () => socket.end(Buffer.from(JSON.stringify(message) + "\n")));
    socket.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > BRIDGE_RESPONSE_BYTES) finish(new Error("bridge-response-limit"));
      else chunks.push(Buffer.from(chunk));
    });
    socket.on("error", error => finish(error));
    socket.on("end", () => {
      if (finished) return;
      const input = Buffer.concat(chunks);
      try {
        requireThat(input.length >= 2 && input.at(-1) === 10 && !input.subarray(0, -1).includes(10),
          "invalid-bridge-response");
        finish(null, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, -1))));
      } catch (error) { finish(error); }
    });
  });
}


const BROKER_CONFIG_BYTES = 64 * 1024;
const BROKER_JOURNAL_BYTES = 32 * 1024 * 1024;
const MCP_PROCESS_SHUTDOWN = "piagent-mcp-process-shutdown";
const brokerFail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const brokerRequire = (value, code) => { if (!value) brokerFail(code); };
function brokerFields(value, names) {
  brokerRequire(plain(value), "invalid-object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  brokerRequire(Reflect.ownKeys(descriptors).length === names.length && names.every(name =>
    descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], "value")), "invalid-fields");
}

const brokerSameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.nlink === b.nlink;
const brokerSameFile = (a, b) => brokerSameNode(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs
  && a.ctimeNs === b.ctimeNs;
const brokerStat = file => fs.lstatSync(file, { bigint: true });
function brokerDirectoryChain(directory) {
  brokerRequire(path.isAbsolute(directory) && path.normalize(directory) === directory,
    "broker-config-path");
  const result = [];
  for (let current = directory;; current = path.dirname(current)) {
    const info = brokerStat(current);
    brokerRequire(info.isDirectory() && !info.isSymbolicLink(), "unsafe-parent");
    result.push([current, info]);
    if (current === path.dirname(current)) return result;
  }
}
function brokerCheckParents(chain) {
  for (const [file, info] of chain) {
    const current = brokerStat(file);
    brokerRequire(current.isDirectory() && current.dev === info.dev && current.ino === info.ino
      && current.mode === info.mode, "parent-changed");
  }
}
function brokerCapture(file, parents, maximum = BROKER_CONFIG_BYTES) {
  brokerRequire(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= BROKER_JOURNAL_BYTES,
    "material-size");
  brokerCheckParents(parents);
  const before = brokerStat(file);
  brokerRequire(before.isFile() && before.nlink === 1n
    && before.size <= BigInt(maximum), "unsafe-material");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    fs.fsyncSync(fd);
    brokerRequire(brokerSameFile(before, fs.fstatSync(fd, { bigint: true })), "material-changed");
    const buffer = Buffer.alloc(maximum + 1);
    let length = 0, read;
    while (length < buffer.length
      && (read = fs.readSync(fd, buffer, length, buffer.length - length, length))) length += read;
    brokerRequire(length <= maximum && BigInt(length) === before.size, "material-size");
    brokerRequire(brokerSameFile(before, fs.fstatSync(fd, { bigint: true }))
      && brokerSameFile(before, brokerStat(file)), "material-changed");
    brokerCheckParents(parents);
    return { bytes: buffer.subarray(0, length), info: before };
  } finally { fs.closeSync(fd); }
}
function readPrivateBrokerFile(file, maximum) {
  brokerRequire(typeof file === "string" && path.isAbsolute(file) && path.normalize(file) === file
    && !file.includes("\0"), "broker-config-path");
  const parents = brokerDirectoryChain(path.dirname(file)), captured = brokerCapture(file, parents, maximum);
  brokerRequire((parents[0][1].mode & 0o077n) === 0n && (captured.info.mode & 0o077n) === 0n,
    "broker-config-permissions");
  return captured.bytes;
}
function readPrivateBrokerConfigFile(file) { return readPrivateBrokerFile(file, BROKER_CONFIG_BYTES); }

/** Strict common loader for both public adapters. Config contains material and
 * journal custody plus only the private verifier bridge socket/token/public
 * receipt key. Host-only execution inputs and receipt private keys are rejected. */
export function loadScopedBrokerFromConfig({ configPath, createBroker } = {}) {
  brokerRequire(typeof createBroker === "function", "broker-config-version");
  const configBytes = readPrivateBrokerConfigFile(configPath);
  let config;
  try { config = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes)); }
  catch { brokerFail("broker-config-json"); }
  brokerRequire(configBytes.equals(Buffer.from(JSON.stringify(config))), "broker-config-noncanonical");
  const legacy = config.version === 1, qualified = config.version === SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION,
    frozen = config.version === SCOPED_BROKER_FROZEN_IDENTITY_VERSION;
  brokerFields(config, legacy
    ? ["version", "manifestPath", "manifestSignaturePath", "manifestPublicKeyPath", "expectedIdentity",
      "journalPath", "journalPrivateKeyPath", "verificationBridge"]
    : ["version", "manifestPath", "manifestSignaturePath", "manifestPublicKeyPath", "journalPath",
      "journalPrivateKeyPath", "verificationBridge", ...(qualified || frozen ? ["qualification"] : []),
      ...(frozen ? ["measurementBinding"] : [])]);
  brokerRequire(legacy || config.version === SCOPED_BROKER_IDENTITY_VERSION || qualified || frozen,
    "broker-config-version");
  let actualQualification;
  if (qualified || frozen) {
    const names = frozen ? ["version", "candidateRoot", "assetsRoot", "sdkRoot", "candidateIndexPath",
      "candidateIndexSha256"] : ["version", "candidateRoot", "assetsRoot", "sdkRoot"];
    brokerFields(config.qualification, names);
    brokerRequire(config.qualification.version === config.version, "broker-config-qualification");
    actualQualification = frozen
      ? scopedFrozenQualificationIdentity(config.qualification, scopedCommonRuntimeClosureIdentity().sha256)
      : scopedQualificationIdentity({ candidateRoot: config.qualification.candidateRoot,
        assetsRoot: config.qualification.assetsRoot, sdkRoot: config.qualification.sdkRoot });
  }
  const measurementBinding = frozen ? validateScopedBrokerMeasurementBinding(config.measurementBinding) : undefined;
  let verificationBridge;
  if (config.verificationBridge !== null) {
    brokerFields(config.verificationBridge, ["socketPath", "authorizationPath", "receiptPublicKeyPath",
      "receiptKeyDigest", "timeoutMs"]);
    const bridge = config.verificationBridge;
    brokerRequire(validHash(bridge.receiptKeyDigest) && Number.isSafeInteger(bridge.timeoutMs)
      && bridge.timeoutMs >= 100 && bridge.timeoutMs <= 60000, "broker-config-bridge");
    const authorization = new TextDecoder("utf-8", { fatal: true })
      .decode(readPrivateBrokerConfigFile(bridge.authorizationPath));
    brokerRequire(/^[a-f0-9]{64}$/.test(authorization), "broker-config-bridge");
    const receiptPublicKey = createPublicKey(readPrivateBrokerConfigFile(bridge.receiptPublicKeyPath));
    verificationBridge = createScopedVerificationRemoteBridge({ receiptPublicKey,
      receiptKeyDigest: bridge.receiptKeyDigest, authorization,
      request: createScopedVerificationUnixRequest({ socketPath: bridge.socketPath,
        timeoutMs: bridge.timeoutMs }) });
  }
  const manifestBytes = readPrivateBrokerConfigFile(config.manifestPath);
  const manifestSignature = readPrivateBrokerConfigFile(config.manifestSignaturePath);
  const manifestPublicKey = readPrivateBrokerConfigFile(config.manifestPublicKeyPath);
  const manifestPublicKeyObject = createPublicKey(manifestPublicKey);
  if (frozen) {
    brokerRequire(manifestPublicKeyObject.asymmetricKeyType === "ed25519"
      && verify(null, manifestBytes, manifestPublicKeyObject, manifestSignature), "manifest-signature");
    let signedManifest;
    try { signedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); }
    catch { brokerFail("manifest-json"); }
    brokerRequire(manifestBytes.equals(Buffer.from(JSON.stringify(signedManifest))), "manifest-noncanonical");
    const signedIdentity = signedManifest?.identity;
    brokerRequire(signedIdentity?.version === SCOPED_BROKER_FROZEN_IDENTITY_VERSION
      && signedIdentity.configSha256 === hash(configBytes), "broker-config-identity");
    brokerRequire(signedIdentity.armId === measurementBinding.armId
      && signedIdentity.requestId === measurementBinding.operatorRequestDigest
      && signedIdentity.contextPolicySha256 === measurementBinding.contextPolicySha256
      && signedIdentity.measurementConfigurationSha256 === measurementBinding.configurationSha256,
    "broker-config-measurement-binding");
  }
  const broker = createBroker({ manifestBytes, manifestSignature,
    manifestPublicKey: manifestPublicKeyObject,
    expectedIdentity: legacy ? config.expectedIdentity : undefined, actualConfigSha256: hash(configBytes),
    journalPath: config.journalPath,
    journalPrivateKey: createPrivateKey(readPrivateBrokerConfigFile(config.journalPrivateKeyPath)), actualQualification,
    verificationBridge });
  const identity = legacy ? config.expectedIdentity : broker?.identity;
  brokerRequire(broker?.identity?.nonce === identity?.nonce && (legacy
    || [SCOPED_BROKER_IDENTITY_VERSION, SCOPED_BROKER_QUALIFICATION_IDENTITY_VERSION,
      SCOPED_BROKER_FROZEN_IDENTITY_VERSION].includes(identity.version)
      && identity.version === config.version && identity.configSha256 === hash(configBytes)),
  "broker-config-identity");
  if (frozen) brokerRequire(identity.armId === measurementBinding.armId
    && identity.requestId === measurementBinding.operatorRequestDigest
    && identity.contextPolicySha256 === measurementBinding.contextPolicySha256
    && identity.measurementConfigurationSha256 === measurementBinding.configurationSha256,
  "broker-config-measurement-binding");
  const journalPublicKey = Buffer.from(broker.journalPublicKey);
  const settlementEvidence = () => {
    const status = broker.status();
    brokerRequire(status.ended === true && status.inflightVerification === null && status.blocked === false
      && status.cancelled === false, "broker-settlement-incomplete");
    brokerRequire(readPrivateBrokerConfigFile(config.manifestPath).equals(manifestBytes)
      && readPrivateBrokerConfigFile(config.manifestSignaturePath).equals(manifestSignature)
      && readPrivateBrokerConfigFile(config.manifestPublicKeyPath).equals(manifestPublicKey),
    "broker-settlement-manifest-changed");
    const journalBytes = readPrivateBrokerFile(config.journalPath, BROKER_JOURNAL_BYTES);
    brokerRequire(hash(journalBytes) === status.journalSha256, "broker-settlement-journal-changed");
    return Object.freeze({ version: "scoped-broker-journal-evidence-v1", manifestBytes: Buffer.from(manifestBytes),
      manifestSignature: Buffer.from(manifestSignature), manifestPublicKey: Buffer.from(manifestPublicKey),
      journalBytes: Buffer.from(journalBytes), journalPublicKey: Buffer.from(journalPublicKey),
      status: Object.freeze({ ...status }) });
  };
  return Object.freeze({ broker, nonce: identity.nonce,
    identity: Object.freeze({ ...identity }), configSha256: hash(configBytes), actualQualification,
    measurementBinding, settlementEvidence });
}

const scopedToolNames = Object.freeze(SCOPED_TOOL_DEFINITIONS.map(tool => tool.name));
const piOwnedTools = new WeakMap();
function exactToolNames(value) {
  return Array.isArray(value) && value.length === scopedToolNames.length
    && value.every((name, index) => name === scopedToolNames[index]);
}

/** Pi extension adapter over the same loaded kernel used by MCP. The host must
 * still construct the SDK session with noTools="all" and tools=exact3. */
export function createScopedBrokerPiExtension({ broker, nonce } = {}) {
  brokerRequire(broker && typeof broker.invokeAsync === "function" && typeof broker.status === "function"
    && nonce === broker.identity?.nonce, "pi-broker-binding");
  let registered = false, shuttingDown = false;
  const assertSurface = pi => {
    const active = pi.getActiveTools?.().map(tool => typeof tool === "string" ? tool : tool?.name)
      ?? pi.getActiveToolNames?.();
    if (active !== undefined) brokerRequire(exactToolNames(active), "pi-tool-surface-mismatch");
  };
  const factory = function scopedBrokerPiExtension(pi) {
    brokerRequire(!registered && pi && typeof pi.registerTool === "function"
      && typeof pi.on === "function" && typeof pi.setActiveTools === "function", "pi-extension-api");
    registered = true;
    const owned = SCOPED_TOOL_DEFINITIONS.map(definition => Object.freeze({ name: definition.name, label: definition.name,
        description: `Bounded broker operation ${definition.name}.`, parameters: definition.inputSchema,
        async execute(_toolCallId, args, signal) {
          brokerRequire(!shuttingDown && !broker.status().ended, "pi-broker-unavailable");
          let aborted = false;
          const cancel = () => { aborted = true;
            if (!broker.status().cancelled && !broker.status().ended) broker.cancel(); };
          signal?.addEventListener("abort", cancel, { once: true });
          if (signal?.aborted) cancel();
          try {
            const result = await broker.invokeAsync(definition.name, args, nonce);
            brokerRequire(!aborted, "pi-tool-cancelled");
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          } finally { signal?.removeEventListener("abort", cancel); }
        }
      }));
    piOwnedTools.set(factory, Object.freeze(owned));
    for (const tool of owned) pi.registerTool(tool);
    const bind = () => { brokerRequire(!shuttingDown, "pi-broker-unavailable");
      pi.setActiveTools([...scopedToolNames]); assertSurface(pi); };
    pi.on("session_start", bind);
    pi.on("before_agent_start", () => { bind(); return undefined; });
    const finish = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        if (broker.status().inflightVerification) {
          if (!broker.status().cancelled) broker.cancel();
          await broker.reconcileVerification();
        }
      } finally { if (!broker.status().ended) broker.close(); }
    };
    pi.on("agent_end", finish);
    pi.on("session_shutdown", finish);
  };
  return factory;
}

/** Proves exact definition object/handler ownership in Pi's loaded registry. */
export function assertScopedBrokerPiOwnership(resourceLoader, extensionFactory) {
  const owned = piOwnedTools.get(extensionFactory), loaded = resourceLoader?.getExtensions?.();
  brokerRequire(owned?.length === SCOPED_TOOL_DEFINITIONS.length && Array.isArray(loaded?.extensions),
    "pi-tool-ownership-unavailable");
  const matches = [];
  for (const extension of loaded.extensions) for (const registered of extension.tools?.values?.() ?? [])
    if (scopedToolNames.includes(registered?.definition?.name)) matches.push(registered.definition);
  brokerRequire(matches.length === owned.length && matches.every((tool, index) => tool === owned[index]
    && tool.execute === owned[index].execute && JSON.stringify(tool.parameters) === JSON.stringify(SCOPED_TOOL_DEFINITIONS[index].inputSchema)),
  "pi-tool-ownership-mismatch");
  return Object.freeze({ names: [...scopedToolNames], toolDefinitionsSha256: scopedToolDefinitionsSha256(), handlersOwned: true });
}

export function loadScopedBrokerPiExtension({ configPath, createBroker } = {}) {
  const loaded = loadScopedBrokerFromConfig({ configPath, createBroker });
  return Object.freeze({ ...loaded, extensionFactory: createScopedBrokerPiExtension(loaded) });
}

/** MCP child over the common strict loader. */
export async function runScopedBrokerChild({ configPath, createBroker, input = process.stdin,
  output = process.stdout, signal } = {}) {
  const loaded = loadScopedBrokerFromConfig({ configPath, createBroker });
  return runScopedBrokerMcp({ ...loaded, input, output, signal });
}

/** Shared CLI shell used by the broker module so process and signal handling do
 * not enlarge its security kernel. Returns false when the module was imported. */
export async function runScopedBrokerCli(moduleUrl, runChild) {
  if (!process.argv[1] || path.resolve(process.argv[1]) !== fileURLToPath(moduleUrl)) return false;
  brokerRequire(typeof runChild === "function", "scoped-broker-invalid-launch");
  if (process.argv.length !== 4 || process.argv[2] !== "--serve-config") {
    process.stderr.write("scoped-broker-invalid-launch\n"); process.exitCode = 2;
  } else {
    const controller = new AbortController(), stop = () => controller.abort(MCP_PROCESS_SHUTDOWN);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    try {
      const result = await runChild(process.argv[3], { signal: controller.signal });
      if (!result.complete) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`${error.brokerCode ?? error.supervisorCode ?? "scoped-broker-failed"}\n`);
      process.exitCode = 1;
    } finally {
      process.off("SIGTERM", stop); process.off("SIGINT", stop);
    }
  }
  return true;
}
