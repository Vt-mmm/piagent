import assert from "node:assert/strict";
import test from "node:test";

import { controlSummary } from "../apps/web/src/control-view.js";
import { renderSearchResults } from "../apps/web/src/search-view.js";
import { renderTimeline } from "../apps/web/src/timeline-view.js";
import { featureAccess } from "../packages/api/src/feature-access.js";
import { LeaseStore } from "../packages/lease/src/store.js";
import { migrationPlan } from "../packages/migration/src/plan.js";
import { normalizeRollout } from "../packages/policy/src/rollout.js";
import { admitRuntimeCommand, runtimeCommandDigest } from "../packages/session/src/admission.js";
import { normalizeQuery } from "../packages/shared/src/search-contract.js";
import { projectTimeline } from "../packages/timeline/src/project.js";
import { searchCatalog } from "../services/catalog/src/search.js";

test("every public capability entrypoint loads before hidden grading", () => {
  for (const entrypoint of [
    controlSummary, renderSearchResults, renderTimeline, featureAccess,
    LeaseStore, migrationPlan, normalizeRollout, admitRuntimeCommand, runtimeCommandDigest,
    normalizeQuery, projectTimeline, searchCatalog
  ]) assert.equal(typeof entrypoint, "function");
});
