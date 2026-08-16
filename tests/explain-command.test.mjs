import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const temporaryRoots = new Set();

after(() => {
  for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-explain-"));
  temporaryRoots.add(cwd);
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".pi", "piagent-profile.json"), JSON.stringify({
    schemaVersion: 1, projectId: "explain-fixture", displayName: "Explain Fixture", mode: "custom",
    protectedPaths: [], readOnlyPaths: []
  }));
  return cwd;
}

function explain(command, cwd, extra = []) {
  const result = execFileSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--import", path.join(root, "scripts", "register-typescript-loader.mjs"),
    path.join(root, "scripts", "explain-command.mjs"),
    command, "--project", cwd, "--json", ...extra
  ], { encoding: "utf8", cwd: root, env: { ...process.env, PIAGENT_PROFILE: "" } });
  return JSON.parse(result);
}

function explainExpectingExit(command, cwd) {
  try {
    return { code: 0, value: explain(command, cwd) };
  } catch (error) {
    return { code: error.status, value: JSON.parse(error.stdout) };
  }
}

describe("piagent explain", () => {
  it("gives the same conclusive static denial as the guard, and says which step decided", () => {
    const cwd = fixture();
    const literal = explainExpectingExit("cat .env", cwd);
    assert.equal(literal.value.decision, "deny");
    assert.equal(literal.value.kind, "protected-path");
    assert.equal(literal.value.confidence, "exact");
    assert.equal(literal.value.steps.find((step) => step.step === "literal-path").matched, true);
    // The chain stops at the step that decided, exactly as the guard stops.
    assert.equal(literal.value.steps.some((step) => step.step === "glob"), false);
  });

  it("separates a proven reach from a target it cannot resolve", () => {
    const cwd = fixture();
    // A pattern is matched against generated examples, so this answers for a
    // name that need not exist -- the operator is told that rather than being
    // told the file was found.
    const glob = explainExpectingExit("cat .env*", cwd);
    assert.equal(glob.value.kind, "protected-glob");
    assert.equal(glob.value.confidence, "over-approximate");

    // Nothing was proven protected here; the target is simply unknowable before
    // it runs, which leads to a different fix.
    const unresolved = explainExpectingExit("cat .en$(mktemp)", cwd);
    assert.equal(unresolved.value.kind, "unresolved");
    assert.equal(unresolved.value.confidence, "unknown-target");
    assert.notEqual(unresolved.value.remedy, glob.value.remedy);
  });

  it("never turns a static pass into runtime permission", () => {
    const cwd = fixture();
    // Two words is an ambiguous redirect: bash opens no file, so neither does
    // this. The regression that made the guard block it is the reason `explain`
    // reuses the guard's readers instead of carrying its own.
    for (const command of ['printf x > "{.env,}"{,}', "ls -la", "printf hello > src/new-file.ts"]) {
      const result = explainExpectingExit(command, cwd);
      assert.equal(result.code, 2, command);
      assert.equal(result.value.decision, "indeterminate", command);
      assert.equal(result.value.confidence, "runtime-required", command);
      assert.equal(result.value.staticDecision, "allow", command);
      assert.ok(result.value.remainingGates.includes("task-contract"), command);
      assert.ok(result.value.remainingGates.includes("permission-profile"), command);
    }
  });

  it("does not claim final confirmation from an exec-policy prompt", () => {
    const cwd = fixture();
    const result = explainExpectingExit("git push origin main", cwd);
    assert.equal(result.code, 2);
    assert.equal(result.value.decision, "indeterminate");
    assert.equal(result.value.staticDecision, "confirm");
    assert.match(result.value.reason, /live runtime may still block/i);
  });

  it("answers every denial with something to do next", () => {
    const cwd = fixture();
    for (const command of ["cat .env", "cat .env*", "cat .en$(mktemp)"]) {
      const result = explainExpectingExit(command, cwd);
      assert.equal(result.code, 1, command);
      assert.ok(result.value.remedy && result.value.remedy.length > 20, `${command} has no remedy`);
    }
  });

  it("does not imply that task scope overrides protected-path policy", () => {
    const cwd = fixture();
    const result = explainExpectingExit("cat .env", cwd);
    assert.match(result.value.remedy, /task scope alone does not override/i);
  });

  it("lists the boundary in effect without being asked about a command", () => {
    const cwd = fixture();
    // The boundary is otherwise only discoverable by running into it.
    const scope = explain("", cwd, ["--scope"]);
    assert.equal(scope.profileSource, "project");
    assert.ok(Array.isArray(scope.shellProtectedPaths) && scope.shellProtectedPaths.length > 0);
    for (const key of ["readProtectedPaths", "writeProtectedPaths", "readOnlyPaths"]) {
      assert.ok(Array.isArray(scope[key]), `${key} missing from --scope`);
    }
    // It must answer from the same resolution the guard uses, not a second view.
    const judged = explainExpectingExit("cat .env", cwd);
    assert.equal(scope.shellProtectedPaths.length, judged.value.protectedPatternCount);
  });

  it("reports the profile it judged against", () => {
    const cwd = fixture();
    const result = explainExpectingExit("cat .env", cwd);
    assert.equal(result.value.profileSource, "project");
    assert.ok(result.value.protectedPatternCount > 0);
  });
});
