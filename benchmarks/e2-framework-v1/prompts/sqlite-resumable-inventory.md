Implement `migrateInventory(db, options)` in `packages/migration/src/inventory.js` using the provided Node `DatabaseSync` instance. Keep changes inside the declared source and tests.

- [M1] Accept only a `DatabaseSync`-compatible object. Legacy `inventory(id,name,quantity)` rows migrate to `inventory_v2(id,label,quantity)` and metadata version 2.
- [M2] Trim ids/names, require non-empty values, and convert quantity to a safe non-negative integer. Any invalid row aborts the whole transaction.
- [M3] The first successful run returns `{ version: 2, migrated: count }`; later runs are idempotent and return `{ version: 2, migrated: 0 }` without duplicating data.
- [M4] `options.crashAfter` is an optional positive safe integer used to inject a failure after that many inserts. A crash leaves no partial v2 schema/data/version and a later normal call completes.
- [M5] Preserve the legacy table and its rows; use prepared statements and a transaction rather than rebuilding from JavaScript-only state.

Run `npm test` when complete.
