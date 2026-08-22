import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.argv[2];
const oracle = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const scenario = process.env.PIAGENT_BENCHMARK_SCENARIO;
const data = oracle.graderData;
const checks = [];
async function check(id, action) { try { await action(); checks.push({ id, passed: true }); } catch { checks.push({ id, passed: false }); } }
async function load(file) { const url = pathToFileURL(path.join(workspace, file)); url.searchParams.set("benchmark", `${Date.now()}-${Math.random()}`); return import(url.href); }
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

switch (scenario) {
  case "revision-event-reconciliation": {
    const { reconcileSession } = await load("src/event-reconcile.js");
    await check("contiguous-revision-application", () => {
      const snapshot = { revision: data.revisions[0], nextSequence: data.start, state: { keep: true, remove: "old" } };
      const first = { id: "a", sequence: data.start, baseRevision: data.revisions[0], revision: data.revisions[1], patch: { [data.key]: 1, remove: null } };
      const second = { id: "b", sequence: data.start + 1, baseRevision: data.revisions[1], revision: data.revisions[2], patch: { [data.key]: 2 } };
      const inputs = structuredClone([snapshot, [second, first, structuredClone(first)]]);
      const result = reconcileSession(snapshot, [second, first, structuredClone(first)]);
      assert.deepEqual(result, { revision: data.revisions[2], nextSequence: data.start + 2, state: { keep: true, [data.key]: 2 },
        appliedIds: ["a", "b"], duplicateIds: ["a"], pending: [], gap: null });
      assert.deepEqual([snapshot, [second, first, structuredClone(first)]], inputs);
    });
    await check("gap-and-conflict-fail-closed", () => {
      const snapshot = { revision: "r0", nextSequence: 4, state: {} };
      const late = { id: "late", sequence: 6, baseRevision: "r1", revision: "r2", patch: {} };
      assert.deepEqual(reconcileSession(snapshot, [late]).gap, { expected: 4, observed: 6 });
      assert.throws(() => reconcileSession(snapshot, [
        { id: "x", sequence: 4, baseRevision: "r0", revision: "r1", patch: {} },
        { id: "y", sequence: 4, baseRevision: "r0", revision: "r2", patch: {} }
      ]));
      assert.throws(() => reconcileSession(snapshot, [{ id: "x", sequence: 4, baseRevision: "wrong", revision: "r1", patch: {} }]));
      assert.throws(() => reconcileSession(snapshot, [{ id: "x", sequence: 4, baseRevision: "r0", revision: "r1", patch: JSON.parse('{"__proto__":1}') }]));
    });
    break;
  }
  case "fair-dependency-scheduler": {
    const { scheduleJobs } = await load("src/scheduler.js");
    await check("dependency-capacity-fairness", () => {
      const [a, b, c] = data.tenants, cap = data.capacity;
      const jobs = [
        { id: "a1", tenant: a, weight: 1, dependsOn: [] }, { id: "a2", tenant: a, weight: 1, dependsOn: [] },
        { id: "b1", tenant: b, weight: 1, dependsOn: [] }, { id: "c1", tenant: c, weight: 1, dependsOn: [] },
        { id: "after", tenant: a, weight: Math.min(2, cap), dependsOn: ["b1", "c1"] }
      ];
      const before = structuredClone(jobs), waves = scheduleJobs(jobs, cap);
      assert.deepEqual(jobs, before);
      assert.equal(new Set(waves.flat()).size, jobs.length);
      assert.deepEqual(new Set(waves[0].slice(0, 3)), new Set(["a1", "b1", "c1"]));
      const waveOf = new Map(waves.flatMap((wave, index) => wave.map((id) => [id, index])));
      assert.ok(waveOf.get("after") > waveOf.get("b1") && waveOf.get("after") > waveOf.get("c1"));
      for (const wave of waves) assert.ok(wave.reduce((sum, id) => sum + jobs.find((job) => job.id === id).weight, 0) <= cap);
    });
    await check("invalid-graph-rejected", () => {
      assert.throws(() => scheduleJobs([{ id: "a", tenant: "t", weight: 1, dependsOn: ["b"] }], 2));
      assert.throws(() => scheduleJobs([{ id: "a", tenant: "t", weight: 1, dependsOn: ["b"] }, { id: "b", tenant: "t", weight: 1, dependsOn: ["a"] }], 2));
      assert.throws(() => scheduleJobs([{ id: "a", tenant: "t", weight: 3, dependsOn: [] }], 2));
    });
    break;
  }
  case "layered-policy-resolution": {
    const { decideAccess } = await load("src/policy.js");
    await check("precedence-and-protected-deny", () => {
      const layers = [
        { name: "global", rules: [{ pattern: "src/**", operations: [data.operation], effect: "allow" },
          { pattern: "src/**", operations: [data.operation], effect: "deny" },
          { pattern: "private/**", operations: ["*"], effect: "deny", protected: true }] },
        { name: "project", rules: [{ pattern: "src/**", operations: [data.operation], effect: "allow" }] }
      ];
      assert.equal(decideAccess({ path: "src/a/config.json", operation: data.operation }, layers).allowed, true);
      const denied = decideAccess({ path: data.protectedPath, operation: data.operation }, layers);
      assert.equal(denied.allowed, false); assert.equal(denied.protected, true); assert.equal(denied.layer, "global");
      assert.equal(decideAccess({ path: "docs/readme.md", operation: data.operation }, layers).allowed, false);
    });
    await check("path-and-rule-validation", () => {
      const allow = [{ name: "x", rules: [{ pattern: "**", operations: ["*"], effect: "allow" }] }];
      for (const unsafe of ["../secret", "/root", "a\\b", "a//b", "./a", "a/../b"]) assert.throws(() => decideAccess({ path: unsafe, operation: "read" }, allow));
      assert.throws(() => decideAccess({ path: "a", operation: "read" }, [{ name: "x", rules: [{ pattern: "[a]", operations: ["read"], effect: "allow" }] }]));
    });
    break;
  }
  case "budgeted-context-graph": {
    const { buildContextPack } = await load("src/context-pack.js");
    await check("ranking-propagation-budget", () => {
      const nodes = [
        { id: "guide", path: "docs/guide.md", text: `${data.term} architecture`, tokens: 3 },
        { id: "impl", path: "src/impl.js", text: "implementation details", tokens: 4 },
        { id: "required", path: "AGENTS.md", text: "rules", tokens: 2, required: true },
        { id: "large", path: "src/large.js", text: data.term, tokens: data.budget + 1 }
      ];
      const before = structuredClone(nodes), result = buildContextPack(data.term, nodes, [{ from: "guide", to: "impl", weight: 1 }], data.budget);
      assert.deepEqual(nodes, before);
      assert.deepEqual(result.selected.map((item) => item.id).slice(0, 3), ["required", "guide", "impl"]);
      assert.ok(result.usedTokens <= data.budget); assert.equal(result.confidence, "high");
      assert.equal(result.selected.find((item) => item.id === "impl").score, 0.5);
      assert.ok(result.omitted.some((item) => item.id === "large"));
    });
    await check("graph-validation-and-required-budget", () => {
      assert.throws(() => buildContextPack("x", [{ id: "a", path: "a", text: "x", tokens: 5, required: true }], [], 4));
      assert.throws(() => buildContextPack("x", [{ id: "a", path: "a", text: "x", tokens: 1 }], [{ from: "a", to: "missing", weight: 1 }], 4));
      const result = buildContextPack("Đặng", [{ id: "a", path: "a", text: "đặng", tokens: 1 }], [], 1);
      assert.equal(result.selected[0].directScore, 1);
    });
    break;
  }
  case "resumable-stream-assembly": {
    const { assembleStream } = await load("src/stream.js");
    await check("contiguous-interleaving-exact-duplicates-and-order", () => {
      const snapshot = { cursor: data.start, messages: [{ id: data.message, text: data.first, complete: false }] };
      const first = {
        cursor: data.start + 1,
        messageId: data.message,
        offset: data.first.length,
        text: data.second,
        complete: false
      };
      const second = {
        cursor: data.start + 2,
        messageId: data.other,
        offset: 0,
        text: data.third,
        complete: false
      };
      const final = {
        cursor: data.start + 3,
        messageId: data.message,
        offset: (data.first + data.second).length,
        text: "",
        complete: true
      };
      const events = [second, first, structuredClone(second), final];
      const before = structuredClone([snapshot, events]), result = assembleStream(snapshot, events);
      assert.deepEqual([snapshot, events], before);
      assert.equal(result.cursor, data.start + 3);
      assert.deepEqual(result.messages, [
        { id: data.message, text: data.first + data.second, complete: true },
        { id: data.other, text: data.third, complete: false }
      ]);
      assert.deepEqual(result.appliedCursors, [data.start + 1, data.start + 2, data.start + 3]);
      assert.deepEqual(result.replayedCursors, []);
      assert.deepEqual(result.buffered, []);
      assert.equal(result.gap, null);
    });
    await check("replay-gap-and-buffer-order", () => {
      const snapshot = { cursor: data.start, messages: [] };
      const replay = { cursor: data.start, messageId: "replay", offset: 0, text: "old", complete: false };
      const events = [
        { cursor: data.start + 3, messageId: "late-b", offset: 0, text: data.second, complete: false },
        replay,
        { cursor: data.start + 2, messageId: "late-a", offset: 0, text: data.first, complete: false },
        structuredClone(replay)
      ];
      const before = structuredClone([snapshot, events]), result = assembleStream(snapshot, events);
      assert.deepEqual([snapshot, events], before);
      assert.equal(result.cursor, data.start);
      assert.deepEqual(result.appliedCursors, []);
      assert.deepEqual(result.replayedCursors, [data.start]);
      assert.deepEqual(result.buffered.map((event) => event.cursor), [data.start + 2, data.start + 3]);
      assert.deepEqual(result.gap, { expected: data.start + 1, observed: data.start + 2 });
    });
    await check("utf16-offset-and-empty-finalization", () => {
      const initial = `${data.astral}${data.first}`;
      const snapshot = { cursor: 0, messages: [{ id: data.message, text: initial, complete: false }] };
      const events = [{ cursor: 1, messageId: data.message, offset: initial.length, text: data.second, complete: true }];
      const result = assembleStream(snapshot, events);
      assert.equal(result.messages[0].text, initial + data.second);
      assert.equal(result.messages[0].complete, true);
      const emptyFinal = assembleStream(
        { cursor: 0, messages: [{ id: data.other, text: initial, complete: false }] },
        [{ cursor: 1, messageId: data.other, offset: initial.length, text: "", complete: true }]
      );
      assert.equal(emptyFinal.messages[0].text, initial);
      assert.equal(emptyFinal.messages[0].complete, true);
    });
    await check("invalid-offset-rejected", () => {
      const base = { cursor: 0, messages: [] };
      assert.throws(() => assembleStream(base, [{ cursor: 1, messageId: "m", offset: 1, text: "x", complete: false }]));
    });
    await check("conflicting-cursor-rejected", () => {
      const base = { cursor: 0, messages: [] };
      assert.throws(() => assembleStream(base, [
        { cursor: 1, messageId: "m", offset: 0, text: "x", complete: false },
        { cursor: 1, messageId: "m", offset: 0, text: "y", complete: false }
      ]));
    });
    await check("event-after-completion-rejected", () => {
      assert.throws(() => assembleStream({ cursor: 0, messages: [{ id: "m", text: "x", complete: true }] },
        [{ cursor: 1, messageId: "m", offset: 1, text: "", complete: true }]));
    });
    await check("input-shape-validation", () => {
      assert.throws(() => assembleStream({ cursor: -1, messages: [] }, []));
      assert.throws(() => assembleStream({ cursor: 0, messages: [] }, [
        { cursor: 1, messageId: "m", offset: Number.MAX_SAFE_INTEGER + 1, text: "x", complete: false }
      ]));
      assert.throws(() => assembleStream({ cursor: 0, messages: [] }, [
        { cursor: 1, messageId: "m", offset: 0, text: 1, complete: false }
      ]));
    });
    break;
  }
  case "transactional-config-merge": {
    const { planConfigTransaction } = await load("src/config-transaction.js");
    await check("merge-delete-default-audit-digest", () => {
      const base = { service: { port: 3000, stale: true }, remove: "x" };
      const layers = [{ service: { port: 0, [data.key]: data.value }, remove: { $delete: true } }];
      const schema = { service: { type: "object", required: true }, remove: { type: "string" }, enabled: { type: "boolean", default: false } };
      const before = structuredClone([base, layers, schema]), result = planConfigTransaction(base, layers, schema);
      assert.deepEqual([base, layers, schema], before);
      assert.equal(
        canonicalJson(result.next),
        canonicalJson({ service: { port: 0, stale: true, [data.key]: data.value }, enabled: false })
      );
      assert.deepEqual(result.changes.map((item) => item.path), [...result.changes.map((item) => item.path)].sort());
      assert.ok(result.changes.some((item) => item.path === "/remove" && item.kind === "delete"));
      assert.ok(result.changes.some((item) => item.path === "/enabled" && item.kind === "add"));
      assert.match(result.digest, /^[a-f0-9]{64}$/);
      const canonical = JSON.stringify({ enabled: false, service: { [data.key]: data.value, port: 0, stale: true } });
      assert.equal(result.digest, crypto.createHash("sha256").update(canonical).digest("hex"));
    });
    await check("schema-and-pollution-fail-closed", () => {
      assert.throws(() => planConfigTransaction({}, [{ unknown: true }], { known: { type: "boolean" } }));
      assert.throws(() => planConfigTransaction({}, [{}], { required: { type: "string", required: true } }));
      assert.throws(() => planConfigTransaction({}, [{ x: { $delete: false } }], { x: { type: "object" } }));
      assert.throws(() => planConfigTransaction(JSON.parse('{"__proto__":1}'), [], {}));
    });
    break;
  }
  case "temporal-usage-billing-close": {
    const { normalizePlanTimeline } = await load("packages/billing/src/plan-timeline.js");
    const { closeUsagePeriod } = await load("packages/billing/src/close-period.js");
    const { billingSummary } = await load("apps/admin/src/billing-summary.js");
    const period = { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
    const [planA1, planA2, planB1] = data.plans;
    const [price1, price2, price3] = data.prices;
    const tiers = (prices = data.prices) => [
      { upTo: data.firstLimit, unitPriceMicros: prices[0] },
      { upTo: data.secondLimit, unitPriceMicros: prices[1] },
      { upTo: null, unitPriceMicros: prices[2] }
    ];
    const plan = ({ id, tenantId, effectiveAt, currency = "USD", meters = { [data.meter]: tiers() } }) => (
      { id, tenantId, currency, effectiveAt, meters }
    );
    const plans = () => [
      plan({ id: planA2, tenantId: data.tenantA, effectiveAt: "2026-08-15T00:00:00.000Z" }),
      plan({ id: planB1, tenantId: data.tenantB, effectiveAt: "2026-07-01T00:00:00.000Z" }),
      plan({ id: planA1, tenantId: data.tenantA, effectiveAt: "2026-07-01T00:00:00.000Z" })
    ];
    const usage = (id, tenantId, at, units, meter = data.meter) => ({ id, kind: "usage", tenantId, meter, at, units });
    const reversal = (id, tenantId, at, targetId) => ({ id, kind: "reversal", tenantId, at, targetId });
    const canonical = (value) => {
      if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isSafeInteger(value)) return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    };
    await check("period-and-timeline-normalization", () => {
      const source = plans();
      source[0].meters = { zeta: tiers(), [data.meter]: tiers() };
      const before = structuredClone(source), normalized = normalizePlanTimeline(source, period);
      assert.deepEqual(source, before);
      assert.notEqual(normalized.find((item) => item.id === planA1), source[2]);
      assert.deepEqual(normalized.map((item) => item.id), before.toSorted((left, right) => left.tenantId.localeCompare(right.tenantId)
        || left.effectiveAt.localeCompare(right.effectiveAt) || left.id.localeCompare(right.id)).map((item) => item.id));
      assert.deepEqual(Object.keys(normalized.find((item) => item.id === planA2).meters), [data.meter, "zeta"].sort());
      assert.deepEqual(Object.keys(normalized[0]), ["id", "tenantId", "currency", "effectiveAt", "meters"]);
    });
    await check("timeline-validation-fail-closed", () => {
      assert.throws(() => normalizePlanTimeline(plans(), { start: period.end, end: period.start }), TypeError);
      assert.throws(() => normalizePlanTimeline([plans()[0], { ...plans()[1], id: plans()[0].id }], period), TypeError);
      assert.throws(() => normalizePlanTimeline([plans()[0], { ...plans()[2], effectiveAt: plans()[0].effectiveAt }], period), TypeError);
      assert.throws(() => normalizePlanTimeline([plans()[2], { ...plans()[0], currency: "EUR" }], period), TypeError);
      assert.throws(() => normalizePlanTimeline([plan({ id: "bad", tenantId: data.tenantA, effectiveAt: "2026-07-01T00:00:00.000Z", meters: { [data.meter]: [{ upTo: 3, unitPriceMicros: 1 }] } })], period), TypeError);
      assert.throws(() => normalizePlanTimeline([plan({ id: "bad", tenantId: data.tenantA, effectiveAt: "2026-07-01", meters: { [data.meter]: tiers() } })], period), TypeError);
    });
    await check("tier-boundary-and-multi-tier-allocation", () => {
      const firstUnits = data.firstLimit - 1, secondUnits = data.secondLimit - data.firstLimit + 3;
      const result = closeUsagePeriod({ period, plans: plans(), events: [
        usage("u-1", data.tenantA, "2026-08-02T00:00:00.000Z", firstUnits),
        usage("u-2", data.tenantA, "2026-08-03T00:00:00.000Z", secondUnits)
      ] });
      const [first, second] = result.invoices[0].lines;
      assert.deepEqual(first.allocations, [{ tierIndex: 0, units: firstUnits, unitPriceMicros: String(price1), chargeMicros: String(BigInt(firstUnits) * BigInt(price1)) }]);
      assert.deepEqual(second.allocations.map((item) => [item.tierIndex, item.units]), [
        [0, 1], [1, data.secondLimit - data.firstLimit], [2, 2]
      ]);
      assert.equal(second.chargeMicros, String(BigInt(price1) + BigInt(data.secondLimit - data.firstLimit) * BigInt(price2) + 2n * BigInt(price3)));
    });
    await check("effective-boundary-and-plan-reset", () => {
      const result = closeUsagePeriod({ period, plans: plans(), events: [
        usage("before", data.tenantA, "2026-08-14T23:59:59.999Z", data.firstLimit),
        usage("boundary", data.tenantA, "2026-08-15T00:00:00.000Z", data.firstLimit + 1)
      ] });
      const [before, boundary] = result.invoices[0].lines;
      assert.equal(before.planId, planA1); assert.equal(boundary.planId, planA2);
      assert.deepEqual(boundary.allocations.map((item) => [item.tierIndex, item.units]), [[0, data.firstLimit], [1, 1]]);
    });
    await check("tenant-and-meter-counter-isolation", () => {
      const otherMeter = `${data.meter}-secondary`;
      const expanded = plans().map((item) => ({ ...item, meters: { ...item.meters, [otherMeter]: tiers() } }));
      const result = closeUsagePeriod({ period, plans: expanded, events: [
        usage("a-main", data.tenantA, "2026-08-02T00:00:00.000Z", data.firstLimit),
        usage("a-other", data.tenantA, "2026-08-03T00:00:00.000Z", data.firstLimit, otherMeter),
        usage("b-main", data.tenantB, "2026-08-02T00:00:00.000Z", data.firstLimit)
      ] });
      assert.equal(result.invoices.length, 2);
      for (const invoice of result.invoices) for (const line of invoice.lines) {
        assert.deepEqual(line.allocations.map((item) => item.tierIndex), [0]);
      }
    });
    await check("reversal-applied-before-rating", () => {
      const result = closeUsagePeriod({ period, plans: plans(), events: [
        reversal("reverse-first", data.tenantA, "2026-08-10T00:00:00.000Z", "charged-first"),
        usage("charged-second", data.tenantA, "2026-08-03T00:00:00.000Z", data.firstLimit),
        usage("charged-first", data.tenantA, "2026-08-02T00:00:00.000Z", data.firstLimit)
      ] });
      assert.deepEqual(result.reversedEventIds, ["charged-first"]);
      assert.deepEqual(result.invoices[0].lines.map((item) => item.eventId), ["charged-second"]);
      assert.deepEqual(result.invoices[0].lines[0].allocations.map((item) => item.tierIndex), [0]);
    });
    await check("reversal-validation", () => {
      const target = usage("target", data.tenantA, "2026-08-05T00:00:00.000Z", 1);
      assert.throws(() => closeUsagePeriod({ period, plans: plans(), events: [target, reversal("r", data.tenantB, "2026-08-06T00:00:00.000Z", "target")] }), TypeError);
      assert.throws(() => closeUsagePeriod({ period, plans: plans(), events: [target, reversal("r", data.tenantA, "2026-08-04T00:00:00.000Z", "target")] }), TypeError);
      assert.throws(() => closeUsagePeriod({ period, plans: plans(), events: [target, reversal("r1", data.tenantA, "2026-08-06T00:00:00.000Z", "target"), reversal("r2", data.tenantA, "2026-08-07T00:00:00.000Z", "target")] }), TypeError);
      assert.throws(() => closeUsagePeriod({ period, plans: plans(), events: [reversal("r", data.tenantA, "2026-08-06T00:00:00.000Z", "missing")] }), TypeError);
    });
    await check("permutation-independent-canonical-output", () => {
      const events = [
        usage("z-last", data.tenantA, "2026-08-04T00:00:00.000Z", 2),
        usage("a-first", data.tenantA, "2026-08-02T00:00:00.000Z", 2),
        usage("b-same-time", data.tenantA, "2026-08-02T00:00:00.000Z", 2),
        usage("tenant-b", data.tenantB, "2026-08-03T00:00:00.000Z", 2)
      ];
      const forward = closeUsagePeriod({ period, plans: plans(), events });
      const reversed = closeUsagePeriod({ period, plans: plans().reverse(), events: [...events].reverse() });
      assert.deepEqual(reversed, forward);
      assert.deepEqual(forward.invoices.find((item) => item.tenantId === data.tenantA).lines.map((item) => item.eventId), ["a-first", "b-same-time", "z-last"]);
    });
    await check("bigint-charge-exactness", () => {
      const units = Number.MAX_SAFE_INTEGER, unitPriceMicros = Number.MAX_SAFE_INTEGER;
      const hugePlan = [plan({ id: planA1, tenantId: data.tenantA, effectiveAt: "2026-07-01T00:00:00.000Z", meters: { [data.meter]: [{ upTo: null, unitPriceMicros }] } })];
      const result = closeUsagePeriod({ period, plans: hugePlan, events: [usage("huge", data.tenantA, "2026-08-02T00:00:00.000Z", units)] });
      const expected = BigInt(units) * BigInt(unitPriceMicros);
      assert.equal(result.invoices[0].lines[0].chargeMicros, String(expected));
      assert.equal(result.invoices[0].subtotalMicros, String(expected));
    });
    await check("round-half-to-even-once", () => {
      const closeAt = (price) => closeUsagePeriod({ period, plans: [plan({ id: planA1, tenantId: data.tenantA, effectiveAt: "2026-07-01T00:00:00.000Z", meters: { [data.meter]: [{ upTo: null, unitPriceMicros: price }] } })], events: [usage("tie", data.tenantA, "2026-08-02T00:00:00.000Z", 1)] });
      assert.equal(closeAt(2_500_000).invoices[0].totalMinor, "2");
      assert.equal(closeAt(3_500_000).invoices[0].totalMinor, "4");
    });
    await check("invoice-shape-total-and-nested-digest", () => {
      const result = closeUsagePeriod({ period, plans: plans(), events: [usage("digest-line", data.tenantA, "2026-08-02T00:00:00.000Z", data.firstLimit + 2)] });
      assert.deepEqual(Object.keys(result), ["period", "invoices", "reversedEventIds"]);
      const { digest: observed, ...content } = result.invoices[0];
      assert.equal(observed, crypto.createHash("sha256").update(canonical(content)).digest("hex"));
      assert.equal(content.subtotalMicros, String(content.lines.reduce((sum, line) => sum + BigInt(line.chargeMicros), 0n)));
      const mutated = structuredClone(content); mutated.lines[0].allocations[0].units += 1;
      assert.notEqual(observed, crypto.createHash("sha256").update(canonical(mutated)).digest("hex"));
    });
    await check("input-immutability", () => {
      const input = { period, plans: plans(), events: [usage("valid", data.tenantA, "2026-08-02T00:00:00.000Z", 1)] };
      const before = structuredClone(input); closeUsagePeriod(input); assert.deepEqual(input, before);
      const finalInvalid = { period, plans: plans(), events: [usage("ok", data.tenantA, "2026-08-02T00:00:00.000Z", 1), usage("bad", data.tenantA, period.end, 1)] };
      const finalBefore = structuredClone(finalInvalid); assert.throws(() => closeUsagePeriod(finalInvalid), TypeError); assert.deepEqual(finalInvalid, finalBefore);
    });
    await check("event-validation", () => {
      for (const invalid of [
        { ...usage("x", data.tenantA, period.end, 1) },
        { ...usage("x", data.tenantA, "2026-08-02T00:00:00.000Z", 1), extra: true },
        { ...usage("x", data.tenantA, "2026-08-02T00:00:00.000Z", 1), units: Number.MAX_SAFE_INTEGER + 1 }
      ]) assert.throws(() => closeUsagePeriod({ period, plans: plans(), events: [invalid] }), TypeError);
    });
    await check("missing-plan-or-meter-fails-closed", () => {
      assert.throws(() => closeUsagePeriod({
        period,
        plans: plans(),
        events: [usage("missing-meter", data.tenantA, "2026-08-02T00:00:00.000Z", 1, "missing-meter")]
      }), TypeError);
      assert.throws(() => closeUsagePeriod({
        period,
        plans: plans(),
        events: [usage("missing-plan", "tenant-without-plan", "2026-08-02T00:00:00.000Z", 1)]
      }), TypeError);
    });
    await check("non-json-and-poison-values-rejected", () => {
      const sparse = []; sparse.length = 1;
      assert.throws(() => normalizePlanTimeline(sparse, period), TypeError);
      const poisonedMeters = JSON.parse(`{"__proto__":[{"upTo":null,"unitPriceMicros":1}]}`);
      assert.throws(() => normalizePlanTimeline([plan({ id: planA1, tenantId: data.tenantA, effectiveAt: "2026-07-01T00:00:00.000Z", meters: poisonedMeters })], period), TypeError);
      const invalidPrice = plans(); invalidPrice[0].meters[data.meter][0].unitPriceMicros = Number.NaN;
      assert.throws(() => normalizePlanTimeline(invalidPrice, period), TypeError);
      const accessorPeriod = { end: period.end }; Object.defineProperty(accessorPeriod, "start", { enumerable: true, get: () => period.start });
      assert.throws(() => normalizePlanTimeline(plans(), accessorPeriod), TypeError);
      const symbolPlan = plans()[0]; symbolPlan[Symbol("hidden")] = true;
      assert.throws(() => normalizePlanTimeline([symbolPlan], period), TypeError);
    });
    await check("terminal-webui-summary-format-parity", () => {
      const result = closeUsagePeriod({ period, plans: plans(), events: [usage("summary", data.tenantA, "2026-08-02T00:00:00.000Z", 1)] });
      const invoice = result.invoices[0];
      assert.equal(billingSummary(result), [
        `period=${period.start}..${period.end}; invoices=1; reversed=0`,
        `tenant=${JSON.stringify(data.tenantA)}; currency=USD; lines=1; subtotalMicros=${invoice.subtotalMicros}; totalMinor=${invoice.totalMinor}; digest=${invoice.digest}`
      ].join("\n"));
    });
    await check("terminal-webui-summary-rejects-malformed-result", () => {
      const result = closeUsagePeriod({ period, plans: plans(), events: [usage("summary-invalid", data.tenantA, "2026-08-02T00:00:00.000Z", 1)] });
      const invoice = result.invoices[0];
      assert.throws(() => billingSummary({ ...result, invoices: [{ ...invoice, digest: "wrong" }] }), TypeError);
    });
    break;
  }
  default: throw new Error(`unsupported deep logic scenario ${scenario}`);
}

const passed = checks.length > 0 && checks.every((item) => item.passed);
process.stdout.write(`${JSON.stringify({ passed, score: passed ? 10 : 0, checks })}\n`);
