import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-package-bin-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("package distribution", () => {
  it("keeps maintainer working notes out of the published tarball", () => {
    // npm packs from the working directory, so these stay on disk even though
    // they are untracked. The files allowlist takes precedence over .npmignore
    // for top-level entries, which is why the exclusions live in package.json.
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(packed.status, 0, packed.stderr);
    const entries = JSON.parse(packed.stdout)[0].files.map((file) => file.path);

    const shipsInternalNotes = entries.filter((entry) =>
      /^plans\//.test(entry)
      || /^docs\/journals\//.test(entry)
      || /^docs\/decisions\//.test(entry)
      || /^docs\/readiness-assessment\.md$/.test(entry));
    assert.deepEqual(shipsInternalNotes, []);

    // The exclusions must not swallow the documentation users install for.
    assert.ok(entries.includes("docs/capability-packs.md"));
    assert.ok(entries.some((entry) => entry.startsWith("templates/project/")));
    assert.ok(entries.some((entry) => entry.startsWith("adapters/")));
  });

  it("declares a publishable package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.equal(pkg.private, undefined, "private would block publishing entirely");
    assert.equal(pkg.name, "@piagent/platform");
    // A scoped package defaults to restricted; publishing publicly is explicit.
    assert.equal(pkg.publishConfig?.access, "public");
    assert.equal(pkg.publishConfig?.provenance, true);
  });

  it("declares only real extension entry points in every pi manifest", () => {
    // Pi loads every path pi.extensions matches and calls its default export as
    // an extension factory. The modules the guard imports live beside it in
    // extensions/, so a directory glob would hand Pi a module that exports
    // helpers and no factory, and the pack would fail to load.
    const manifests = [
      { root: repositoryRoot, name: "package.json" },
      { root: path.join(repositoryRoot, "packages", "piagent-core"), name: "packages/piagent-core/package.json" }
    ];

    for (const manifest of manifests) {
      const pkg = JSON.parse(fs.readFileSync(path.join(manifest.root, "package.json"), "utf8"));
      const patterns = pkg.pi?.extensions ?? [];
      assert.ok(patterns.length > 0, `${manifest.name} declares no extensions`);

      const matched = patterns.flatMap((pattern) => fs.globSync(pattern, { cwd: manifest.root }));
      assert.ok(matched.length > 0, `${manifest.name} matches no files`);

      for (const relative of matched) {
        const source = fs.readFileSync(path.join(manifest.root, relative), "utf8");
        assert.match(
          source,
          /^export default /m,
          `${manifest.name} declares ${relative} as an extension, but it has no default export for Pi to call`
        );
      }
    }
  });

  it("keeps the guard's own modules out of the extension entry points", () => {
    // The inverse of the check above: proving the manifest is narrow, not just
    // that everything it currently happens to match is loadable.
    const packageRoot = path.join(repositoryRoot, "packages", "piagent-core");
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const matched = new Set(pkg.pi.extensions.flatMap((pattern) => fs.globSync(pattern, { cwd: packageRoot })));

    const libraryModules = fs
      .readdirSync(path.join(packageRoot, "extensions"))
      .filter((entry) => entry !== "piagent-guard.ts")
      .map((entry) => path.join("extensions", entry));

    assert.ok(libraryModules.length > 0, "the guard should still have modules beside it");
    for (const relative of libraryModules) {
      assert.equal(matched.has(relative), false, `${relative} is a library module, not an extension entry point`);
    }
    assert.equal(matched.has(path.join("extensions", "piagent-guard.ts")), true);
  });

  it("routes all global bin commands through the package-root dispatcher", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const bins = Object.entries(pkg.bin);
    assert.ok(bins.length > 0);
    for (const [name, target] of bins) {
      assert.match(name, /^piagent-/);
      assert.equal(target, "scripts/piagent-cli.mjs");
    }
    assert.equal(fs.statSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs")).mode & 0o111, 0o111);
  });

  it("includes runtime templates that npm may otherwise omit as dotfiles", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const pack = JSON.parse(result.stdout)[0];
    const files = new Set(pack.files.map((file) => file.path));
    assert.equal(files.has("SECURITY.md"), true);
    assert.equal(files.has("scripts/piagent-cli.mjs"), true);
    assert.equal(files.has("scripts/verify-vercel-link.mjs"), true);
    assert.equal(files.has("templates/project/.pi/gitignore.template"), true);
    assert.equal(files.has("templates/project/.pi/context-index.json"), true);
    assert.equal(files.has("templates/project/.pi/tech-stack.json"), true);
    assert.equal(files.has("templates/project/.pi/tech-context/README.md"), true);
    assert.equal(files.has("templates/project/.pi/npmignore.template"), false);
  });

  it("resolves package root correctly when invoked through a global-bin style symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    const link = path.join(root, "piagent-capabilities");
    fs.symlinkSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs"), link);
    const result = spawnSync(link, ["--help"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /piagent-capabilities catalog/);
  });

  it("shows help successfully for every global command without requiring project state", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);

    for (const name of Object.keys(pkg.bin)) {
      const link = path.join(root, name);
      fs.symlinkSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs"), link);
      const result = spawnSync(link, ["--help"], {
        cwd: root,
        encoding: "utf8"
      });
      assert.equal(result.status, 0, `${name} --help failed:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Usage:/, `${name} should print usage`);
      assert.equal(result.stderr, "", `${name} --help should not emit an error`);
    }
  });

  it("reports a controlled error when a command runner is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    const link = path.join(root, "piagent-install");
    fs.symlinkSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs"), link);
    const result = spawnSync(process.execPath, [link, "--help"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: root
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start bash \(ENOENT\)/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event|node:events/);
  });

  it("does not create a project npmignore that re-includes local Pi runtime state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "package-fixture", version: "1.0.1" }, null, 2)}\n`);

    const initialized = spawnSync("bash", [
      path.join(repositoryRoot, "scripts", "init-project.sh"),
      root,
      "--profile", "generic",
      "--package-source", "git:github.com/Vt-mmm/piagent@v1.0.1",
      "--skip-agents",
      "--skip-review-guidelines"
    ], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    assert.equal(fs.existsSync(path.join(root, ".pi", ".npmignore")), false);
    assert.equal(fs.existsSync(path.join(root, ".pi", "context-index.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".pi", "tech-stack.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".pi", "tech-context", "README.md")), true);

    const sensitivePaths = [
      ".pi/auth.json",
      ".pi/trust.json",
      ".pi/piagent-state/observed-bash.jsonl",
      ".pi/memory/state.sqlite"
    ];
    for (const relative of sensitivePaths) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "synthetic-sensitive-state\n");
    }

    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(packed.status, 0, packed.stderr);
    const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
    for (const relative of sensitivePaths) assert.equal(files.has(relative), false, `${relative} must not be packed`);
  });
});
