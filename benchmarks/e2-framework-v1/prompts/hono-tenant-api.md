Implement the tenant user route in `apps/api/src/tenant-app.js` using the pinned Hono framework already vendored in this repository. Keep changes inside the declared source and tests.

- [A1] `createTenantApp({ users })` returns a Hono app and registers `GET /tenants/:tenantId/users/:userId`.
- [A2] Only `owner` or `admin` callers whose trimmed `x-tenant-id` exactly matches the trimmed path tenant may read the route; every other caller receives 403 without user data.
- [A3] Validate `users` as an array and trim/reject empty tenant, user, header tenant, and role values with a 400 JSON response.
- [A4] An active matching user returns 200 and exactly `{ id, tenantId, name }`; a missing or inactive user returns 404.
- [A5] Do not mutate the caller's users array or user objects and do not return internal object references.

Run `npm test` when complete.
