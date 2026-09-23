// Public examples for the declared API. No private oracle values or solution.
test("cached access uses the declared field names and all identity boundaries", async () => {
  const { isCachedAccessUsable: usable } = await import("../src/backend/revocation-cache.js");
  const entry = Object.freeze({ tenantId: "north", userId: "u1", capability: "edit",
    permissionRevision: 4, evaluatedAt: 100, expiresAt: 200 });
  const request = Object.freeze({ tenantId: "north", userId: "u1", capability: "edit",
    currentPermissionRevision: 4, now: 150, revokedAt: null });
  assert.equal(usable(entry, request), true);
  for (const patch of [{ tenantId: "south" }, { userId: "u2" }, { capability: "delete" },
    { currentPermissionRevision: 5 }, { now: 200 }, { revokedAt: 150 }]) {
    assert.equal(usable(entry, Object.freeze({ ...request, ...patch })), false, JSON.stringify(patch));
  }
  assert.equal(usable({ ...entry, evaluatedAt: 151 }, request), false);
  assert.equal(usable(entry, { ...request, now: 199, revokedAt: 200 }), true);
  for (const bad of [null, [], {}, { ...request, now: 1.5 }, { ...request, revokedAt: undefined },
    { ...request, capability: "" }, { ...request, currentPermissionRevision: "4" }]) {
    assert.throws(() => usable(entry, bad), TypeError);
  }
  assert.throws(() => usable({ ...entry, expiresAt: Infinity }, request), TypeError);
});
