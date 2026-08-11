export function normalizeQuery(value) {
  return String(value ?? "").trim().toLowerCase();
}
