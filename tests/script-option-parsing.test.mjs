import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptDirectory = path.join(repositoryRoot, "scripts");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("piagent-argv-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-argv-"));
  temporaryRoots.add(root);
  return root;
}

function runScript(name, argv, cwd = repositoryRoot) {
  return spawnSync("bash", [path.join(scriptDirectory, name), ...argv], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PIAGENT_PACKAGE_SOURCE: "" }
  });
}

// A `--flag <value>` branch that reads `$2` without checking its shape accepts
// the next flag as the value. The result is worse than a hard failure: the
// option that was consumed silently does nothing, and the one that ate it acts
// on a value nobody typed. `--settings --dry-run` wrote a file literally named
// "--dry-run" and reported success.
//
// The check is static so it covers scripts nobody thought to add a case for,
// including ones added after this test.
function optionBranchesTakingAValue(source) {
  const lines = source.split("\n");
  const branches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "shift 2") continue;
    let start = index;
    while (start > 0) {
      const previous = lines[start - 1].trim();
      if (previous === ";;" || /^-{1,2}[^)]*\)$/.test(previous)) break;
      start -= 1;
    }
    const label = start > 0 ? lines[start - 1].trim() : "";
    branches.push({ label, body: lines.slice(start, index + 1).join("\n") });
  }
  return branches;
}

describe("shell scripts refuse a flag where a value belongs", () => {
  const scripts = fs.readdirSync(scriptDirectory).filter((entry) => entry.endsWith(".sh")).sort();

  it("finds scripts to check", () => {
    assert.ok(scripts.length > 0);
  });

  for (const script of scripts) {
    const source = fs.readFileSync(path.join(scriptDirectory, script), "utf8");
    const branches = optionBranchesTakingAValue(source);
    if (branches.length === 0) continue;

    it(`guards every value-taking option in ${script}`, () => {
      const unguarded = branches
        .filter((branch) => !/require_value\s/.test(branch.body))
        .map((branch) => branch.label || branch.body.trim().split("\n")[0]);
      assert.deepEqual(unguarded, [], `${script} reads a value without require_value: ${unguarded.join(", ")}`);
    });
  }
});

describe("the refusal holds when the scripts actually run", () => {
  // One repro per script that had the hole, using the flag pair that was
  // reported rather than a synthetic one.
  const cases = [
    { script: "configure-subagents.sh", argv: ["--config", "--dry-run"], option: "--config" },
    { script: "configure-model-scope.sh", argv: ["--settings", "--dry-run"], option: "--settings" },
    { script: "pi-model-catalog.sh", argv: ["--provider", "--json"], option: "--provider" },
    { script: "uninstall-global.sh", argv: ["--project", "--apply"], option: "--project" },
    { script: "setup.sh", argv: ["--profile", "--dry-run"], option: "--profile" }
  ];

  for (const { script, argv, option } of cases) {
    it(`${script} ${argv.join(" ")} fails instead of naming a value ${argv[1]}`, () => {
      const result = runScript(script, argv);
      assert.equal(result.status, 2, result.stdout);
      assert.match(result.stderr, new RegExp(`Missing value for ${option}`));
    });
  }

  it("init-project.sh fails before touching the project", () => {
    const project = makeProject();
    const result = runScript("init-project.sh", [project, "--profile", "--force-profile"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /Missing value for --profile/);
    assert.equal(fs.existsSync(path.join(project, ".pi")), false);
  });

  it("quality-benchmark.sh names the positional it was given a flag for", () => {
    const result = runScript("quality-benchmark.sh", ["--record"]);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /the project path comes first/);
  });

  // The guard must not reject values that only look like flags in passing.
  it("still takes a value that begins with a dash inside it", () => {
    const project = makeProject();
    const result = runScript("quality-benchmark.sh", [
      project, "--record", "--scenario", "read-only-scout", "--surface", "pi", "--result", "pass"
    ]);
    assert.equal(result.status, 0, result.stderr);
    const recorded = fs.readFileSync(path.join(project, ".pi", "benchmarks", "quality-runs.jsonl"), "utf8");
    assert.match(recorded, /"scenario":"read-only-scout"/);
  });
});
