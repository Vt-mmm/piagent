export function normalizeQuery(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}+/gu, "").trim().replace(/\s+/gu, " ").toLowerCase();
}
