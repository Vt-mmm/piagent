function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderSearchResults(results) {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");
  const items = results.map((item) => `<li data-id="${escapeHtml(item?.id ?? "")}">${escapeHtml(item?.name ?? "")}</li>`).join("");
  return `<ul aria-label="Search results">${items}</ul>`;
}
