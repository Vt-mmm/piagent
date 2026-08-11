const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

function escaped(value) {
  return String(value).replace(/[&<>"']/gu, (character) => entities[character]);
}

export function renderSearchResults(results) {
  if (!Array.isArray(results)) throw new TypeError("results must be an array");
  let html = '<ul aria-label="Search results">';
  for (const result of results) {
    html += `<li data-id="${escaped(result?.id ?? "")}">${escaped(result?.name ?? "")}</li>`;
  }
  return `${html}</ul>`;
}
