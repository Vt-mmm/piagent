import {
  callReturns,
  callThrows,
  encodeBenchmarkValue,
  recipe
} from "./benchmark-registered-plan-recipe-support.mjs";

function authorizationRecipe() {
  const resource = tenantId => ({ tenantId });
  const user = (role, tenantId = "tenant-a", active = true) => ({ role, tenantId, active });
  return recipe("src/backend/auth.js", "canManage", [
    callReturns("owner-allowed", [user("owner"), resource("tenant-a")], true),
    callReturns("admin-allowed", [user("admin"), resource("tenant-a")], true),
    callReturns("inactive-denied", [user("owner", "tenant-a", false), resource("tenant-a")], false),
    callReturns("missing-active-denied", [{ role: "owner", tenantId: "tenant-a" }, resource("tenant-a")], false),
    callReturns("member-denied", [user("member"), resource("tenant-a")], false),
    callReturns("tenant-mismatch-denied", [user("admin"), resource("tenant-b")], false),
    callReturns("empty-tenant-denied", [user("owner", ""), resource("")], false),
    callReturns("missing-user-denied", [undefined, resource("tenant-a")], false),
    callReturns("missing-resource-denied", [user("owner"), undefined], false)
  ]);
}

function cacheCase(id, invocation, args, expected, sequence = "cache-isolation") {
  const encoded = args.map(encodeBenchmarkValue);
  return { id, sequence, args: encoded, invocation, observeArgs: true,
    expected: { outcome: invocation.kind === "construct" ? "constructed" : "return",
      ...(invocation.kind === "construct" ? {} : { value: encodeBenchmarkValue(expected) }),
      argsAfter: encoded } };
}

function cacheRecipe() {
  const receiverId = "tenant-cache";
  const construct = { kind: "construct", receiverId };
  const method = name => ({ kind: "method", receiverId, method: name });
  return recipe("src/backend/cache.js", "TenantCache", [
    cacheCase("construct", construct, [], undefined),
    cacheCase("set-tenant-a", method("set"), ["tenant-a", "record", "7", "alpha"], undefined),
    cacheCase("set-tenant-b", method("set"), ["tenant-b", "record", "7", "beta"], undefined),
    cacheCase("get-tenant-a", method("get"), ["tenant-a", "record", "7"], "alpha"),
    cacheCase("get-tenant-b", method("get"), ["tenant-b", "record", "7"], "beta"),
    cacheCase("set-punctuation-left", method("set"), ["a:b", "c", "d", "left"], undefined),
    cacheCase("set-punctuation-right", method("set"), ["a", "b:c", "d", "right"], undefined),
    cacheCase("get-punctuation-left", method("get"), ["a:b", "c", "d"], "left"),
    cacheCase("get-punctuation-right", method("get"), ["a", "b:c", "d"], "right"),
    cacheCase("set-id-partition", method("set"), ["a", "b", "c:d", "id-part"], undefined),
    cacheCase("get-id-partition", method("get"), ["a", "b", "c:d"], "id-part"),
    cacheCase("missing-key", method("get"), ["tenant-a", "record", "missing"], undefined)
  ]);
}

