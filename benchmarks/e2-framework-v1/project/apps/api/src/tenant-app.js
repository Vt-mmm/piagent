import { Hono } from "../../../vendor/hono/dist/index.js";

export function createTenantApp() {
  return new Hono();
}
