import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createTenantApp } from "../apps/api/src/tenant-app.js";
import { createSearchApp } from "../apps/web/src/search-app.js";
import { repositoryIdentity } from "../packages/shared/src/identity.js";

test("real framework and runtime dependencies boot offline", async () => {
  assert.equal(repositoryIdentity, "e2-real-framework-monorepo");
  assert.equal((await createTenantApp().request("http://local/unknown")).status, 404);
  assert.equal((await createSearchApp().request("http://local/unknown")).status, 404);
  const db = new DatabaseSync(":memory:");
  assert.equal(db.prepare("select 1 as value").get().value, 1);
  db.close();
});
