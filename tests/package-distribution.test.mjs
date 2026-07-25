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
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "package-fixture", version: "1.0.0" }, null, 2)}\n`);

    const initialized = spawnSync("bash", [
      path.join(repositoryRoot, "scripts", "init-project.sh"),
      root,
      "--profile", "generic",
      "--package-source", "git:github.com/Vt-mmm/piagent@v0.4.8",
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
