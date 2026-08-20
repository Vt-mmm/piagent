const KINDS = new Set(["status", "scout", "compact", "abort"]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError(`${label} has unsupported fields`);
}

export function routeRuntimeCommand(input) {
  record(input, "command");
  exactKeys(input, ["idempotencyKey", "expectedRevision", "kind", "payload", "confirmed"], "command");
  if (!KINDS.has(input.kind)) throw new TypeError("unknown runtime command kind");
  const payload = record(input.payload, "payload");
  if (input.kind === "scout") {
    exactKeys(payload, ["objective"], "scout payload");
    if (typeof payload.objective !== "string" || !payload.objective.trim()) throw new TypeError("scout objective must be non-empty");
    const objective = payload.objective.trim().replace(/\s+/gu, " ");
    return { terminalCommand: `/scout ${objective}`, confirmationRequired: true, expectedModelCalls: "bounded", effect: "model" };
  }
  exactKeys(payload, [], `${input.kind} payload`);
  if (input.kind === "status") return { terminalCommand: "/status", confirmationRequired: false, expectedModelCalls: 0, effect: "read" };
  if (input.kind === "compact") return { terminalCommand: "/compact", confirmationRequired: true, expectedModelCalls: "bounded", effect: "semantic" };
  return { terminalCommand: "/abort", confirmationRequired: true, expectedModelCalls: 0, effect: "state" };
}
