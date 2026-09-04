/** @param {Record<string, unknown>} trace */
export function validTerminalDisposition(trace) {
  return trace.terminalDisposition === undefined
    || trace.terminalDisposition === "refused" && trace.outcome === "blocked";
}

/** @param {Record<string, unknown>} trace @returns {"refused" | undefined} */
export function normalizeTerminalDisposition(trace) {
  return trace.terminalDisposition === "refused" && trace.outcome === "blocked" ? "refused" : undefined;
}
