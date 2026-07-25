import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  digestDirectory,
  resolveCapabilitySourceRoots,
  validateCapabilitySources,
  vendorDirectoryFor
} from "../packages/piagent-core/capabilities/capability-sources.js";
import { resolveCapabilityProfileDocument, scanCapabilityPacks } from "../packages/piagent-core/capabilities/capability-core.js";

const platformRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-sources-"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, undefined, 2)}\n`);
}

// A minimal but complete external pack. Written out rather than copied so the
// tests state exactly what an outside contributor has to produce.
function writeExternalPack(root, overrides = {}) {
  const metadata = {
    name: "acme-delivery",
    version: "1.0.1",
    owner: "acme",
    lifecycle: "experimental",
    license: "MIT",
    description: "External pack used to exercise third-party resolution.",
    tags: ["delivery"],
    ...overrides.metadata
  };
  fs.mkdirSync(path.join(root, "packs", metadata.name, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(root, "packs", metadata.name, "prompts", "ship.md"), "# Ship\n");
  writeJson(path.join(root, "packs", metadata.name, "pack.json"), {
    apiVersion: "piagent/v1",
    kind: "CapabilityPack",
    metadata,
    spec: {
      coreApiVersion: 1,
      requires: { packs: [] },
      provides: {
        prompts: [{ id: "acme/ship", path: `packs/${metadata.name}/prompts/ship.md` }],
        skills: [],
        subagents: [],
        policies: [],
        adapters: [],
        recipes: [],
        evals: []
      },
      permissions: {
        capabilities: [],
        filesystemRead: [],
        filesystemWrite: [],
        networkDomains: [],
        externalActions: [],
        ...overrides.permissions
      },
      activation: { mode: "explicit", profiles: [] },
      verification: { evalScenarios: [] }
    }
  });
  return metadata;
}

function baseProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    projectId: "sources-under-test",
    displayName: "Sources under test",
    mode: "generic",
    rootMarkers: ["package.json"],
    protectedPaths: [],
    requiredContext: [],
    verifyCommands: [],
    mcpCapabilities: [],
    capabilityPacks: [{ name: "acme-delivery", version: "1.0.1" }],
    capabilityPolicy: {
      allowedOwners: ["acme"],
      allowedLifecycles: ["experimental"],
      allowedFilesystemRead: [],
      allowedFilesystemWrite: [],
      allowedNetworkDomains: [],
      allowedExternalActions: []
    },
    ...overrides
  };
}

describe("capability source declarations", () => {
  it("accepts a local path and an exact remote source", () => {
    const sources = validateCapabilitySources([
      { name: "team", path: ".pi/packs" },
      { name: "acme", source: "npm:@acme/packs@1.2.3" }
    ]);
    assert.deepEqual(sources, [
      { name: "team", path: ".pi/packs" },
      { name: "acme", source: "npm:@acme/packs@1.2.3" }
    ]);
  });

  it("refuses a source that declares both a path and a remote", () => {
    assert.throws(() => validateCapabilitySources([{ name: "team", path: ".pi/packs", source: "npm:@acme/packs@1.2.3" }]));
  });

  it("refuses a source that declares neither", () => {
    assert.throws(() => validateCapabilitySources([{ name: "team" }]));
  });

  it("refuses a floating remote version", () => {
    // Version pinning is the whole basis of the lock. A range would let the
    // resolved code change without the lock changing.
    assert.throws(() => validateCapabilitySources([{ name: "acme", source: "npm:@acme/packs@^1.2.3" }]));
    assert.throws(() => validateCapabilitySources([{ name: "acme", source: "npm:@acme/packs@latest" }]));
    assert.throws(() => validateCapabilitySources([{ name: "acme", source: "git:github.com/acme/packs@main" }]));
  });

  it("refuses a remote source carrying credentials", () => {
    assert.throws(() => validateCapabilitySources([{ name: "acme", source: "git:user:token@github.com/acme/packs@1.0.1" }]));
  });

  it("refuses a path that climbs out of the project", () => {
    assert.throws(() => validateCapabilitySources([{ name: "team", path: "../../etc" }]));
    assert.throws(() => validateCapabilitySources([{ name: "team", path: "/etc" }]));
  });

  it("refuses duplicate source names", () => {
    assert.throws(() => validateCapabilitySources([
      { name: "team", path: ".pi/packs" },
      { name: "team", path: ".pi/other" }
    ]));
  });

  it("refuses an unsupported scheme", () => {
    assert.throws(() => validateCapabilitySources([{ name: "acme", source: "file:///etc/passwd" }]));
    assert.throws(() => validateCapabilitySources([{ name: "acme", source: "https://example.com/packs/archive/refs/tags/v1.0.1.tar.gz" }]));
  });
});

