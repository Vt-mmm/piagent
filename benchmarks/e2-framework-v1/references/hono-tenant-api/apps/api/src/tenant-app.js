import { Hono } from "../../../vendor/hono/dist/index.js";

const text = (value) => typeof value === "string" ? value.trim() : "";

export function createTenantApp({ users = [] } = {}) {
  const app = new Hono();
  app.get("/tenants/:tenantId/users/:userId", (context) => {
    if (!Array.isArray(users)) return context.json({ error: "invalid-request" }, 400);
    const tenantId = text(context.req.param("tenantId"));
    const userId = text(context.req.param("userId"));
    const callerTenant = text(context.req.header("x-tenant-id"));
    const role = text(context.req.header("x-role"));
    if (!tenantId || !userId || !callerTenant || !role) return context.json({ error: "invalid-request" }, 400);
    if (callerTenant !== tenantId || !["owner", "admin"].includes(role)) {
      return context.json({ error: "forbidden" }, 403);
    }
    const user = users.find((item) => item && text(item.id) === userId && text(item.tenantId) === tenantId);
    if (!user || user.active !== true) return context.json({ error: "not-found" }, 404);
    return context.json({ id: text(user.id), tenantId: text(user.tenantId), name: String(user.name) });
  });
  return app;
}
