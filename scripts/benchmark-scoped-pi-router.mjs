import { createHash } from "node:crypto";

import { SCOPED_TOOL_DEFINITIONS } from "./benchmark-scoped-verification-supervisor.mjs";

export const SCOPED_PI_OPERATION_ROUTER_VERSION = "scoped-pi-operation-router-v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,159}$/;
const toolNames = Object.freeze(SCOPED_TOOL_DEFINITIONS.map(tool => tool.name));
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { brokerCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };

function wireIdentity(value) {
  const names = ["sessionId", "operationRef", "messageRequestId", "inputText"];
  requireThat(value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name))
    && [value.sessionId, value.operationRef, value.messageRequestId].every(item => typeof item === "string" && ID.test(item))
    && typeof value.inputText === "string" && value.inputText.length > 0 && value.inputText.isWellFormed()
    && Buffer.byteLength(value.inputText) <= 64 * 1024, "pi-router-operation-identity");
  return Object.freeze({ ...value, inputSha256: hash(value.inputText) });
}

function loadedBroker(value, expected) {
  requireThat(value && typeof value === "object" && value.broker && typeof value.broker.invokeAsync === "function"
    && typeof value.broker.status === "function" && typeof value.broker.close === "function"
    && typeof value.settlementEvidence === "function"
    && (value.assertProviderDispatchReady === undefined
      || typeof value.assertProviderDispatchReady === "function")
    && (value.dispose === undefined || typeof value.dispose === "function")
    && value.identity && value.nonce === value.identity.nonce
    && value.identity.sessionId === expected.sessionId && value.identity.operationId === expected.operationRef
    && value.identity.nonce === expected.messageRequestId, "pi-router-broker-identity");
  return value;
}

/** Host-only capability router. Operation labels and extension events are data;
 * open() must independently validate the current task and create fresh custody. */
