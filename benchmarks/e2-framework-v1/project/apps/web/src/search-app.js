import { Hono } from "../../../vendor/hono/dist/index.js";

export function normalizeQuery(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function createSearchApp() {
  return new Hono();
}
