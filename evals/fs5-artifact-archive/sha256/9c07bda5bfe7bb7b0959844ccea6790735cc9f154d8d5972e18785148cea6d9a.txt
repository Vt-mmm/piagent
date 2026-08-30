const phases = new Set(["intake", "plan", "execute", "verify", "review", "repair", "handoff"]);

function increment(record, key, amount = 1) {
  record[key] = (record[key] ?? 0) + amount;
}

function orderedRecord(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function toolClass(name) {
  const value = String(name ?? "").toLowerCase();
  if (value === "read") return "read";
  if (["grep", "find", "ls"].includes(value)) return "search";
  if (["edit", "write", "apply_patch"].includes(value)) return "mutation";
  if (["bash", "shell", "command", "exec", "execute"].includes(value)) return "shell";
  if (value.startsWith("piagent_")) return "piagent";
  return "other";
}

function resultFailed(event) {
  return event.isError === true || (event.exitCodeExact === true && Number(event.exitCode) !== 0);
}

/**
 * Project privacy-safe, phase-level choreography from local context telemetry.
 * It intentionally retains only closed phase/tool classes and aggregate counts;
 * commands, paths, model text, hashes and provider values never leave the
 * private workspace.
 */
export function benchmarkPhaseAttribution(events, decisionsComplete) {
  const calls = new Map();
  const blocked = new Set();
  const results = new Set();
  const promptsByPhase = {};
  const toolCallsByPhase = {};
  const transitions = {};
  let phase = "intake";
  let promptsObserved = 0;
  let toolResultsObserved = 0;
  let toolResultErrors = 0;
  let repeatedToolResults = 0;
  let compactedToolResults = 0;
  let outputCharsObserved = 0;

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    if (event.event === "trajectory_transition") {
      const from = phases.has(String(event.from)) ? String(event.from) : phase;
      const to = phases.has(String(event.to)) ? String(event.to) : "handoff";
      increment(transitions, `${from}->${to}`);
      phase = to;
      continue;
    }
    if (event.event === "agent_prompt") {
      promptsObserved += 1;
      increment(promptsByPhase, phase);
      continue;
    }
    if (event.event === "tool_call" && typeof event.toolCallId === "string" && event.toolCallId) {
      const category = toolClass(event.toolName);
      calls.set(event.toolCallId, { phase, category });
      toolCallsByPhase[phase] ??= {};
      increment(toolCallsByPhase[phase], category);
      continue;
    }
    if (event.event === "tool_decision" && event.decision === "blocked" && typeof event.toolCallId === "string") {
      blocked.add(event.toolCallId);
      continue;
    }
    if (event.event === "tool_result" && typeof event.toolCallId === "string" && event.toolCallId) {
      results.add(event.toolCallId);
      toolResultsObserved += 1;
      if (resultFailed(event)) toolResultErrors += 1;
      if (event.repeated === true) repeatedToolResults += 1;
      if (event.compacted === true) compactedToolResults += 1;
      if (Number.isFinite(event.outputChars) && event.outputChars >= 0) outputCharsObserved += Number(event.outputChars);
    }
  }

  const expectedResults = [...calls.keys()].filter((id) => !blocked.has(id));
  const available = decisionsComplete === true
    && promptsObserved > 0
    && expectedResults.every((id) => results.has(id))
    && [...results].every((id) => calls.has(id));
  return {
    schemaVersion: 1,
    available,
    promptsObserved,
    promptsByPhase: orderedRecord(promptsByPhase),
    toolCallsByPhase: Object.fromEntries(Object.entries(toolCallsByPhase)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, orderedRecord(value)])),
    transitions: orderedRecord(transitions),
    toolResultsObserved,
    toolResultErrors,
    repeatedToolResults,
    compactedToolResults,
    outputCharsObserved
  };
}
