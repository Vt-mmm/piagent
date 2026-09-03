import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { types } from "node:util";

import { SCOPED_CODEX_TURN_OBSERVATION_VERSION, SCOPED_MCP_LIMITS,
  SCOPED_MCP_METADATA_CONTRACT, SCOPED_TOOL_DEFINITIONS
} from "./benchmark-scoped-frozen-qualification.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const plain = value => Boolean(value && typeof value === "object" && !types.isProxy(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value)));
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
const brokerFail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const brokerRequire = (value, code) => { if (!value) brokerFail(code); };
const brokerWellFormed = value => typeof value === "string" && value.isWellFormed();
function brokerFields(value, names) {
  brokerRequire(plain(value), "invalid-object");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  brokerRequire(Reflect.ownKeys(descriptors).length === names.length && names.every(name =>
    descriptors[name]?.enumerable && Object.hasOwn(descriptors[name], "value")), "invalid-fields");
}
const MCP_VERSION = "2025-06-18";
const MCP_PROCESS_SHUTDOWN = "piagent-mcp-process-shutdown";
const MCP_META_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const MCP_TURN_FIELDS = SCOPED_MCP_METADATA_CONTRACT.turnFields;
const MCP_TURN_REQUIRED_FIELDS = Object.freeze(MCP_TURN_FIELDS.filter(key => key !== "reasoning_effort"));
const MCP_CALL_META_FIELDS = SCOPED_MCP_METADATA_CONTRACT.callFields;
const rpcId = value => Number.isSafeInteger(value) || typeof value === "string" && value.length > 0
  && value.length <= 160 && brokerWellFormed(value);
const rpcError = (requestId, code, message) => ({ jsonrpc: "2.0", id: requestId,
  error: { code, message } });

// The broker kernel registers a private journal append capability here. This
// keeps protocol transport and child loading outside the auditable kernel while
// preserving an in-process-only capability: it is never serialized to Codex.
const brokerPorts = new WeakMap();

export function registerScopedBrokerTransport(broker, append, seal) {
  brokerRequire(broker && typeof broker === "object" && typeof broker.status === "function"
    && typeof append === "function" && typeof seal === "function" && !brokerPorts.has(broker),
  "mcp-broker-binding");
  brokerPorts.set(broker, { append, seal, used: false });
}

function mcpMetaExact(value, allowed, required = []) {
  brokerRequire(plain(value), "mcp-invalid-metadata");
  const keys = Object.keys(value);
  brokerRequire(keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)),
    "mcp-invalid-metadata");
}
const mcpMetaId = value => typeof value === "string" && MCP_META_ID.test(value) && brokerWellFormed(value);
const mcpMetaText = (value, maxBytes = 2048) => typeof value === "string" && value.length > 0
  && Buffer.byteLength(value) <= maxBytes && brokerWellFormed(value);