function revocationRecipe() {
  const entry = overrides => ({ tenantId: "tenant-a", userId: "user-a", capabilityId: "write",
    permissionRevision: 7, evaluatedAt: 90, expiresAt: 110, ...overrides });
  const request = overrides => ({ tenantId: "tenant-a", userId: "user-a", capabilityId: "write",
    permissionRevision: 7, now: 100, revokedAt: null, ...overrides });
  return recipe("src/backend/revocation-cache.js", "isCachedAccessUsable", [
    callReturns("matching-null-revocation", [entry({}), request({})], true),
    callReturns("future-revocation", [entry({}), request({ revokedAt: 101 })], true),
    callReturns("revoked-at-now", [entry({}), request({ revokedAt: 100 })], false),
    callReturns("revoked-before-now", [entry({}), request({ revokedAt: 99 })], false),
    callReturns("evaluated-at-now", [entry({ evaluatedAt: 100 }), request({})], true),
    callReturns("evaluated-in-future", [entry({ evaluatedAt: 101 }), request({})], false),
    callReturns("expires-at-now", [entry({ expiresAt: 100 }), request({})], false),
    callReturns("tenant-mismatch", [entry({}), request({ tenantId: "tenant-b" })], false),
    callReturns("capability-mismatch", [entry({}), request({ capabilityId: "read" })], false),
    callReturns("revision-mismatch", [entry({}), request({ permissionRevision: 8 })], false),
    callReturns("space-identifier-valid", [entry({ tenantId: " " }), request({ tenantId: " " })], true),
    callReturns("negative-times-valid", [entry({ evaluatedAt: -10, expiresAt: 10 }), request({ now: 0 })], true),
    callReturns("large-integers-valid", [entry({ permissionRevision: 1e20, evaluatedAt: 1e20, expiresAt: 1e20 + 32768 }),
      request({ permissionRevision: 1e20, now: 1e20, revokedAt: null })], true),
    callThrows("malformed-revision-outranks-mismatch", [entry({}), request({ tenantId: "tenant-b", permissionRevision: "7" })]),
    callThrows("entry-array", [[], request({})]),
    callThrows("request-null", [entry({}), null]),
    callThrows("empty-identifier", [entry({ userId: "" }), request({})]),
    callThrows("fractional-time", [entry({ evaluatedAt: 90.5 }), request({})]),
    callThrows("nan-revision", [entry({ permissionRevision: NaN }), request({})]),
    callThrows("infinite-now", [entry({}), request({ now: Infinity })]),
    callThrows("missing-revoked-at", [entry({}), { tenantId: "tenant-a", userId: "user-a",
      capabilityId: "write", permissionRevision: 7, now: 100 }])
  ]);
}

function invoiceRecipe() {
  return recipe("src/backend/invoice.js", "invoiceTotalCents", [
    callReturns("empty-default-tax", [[]], 0),
    callReturns("default-quantity-discount-tax", [[{ unitCents: 100 }]], 100),
    callReturns("quantity", [[{ unitCents: 125, quantity: 2 }], 0], 250),
    callReturns("discount-half-up-one", [[{ unitCents: 1, discountBps: 5000 }], 0], 1),
    callReturns("discount-half-up-three", [[{ unitCents: 3, discountBps: 5000 }], 0], 2),
    callReturns("round-each-line-before-sum", [[{ unitCents: 1, discountBps: 5000 },
      { unitCents: 1, discountBps: 5000 }], 0], 2),
    callReturns("tax-once-after-sum", [[{ unitCents: 1 }, { unitCents: 1 }], 5000], 3),
    callReturns("full-discount", [[{ unitCents: 999, quantity: 3, discountBps: 10000 }], 2500], 0),
    callReturns("full-tax", [[{ unitCents: 250 }], 10000], 500),
    callReturns("bounded-large-line", [[{ unitCents: 1000000, quantity: 100, discountBps: 1 }], 1], 99999999),
    callThrows("lines-not-array", [{ unitCents: 1 }, 0]),
    callThrows("line-not-record", [[null], 0]),
    callThrows("missing-unit", [[{}], 0]),
    callThrows("negative-unit", [[{ unitCents: -1 }], 0]),
    callThrows("fractional-unit", [[{ unitCents: 1.5 }], 0]),
    callThrows("string-unit", [[{ unitCents: "1" }], 0]),
    callThrows("zero-quantity", [[{ unitCents: 1, quantity: 0 }], 0]),
    callThrows("fractional-quantity", [[{ unitCents: 1, quantity: 1.5 }], 0]),
    callThrows("discount-over-range", [[{ unitCents: 1, discountBps: 10001 }], 0]),
    callThrows("negative-tax", [[{ unitCents: 1 }], -1]),
    callThrows("nonfinite-tax", [[{ unitCents: 1 }], Infinity])
  ]);
}

