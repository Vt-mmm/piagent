import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";

import { ProjectRegistry } from "../packages/piagent-webui/gateway/project-registry.ts";

const roots = new Set();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-project-registry-")); roots.add(root);
  const state = path.join(root, "state"), project = path.join(root, "example-project");
  fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(project);
  return { root, state, project, key: Buffer.alloc(32, 7) };
}

it("persists imported folders owner-only and exposes only opaque project projections", () => {
  const value = fixture(), registry = new ProjectRegistry(value.state, value.key);
  const projection = registry.register(value.project, new Date("2026-08-14T10:00:00.000Z"));
  assert.match(projection.projectRef, /^project_/); assert.equal(projection.placeRef, projection.projectRef);
  assert.equal(projection.label, "example-project"); assert.equal(JSON.stringify(projection).includes(value.project), false);
  assert.equal(registry.resolve(projection.projectRef), fs.realpathSync(value.project));
  assert.deepEqual(new ProjectRegistry(value.state, value.key).list(), [projection]);
  assert.equal(fs.statSync(registry.file).mode & 0o777, 0o600);
});

it("fails closed for root folders and corrupt durable registries", () => {
  const value = fixture(), registry = new ProjectRegistry(value.state, value.key);
  assert.throws(() => registry.register(path.parse(value.project).root), /project-import-folder-invalid/);
  fs.writeFileSync(registry.file, '{"version":"piagent-project-registry-v1","projects":[{"cwd":"/tmp/raw"}]}\n', { mode: 0o600 });
  assert.throws(() => registry.list(), /project-registry-content-invalid/);
});
