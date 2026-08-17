import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { DOCUMENT_WORKSPACE_LIMITS, projectDocumentWorkspaceDocument, projectDocumentWorkspaceListing }
  from "../packages/piagent-core/runtime/inspection/document-workspace-projection.ts";
import { runtimeDocumentReadRoots } from "../packages/piagent-core/runtime/inspection/project-runtime-inspection.ts";
import { createWebUiSchemaRegistry, validateFixture } from "./helpers/piagent-webui-schema-registry.mjs";
import { docx } from "./helpers/piagent-docx-fixture.mjs";

const registry = createWebUiSchemaRegistry(), temporaryRoots = new Set();
const now = () => new Date("2026-08-17T09:00:00.000Z");

function valid(projection) {
  const result = validateFixture(registry, "document-workspace-v1", projection);
  assert.equal(result.valid, true, result.errors);
  return projection;
}

function write(target, contents) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

// One tree used by every case: a project, a directory the operator granted, and
// a directory nobody granted that the other two are made to point at.
function fixture() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-document-workspace-")));
  temporaryRoots.add(base);
  const project = path.join(base, "project"), granted = path.join(base, "granted"), outside = path.join(base, "outside");

  write(path.join(project, "README.md"), "# Ke hoach\n\nNoi dung that.\n");
  write(path.join(project, "notes.txt"), "ghi chu\n");
  write(path.join(project, "data.csv"), "ten,so\nA,1\nB,2\n");
  write(path.join(project, "docs", "spec.md"), "# Spec\n");
  write(path.join(project, "plan.docx"), docx("Chot ngan sach Q3.", "Doi tac ky ngay 12/09."));
  // Refused by the extension gate rather than by anything this module decides.
  write(path.join(project, "id_rsa"), "PRIVATE KEY MATERIAL");
  write(path.join(project, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(path.join(project, "empty.md"), "");
  // Vendored and hidden directories the walk refuses to descend into.
  write(path.join(project, "node_modules", "pkg", "README.md"), "# Vendored\n");
  write(path.join(project, ".hidden", "secret.md"), "# Hidden\n");
  write(path.join(project, ".pi", "piagent-state", "private.md"), "# Private state\n");
  // Sits in a visible directory on purpose: a protected document under a dotted
  // path would be excluded by the hidden-directory rule first, and the test
  // would pass without the protected-path rule doing anything.
  write(path.join(project, "ops", "credentials.md"), "# Protected runbook\n");
  // A protected file that is not under a protected directory. Without it the
  // directory rule alone excludes every protected fixture, and the per-file
  // check could be deleted with the suite still green.
  write(path.join(project, "vault.md"), "# Protected vault\n");
  write(path.join(granted, "vendor-spec.md"), "# Vendor spec\n");
  write(path.join(outside, "target.md"), "# NEVER LISTED\n");
  fs.symlinkSync(path.join(outside, "target.md"), path.join(project, "linked.md"));
  fs.symlinkSync(outside, path.join(project, "linked-dir"));

  return { base, project, granted, outside };
}

const protectedProject = (candidate) => /(^|\/)ops(\/|$)/.test(candidate) || /(^|\/)vault\.md$/.test(candidate);

afterEach(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); temporaryRoots.clear(); });

