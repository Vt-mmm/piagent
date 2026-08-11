import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  readRuntimeSnapshotTelemetry,
  recordRuntimeSnapshotTelemetry,
  runtimeSnapshotTelemetryPath
} from "../packages/piagent-core/runtime/model/snapshot-telemetry.ts";

const roots = new Set();
const capturedAt = "2026-08-08T00:00:00.000Z";

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-snapshot-"));
  roots.add(root);
  return root;
}

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    capturedAt,
    source: "pi-runtime",
    piHostVersion: "0.82.0",
    piagentVersion: "1.2.17",
    provider: "openai-codex",
    modelId: "gpt-5.6-terra",
    availability: "unknown",
    contextWindow: 200_000,
    requestedThinkingLevel: null,
    effectiveThinkingLevel: "medium",
    supportedThinkingLevels: null,
    capabilities: [],
    provenance: [{ field: "modelId", source: "pi-runtime", capturedAt }],
    warnings: [],
    ...overrides
  };
}

describe("runtime snapshot telemetry", () => {
  it("writes owner-only bounded state once per material snapshot", () => {
    const cwd = project();
    assert.equal(recordRuntimeSnapshotTelemetry(cwd, snapshot(), { recordedAt: capturedAt }).written, true);
    assert.equal(recordRuntimeSnapshotTelemetry(cwd, snapshot({ capturedAt: "2026-08-08T01:00:00.000Z" })).written, false);
    assert.equal(recordRuntimeSnapshotTelemetry(cwd, snapshot({ modelId: "gpt-5.6-sol" })).written, true);
    const view = readRuntimeSnapshotTelemetry(cwd);
    assert.equal(view.records.length, 2);
    assert.equal(view.latest.snapshot.modelId, "gpt-5.6-sol");
    assert.equal(fs.statSync(runtimeSnapshotTelemetryPath(cwd)).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(runtimeSnapshotTelemetryPath(cwd))).mode & 0o777, 0o700);
  });

  it("redacts diagnostic secrets before storage", () => {
    const cwd = project();
    recordRuntimeSnapshotTelemetry(cwd, snapshot({ warnings: ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz"] }));
    assert.doesNotMatch(fs.readFileSync(runtimeSnapshotTelemetryPath(cwd), "utf8"), /abcdefghijklmnopqrstuvwxyz/);
  });

  it("reports corruption and refuses to extend it without blocking the caller", () => {
    const cwd = project();
    recordRuntimeSnapshotTelemetry(cwd, snapshot());
    fs.appendFileSync(runtimeSnapshotTelemetryPath(cwd), "not-json\n");
    const result = recordRuntimeSnapshotTelemetry(cwd, snapshot({ modelId: "other" }));
    assert.equal(result.written, false);
    assert.match(result.corruptions.join("; "), /invalid JSON|Unexpected token/);
    assert.equal(readRuntimeSnapshotTelemetry(cwd).routingSafe, false);
  });

  it("refuses a symlinked state boundary", () => {
    const cwd = project();
    const outside = project();
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.symlinkSync(outside, path.join(cwd, ".pi", "piagent-state"));
    const result = recordRuntimeSnapshotTelemetry(cwd, snapshot());
    assert.equal(result.written, false);
    assert.match(result.corruptions.join("; "), /unsafe/);
    assert.equal(fs.readdirSync(outside).length, 0);
  });
});
