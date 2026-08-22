import assert from "node:assert/strict";
import { test } from "node:test";

import { billingSummary } from "../apps/admin/src/billing-summary.js";
import { closeUsagePeriod } from "../packages/billing/src/close-period.js";
import { normalizePlanTimeline } from "../packages/billing/src/plan-timeline.js";
import { planConfigTransaction } from "../src/config-transaction.js";
import { buildContextPack } from "../src/context-pack.js";
import { reconcileSession } from "../src/event-reconcile.js";
import { decideAccess } from "../src/policy.js";
import { scheduleJobs } from "../src/scheduler.js";
import { assembleStream } from "../src/stream.js";

const scenario = process.env.PIAGENT_BENCHMARK_SCENARIO;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

test("the selected benchmark entrypoint handles a fixed public happy path", { skip: !scenario }, () => {
  switch (scenario) {
    case "revision-event-reconciliation": {
      const snapshot = { revision: "r0", nextSequence: 1, state: { keep: true } };
      const events = [{ id: "e1", sequence: 1, baseRevision: "r0", revision: "r1", patch: { value: 1 } }];
      const before = structuredClone([snapshot, events]);
      assert.equal(canonicalJson(reconcileSession(snapshot, events)), canonicalJson({
        revision: "r1",
        nextSequence: 2,
        state: { keep: true, value: 1 },
        appliedIds: ["e1"],
        duplicateIds: [],
        pending: [],
        gap: null
      }));
      assert.deepEqual([snapshot, events], before);
      break;
    }
    case "fair-dependency-scheduler": {
      const jobs = [{ id: "job-1", tenant: "tenant-a", weight: 1, dependsOn: [] }];
      const before = structuredClone(jobs);
      assert.deepEqual(scheduleJobs(jobs, 1), [["job-1"]]);
      assert.deepEqual(jobs, before);
      break;
    }
    case "layered-policy-resolution": {
      const result = decideAccess({ path: "lib/tool.js", operation: "inspect" }, [
        { name: "local", rules: [{ pattern: "lib/*", operations: ["inspect"], effect: "allow" }] }
      ]);
      assert.equal(result.allowed, true);
      assert.equal(result.effect, "allow");
      assert.equal(result.layer, "local");
      assert.equal(result.ruleIndex, 0);
      assert.equal(result.protected, false);
      assert.equal(typeof result.reason, "string");
      break;
    }
    case "budgeted-context-graph": {
      const nodes = [{ id: "note", path: "notes/item.txt", text: "Needle note", tokens: 1 }];
      const before = structuredClone(nodes);
      const result = buildContextPack(
        "needle",
        nodes,
        [],
        1
      );
      assert.deepEqual(result.selected.map((item) => item.id), ["note"]);
      assert.equal(result.selected[0].directScore, 1);
      assert.equal(result.selected[0].score, 1);
      assert.equal(result.usedTokens, 1);
      assert.deepEqual(result.omitted, []);
      assert.equal(result.confidence, "high");
      assert.deepEqual(nodes, before);
      break;
    }
    case "resumable-stream-assembly": {
      const snapshot = { cursor: 0, messages: [] };
      const events = [{ cursor: 1, messageId: "m1", offset: 0, text: "hello", complete: true }];
      const before = structuredClone([snapshot, events]);
      assert.equal(canonicalJson(assembleStream(snapshot, events)), canonicalJson({
        cursor: 1,
        messages: [{ id: "m1", text: "hello", complete: true }],
        appliedCursors: [1],
        replayedCursors: [],
        buffered: [],
        gap: null
      }));
      assert.deepEqual([snapshot, events], before);

      const openSnapshot = { cursor: 0, messages: [{ id: "open", text: "ready", complete: false }] };
      const emptyFinal = [{ cursor: 1, messageId: "open", offset: 5, text: "", complete: true }];
      assert.equal(canonicalJson(assembleStream(openSnapshot, emptyFinal)), canonicalJson({
        cursor: 1,
        messages: [{ id: "open", text: "ready", complete: true }],
        appliedCursors: [1],
        replayedCursors: [],
        buffered: [],
        gap: null
      }));

      const completedSnapshot = { cursor: 0, messages: [{ id: "done", text: "ready", complete: true }] };
      const completedEvents = [{ cursor: 1, messageId: "done", offset: 5, text: "", complete: true }];
      assert.throws(() => assembleStream(completedSnapshot, completedEvents));
      break;
    }
    case "transactional-config-merge": {
      const base = { label: "old", legacy: true };
      const layers = [{ label: "new", legacy: { $delete: true } }];
      const schema = {
        label: { type: "string", required: true },
        legacy: { type: "boolean" }
      };
      const before = structuredClone([base, layers, schema]);
      const result = planConfigTransaction(
        base,
        layers,
        schema
      );
      assert.equal(canonicalJson(result.next), canonicalJson({ label: "new" }));
      assert.ok(result.changes.some((item) => item.path === "/label" && item.kind === "replace"));
      assert.ok(result.changes.some((item) => item.path === "/legacy" && item.kind === "delete"));
      assert.match(result.digest, /^[a-f0-9]{64}$/);
      assert.deepEqual([base, layers, schema], before);
      break;
    }
    case "temporal-usage-billing-close": {
      const period = { start: "2025-01-01T00:00:00.000Z", end: "2025-02-01T00:00:00.000Z" };
      const plans = [{
        id: "basic",
        tenantId: "customer-1",
        currency: "USD",
        effectiveAt: "2024-12-01T00:00:00.000Z",
        meters: { requests: [{ upTo: null, unitPriceMicros: 1_000_000 }] }
      }];
      const normalized = normalizePlanTimeline(plans, period);
      assert.equal(canonicalJson(normalized), canonicalJson(plans));
      assert.notEqual(normalized[0], plans[0]);
      const result = closeUsagePeriod({
        period,
        plans,
        events: [{
          id: "usage-1",
          kind: "usage",
          tenantId: "customer-1",
          meter: "requests",
          at: "2025-01-02T00:00:00.000Z",
          units: 2
        }]
      });
      assert.equal(result.invoices.length, 1);
      assert.equal(result.invoices[0].subtotalMicros, "2000000");
      assert.equal(result.invoices[0].totalMinor, "2");
      assert.match(result.invoices[0].digest, /^[a-f0-9]{64}$/);
      assert.deepEqual(billingSummary(result).split("\n"), [
        `period=${period.start}..${period.end}; invoices=1; reversed=0`,
        `tenant="customer-1"; currency=USD; lines=1; subtotalMicros=2000000; totalMinor=2; digest=${result.invoices[0].digest}`
      ]);
      break;
    }
    default:
      assert.fail(`unsupported benchmark scenario ${scenario}`);
  }
});
