const LEGACY_PROJECT_INSTRUCTIONS_START = "Before implementation:\n\n1. Load `.pi/piagent-profile.json` with `piagent_context`.";
const LEGACY_PROJECT_INSTRUCTIONS_END = "18. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns, review loops, native supervisor coordination, and safety boundaries.";
const RUNTIME_MANAGED_PROJECT_INSTRUCTIONS = [
  "Piagent runtime-managed task flow:",
  "1. Runtime creates the task contract automatically for a bounded source-changing request before the model starts.",
  "2. Only when runtime intake pauses for broad, high-risk, or ambiguous scope, call `piagent_task_start` exactly once with project-relative path/glob scope; reuse an active contract.",
  "3. Read the narrow target and nearest relevant test, then use ordinary read/edit/bash tools.",
  "4. Run every exact runtime-provided verifier after the latest mutation. Automatic tasks need no management calls.",
  "5. Runtime hooks enforce policy and record context, changes, current-tree verification, trace and final gate. Diagnostic groups appear only for explicit requests or manual high-risk checkpoints."
].join("\n");

export function rewriteLegacyProjectInstructions(systemPrompt: string): {
  systemPrompt: string;
  rewritten: boolean;
} {
  const start = systemPrompt.indexOf(LEGACY_PROJECT_INSTRUCTIONS_START);
  if (start < 0) return { systemPrompt, rewritten: false };
  const endStart = systemPrompt.indexOf(LEGACY_PROJECT_INSTRUCTIONS_END, start);
  if (endStart < 0) return { systemPrompt, rewritten: false };
  const end = endStart + LEGACY_PROJECT_INSTRUCTIONS_END.length;
  return {
    systemPrompt: `${systemPrompt.slice(0, start)}${RUNTIME_MANAGED_PROJECT_INSTRUCTIONS}${systemPrompt.slice(end)}`,
    rewritten: true
  };
}

export function compactManagedProjectInstructions(
  systemPrompt: string,
  mode: "automatic" | "protected"
): { systemPrompt: string; compacted: boolean } {
  const concise = mode === "protected"
    ? "Piagent protected-path policy: do not read, disclose, or mutate protected content. Refuse without tool calls."
    : "Piagent runtime task is injected below. Root project instructions are already loaded; do not re-read root AGENTS.md. Use task-relevant source/tests and ordinary tools, run the exact verifier after final edits, and make no task-management calls.";
  const markerStart = "<!-- piagent-managed:start -->";
  const markerEnd = "<!-- piagent-managed:end -->";
  const start = systemPrompt.indexOf(markerStart);
  const endStart = start >= 0 ? systemPrompt.indexOf(markerEnd, start) : -1;
  if (start >= 0 && endStart >= 0) {
    const end = endStart + markerEnd.length;
    return {
      systemPrompt: `${systemPrompt.slice(0, start)}${markerStart}\n${concise}\n${markerEnd}${systemPrompt.slice(end)}`,
      compacted: true
    };
  }
  if (systemPrompt.includes(RUNTIME_MANAGED_PROJECT_INSTRUCTIONS)) {
    return {
      systemPrompt: systemPrompt.replace(RUNTIME_MANAGED_PROJECT_INSTRUCTIONS, concise),
      compacted: true
    };
  }
  return { systemPrompt, compacted: false };
}