function validateMcpWorkspaces(value) {
  brokerRequire(plain(value), "mcp-invalid-metadata");
  const entries = Object.entries(value);
  brokerRequire(entries.length > 0 && entries.length <= 16, "mcp-invalid-metadata");
  for (const [workspace, state] of entries) {
    brokerRequire(mcpMetaText(workspace) && path.isAbsolute(workspace) && path.normalize(workspace) === workspace,
      "mcp-invalid-metadata");
    mcpMetaExact(state, ["has_changes"], ["has_changes"]);
    brokerRequire(typeof state.has_changes === "boolean", "mcp-invalid-metadata");
  }
}
function validateMcpTurnMetadata(value) {
  mcpMetaExact(value, MCP_TURN_FIELDS, MCP_TURN_REQUIRED_FIELDS);
  for (const key of ["session_id", "thread_id", "turn_id", "model"]) {
    brokerRequire(mcpMetaId(value[key]), "mcp-invalid-metadata");
  }
  brokerRequire(Number.isSafeInteger(value.turn_started_at_unix_ms) && value.turn_started_at_unix_ms >= 0
    && value.thread_source === "user" && mcpMetaText(value.sandbox, 80)
    && value.sandbox_mode === "workspace-write"
    && typeof value.node_repl_disabled === "boolean" && typeof value.auto_review_enabled === "boolean"
    && typeof value.node_repl_auto_review_required === "boolean", "mcp-invalid-metadata");
  validateMcpWorkspaces(value.workspaces);
  if (Object.hasOwn(value, "reasoning_effort")) brokerRequire(typeof value.reasoning_effort === "string"
    && ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value.reasoning_effort),
  "mcp-invalid-metadata");
}
function validateMcpSpecialPath(value) {
  mcpMetaExact(value, ["kind", "subpath"]);
  brokerRequire(["root", "minimal", "project_roots", "tmpdir", "slash_tmp"].includes(value.kind),
    "mcp-invalid-metadata");
  if (value.kind === "project_roots") {
    if (Object.hasOwn(value, "subpath")) brokerRequire(mcpMetaText(value.subpath, 1024), "mcp-invalid-metadata");
  } else brokerRequire(!Object.hasOwn(value, "subpath"), "mcp-invalid-metadata");
}
function validateMcpSandboxPath(value) {
  brokerRequire(plain(value) && ["path", "glob_pattern", "special"].includes(value.type),
    "mcp-invalid-metadata");
  if (value.type === "path") {
    mcpMetaExact(value, ["type", "path"], ["type", "path"]);
    brokerRequire(mcpMetaText(value.path), "mcp-invalid-metadata");
  } else if (value.type === "glob_pattern") {
    mcpMetaExact(value, ["type", "pattern"], ["type", "pattern"]);
    brokerRequire(mcpMetaText(value.pattern), "mcp-invalid-metadata");
  } else {
    mcpMetaExact(value, ["type", "value"], ["type", "value"]); validateMcpSpecialPath(value.value);
  }
}
function validateMcpFileSystemPermissions(value) {
  brokerRequire(plain(value) && ["restricted", "unrestricted"].includes(value.type), "mcp-invalid-metadata");
  if (value.type === "unrestricted") return mcpMetaExact(value, ["type"], ["type"]);
  mcpMetaExact(value, ["type", "entries", "glob_scan_max_depth"], ["type", "entries"]);
  brokerRequire(Array.isArray(value.entries) && value.entries.length <= 64, "mcp-invalid-metadata");
  if (Object.hasOwn(value, "glob_scan_max_depth")) brokerRequire(Number.isSafeInteger(value.glob_scan_max_depth)
    && value.glob_scan_max_depth > 0 && value.glob_scan_max_depth <= 64, "mcp-invalid-metadata");
  for (const entry of value.entries) {
    mcpMetaExact(entry, ["path", "access", "missing_path_behavior"], ["path", "access"]);
    validateMcpSandboxPath(entry.path);
    brokerRequire(["read", "write", "deny"].includes(entry.access), "mcp-invalid-metadata");
    if (Object.hasOwn(entry, "missing_path_behavior")) brokerRequire(entry.missing_path_behavior === "skip",
      "mcp-invalid-metadata");
  }
}
function validateMcpPermissionProfile(value) {
  brokerRequire(plain(value) && ["managed", "disabled", "external"].includes(value.type),
    "mcp-invalid-metadata");
  if (value.type === "disabled") return mcpMetaExact(value, ["type"], ["type"]);
  if (value.type === "external") {
    mcpMetaExact(value, ["type", "network"], ["type", "network"]);
  } else {
    mcpMetaExact(value, ["type", "file_system", "network"], ["type", "file_system", "network"]);
    validateMcpFileSystemPermissions(value.file_system);
  }
  brokerRequire(["restricted", "enabled"].includes(value.network), "mcp-invalid-metadata");
}
function validateMcpSandboxState(value) {
  mcpMetaExact(value, ["permissionProfile", "codexLinuxSandboxExe", "sandboxCwd", "useLegacyLandlock"],
    ["permissionProfile", "codexLinuxSandboxExe", "sandboxCwd", "useLegacyLandlock"]);
  validateMcpPermissionProfile(value.permissionProfile);
  brokerRequire((value.codexLinuxSandboxExe === null || typeof value.codexLinuxSandboxExe === "string"
    && path.isAbsolute(value.codexLinuxSandboxExe) && path.normalize(value.codexLinuxSandboxExe) === value.codexLinuxSandboxExe
    && Buffer.byteLength(value.codexLinuxSandboxExe) <= 2048 && brokerWellFormed(value.codexLinuxSandboxExe))
    && mcpMetaText(value.sandboxCwd) && value.sandboxCwd.startsWith("file:")
    && typeof value.useLegacyLandlock === "boolean", "mcp-invalid-metadata");
}
function mcpBusinessParams(params, method) {
  if (!params || !Object.hasOwn(params, "_meta")) return { business: params, observation: null };
  const metadata = params._meta;
  const allowed = method === "tools/call" ? MCP_CALL_META_FIELDS : ["progressToken"];
  mcpMetaExact(metadata, allowed);
  brokerRequire(Buffer.byteLength(JSON.stringify(metadata)) <= SCOPED_MCP_METADATA_CONTRACT.maxBytes,
    "mcp-invalid-metadata");
  if (Object.hasOwn(metadata, "progressToken")) {
    const token = metadata.progressToken;
    brokerRequire(Number.isSafeInteger(token) || brokerWellFormed(token)
      && Buffer.byteLength(token) <= 160, "mcp-invalid-metadata");
  }
  const codexFields = ["callId", "threadId", "itemId", "x-codex-turn-metadata", "codex/sandbox-state-meta"];
  const hasCodexFields = codexFields.some(key => Object.hasOwn(metadata, key));
  let observation = null;
  if (hasCodexFields) {
    brokerRequire(method === "tools/call" && ["callId", "threadId", "itemId", "x-codex-turn-metadata"]
      .every(key => Object.hasOwn(metadata, key)) && [metadata.callId, metadata.threadId, metadata.itemId].every(mcpMetaId),
    "mcp-invalid-metadata");
    validateMcpTurnMetadata(metadata["x-codex-turn-metadata"]);
    brokerRequire(metadata.threadId === metadata["x-codex-turn-metadata"].thread_id,
      "mcp-invalid-metadata");
    if (Object.hasOwn(metadata, "codex/sandbox-state-meta")) validateMcpSandboxState(metadata["codex/sandbox-state-meta"]);
    const turn = metadata["x-codex-turn-metadata"];
    observation = deepFreeze({ version: SCOPED_CODEX_TURN_OBSERVATION_VERSION,
      contractId: SCOPED_MCP_METADATA_CONTRACT.id, authority: "none",
      metadataSha256: hash(JSON.stringify(metadata)), callId: metadata.callId,
      threadId: metadata.threadId, itemId: metadata.itemId, sessionId: turn.session_id,
      turnId: turn.turn_id, turnStartedAtUnixMs: turn.turn_started_at_unix_ms,
      model: turn.model, reasoningEffort: turn.reasoning_effort ?? null,
      sandboxMode: turn.sandbox_mode,
      sandboxStateSha256: Object.hasOwn(metadata, "codex/sandbox-state-meta")
        ? hash(JSON.stringify(metadata["codex/sandbox-state-meta"])) : null });
  }
  const business = { ...params }; delete business._meta;
  return { business, observation };
}

