import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { appendTaskJournalEvent, readTaskJournal, taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import {
  AUTHORITY_RESUME_EVENT_TYPE,
  authorityReplacementState,
  ensureTaskAuthorityResumePolicy,
  inspectTaskAuthorityResumePolicy
} from "../packages/piagent-core/runtime/policy/authority-resume-policy.ts";

const roots = new Set();
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-authority-resume-"));
  roots.add(root);
  return root;
}

function task(profile = "broad-default", suffix = "one") {
  const carrier = {
    taskId: `task-${suffix}`,
    taskRunId: `run-${suffix}`,
    createdAt: "2026-08-10T12:00:00.000Z",
    sessionId: `session-${suffix}`,
    sessionName: `TASK-${suffix.toUpperCase()}`
  };
  return { ...carrier, authoritySnapshot: createBoundTaskAuthority({ ...carrier, profile }), trace: { outcome: "pending" } };
}

describe("pinned authority rollback and resume policy", () => {
  it("resumes the exact pinned snapshot despite non-kill-switch profile drift", () => {
    const cwd = project(), broad = task("broad-default", "pinned");
    const bytes = JSON.stringify(broad.authoritySnapshot);
    assert.deepEqual(inspectTaskAuthorityResumePolicy(cwd, broad, { authorityProfile: "strict-high-risk" }), {
      policyVersion: "authority-resume-v1",
      disposition: "resume-pinned",
      enforcementSafe: true,
      reason: "compatible",
      pinnedProfile: "broad-default",
      requestedProfile: "strict-high-risk",
      killedCapabilities: [],
      persisted: false,
      recordedAt: null
    });
    assert.equal(JSON.stringify(broad.authoritySnapshot), bytes);
    assert.equal(readTaskJournal(cwd).events.length, 0);
    const strict = task("strict-high-risk", "downgrade");
    const downgraded = inspectTaskAuthorityResumePolicy(cwd, strict, { authorityProfile: "broad-default" });
    assert.equal(downgraded.disposition, "resume-pinned");
    assert.equal(downgraded.pinnedProfile, "strict-high-risk");
    assert.equal(downgraded.requestedProfile, "broad-default");
  });

  it("persists mechanical rollback once and never reopens the old active task", () => {
    const cwd = project(), strict = task("strict-high-risk", "mechanical"), bytes = JSON.stringify(strict);
    const stopped = ensureTaskAuthorityResumePolicy(cwd, strict, {
      authorityProfile: "mechanical-only",
      recordedAt: "2026-08-10T12:01:00.000Z"
    });
    assert.equal(stopped.disposition, "new-attempt-required");
    assert.equal(stopped.reason, "mechanical-rollback-requested");
    assert.equal(stopped.persisted, true);
    assert.equal(JSON.stringify(strict), bytes, "the pinned Task Contract remains byte-equivalent in memory");
    const resumed = inspectTaskAuthorityResumePolicy(cwd, structuredClone(strict), { authorityProfile: "strict-high-risk" });
    assert.equal(resumed.disposition, "new-attempt-required");
    assert.equal(resumed.reason, "mechanical-rollback-requested");
    assert.equal(authorityReplacementState(cwd, strict).required, true);
    assert.equal(readTaskJournal(cwd, { taskRunId: strict.taskRunId }).events.filter((event) => event.eventType === AUTHORITY_RESUME_EVENT_TYPE).length, 1);
    ensureTaskAuthorityResumePolicy(cwd, strict, { authorityProfile: "mechanical-only" });
    assert.equal(readTaskJournal(cwd, { taskRunId: strict.taskRunId }).events.filter((event) => event.eventType === AUTHORITY_RESUME_EVENT_TYPE).length, 1);
  });

  it("treats explicit feature off values as durable per-capability kill switches", () => {
    const cwd = project(), strict = task("strict-high-risk", "kills");
    const stopped = ensureTaskAuthorityResumePolicy(cwd, strict, {
      environment: { PIAGENT_PHASE_TOOLS: "off", PIAGENT_AUTO_RECOVERY: "0", PIAGENT_HELPERS_MODE: "disabled" },
      recordedAt: "2026-08-10T12:02:00.000Z"
    });
    assert.equal(stopped.reason, "capability-kill-switch-requested");
    assert.deepEqual(stopped.killedCapabilities, ["CAP-09", "CAP-12", "CAP-14"]);
    const later = inspectTaskAuthorityResumePolicy(cwd, strict, { environment: { PIAGENT_PHASE_TOOLS: "on", PIAGENT_AUTO_RECOVERY: "on" } });
    assert.equal(later.disposition, "new-attempt-required");
    assert.deepEqual(later.killedCapabilities, ["CAP-09", "CAP-12", "CAP-14"]);
  });

  it("rolls acceptance and semantic enforcement back independently without changing phase or recovery", () => {
    const assuranceRoot = project(), assuranceTask = task("strict-high-risk", "assurance-off");
    const assurance = ensureTaskAuthorityResumePolicy(assuranceRoot, assuranceTask, {
      environment: { PIAGENT_ACCEPTANCE_ASSURANCE: "off" },
      recordedAt: "2026-08-10T12:02:10.000Z"
    });
    assert.equal(assurance.reason, "capability-kill-switch-requested");
    assert.deepEqual(assurance.killedCapabilities, ["CAP-11"]);
    const semanticRoot = project(), semanticTask = task("strict-high-risk", "semantic-off");
    const semantic = ensureTaskAuthorityResumePolicy(semanticRoot, semanticTask, {
      environment: { PIAGENT_SEMANTIC_REPAIR: "disabled" },
      recordedAt: "2026-08-10T12:02:20.000Z"
    });
    assert.equal(semantic.reason, "capability-kill-switch-requested");
    assert.deepEqual(semantic.killedCapabilities, ["CAP-13"]);
    for (const [root, current] of [[assuranceRoot, assuranceTask], [semanticRoot, semanticTask]]) {
      assert.equal(readTaskJournal(root, { taskRunId: current.taskRunId }).events.filter((event) => event.eventType === AUTHORITY_RESUME_EVENT_TYPE).length, 1);
    }
  });

  it("requires a new attempt for missing, unknown, drifted, invalid, or cross-task snapshots", () => {
    const cases = [
      ["missing-task-snapshot", (value) => { delete value.authoritySnapshot; }],
      ["unknown-snapshot-version", (value) => { value.authoritySnapshot.snapshotVersion = "authority-snapshot-v2"; }],
      ["unknown-manifest-version", (value) => { value.authoritySnapshot.manifestVersion = "authority-v2"; }],
      ["manifest-digest-mismatch", (value) => { value.authoritySnapshot.manifestDigest = `sha256:${"f".repeat(64)}`; }],
      ["invalid-snapshot", (value) => { value.authoritySnapshot.capabilities[0].authority = "off"; }],
      ["task-identity-mismatch", (value) => { value.authoritySnapshot.taskRunId = "other-run"; }]
    ];
    for (const [reason, mutate] of cases) {
      const cwd = project(), current = structuredClone(task("broad-default", reason));
      mutate(current);
      const result = inspectTaskAuthorityResumePolicy(cwd, current);
      assert.equal(result.disposition, "new-attempt-required", reason);
      assert.equal(result.reason, reason);
      assert.equal(ensureTaskAuthorityResumePolicy(cwd, current).persisted, true);
    }
  });

  it("fails closed for stale disposition identity and corrupt journal tails", () => {
    const staleRoot = project(), current = task("broad-default", "stale");
    appendTaskJournalEvent(staleRoot, {
      eventType: AUTHORITY_RESUME_EVENT_TYPE,
      taskId: current.taskId,
      taskRunId: current.taskRunId,
      sessionId: current.sessionId,
      idempotencyKey: `sha256:${"a".repeat(64)}`,
      data: {
        policyVersion: "authority-resume-v1",
        taskCreatedAt: current.createdAt,
        authoritySnapshotDigest: `sha256:${"b".repeat(64)}`,
        reason: "mechanical-rollback-requested",
        requestedProfile: "mechanical-only",
        killedCapabilities: []
      }
    });
    assert.deepEqual(authorityReplacementState(staleRoot, current), {
      required: false,
      enforcementSafe: false,
      reason: "authority-resume-state-invalid",
      recordedAt: null,
      requestedProfile: null,
      killedCapabilities: []
    });
    assert.equal(inspectTaskAuthorityResumePolicy(staleRoot, current).disposition, "blocked");

    const corruptRoot = project(), corrupt = task("broad-default", "corrupt");
    ensureTaskAuthorityResumePolicy(corruptRoot, corrupt, { authorityProfile: "mechanical-only" });
    fs.appendFileSync(taskJournalPaths(corruptRoot).events, "{bad-json}\n");
    assert.equal(inspectTaskAuthorityResumePolicy(corruptRoot, corrupt).reason, "authority-journal-corrupt");
    assert.equal(authorityReplacementState(corruptRoot, corrupt).enforcementSafe, false);
  });
});
