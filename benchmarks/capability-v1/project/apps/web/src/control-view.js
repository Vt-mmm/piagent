export function controlSummary(receipt) {
  return String(receipt?.kind ?? "");
}