function billingRecipe() {
  const event = overrides => ({ occurredAt: 100, receivedAt: 100, ...overrides });
  const period = overrides => ({ startsAt: 100, endsAt: 200, maxClockSkewMs: 10, ...overrides });
  return recipe("src/backend/billing-window.js", "billingBucket", [
    callReturns("before-start-outside", [event({ occurredAt: 99 }), period({})], "outside"),
    callReturns("at-start-current", [event({ occurredAt: 100 }), period({})], "current"),
    callReturns("before-end-current", [event({ occurredAt: 199, receivedAt: 199 }), period({})], "current"),
    callReturns("at-end-outside", [event({ occurredAt: 200, receivedAt: 500 }), period({})], "outside"),
    callReturns("clock-skew-exact-current", [event({ occurredAt: 150, receivedAt: 140 }), period({})], "current"),
    callReturns("clock-skew-over-invalid", [event({ occurredAt: 150, receivedAt: 139 }), period({})], "invalid-clock"),
    callReturns("late-boundary", [event({ occurredAt: 150, receivedAt: 210 }), period({})], "late"),
    callReturns("late-before-boundary-current", [event({ occurredAt: 150, receivedAt: 209 }), period({})], "current"),
    callThrows("invalid-event-field", [event({ occurredAt: 1.5 }), period({})]),
    callThrows("invalid-received-outside", [event({ occurredAt: 99, receivedAt: NaN }), period({})]),
    callThrows("negative-skew", [event({}), period({ maxClockSkewMs: -1 })]),
    callThrows("empty-period", [event({}), period({ endsAt: 100 })]),
    callThrows("reversed-period", [event({}), period({ startsAt: 201 })]),
    callThrows("missing-field", [{ occurredAt: 100 }, period({})])
  ]);
}

function paginationRecipe() {
  return recipe("src/frontend/pagination.js", "pageCount", [
    callReturns("count-zero", [0, 10], 0),
    callReturns("count-exact", [20, 10], 2),
    callReturns("count-ceiling", [21, 10], 3),
    callReturns("count-large", [1000000000, 1000000], 1000),
    callThrows("count-negative", [-1, 10]),
    callThrows("count-fraction", [1.5, 10]),
    callThrows("count-nan", [NaN, 10]),
    callThrows("count-size-zero", [0, 0]),
    callThrows("count-size-fraction", [10, 2.5]),
    callReturns("clamp-zero-ignores-record-page", [{ arbitrary: true }, 0, 10], 0, { exportName: "clampPage" }),
    callReturns("clamp-zero-ignores-undefined-page", [undefined, 0, 10], 0, { exportName: "clampPage" }),
    callThrows("clamp-invalid-size-outranks-zero", [{ arbitrary: true }, 0, 0], "TypeError", { exportName: "clampPage" }),
    callReturns("clamp-low", [-3, 21, 10], 1, { exportName: "clampPage" }),
    callReturns("clamp-middle", [2, 21, 10], 2, { exportName: "clampPage" }),
    callReturns("clamp-high", [9, 21, 10], 3, { exportName: "clampPage" }),
    callThrows("clamp-fractional-page", [1.5, 21, 10], "TypeError", { exportName: "clampPage" }),
    callThrows("clamp-nonfinite-page", [Infinity, 21, 10], "TypeError", { exportName: "clampPage" })
  ]);
}

const RECIPES = Object.freeze({
  "tenant-role-authorization": authorizationRecipe,
  "tenant-cache-isolation": cacheRecipe,
  "revoked-session-cache": revocationRecipe,
  "invoice-rounding": invoiceRecipe,
  "billing-cutoff-clock-skew": billingRecipe,
  "pagination-boundary": paginationRecipe
});

export function registeredBackendRecipe(scenarioId) {
  return RECIPES[scenarioId]?.() ?? null;
}