describe("Piagent WebUI bounded document workspace", () => {
  it("lists document files from the project and refuses everything the reader would refuse", () => {
    const tree = fixture();
    const listing = valid(projectDocumentWorkspaceListing({ cwd: tree.project, now, isProtectedPath: protectedProject }));
    assert.equal(listing.state, "ready");
    const paths = listing.documents.map((entry) => entry.relativePath).sort();
    assert.deepEqual(paths, ["README.md", "data.csv", "docs/spec.md", "notes.txt", "plan.docx"]);
    // Extensions outside the reader's set, an empty file, vendored and hidden
    // trees, and the protected directory all stay out.
    for (const absent of ["id_rsa", "logo.png", "empty.md", "node_modules/pkg/README.md", ".hidden/secret.md", ".pi/piagent-state/private.md"]) {
      assert.equal(paths.includes(absent), false, absent);
    }
    assert.equal(listing.roots.length, 1);
    assert.equal(listing.roots[0].source, "project");
    assert.equal(listing.roots[0].documentCount, 5);
    assert.equal(listing.truncated, false);
  });

  it("never lists a link or reads through one, in either direction", () => {
    const tree = fixture();
    const listing = projectDocumentWorkspaceListing({ cwd: tree.project, now });
    const paths = listing.documents.map((entry) => entry.relativePath);
    // A symlinked file and a symlinked directory both carry a document extension
    // into the root. Neither may put the target's name in front of the operator.
    assert.equal(paths.includes("linked.md"), false);
    assert.equal(paths.some((item) => item.startsWith("linked-dir/")), false);
    assert.equal(JSON.stringify(listing).includes("NEVER LISTED"), false);

    // A file that becomes a link to somewhere outside every root after it was
    // listed is refused on read, and the target is never returned.
    const readme = listing.documents.find((entry) => entry.relativePath === "README.md");
    fs.unlinkSync(path.join(tree.project, "README.md"));
    fs.symlinkSync(path.join(tree.outside, "target.md"), path.join(tree.project, "README.md"));
    const swapped = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now, documentRef: readme.documentRef }));
    assert.equal(swapped.state, "unavailable");
    assert.equal(swapped.text, null);
    assert.equal(JSON.stringify(swapped).includes("NEVER LISTED"), false);
  });

  it("lists a granted directory beside the project and never one that was not granted", () => {
    const tree = fixture();
    const listing = valid(projectDocumentWorkspaceListing({ cwd: tree.project, now,
      profileRoots: [tree.granted], isProtectedPath: protectedProject }));
    const sources = listing.roots.map((root) => root.source).sort();
    assert.deepEqual(sources, ["profile", "project"]);
    const granted = listing.documents.find((entry) => entry.relativePath === "vendor-spec.md");
    assert.ok(granted, "the granted directory contributes its documents");
    assert.notEqual(granted.rootRef, listing.documents.find((entry) => entry.relativePath === "README.md").rootRef);
    // The ungranted sibling of both roots stays invisible.
    assert.equal(JSON.stringify(listing).includes("NEVER LISTED"), false);

    const opened = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now,
      profileRoots: [tree.granted], documentRef: granted.documentRef }));
    assert.equal(opened.state, "ready");
    assert.match(opened.text, /# Vendor spec/);
  });

  it("gives each root its own share of the listing budget", () => {
    const tree = fixture();
    // The project alone holds more documents than the whole budget, so a shared
    // budget spent in root order would leave the granted directory empty.
    const many = path.join(tree.project, "bulk");
    for (let index = 0; index < DOCUMENT_WORKSPACE_LIMITS.documents + 50; index += 1) {
      write(path.join(many, `note-${String(index).padStart(5, "0")}.md`), `# Note ${index}\n`);
    }
    const listing = valid(projectDocumentWorkspaceListing({ cwd: tree.project, now, profileRoots: [tree.granted] }));
    assert.equal(listing.truncated, true);
    const grantedRoot = listing.roots.find((root) => root.source === "profile");
    assert.equal(grantedRoot.documentCount, 1, "the granted directory is still listed after a project that overruns the budget");
    assert.ok(listing.documents.some((entry) => entry.relativePath === "vendor-spec.md"));
    assert.ok(listing.documents.length <= DOCUMENT_WORKSPACE_LIMITS.documents);
  });

  it("keeps a protected document out of the listing and out of a read", () => {
    const tree = fixture();
    // Listed without the protected-path rule, so the ref is real and the refusal
    // has to come from the rule rather than from the document being absent.
    const unguarded = projectDocumentWorkspaceListing({ cwd: tree.project, now });
    const guarded = valid(projectDocumentWorkspaceListing({ cwd: tree.project, now, isProtectedPath: protectedProject }));
    // Both shapes of protected match: a file because its directory is protected,
    // and a file protected by its own name in a directory that is not.
    for (const relativePath of ["ops/credentials.md", "vault.md"]) {
      const entry = unguarded.documents.find((candidate) => candidate.relativePath === relativePath);
      assert.ok(entry, `the fixture holds ${relativePath}`);
      assert.equal(guarded.documents.some((candidate) => candidate.documentRef === entry.documentRef), false, relativePath);
      const refusedEntry = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now,
        isProtectedPath: protectedProject, documentRef: entry.documentRef }));
      assert.equal(refusedEntry.state, "unavailable", relativePath);
      assert.equal(refusedEntry.text, null, relativePath);
    }
    const target = unguarded.documents.find((entry) => entry.relativePath === "ops/credentials.md");

    // The same ref still resolves to a real, listable file, so the refusal has to
    // come from the protected-path rule rather than from the document vanishing.
    assert.equal(valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now, documentRef: target.documentRef })).state, "ready");
    const refused = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now,
      isProtectedPath: protectedProject, documentRef: target.documentRef }));
    assert.equal(refused.state, "unavailable");
    assert.equal(refused.reasonCode, "document-not-listed");
    assert.equal(refused.text, null);
    assert.equal(JSON.stringify(refused).includes("Protected runbook"), false);
  });

  it("reads a .docx as prose and redacts what the document carries", () => {
    const tree = fixture();
    write(path.join(tree.project, "leak.md"), "Khoa: sk-proj-abcdefghijklmnopqrstuvwxyz\nphan con lai\n");
    const listing = projectDocumentWorkspaceListing({ cwd: tree.project, now });

    const word = listing.documents.find((entry) => entry.relativePath === "plan.docx");
    const opened = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now, documentRef: word.documentRef }));
    assert.equal(opened.state, "ready");
    assert.equal(opened.format, "docx");
    assert.match(opened.text, /Chot ngan sach Q3\./);
    assert.match(opened.text, /Doi tac ky ngay 12\/09\./);
    // The archive itself never crosses the boundary, only the text inside it.
    assert.equal(opened.text.includes("word/document.xml"), false);
    assert.equal(opened.redacted, false);

    const leak = listing.documents.find((entry) => entry.relativePath === "leak.md");
    const redacted = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now, documentRef: leak.documentRef }));
    assert.equal(redacted.state, "ready");
    assert.equal(redacted.redacted, true);
    assert.equal(redacted.text.includes("sk-proj-abcdefghijklmnopqrstuvwxyz"), false);
    assert.match(redacted.text, /phan con lai/);
  });

  it("reads the granted directories the Gateway hands the workspace", () => {
    const tree = fixture();
    const packageRoot = path.resolve(import.meta.dirname, "..");
    // No profile at all is the common case and must be an empty grant, not a throw.
    assert.deepEqual(runtimeDocumentReadRoots(packageRoot, tree.project), []);

    write(path.join(tree.project, ".pi", "piagent-profile.json"),
      JSON.stringify({ additionalReadRoots: [tree.granted, 42, "~/Downloads"] }));
    // Non-string entries are dropped here; resolveDocumentRoots decides which of
    // the rest actually exist, so an unexpanded ~ is passed through untouched.
    assert.deepEqual(runtimeDocumentReadRoots(packageRoot, tree.project), [tree.granted, "~/Downloads"]);

    write(path.join(tree.project, ".pi", "piagent-profile.json"), "{ not json");
    assert.deepEqual(runtimeDocumentReadRoots(packageRoot, tree.project), [],
      "an unreadable profile grants nothing rather than failing the listing");
  });

  it("refuses a ref that no longer names a listed document", () => {
    const tree = fixture();
    const missing = valid(projectDocumentWorkspaceDocument({ cwd: tree.project, now, documentRef: "document.deadbeef" }));
    assert.equal(missing.state, "unavailable");
    assert.equal(missing.reasonCode, "document-not-listed");
    assert.equal(missing.text, null);
    assert.equal(missing.name, null);

    const absent = valid(projectDocumentWorkspaceListing({ cwd: path.join(tree.base, "no-such-project"), now }));
    assert.equal(absent.state, "unavailable");
    assert.equal(absent.reasonCode, "no-readable-root");
    assert.deepEqual(absent.documents, []);
  });
});
