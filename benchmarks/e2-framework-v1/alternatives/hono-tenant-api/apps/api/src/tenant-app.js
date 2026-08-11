import { Hono } from "../../../vendor/hono/dist/index.js";

function normalized(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function createTenantApp(options = {}) {
  const repository = Object.hasOwn(options, "users") ? options.users : [];
  const app = new Hono();
  app.use("/tenants/:tenantId/users/:userId", async (context, next) => {
    if (!Array.isArray(repository)) return context.json({ error: "invalid-request" }, 400);
    const values = [context.req.param("tenantId"), context.req.param("userId"), context.req.header("x-tenant-id"), context.req.header("x-role")].map(normalized);
    if (values.some((value) => value.length === 0)) return context.json({ error: "invalid-request" }, 400);
    const [tenantId, , callerTenant, role] = values;
    if (tenantId !== callerTenant || (role !== "owner" && role !== "admin")) return context.json({ error: "forbidden" }, 403);
    context.set("identity", values);
    return next();
  });
  app.get("/tenants/:tenantId/users/:userId", (context) => {
    const [tenantId, userId] = context.get("identity");
    const record = repository.find(({ id, tenantId: owner }) => normalized(id) === userId && normalized(owner) === tenantId);
    return !record || record.active !== true
      ? context.json({ error: "not-found" }, 404)
      : context.json({ id: normalized(record.id), tenantId: normalized(record.tenantId), name: `${record.name}` });
  });
  return app;
}
