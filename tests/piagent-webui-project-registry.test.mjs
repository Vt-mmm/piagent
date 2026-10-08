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
  // Windows has no POSIX modes.
  if (process.platform !== "win32") assert.equal(fs.statSync(registry.file).mode & 0o777, 0o600);
});

it("fails closed for root folders and corrupt durable registries", () => {
  const value = fixture(), registry = new ProjectRegistry(value.state, value.key);
  assert.throws(() => registry.register(path.parse(value.project).root), /project-import-folder-invalid/);
  fs.writeFileSync(registry.file, '{"version":"piagent-project-registry-v1","projects":[{"cwd":"/tmp/raw"}]}\n', { mode: 0o600 });
  assert.throws(() => registry.list(), /project-registry-content-invalid/);
});

// The new-conversation menu lists folders by name; two with the same name
// (two clones of one repository) also show where each one is.
it("tells same-name projects apart by their parent folders", async () => {
  const { projectLocations } = await import("../packages/piagent-webui/gateway/session-inspection-registry.ts");
  const home = process.env.HOME;
  assert.deepEqual(projectLocations([`${home}/work/shop`, `${home}/work/clones/a/shop`, `${home}/work/clones/b/shop`]),
    ["…/work/shop", "…/a/shop", "…/b/shop"]);
  // Two last folders alike: as many as it takes.
  assert.deepEqual(projectLocations(["/srv/a/x/y", "/srv/b/x/y"]), ["…/a/x/y", "…/b/x/y"]);
  assert.deepEqual(projectLocations([home, `${home}/code`, "/tmp"]), ["~", "~/code", "/tmp"]);
});

// The list of added folders never refuses a new one: a full list forgets
// folders gone from the disk first, then the folders added longest ago; a
// folder added again moves to the newest place.
it("makes room for a new folder when the list is full", () => {
  const value = fixture(), registry = new ProjectRegistry(value.state, value.key);
  const folder = (name) => { const dir = path.join(value.root, name); fs.mkdirSync(dir); return dir; };
  const first = registry.register(folder("first"), new Date("2026-01-01T00:00:00.000Z"));
  const gone = folder("gone"); registry.register(gone, new Date("2026-01-02T00:00:00.000Z"));
  for (let index = 0; index < 197; index += 1) registry.register(folder(`lab-${index}`), new Date(Date.UTC(2026, 1, 1, 0, index)));
  const kept = registry.register(folder("kept"), new Date("2026-03-01T00:00:00.000Z"));
  assert.equal(registry.list().length, 200);
  fs.rmSync(gone, { recursive: true });
  // Added again, "first" is now the newest.
  registry.register(value.root + "/first", new Date("2026-04-01T00:00:00.000Z"));
  const fe = registry.register(folder("FE"), new Date("2026-04-02T00:00:00.000Z"));
  let labels = registry.list().map((item) => item.label);
  assert.equal(labels.length, 200);
  assert.equal(labels.includes("gone"), false, "a folder gone from the disk is forgotten first");
  assert.deepEqual(labels.slice(-2), ["first", "FE"]);
  assert.ok(registry.resolve(fe.projectRef) && registry.resolve(first.projectRef) && registry.resolve(kept.projectRef));
  registry.register(folder("BE"), new Date("2026-04-03T00:00:00.000Z"));
  labels = registry.list().map((item) => item.label);
  assert.equal(labels.length, 200);
  assert.equal(labels.includes("lab-0"), false, "then the folder added longest ago");
  assert.deepEqual(labels.slice(-3), ["first", "FE", "BE"]);
});
