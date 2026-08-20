import assert from "node:assert/strict";
import { test } from "node:test";

import { planConfigTransaction } from "../src/config-transaction.js";
import { buildContextPack } from "../src/context-pack.js";
import { reconcileSession } from "../src/event-reconcile.js";
import { decideAccess } from "../src/policy.js";
import { scheduleJobs } from "../src/scheduler.js";
import { assembleStream } from "../src/stream.js";

test("every benchmark entrypoint loads before private grading", () => {
  for (const entrypoint of [
    planConfigTransaction,
    buildContextPack,
    reconcileSession,
    decideAccess,
    scheduleJobs,
    assembleStream
  ]) assert.equal(typeof entrypoint, "function");
});