function parseMcpFrame(bytes) {
  let text, value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text, (key, item) => {
      brokerRequire(brokerWellFormed(key) && (typeof item !== "string" || brokerWellFormed(item))
        && (typeof item !== "number" || Number.isFinite(item)), "mcp-invalid-json");
      return item;
    });
  } catch { brokerFail("mcp-invalid-json"); }
  const stack = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)) {
    const token = match[0], current = stack.at(-1);
    if (token === "{") stack.push({ keys: new Set(), key: true });
    else if (token === "[") stack.push({ keys: null });
    else if (token === "}" || token === "]") stack.pop();
    else if (current?.keys && token === ",") current.key = true;
    else if (current?.keys && token === ":") current.key = false;
    else if (current?.keys && current.key && token.startsWith('"')) {
      const key = JSON.parse(token);
      brokerRequire(!current.keys.has(key), "mcp-duplicate-json-key"); current.keys.add(key);
    }
    brokerRequire(stack.length <= 16, "mcp-json-depth");
  }
  brokerRequire(value && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0"
    && typeof value.method === "string" && value.method.length <= 160
    && Object.keys(value).every(key => ["jsonrpc", "id", "method", "params"].includes(key))
    && (!Object.hasOwn(value, "params") || value.params && typeof value.params === "object"
      && !Array.isArray(value.params))
    && (!Object.hasOwn(value, "id") || rpcId(value.id)), "mcp-invalid-request");
  return value;
}

