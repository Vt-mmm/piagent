import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  detectProfileName,
  detectProjectShape,
  readWorkspacePackageDirs
} from "../packages/piagent-core/extensions/project-shape.js";
import { matchesProtectedPath } from "../packages/piagent-core/extensions/policy-core.js";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== fs.realpathSync.native(os.tmpdir())) continue;
    if (!path.basename(root).startsWith("pi-shape-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A repository is described by the files that exist in it, so every case here
// stages a real directory tree rather than stubbing the filesystem.
function repository(layout) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-shape-")));
  temporaryRoots.add(root);
  for (const [relative, contents] of Object.entries(layout)) {
    const target = path.join(root, relative);
    if (contents === null) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
  }
  return root;
}

const reactPackage = { name: "web", dependencies: { react: "18.0.0" } };
const expressPackage = { name: "api", dependencies: { express: "4.19.0" } };

describe("monorepo layout detection", () => {
  it("reads a frontend and a backend directory at the root", () => {
    const root = repository({ "package.json": { name: "r" }, frontend: null, backend: null });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("reads apps/web next to apps/api", () => {
    const root = repository({ "package.json": { name: "r" }, "apps/web": null, "apps/api": null });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  // apps/frontend was a frontend marker while apps/backend was not, so a repository
  // that named both halves symmetrically had its backend read as absent.
  it("reads apps/backend, not just apps/api and apps/server", () => {
    const root = repository({ "package.json": { name: "r" }, "apps/frontend": null, "apps/backend": null });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("reads client next to server", () => {
    const root = repository({ "package.json": { name: "r" }, client: null, server: null });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("reads packages/web next to packages/api", () => {
    const root = repository({ "package.json": { name: "r" }, "packages/web": null, "packages/api": null });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("reads services/api", () => {
    const root = repository({ "package.json": { name: "r" }, frontend: null, "services/api": null });
    assert.equal(detectProfileName(root).name, "fullstack");
  });
});

describe("workspace-declared packages", () => {
  // The package names here are deliberately outside the directory-name lists, so
  // only the workspace walk plus each package's own manifest can classify them.
  const workspaceLayout = {
    "packages/storefront/package.json": reactPackage,
    "packages/gateway/package.json": expressPackage
  };

  it("classifies packages named nothing in particular through their manifests", () => {
    const root = repository({
      "package.json": { name: "r", workspaces: ["packages/*"] },
      ...workspaceLayout
    });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("accepts the object form of the workspaces field", () => {
    const root = repository({
      "package.json": { name: "r", workspaces: { packages: ["packages/*"] } },
      ...workspaceLayout
    });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("accepts pnpm-workspace.yaml", () => {
    const root = repository({
      "package.json": { name: "r" },
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n  - '!**/fixtures/**'\n",
      ...workspaceLayout
    });
    assert.equal(detectProfileName(root).name, "fullstack");
  });

  it("stops the pnpm list at the next top-level key", () => {
    const root = repository({
      "package.json": { name: "r" },
      "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n\ncatalog:\n  - 'not-a-workspace/*'\n",
      "not-a-workspace/thing/package.json": { name: "thing" },
      ...workspaceLayout
    });
    assert.deepEqual(readWorkspacePackageDirs(root).sort(), ["packages/gateway", "packages/storefront"]);
  });

  it("expands a literal workspace path with no wildcard", () => {
    const root = repository({
      "package.json": { name: "r", workspaces: ["packages/storefront"] },
      ...workspaceLayout
    });
    assert.deepEqual(readWorkspacePackageDirs(root), ["packages/storefront"]);
  });

  // Each of these stages a directory the pattern would really reach, so the
  // assertion fails when the guard is removed rather than because the target
  // happened not to exist.
  it("refuses a workspace pattern that climbs out of the repository", () => {
    const sibling = repository({ "pkg/package.json": { name: "outside" } });
    const root = repository({
      "package.json": { name: "r", workspaces: [`../${path.basename(sibling)}/*`] }
    });
    assert.ok(fs.existsSync(path.join(root, "..", path.basename(sibling), "pkg")));
    assert.deepEqual(readWorkspacePackageDirs(root), []);
  });

  it("refuses an absolute workspace pattern instead of rereading it as relative", () => {
    const root = repository({
      "package.json": { name: "r", workspaces: ["/etc/*"] },
      "etc/pkg/package.json": { name: "etc-pkg" }
    });
    assert.deepEqual(readWorkspacePackageDirs(root), []);
  });

  it("ignores exclusion patterns rather than treating them as directory names", () => {
    const root = repository({
      "package.json": { name: "r", workspaces: ["!packages/*"] },
      "!packages/pkg/package.json": { name: "excluded" }
    });
    assert.deepEqual(readWorkspacePackageDirs(root), []);
  });

  it("reads at most a bounded number of workspace packages", () => {
    const layout = { "package.json": { name: "r", workspaces: ["packages/*"] } };
    for (let index = 0; index < 80; index += 1) {
      layout[`packages/p${String(index).padStart(3, "0")}/package.json`] = { name: `p${index}` };
    }
    const root = repository(layout);
    assert.equal(readWorkspacePackageDirs(root).length, 64);
  });
});

describe("detection that must not widen", () => {
  it("keeps a frontend-only repository on web-frontend", () => {
    const root = repository({ "package.json": { name: "r", dependencies: { next: "14.0.0" } } });
    assert.equal(detectProfileName(root).name, "web-frontend");
  });

  it("keeps a backend-only repository on backend-api", () => {
    const root = repository({ "package.json": expressPackage });
    assert.equal(detectProfileName(root).name, "backend-api");
  });

  // `public/` and `pages/` are ordinary directory names. They only speak for a web
  // framework when there is a manifest beside them.
  it("does not call a repository frontend for a bare public directory", () => {
    const root = repository({ "pyproject.toml": "[project]\nname='x'\n", public: null });
    assert.equal(detectProfileName(root).name, "python");
  });

  it("does not read a file named like a stack directory as one", () => {
    const root = repository({ "package.json": { name: "r" }, frontend: null, backend: "not a directory" });
    assert.equal(detectProfileName(root).name, "web-frontend");
  });

  it("still prefers mobile over everything else", () => {
    const root = repository({ "package.json": { name: "r" }, "pubspec.yaml": "name: app\n", frontend: null, backend: null });
    assert.equal(detectProfileName(root).name, "mobile");
  });

  it("falls back to generic when nothing identifies the repository", () => {
    const root = repository({ "notes.txt": "hello" });
    assert.equal(detectProfileName(root).name, "generic");
  });

  it("lets stated intent win over the detected shape", () => {
    const root = repository({ "package.json": { name: "r" }, frontend: null, backend: null });
    assert.equal(detectProfileName(root, "be-readonly-fe").name, "be-readonly-fe");
    assert.equal(detectProfileName(root, "backend-only").name, "backend-api");
  });

  it("reports the shape it used, not only the profile name", () => {
    const root = repository({ "package.json": { name: "r" }, "apps/frontend": null, "apps/backend": null });
    const shape = detectProjectShape(root);
    assert.equal(shape.frontend, true);
    assert.equal(shape.backend, true);
  });
});

describe("be-readonly-fe keeps the backend read-only", () => {
  const profile = JSON.parse(fs.readFileSync(path.join(repoRoot, "adapters/be-readonly-fe/profile.json"), "utf8"));

  function readOnly(candidate) {
    return matchesProtectedPath(candidate, profile.readOnlyPaths) !== undefined;
  }
  function shellBlocked(candidate) {
    return matchesProtectedPath(candidate, profile.shellProtectedPaths) !== undefined;
  }

  // The profile promises the backend is read-only. Anchored globs kept that promise
  // only for repositories whose backend sat at the root.
  for (const candidate of [
    "backend/src/main.ts",
    "server/index.js",
    "api/routes.ts",
    "apps/api/src/main.ts",
    "apps/server/src/main.ts",
    "apps/backend/src/main.ts",
    "packages/api/src/main.ts",
    "packages/server/src/main.ts",
    "packages/backend/src/main.ts",
    "services/payments/src/main.ts"
  ]) {
    it(`refuses writes to ${candidate}`, () => {
      assert.equal(readOnly(candidate), true);
      assert.equal(shellBlocked(candidate), true);
    });
  }

  // The frontend is the write target. A frontend's own HTTP client lives in an
  // `api` directory, and a `**/api/**` pattern would have frozen it.
  for (const candidate of [
    "packages/web/src/api/client.ts",
    "frontend/src/api/client.ts",
    "apps/web/src/server/render.ts",
    "src/api/client.ts"
  ]) {
    it(`still allows writes to ${candidate}`, () => {
      assert.equal(readOnly(candidate), false);
      assert.equal(shellBlocked(candidate), false);
    });
  }

  it("looks for the frontend verify command beyond frontend/ and apps/web/", () => {
    const commands = profile.verifyCommands.frontendSource.join(" ");
    for (const location of ["apps/frontend/package.json", "packages/web/package.json", "client/package.json"]) {
      assert.ok(commands.includes(location), `frontendSource does not look at ${location}`);
    }
  });
});

describe("one detector, not two", () => {
  // The shell initialiser and the runtime recommendation disagreed for several
  // releases because each carried its own copy of these rules.
  const initProject = fs.readFileSync(path.join(repoRoot, "scripts/init-project.sh"), "utf8");

  it("has init-project.sh call the shared module", () => {
    assert.ok(initProject.includes("packages/piagent-core/extensions/project-shape.js"));
  });

  it("leaves no second copy of the rules in the shell", () => {
    for (const marker of ["frontend=true", "backend=true", "apps/api", "next.config"]) {
      assert.ok(!initProject.includes(marker), `init-project.sh still carries its own detection: ${marker}`);
    }
  });

  it("has the guard call the shared module", () => {
    const guard = fs.readFileSync(path.join(repoRoot, "packages/piagent-core/extensions/piagent-guard.ts"), "utf8");
    assert.ok(guard.includes('from "./project-shape.js"'));
    assert.ok(!guard.includes("function detectProfileName"), "the guard still carries its own detection");
  });
});
