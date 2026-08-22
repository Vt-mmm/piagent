import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { adaptActivityTelemetryEvent, runtimeStartedEventDraft } from "../packages/piagent-core/runtime/inspection/activity-event-adapter.ts";
import { RuntimeEventStore } from "../packages/piagent-core/runtime/inspection/runtime-event-store.ts";
import { buildWebUiInspectionProjection } from "../packages/piagent-core/runtime/inspection/webui-snapshot.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";

const revision = { runtimeRevision: "runtime_rev_01", taskRevision: null, controlRevision: null, workspaceRevision: null,
  indexRevision: null, approvalRevision: null, sessionOptionRevision: null, queueRevision: null };
const identity = { projectRef: "project_01", runtimeInstanceId: "runtime_01", sessionRef: "session_01", taskId: "task_01", taskRunId: "task_run_01" };
const registry = createWebUiSchemaRegistry();

function root() { return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-events-")); }
function store(projectRoot, overrides = {}) {
  return new RuntimeEventStore({ projectRoot, projectRef: identity.projectRef, runtimeInstanceId: identity.runtimeInstanceId,
    sessionRef: identity.sessionRef, maxEventsPerSegment: 2, maxSegments: 2, ...overrides });
}
function at(index) { return `2026-08-13T14:00:${String(index).padStart(2, "0")}.000Z`; }
function activity(index, event = "tool_call", overrides = {}, native = false) {
  return adaptActivityTelemetryEvent({ identity: { ...identity, agentOperationId: native ? "host-operation-01" : null }, revision,
    event: { activityId: `${event}-${index}`, event, toolCallId: `tool-${index}`, toolName: index % 2 ? "bash" : "read",
      command: index % 2 ? `npm test -- ${index}` : undefined, targetPath: index % 2 ? undefined : `src/file-${index}.ts`, recordedAt: at(index), ...overrides } });
}
function expectSchema(event) {
  const result = validateFixture(registry, "runtime-event-v2", event);
  assert.equal(result.valid, true, result.errors);
}

describe("Piagent WebUI runtime event store", () => {
  it("normalizes legacy/native activity truth into strict event-v2 without inventing operation identity", () => {
    const projectRoot = root(), events = store(projectRoot);
    const started = events.append(runtimeStartedEventDraft({ identity, revision, sourceObservedAt: at(0), buildRef: "build_01", capabilitySnapshotRef: "capabilities_01" }), at(0)).event;
    const legacy = events.append(activity(1), at(1)).event;
    const native = events.append(activity(2, "tool_call", {}, true), at(2)).event;
    const failed = events.append(activity(3, "tool_result", { exitCode: 1, isError: true }, true), at(3)).event;
    const blocked = events.append(activity(4, "tool_decision", { decision: "blocked", reason: "operator denied" }), at(4)).event;
    for (const event of [started, legacy, native, failed, blocked]) expectSchema(event);
    assert.equal(legacy.kind, "activity.requested");
    assert.equal(native.kind, "activity.requested");
    assert.equal(legacy.payload.activityType, "command");
    assert.equal(legacy.agentOperationId, null);
    assert.equal(legacy.toolCallId, null);
    assert.equal(native.payload.activityType, "tool");
    assert.match(native.agentOperationId, /^operation\./);
    assert.match(native.toolCallId, /^tool\./);
    assert.equal(failed.kind, "activity.failed");
    assert.equal(failed.payload.reasonCode, "tool-result-failed");
    const missing = events.append(activity(5, "tool_result", { isError: true, reasonCode: "target-not-found" }, true), at(5)).event;
    assert.equal(missing.payload.reasonCode, "target-not-found");
    assert.equal(blocked.kind, "activity.blocked");
  });

  it("is idempotent, monotonic and supports bounded replay from an exact cursor", () => {
    const projectRoot = root(), events = store(projectRoot, { maxEventsPerSegment: 10 });
    const firstDraft = activity(1), first = events.append(firstDraft, at(1));
    const duplicate = events.append(firstDraft, at(2));
    assert.equal(first.appended, true); assert.equal(duplicate.appended, false);
    assert.equal(duplicate.event.writerSequence, 1);
    const second = events.append(activity(2), at(2)).event;
    const third = events.append(activity(3), at(3)).event;
    assert.deepEqual([first.event.writerSequence, second.writerSequence, third.writerSequence], [1, 2, 3]);
    const page = events.replay(first.event.eventCursor, 1);
    assert.equal(page.state, "truncated");
    assert.deepEqual(page.events.map((event) => event.writerSequence), [2]);
    const tail = events.replay(page.nextCursor, 10);
    assert.equal(tail.state, "current");
    assert.deepEqual(tail.events.map((event) => event.writerSequence), [3]);
    assert.equal(tail.latestCursor, third.eventCursor);
    const segment = fs.readdirSync(events.directory).find((file) => file.endsWith(".jsonl"));
    assert.equal(fs.statSync(events.directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(events.directory, segment)).mode & 0o777, 0o600);
  });

  it("rotates ephemeral replay segments, detects retention gaps and resumes sequence after process reconstruction", () => {
    const projectRoot = root(), events = store(projectRoot);
    const cursors = [];
    for (let index = 1; index <= 6; index += 1) cursors.push(events.append(activity(index), at(index)).event.eventCursor);
    assert.deepEqual(fs.readdirSync(events.directory).filter((file) => file.endsWith(".jsonl")).sort(), ["segment.000000000003.jsonl", "segment.000000000005.jsonl"]);
    const gap = events.replay(cursors[0], 10);
    assert.equal(gap.state, "resync-required"); assert.equal(gap.reasonCode, "event-cursor-gap");
    assert.equal(gap.firstAvailableSequence, 3); assert.equal(gap.lastAvailableSequence, 6);
    const reconstructed = store(projectRoot);
    assert.equal(reconstructed.resyncRequired(), false);
    const seventh = reconstructed.append(activity(7), at(7)).event;
    assert.equal(seventh.writerSequence, 7);
    expectSchema(seventh);
  });

  it("fails closed on an incomplete/corrupt segment and never appends over it", () => {
    const projectRoot = root(), events = store(projectRoot);
    events.append(activity(1), at(1));
    const segment = path.join(events.directory, fs.readdirSync(events.directory).find((file) => file.endsWith(".jsonl")));
    fs.appendFileSync(segment, "{\"partial\":");
    const reconstructed = store(projectRoot);
    assert.equal(reconstructed.resyncRequired(), true);
    assert.equal(reconstructed.replay(null).state, "resync-required");
    assert.throws(() => reconstructed.append(activity(2), at(2)), /requires resync/);
  });

  it("rejects unexpected entries and symlinked segments instead of reading attacker-controlled state", () => {
    const unexpectedRoot = root(), unexpected = store(unexpectedRoot);
    unexpected.append(activity(1), at(1));
    fs.writeFileSync(path.join(unexpected.directory, "foreign-state"), "not an event segment\n");
    const withUnexpectedEntry = store(unexpectedRoot);
    assert.equal(withUnexpectedEntry.resyncRequired(), true);
    assert.equal(withUnexpectedEntry.replay(null).reasonCode, "event-store-directory-unavailable");

    const symlinkRoot = root(), symlinked = store(symlinkRoot);
    symlinked.append(activity(1), at(1));
    const external = path.join(symlinkRoot, "external.jsonl");
    fs.writeFileSync(external, "{}\n");
    fs.symlinkSync(external, path.join(symlinked.directory, "segment.000000000002.jsonl"));
    const withSymlink = store(symlinkRoot);
    assert.equal(withSymlink.resyncRequired(), true);
    assert.equal(withSymlink.replay(null).reasonCode, "event-store-corrupt");
  });

  it("binds fresh snapshot resync state and cursor without a provider turn", async () => {
    const projectRoot = root();
    execFileSync("git", ["init", "-q", projectRoot]);
    execFileSync("git", ["-C", projectRoot, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", projectRoot, "config", "user.name", "Piagent Test"]);
    fs.writeFileSync(path.join(projectRoot, "README.md"), "fixture\n");
    execFileSync("git", ["-C", projectRoot, "add", "."]); execFileSync("git", ["-C", projectRoot, "commit", "-qm", "fixture"]);
    const events = store(projectRoot), current = events.append(activity(1), at(1)).event.eventCursor;
    const projection = await buildWebUiInspectionProjection({ cwd: projectRoot, sessionId: "private-session", runtimeInstanceId: identity.runtimeInstanceId,
      eventCursor: current, resyncRequired: true, generatedAt: at(2) });
    assert.equal(projection.snapshot.revision.eventCursor, current);
    assert.equal(projection.snapshot.health.resyncRequired, true);
    assert.equal(projection.snapshot.session.connectionState, "resync-required");
    assert.equal(projection.snapshot.capabilities.compatibility.state, "resync-required");
    const result = validateFixture(registry, "snapshot-v1", projection.snapshot);
    assert.equal(result.valid, true, result.errors);
  });
});