/** Bounded byte-stream MCP adapter. It receives a broker object and opaque
 * journal capability, never host verifier plans, source, Docker, or signing key. */
export async function runScopedBrokerMcp({ broker, input, output, nonce, signal,
  limits = SCOPED_MCP_LIMITS }) {
  const port = brokerPorts.get(broker);
  brokerRequire(port && !port.used && !broker.status().ended && nonce === broker.identity.nonce,
    "mcp-broker-binding");
  brokerFields(limits, Object.keys(SCOPED_MCP_LIMITS));
  for (const key of Object.keys(limits)) brokerRequire(Number.isSafeInteger(limits[key])
    && limits[key] > 0 && limits[key] <= SCOPED_MCP_LIMITS[key], "mcp-invalid-limit");
  limits = { ...limits };
  brokerRequire(input !== output && typeof input?.[Symbol.asyncIterator] === "function"
    && typeof input.destroy === "function" && typeof output?.write === "function"
    && typeof output.end === "function" && typeof output.destroy === "function"
    && !input.readableObjectMode && !output.writableObjectMode, "mcp-byte-streams-required");
  port.used = true;
  const transportId = randomUUID(), seenIds = new Set(), deadline = Date.now() + limits.timeoutMs;
  let phase = "new", frames = 0, outputFrames = 0, inputBytes = 0, outputBytes = 0;
  let buffer = Buffer.alloc(0), failure = null, recorded = true, rejectStop, inflight = null;
  let queuedSends = 0, terminalized = false, outputEnded = false;
  const decidedFrames = new Set(), writtenOutputFrames = new Set();
  const pending = new Set();
  const stopped = new Promise((_, reject) => { rejectStop = reject; }); stopped.catch(() => {});
  const stop = reason => {
    if (!failure) { failure = reason; rejectStop(Object.assign(new Error(reason), { brokerCode: reason })); }
  };
  const check = () => {
    if (Date.now() >= deadline) stop("mcp-timeout");
    brokerRequire(!failure, failure);
  };
  const onError = () => { if (!terminalized) stop("mcp-stream-error"); };
  const timer = setTimeout(() => stop("mcp-timeout"), limits.timeoutMs);
  input.on("error", onError); output.on("error", onError);
  input.once("close", () => input.off("error", onError));
  output.once("close", () => output.off("error", onError));
  const audit = event => {
    try { port.append({ transportId, ...event }); }
    catch (error) { recorded = false; throw error; }
  };
  // A deferred call has two promise-finally bookkeeping steps after its reply,
  // transport-write, and transport-decision are already durable. Codex can
  // close stdin and terminate the process group in that narrow gap. Treat the
  // transport as settled once every accepted frame has a durable decision,
  // every emitted frame has a durable write record, and the broker has no
  // actual verifier work left. Stale local promise references carry no more
  // journal or output work and must not prevent normal shutdown sealing.
  const transportSettled = () => phase === "ready" && buffer.length === 0
    && decidedFrames.size === frames && writtenOutputFrames.size === outputFrames
    && !broker.status().inflightVerification
    && (typeof input.readableLength !== "number" || input.readableLength === 0);
  const quiescent = () => transportSettled() && !inflight && pending.size === 0 && queuedSends === 0;
  const closeOutput = () => {
    if (outputEnded) return;
    outputEnded = true; output.end();
  };
  const sealTransport = () => {
    if (terminalized) return true;
    try {
      port.seal({ transportId, type: "transport-end", complete: !failure, reason: failure,
        frames, outputFrames, inputBytes, outputBytes, phase });
    } catch { recorded = false; failure ??= "journal-unavailable"; }
    terminalized = true;
    return broker.status().ended;
  };
  const finalizeSettled = () => {
    if (terminalized) return true;
    if (!transportSettled()) return false;
    sealTransport();
    try { closeOutput(); }
    catch { recorded = false; failure ??= "mcp-stream-error"; }
    return true;
  };
  const finalizeQuiescent = () => quiescent() && finalizeSettled();
  const shutdownError = () => Object.assign(new Error(MCP_PROCESS_SHUTDOWN),
    { brokerCode: MCP_PROCESS_SHUTDOWN });
  const onInputEnd = () => { if (!failure) finalizeSettled(); };
  const onAbort = () => {
    if (signal?.reason === MCP_PROCESS_SHUTDOWN && transportSettled()) {
      finalizeSettled(); rejectStop(shutdownError());
    } else stop("mcp-cancelled");
    // Promise.race stops the main loop; destroying the stream also releases
    // the losing iterator.next() so no stdin handle can hold the child open
    // until Codex's two-second SIGKILL escalation.
    if (!input.destroyed) input.destroy(signal?.reason === MCP_PROCESS_SHUTDOWN
      ? shutdownError() : Object.assign(new Error("mcp-cancelled"), { brokerCode: "mcp-cancelled" }));
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  input.once("end", onInputEnd);
  const wait = promise => Promise.race([promise, stopped]);
  async function send(reply) {
    check(); const bytes = Buffer.from(JSON.stringify(reply) + "\n");
    brokerRequire(bytes.length <= limits.frameBytes && outputBytes + bytes.length <= limits.outputBytes,
      "mcp-output-limit");
    const frame = ++outputFrames, sha256 = hash(bytes); outputBytes += bytes.length;
    audit({ type: "transport-frame", direction: "out", frame, sha256, bytes: bytes.length,
      state: "prepared" });
    await wait(new Promise((resolve, reject) =>
      output.write(bytes, error => error ? reject(error) : resolve())));
    check(); audit({ type: "transport-write", frame, sha256, state: "write-callback" });
    writtenOutputFrames.add(frame);
  }
  let sendChain = Promise.resolve();
  const queueSend = reply => {
    queuedSends++;
    const sending = sendChain.then(() => send(reply)).finally(() => { queuedSends--; });
    sendChain = sending.catch(() => {}); return sending;
  };
  function dispatch(request) {
    const requestId = Object.hasOwn(request, "id") ? request.id : null;
    const error = (code, message) => requestId === null ? null : rpcError(requestId, code, message);
    if (requestId !== null) {
      brokerRequire(!seenIds.has(requestId), "mcp-duplicate-id"); seenIds.add(requestId);
    }
    if (request.method === "notifications/initialized") {
      brokerRequire(requestId === null && phase === "initializing"
        && (!request.params || Object.keys(request.params).length === 0), "mcp-ready-order");
      phase = "ready"; return null;
    }
    if (request.method === "notifications/cancelled") {
      brokerRequire(phase === "ready" && requestId === null, "mcp-cancel-shape");
      const target = rpcId(request.params?.requestId) ? request.params.requestId : null;
      if (inflight && target === inflight.requestId) {
        if (!broker.status().cancelled) broker.cancel();
        audit({ type: "transport-cancellation", requestId: target, outcome: "signalled",
          reason: "inflight-verification" });
      } else audit({ type: "transport-cancellation", requestId: target, outcome: "ignored",
        reason: "no-matching-inflight-request" });
      return null;
    }
    brokerRequire(requestId !== null, "mcp-unsupported-notification");
    const decoded = mcpBusinessParams(request.params, request.method);
    request = { ...request, params: decoded.business };
    if (decoded.observation) audit({ type: "transport-observation", requestId,
      observation: decoded.observation });
    if (request.method === "initialize") {
      brokerRequire(phase === "new", "mcp-initialize-order");
      brokerFields(request.params, ["protocolVersion", "capabilities", "clientInfo"]);
      const info = request.params.clientInfo;
      brokerRequire(typeof request.params.protocolVersion === "string"
        && /^\d{4}-\d{2}-\d{2}$/.test(request.params.protocolVersion)
        && request.params.capabilities && typeof request.params.capabilities === "object"
        && !Array.isArray(request.params.capabilities) && info && typeof info.name === "string"
        && info.name.length <= 160 && typeof info.version === "string" && info.version.length <= 160
        && Object.keys(info).every(key => ["name", "version", "title"].includes(key)),
      "mcp-initialize-parameters");
      phase = "initializing";
      return { jsonrpc: "2.0", id: requestId, result: { protocolVersion: MCP_VERSION,
        capabilities: { tools: {} }, serverInfo: { name: "piagent-scoped-broker", version: "1" } } };
    }
    brokerRequire(phase === "ready", "mcp-not-ready");
    if (inflight) return error(-32001, "request-inflight");
    if (request.method === "ping" || request.method === "tools/list") {
      if (request.params !== undefined) brokerFields(request.params, []);
      return { jsonrpc: "2.0", id: requestId,
        result: request.method === "ping" ? {} : { tools: SCOPED_TOOL_DEFINITIONS } };
    }
    if (request.method !== "tools/call") return error(-32601, "method-not-found");
    try { brokerFields(request.params, ["name", "arguments"]); }
    catch {
      try { broker.invoke(request.params?.name, null, nonce); }
      catch { /* The kernel records this invalid call. */ }
      brokerRequire(!broker.status().blocked, "journal-unavailable");
      return error(-32602, "invalid-tool-parameters");
    }
    const present = result => {
      brokerRequire(!result.lines || result.lines.length <= 256, "mcp-output-record-limit");
      return { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text",
        text: JSON.stringify(result) }], structuredContent: result, isError: false } };
    };
    const denied = errorValue => {
      brokerRequire(!broker.status().blocked && errorValue.brokerCode !== "mcp-output-record-limit",
        errorValue.brokerCode ?? "mcp-kernel-error");
      if (["tool-denied", "invalid-fields", "invalid-object", "invalid-argument", "invalid-tool",
        "invalid-id"].includes(errorValue.brokerCode)) return error(-32602, "invalid-tool-or-arguments");
      return { jsonrpc: "2.0", id: requestId, result: { isError: true,
        content: [{ type: "text", text: errorValue.brokerCode ?? "operation-error" }] } };
    };
    if (request.params.name === "scoped_verify" && broker.status().verificationAvailable) {
      return { deferred: broker.invokeAsync(request.params.name, request.params.arguments, nonce)
        .then(present, denied), requestId, method: request.method };
    }
    try { return present(broker.invoke(request.params.name, request.params.arguments, nonce)); }
    catch (errorValue) { return denied(errorValue); }
  }
  try {
    audit({ type: "transport-begin", protocolVersion: MCP_VERSION,
      toolsSha256: hash(JSON.stringify(SCOPED_TOOL_DEFINITIONS)), limits });
    if (signal?.aborted) stop("mcp-cancelled");
    const iterator = input[Symbol.asyncIterator]();
    for (;;) {
      check(); const next = await wait(iterator.next()); if (next.done) break;
      brokerRequire(Buffer.isBuffer(next.value), "mcp-nonbyte-input"); inputBytes += next.value.length;
      brokerRequire(inputBytes <= limits.inputBytes, "mcp-input-limit");
      buffer = Buffer.concat([buffer, next.value]);
      for (let index; (index = buffer.indexOf(10)) >= 0;) {
        check(); const frame = buffer.subarray(0, index + 1); buffer = buffer.subarray(index + 1); frames++;
        audit({ type: "transport-frame", direction: "in", frame: frames, sha256: hash(frame),
          bytes: frame.length });
        brokerRequire(frame.length <= limits.frameBytes && frames <= limits.frames, "mcp-frame-limit");
        let request, reply;
        try { request = parseMcpFrame(frame.subarray(0, -1)); reply = dispatch(request); }
        catch (error) {
          audit({ type: "transport-decision", frame: frames, requestId: request?.id ?? null,
            method: request?.method ?? null, outcome: "denied",
            reason: error.brokerCode ?? "mcp-invalid-request" });
          decidedFrames.add(frames);
          if (recorded && !broker.status().blocked && (!request || Object.hasOwn(request, "id"))
            && error.brokerCode !== "mcp-cancelled") {
            const code = !request ? (error.brokerCode === "mcp-invalid-json" ? -32700 : -32600)
              : error.brokerCode === "mcp-not-ready" ? -32002 : -32602;
            await send(rpcError(request?.id ?? null, code, "request-rejected"));
          }
          throw error;
        }
        if (reply?.deferred) {
          const active = { requestId: reply.requestId, method: reply.method, frame: frames, promise: null };
          inflight = active;
          active.promise = reply.deferred.then(async deferredReply => {
            await queueSend(deferredReply);
            audit({ type: "transport-decision", frame: active.frame, requestId: active.requestId,
              method: active.method, outcome: deferredReply?.error || deferredReply?.result?.isError
                ? "denied" : "processed" });
            decidedFrames.add(active.frame);
          }).catch(error => { stop(error.brokerCode ?? "mcp-kernel-error"); }).finally(() => {
            if (inflight === active) inflight = null;
          });
          pending.add(active.promise); active.promise.finally(() => pending.delete(active.promise));
        } else {
          if (reply) await queueSend(reply);
          audit({ type: "transport-decision", frame: frames, requestId: request.id ?? null,
            method: request.method, outcome: reply?.error || reply?.result?.isError ? "denied" : "processed" });
          decidedFrames.add(frames);
        }
      }
      brokerRequire(buffer.length <= limits.frameBytes, "mcp-frame-limit");
    }
    brokerRequire(buffer.length === 0 && phase === "ready", "mcp-incomplete-stream");
    if (pending.size) await wait(Promise.all([...pending]));
    await wait(sendChain);
    brokerRequire(finalizeQuiescent(), "mcp-incomplete-stream");
    check();
  } catch (error) {
    if (error.brokerCode !== MCP_PROCESS_SHUTDOWN) stop(error.brokerCode ?? "mcp-stream-error");
  }
  finally {
    clearTimeout(timer); signal?.removeEventListener("abort", onAbort); input.off("end", onInputEnd);
    try {
      if (buffer.length) audit({ type: "transport-tail", bytes: buffer.length, sha256: hash(buffer) });
      if (failure && !broker.status().blocked && !broker.status().cancelled) broker.cancel();
      if (broker.status().inflightVerification) {
        broker.cancelVerification(); await broker.reconcileVerification();
      }
      if (pending.size) await Promise.allSettled([...pending]);
      await sendChain;
      if (!terminalized) sealTransport();
    } catch { recorded = false; failure ??= "journal-unavailable"; }
    terminalized = true; input.destroy();
    if (failure) output.destroy();
    else {
      try { closeOutput(); }
      catch { recorded = false; failure ??= "mcp-stream-error"; }
    }
  }
  const status = broker.status();
  return Object.freeze({ complete: !failure && recorded, recorded, reason: failure, frames, outputFrames,
    inputBytes, outputBytes, g0Qualified: false, verificationAvailable: status.verificationAvailable });
}
