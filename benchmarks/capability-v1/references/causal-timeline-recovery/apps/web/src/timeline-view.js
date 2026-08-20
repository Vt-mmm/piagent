function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderTimeline(messages) {
  if (!Array.isArray(messages)) throw new TypeError("messages must be an array");
  const rows = messages.map((item) => `<li data-id="${escapeHtml(item?.id ?? "")}" data-state="${item?.complete === true ? "complete" : "pending"}">${escapeHtml(item?.text ?? "")}</li>`).join("");
  return `<ol aria-label="Session timeline">${rows}</ol>`;
}