describe("capability source resolution", () => {
  it("resolves a local directory that contains packs", () => {
    const project = makeProject();
    writeExternalPack(path.join(project, ".pi", "packs"));
    const roots = resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].origin, "team");
    assert.equal(roots[0].source, "./.pi/packs");
  });

  it("refuses a directory that provides no packs", () => {
    const project = makeProject();
    fs.mkdirSync(path.join(project, ".pi", "packs"), { recursive: true });
    assert.throws(
      () => resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]),
      /must contain a packs directory/
    );
  });

  it("refuses a source directory that is a symbolic link", () => {
    const project = makeProject();
    const outside = makeProject();
    writeExternalPack(outside);
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.symlinkSync(outside, path.join(project, ".pi", "packs"));
    assert.throws(
      () => resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]),
      /must not be a symbolic link/
    );
  });

  it("refuses a source tree containing a symbolic link that escapes it", () => {
    const project = makeProject();
    const outside = makeProject();
    fs.writeFileSync(path.join(outside, "secret.txt"), "token\n");
    const sourceRoot = path.join(project, ".pi", "packs");
    writeExternalPack(sourceRoot);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(sourceRoot, "packs", "acme-delivery", "escape.txt"));
    assert.throws(
      () => resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]),
      /must not contain symbolic links/
    );
  });

  it("refuses a missing vendored source rather than resolving without it", () => {
    // Silently resolving fewer packs than the profile asked for would look like
    // success while the agent runs with capabilities nobody reviewed.
    const project = makeProject();
    assert.throws(
      () => resolveCapabilitySourceRoots(project, [{ name: "acme", source: "npm:@acme/packs@1.2.3" }]),
      /does not exist/
    );
  });

  it("puts a vendored source in a predictable place", () => {
    const project = makeProject();
    assert.equal(vendorDirectoryFor(project, "acme"), path.join(project, ".pi", "capability-vendor", "acme"));
  });

  it("resolves a remote source from the tree already vendored for it", () => {
    // The half of level 2 that runs without the network: once a release is
    // vendored and committed, every later resolution is a local read.
    const project = makeProject();
    writeExternalPack(vendorDirectoryFor(project, "acme"));
    const roots = resolveCapabilitySourceRoots(project, [{ name: "acme", source: "npm:@acme/packs@1.2.3" }]);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].origin, "acme");
    // The lock pins the release the tree came from, not the directory it landed in.
    assert.equal(roots[0].source, "npm:@acme/packs@1.2.3");
  });

  it("refuses a vendored tree that a later edit turned into a symlink farm", () => {
    const project = makeProject();
    const outside = makeProject();
    fs.writeFileSync(path.join(outside, "secret.txt"), "token\n");
    const vendored = vendorDirectoryFor(project, "acme");
    writeExternalPack(vendored);
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(vendored, "packs", "acme-delivery", "leak.txt"));
    assert.throws(
      () => resolveCapabilitySourceRoots(project, [{ name: "acme", source: "npm:@acme/packs@1.2.3" }]),
      /must not contain symbolic links/
    );
  });
});

describe("resolving packs from an external source", () => {
  it("scans an external pack alongside the platform's own", () => {
    const project = makeProject();
    writeExternalPack(path.join(project, ".pi", "packs"));
    const roots = resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]);
    const records = scanCapabilityPacks(platformRoot, { extraRoots: roots });
    const external = records.find((record) => record.key === "acme-delivery@1.0.1");
    assert.ok(external, "the external pack must appear in the scan");
    assert.equal(external.origin, "team");
    assert.ok(records.some((record) => record.origin === "workspace"), "platform packs must still resolve");
  });

  it("refuses two sources providing the same pack and version", () => {
    // Otherwise load order decides which code runs.
    const project = makeProject();
    writeExternalPack(path.join(project, ".pi", "packs"));
    writeExternalPack(path.join(project, ".pi", "other"));
    const roots = resolveCapabilitySourceRoots(project, [
      { name: "team", path: ".pi/packs" },
      { name: "mirror", path: ".pi/other" }
    ]);
    assert.throws(() => scanCapabilityPacks(platformRoot, { extraRoots: roots }), /duplicate capability pack/);
  });

  it("refuses an external source claiming the reserved workspace name", () => {
    const project = makeProject();
    writeExternalPack(path.join(project, ".pi", "packs"));
    const [root] = resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]);
    assert.throws(
      () => scanCapabilityPacks(platformRoot, { extraRoots: [{ ...root, origin: "workspace" }] }),
      /reserved/
    );
  });

  it("records where each pack came from so the lock pins its source", () => {
    const project = makeProject();
    writeExternalPack(path.join(project, ".pi", "packs"));
    const roots = resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]);
    const lock = resolveCapabilityProfileDocument(platformRoot, baseProfile(), { extraRoots: roots });
    const entry = lock.packs.find((pack) => pack.name === "acme-delivery");
    assert.equal(entry.origin, "team");
    assert.equal(entry.source, "./.pi/packs");
  });
});

