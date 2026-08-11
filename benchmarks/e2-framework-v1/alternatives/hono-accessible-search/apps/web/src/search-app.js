import { Hono } from "../../../vendor/hono/dist/index.js";

export const normalizeQuery = (value) => `${value ?? ""}`.normalize("NFD").replaceAll(/\p{M}/gu, "").split(/\s+/u).filter(Boolean).join(" ").toLocaleLowerCase("en-US");

const entities = new Map([["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"]]);
const escaped = (value) => `${value}`.replace(/[&<>"']/g, (character) => entities.get(character));
const matches = (item, query) => [item?.name].concat(Array.isArray(item?.tags) ? item.tags : []).filter((value) => typeof value === "string").some((value) => normalizeQuery(value).includes(query));

export function createSearchApp(configuration = {}) {
  const app = new Hono();
  app.get("/search", ({ req, html, json }) => {
    const raw = req.query("q") || "";
    const specified = req.query("limit");
    const maximum = specified == null ? 20 : +specified;
    if (!Array.isArray(configuration.items) || !Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 100) return json({ error: "invalid-request" }, 400);
    const body = configuration.items.filter((item) => matches(item, normalizeQuery(raw))).slice(0, maximum).reduce((output, item) => output + `<li data-id="${escaped(item.id)}">${escaped(item.name)}</li>`, "");
    return html(`<form aria-label="Search"><label>Query <input name="q" value="${escaped(raw)}"></label></form><ul aria-label="Search results">${body}</ul>`);
  });
  return app;
}