export function createScopedBrokerPiOperationRouter({ open } = {}) {
  requireThat(typeof open === "function", "pi-router-open-required");
  let registered = false, shuttingDown = false, pending = null, active = null, completed = null;
  let consumed = true, tools = null, boundaryFailure = null;
  const assertSurface = pi => {
    const names = pi.getActiveTools?.().map(tool => typeof tool === "string" ? tool : tool?.name)
      ?? pi.getActiveToolNames?.();
    if (names !== undefined) requireThat(JSON.stringify(names) === JSON.stringify(toolNames),
      "pi-router-tool-surface");
  };
  const closeActive = async (reason = "agent-end") => {
    if (!active) return;
    const current = active; active = null;
    try {
      if (current.loaded.broker.status().inflightVerification) {
        if (!current.loaded.broker.status().cancelled) current.loaded.broker.cancel();
        await current.loaded.broker.reconcileVerification();
      }
    } finally {
      try {
        if (!current.loaded.broker.status().ended) current.loaded.broker.close();
      } finally {
        try { await current.loaded.dispose?.(); }
        finally { completed = Object.freeze({ ...current, reason }); consumed = false; }
      }
    }
  };
  const extensionFactory = function scopedBrokerPiOperationExtension(pi) {
    requireThat(!registered && pi && typeof pi.registerTool === "function" && typeof pi.on === "function"
      && typeof pi.setActiveTools === "function", "pi-router-extension-api");
    registered = true;
    tools = Object.freeze(SCOPED_TOOL_DEFINITIONS.map(definition => Object.freeze({ name: definition.name,
      label: definition.name, description: `Bounded broker operation ${definition.name}.`,
      parameters: definition.inputSchema, async execute(_callId, args, signal) {
        requireThat(!shuttingDown && active && !active.loaded.broker.status().ended,
          "pi-router-broker-unavailable");
        let aborted = false;
        const cancel = () => { aborted = true; const broker = active?.loaded.broker;
          if (broker && !broker.status().cancelled && !broker.status().ended) broker.cancel(); };
        signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
        try {
          const result = await active.loaded.broker.invokeAsync(definition.name, args, active.loaded.nonce);
          requireThat(!aborted, "pi-router-tool-cancelled");
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        } finally { signal?.removeEventListener("abort", cancel); }
      }
    })));
    for (const tool of tools) pi.registerTool(tool);
    const bind = () => { requireThat(!shuttingDown, "pi-router-unavailable");
      pi.setActiveTools([...toolNames]); assertSurface(pi); };
    pi.on("session_start", bind);
    pi.on("before_agent_start", async (_event, ctx) => {
      requireThat(pending && !active && (consumed || completed === null), "pi-router-operation-missing");
      const sessionId = ctx?.sessionManager?.getSessionId?.();
      requireThat(sessionId === pending.sessionId, "pi-router-session-mismatch");
      const reservation = pending; pending = null;
      let loaded;
      try { loaded = loadedBroker(await open(reservation, ctx), reservation); }
      catch (error) {
        const fatalProviderBoundaryError = error instanceof Error ? error : new Error(String(error));
        boundaryFailure = Object.freeze({ reservation, error: fatalProviderBoundaryError });
        completed = Object.freeze({ reservation, loaded: null, reason: "open-failed",
          fatalProviderBoundaryError });
        consumed = false; shuttingDown = true; throw error;
      }
      active = Object.freeze({ reservation, loaded }); bind();
    });
    pi.on("agent_end", () => closeActive("agent-end"));
    pi.on("session_shutdown", async () => { shuttingDown = true; await closeActive("session-shutdown"); });
  };
  return Object.freeze({
    version: SCOPED_PI_OPERATION_ROUTER_VERSION,
    authority: "none",
    toolNames,
    extensionFactory,
    beginOperation(value) {
      requireThat(!shuttingDown && registered && !pending && !active && (consumed || completed === null),
        "pi-router-operation-reuse");
      const reservation = wireIdentity(value); pending = reservation;
      let finished = false;
      return reason => {
        if (finished) return; finished = true;
        requireThat(typeof reason === "string" && reason.length > 0, "pi-router-finish-reason");
        if (pending === reservation) { pending = null; completed = Object.freeze({ reservation,
          loaded: null, reason }); consumed = false; return; }
        if (active?.reservation === reservation) {
          if (reason !== "operation-settled" && !active.loaded.broker.status().cancelled
            && !active.loaded.broker.status().ended) active.loaded.broker.cancel();
          void closeActive(reason); return;
        }
        if (completed?.reservation !== reservation) fail("pi-router-operation-continuity");
        completed = Object.freeze({ ...completed, reason });
      };
    },
    settlementEvidence() {
      requireThat(completed?.loaded && !consumed && completed.reason === "operation-settled",
        "pi-router-settlement-unavailable");
      requireThat(boundaryFailure?.reservation !== completed.reservation,
        "pi-router-settlement-boundary-failed");
      const evidence = completed.loaded.settlementEvidence(); consumed = true;
      return evidence;
    },
    discardUnusedSettlement(identity) {
      requireThat(identity && Object.keys(identity).length === 3
        && ["sessionId", "operationRef", "messageRequestId"].every(name =>
          typeof identity[name] === "string" && ID.test(identity[name])
          && identity[name] === completed?.reservation[name]), "pi-router-retirement-identity");
      requireThat(!shuttingDown && !pending && !active && completed?.loaded
        && completed.reason === "operation-settled" && !boundaryFailure,
        "pi-router-retirement-unavailable");
      if (consumed) return;
      const status = completed.loaded.broker.status();
      requireThat(status.ended && !status.cancelled && !status.blocked
        && status.inflightVerification === null, "pi-router-retirement-incomplete");
      // Validate closed custody, then discard it without publishing acceptance facts.
      completed.loaded.settlementEvidence(); consumed = true;
    },
    assertProviderDispatchReady() {
      if (boundaryFailure) throw boundaryFailure.error;
      requireThat(!shuttingDown && active && !active.loaded.broker.status().ended,
        "pi-router-provider-boundary-unavailable");
      try {
        const asserted = active.loaded.assertProviderDispatchReady?.();
        requireThat(asserted === undefined || asserted === true, "pi-router-provider-boundary-async");
      }
      catch (error) {
        const fatalProviderBoundaryError = error instanceof Error ? error : new Error(String(error));
        boundaryFailure = Object.freeze({ reservation: active.reservation,
          error: fatalProviderBoundaryError });
        shuttingDown = true;
        throw error;
      }
      return true;
    },
    takeFatalProviderBoundaryError() {
      if (!completed || !boundaryFailure || consumed || completed.reason !== "operation-settled"
        || completed.reservation !== boundaryFailure.reservation) return null;
      const error = boundaryFailure.error; boundaryFailure = null;
      consumed = true;
      return error;
    },
    assertOwnership(resourceLoader) {
      const loaded = resourceLoader?.getExtensions?.(), matches = [];
      requireThat(tools && Array.isArray(loaded?.extensions), "pi-router-ownership-unavailable");
      for (const extension of loaded.extensions) for (const registeredTool of extension.tools?.values?.() ?? [])
        if (toolNames.includes(registeredTool?.definition?.name)) matches.push(registeredTool.definition);
      requireThat(matches.length === tools.length && matches.every((tool, index) => tool === tools[index]
        && tool.execute === tools[index].execute), "pi-router-ownership-mismatch");
      return Object.freeze({ names: [...toolNames], toolDefinitionsSha256: hash(JSON.stringify(SCOPED_TOOL_DEFINITIONS)),
        handlersOwned: true });
    },
    async dispose() { shuttingDown = true;
      if (active && !active.loaded.broker.status().cancelled && !active.loaded.broker.status().ended)
        active.loaded.broker.cancel();
      await closeActive("router-dispose"); pending = null;
    },
    status() { return Object.freeze({ registered, pending: Boolean(pending), active: Boolean(active),
      completed: Boolean(completed), consumed, shuttingDown }); }
  });
}