describe("external packs are denied by default", () => {
  const project = makeProject();
  writeExternalPack(path.join(project, ".pi", "packs"));
  const roots = resolveCapabilitySourceRoots(project, [{ name: "team", path: ".pi/packs" }]);

  it("refuses an owner the profile does not list", () => {
    const profile = baseProfile();
    profile.capabilityPolicy.allowedOwners = ["platform-maintainers"];
    assert.throws(
      () => resolveCapabilityProfileDocument(platformRoot, profile, { extraRoots: roots }),
      /does not allow capability owner acme/
    );
  });

  it("refuses a lifecycle the profile does not list", () => {
    const profile = baseProfile();
    profile.capabilityPolicy.allowedLifecycles = ["stable"];
    assert.throws(
      () => resolveCapabilityProfileDocument(platformRoot, profile, { extraRoots: roots }),
      /does not allow experimental capability packs/
    );
  });

  it("refuses a profile whose policy omits the lists entirely", () => {
    // An absent list must deny, not throw an internal error and not permit.
    const profile = baseProfile({ capabilityPolicy: {} });
    assert.throws(
      () => resolveCapabilityProfileDocument(platformRoot, profile, { extraRoots: roots }),
      /does not allow capability owner acme/
    );
  });

  it("refuses a pack asking for filesystem write beyond the profile grant", () => {
    const writeProject = makeProject();
    writeExternalPack(path.join(writeProject, ".pi", "packs"), { permissions: { filesystemWrite: ["src/**"] } });
    const writeRoots = resolveCapabilitySourceRoots(writeProject, [{ name: "team", path: ".pi/packs" }]);
    assert.throws(
      () => resolveCapabilityProfileDocument(platformRoot, baseProfile(), { extraRoots: writeRoots }),
      /does not allow filesystem write scope src/
    );
  });

  it("refuses a pack asking for an external action beyond the profile grant", () => {
    const actionProject = makeProject();
    writeExternalPack(path.join(actionProject, ".pi", "packs"), { permissions: { externalActions: ["git-push"] } });
    const actionRoots = resolveCapabilitySourceRoots(actionProject, [{ name: "team", path: ".pi/packs" }]);
    assert.throws(
      () => resolveCapabilityProfileDocument(platformRoot, baseProfile(), { extraRoots: actionRoots }),
      /does not allow external action git-push/
    );
  });

  it("refuses a pack asking for a network domain beyond the profile grant", () => {
    const networkProject = makeProject();
    writeExternalPack(path.join(networkProject, ".pi", "packs"), { permissions: { networkDomains: ["evil.example"] } });
    const networkRoots = resolveCapabilitySourceRoots(networkProject, [{ name: "team", path: ".pi/packs" }]);
    assert.throws(
      () => resolveCapabilityProfileDocument(platformRoot, baseProfile(), { extraRoots: networkRoots }),
      /does not allow network domain evil.example/
    );
  });

  it("admits the pack once the profile names its owner and lifecycle", () => {
    // The accepting case matters here: a gate nobody can pass is indistinguishable
    // from a broken resolver.
    const lock = resolveCapabilityProfileDocument(platformRoot, baseProfile(), { extraRoots: roots });
    assert.ok(lock.packs.some((pack) => pack.name === "acme-delivery"));
  });
});

describe("vendored tree integrity", () => {
  it("digests file contents and paths, not just contents", () => {
    const first = makeProject();
    const second = makeProject();
    fs.writeFileSync(path.join(first, "a.txt"), "same\n");
    fs.writeFileSync(path.join(second, "b.txt"), "same\n");
    assert.notEqual(digestDirectory(first), digestDirectory(second));
  });

  it("produces the same digest for the same tree", () => {
    const first = makeProject();
    const second = makeProject();
    for (const root of [first, second]) {
      fs.mkdirSync(path.join(root, "nested"), { recursive: true });
      fs.writeFileSync(path.join(root, "nested", "a.txt"), "content\n");
      fs.writeFileSync(path.join(root, "b.txt"), "other\n");
    }
    assert.equal(digestDirectory(first), digestDirectory(second));
  });

  it("changes when any file changes", () => {
    const root = makeProject();
    fs.writeFileSync(path.join(root, "a.txt"), "before\n");
    const before = digestDirectory(root);
    fs.writeFileSync(path.join(root, "a.txt"), "after\n");
    assert.notEqual(digestDirectory(root), before);
  });

  it("refuses to digest a tree containing a symbolic link", () => {
    const root = makeProject();
    const outside = makeProject();
    fs.writeFileSync(path.join(outside, "secret.txt"), "token\n");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    assert.throws(() => digestDirectory(root), /must not contain symbolic links/);
  });
});
