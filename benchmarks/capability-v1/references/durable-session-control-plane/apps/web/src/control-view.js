export function controlSummary(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new TypeError("receipt must be an object");
  return `kind=${receipt.kind}; command=${JSON.stringify(receipt.terminalCommand)}; revision=${receipt.revisionBefore}->${receipt.revisionAfter}; effect=${receipt.effect}; model=${receipt.expectedModelCalls}; replayed=${receipt.replayed}`;
}
