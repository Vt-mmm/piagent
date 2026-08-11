import { Hono } from "../../../vendor/hono/dist/index.js";

export function normalizeQuery(value) {
  return String(value ?? "").normalize("NFD").replace(/\p{M}+/gu, "").trim().replace(/\s+/gu, " ").toLowerCase();
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function createSearchApp({ items = [] } = {}) {
  const app = new Hono();
  app.get("/search", (context) => {
    const rawQuery = context.req.query("q") ?? "";
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Array.isArray(items)) {
      return context.json({ error: "invalid-request" }, 400);
    }
    const query = normalizeQuery(rawQuery);
    const results = items.filter((item) => {
      const fields = [item?.name, ...(Array.isArray(item?.tags) ? item.tags.filter((tag) => typeof tag === "string") : [])];
      return fields.some((field) => normalizeQuery(field).includes(query));
    }).slice(0, limit);
    const rows = results.map((item) => `<li data-id="${escapeHtml(item.id)}">${escapeHtml(item.name)}</li>`).join("");
    return context.html(`<form aria-label="Search"><label>Query <input name="q" value="${escapeHtml(rawQuery)}"></label></form><ul aria-label="Search results">${rows}</ul>`);
  });
  return app;
}
