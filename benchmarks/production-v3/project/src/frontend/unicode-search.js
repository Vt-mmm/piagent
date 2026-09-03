export function normalizeSearchText(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function includesSearchText(value, query) {
  return normalizeSearchText(value).includes(normalizeSearchText(query));
}
