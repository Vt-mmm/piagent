Fix the cross-tenant collision in `src/backend/cache.js`.

`TenantCache` must isolate entries by all three identity components:
`tenantId`, `entity`, and `id`. String values containing punctuation must not
create ambiguous keys. Preserve the class API and keep the patch local. Verify
the project after the change.
