import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "uninstall-global.sh");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-uninstall-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-uninstall-"));
  temporaryRoots.add(root);
  return root;
}

// A pi that records what it was asked to remove instead of touching anything.
function fakePi(root) {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const log = path.join(root, "pi-calls.log");
  fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  fs.chmodSync(path.join(bin, "pi"), 0o755);
  return { bin, log };
}

function agentDir(root, packages) {
  const dir = path.join(root, "agent");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages }, null, 2));
  return dir;
}

function run(args, { root, agent, extraEnv = {} } = {}) {
  const { bin } = fakePi(root);
  return spawnSync("bash", [script, ...args], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agent,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      ...extraEnv
    },
    encoding: "utf8"
  });
}

describe("uninstall", () => {
  it("reports without removing anything unless --apply is given", () => {
    // Uninstall touches Pi state other tools also write to, so the default has
    // to be a report.
    const root = scratch();
    const agent = agentDir(root, ["npm:@piagent/platform@1.0.2"]);
    const result = run([], { root, agent });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /mode: dry run/);
    assert.match(result.stdout, /\+ pi remove npm:@piagent\/platform@1\.0\.2/);
    assert.match(result.stdout, /Nothing was removed/);
    assert.equal(fs.existsSync(path.join(root, "pi-calls.log")), false, "dry run must not invoke pi");
  });

  it("recognises every shape this platform has been installed as", () => {
    // An install from an earlier release registered a different source, and it
    // still has to come out.
    const shapes = [
      "npm:@piagent/platform@1.0.2",
      "git:github.com/Vt-mmm/piagent@v1.0.2",
      "git:github.com/Vt-mmm/piagent",
      "/Users/someone/Documents/pi-company-platform",
      "../../Documents/pi-company-platform/packages/pi-company-core"
    ];
    for (const shape of shapes) {
      const root = scratch();
      const agent = agentDir(root, [shape]);
      const result = run(["--apply"], { root, agent });
      assert.equal(result.status, 0, result.stderr);
      const calls = fs.readFileSync(path.join(root, "pi-calls.log"), "utf8");
      assert.match(calls, new RegExp(`remove ${shape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${shape} was not removed`);
    }
  });

  it("leaves packages it did not install alone", () => {
    const root = scratch();
    const agent = agentDir(root, ["npm:some-other-extension@1.0.0", "git:github.com/someone/piagent-lookalike-tool"]);
    const result = run(["--apply"], { root, agent });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No platform package found/);
    assert.equal(fs.existsSync(path.join(root, "pi-calls.log")), false);
  });

  it("removes the pinned add-ons only when asked", () => {
    const packages = ["npm:@piagent/platform@1.0.2", "npm:pi-mcp-adapter@2.11.0", "npm:pi-subagents@0.35.1"];

    const without = scratch();
    run(["--apply"], { root: without, agent: agentDir(without, packages) });
    const withoutCalls = fs.readFileSync(path.join(without, "pi-calls.log"), "utf8");
    assert.doesNotMatch(withoutCalls, /pi-mcp-adapter|pi-subagents/);

    const withAddons = scratch();
    run(["--apply", "--with-addons"], { root: withAddons, agent: agentDir(withAddons, packages) });
    const withCalls = fs.readFileSync(path.join(withAddons, "pi-calls.log"), "utf8");
    assert.match(withCalls, /remove npm:pi-mcp-adapter@2\.11\.0/);
    assert.match(withCalls, /remove npm:pi-subagents@0\.35\.1/);
  });

  it("removes platform project state but never operator data", () => {
    const root = scratch();
    const agent = agentDir(root, []);
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".pi", "piagent-state"), { recursive: true });
    fs.mkdirSync(path.join(project, ".pi", "memory"), { recursive: true });

    const platformState = [".pi/piagent-profile.json", ".pi/piagent-profile.lock.json", ".pi/piagent-state/observed-bash.jsonl"];
    // Credentials, trust, sessions, todos, and memory are the operator's, not
    // this platform's, no matter which flags are passed.
    const operatorData = [".pi/auth.json", ".pi/trust.json", ".pi/memory/MEMORY.md", "AGENTS.md", ".pi/project-context.md"];
    for (const relative of [...platformState, ...operatorData]) {
      fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
      fs.writeFileSync(path.join(project, relative), "content\n");
    }
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({
      defaultProjectTrust: "ask",
      packages: ["npm:@piagent/platform@1.0.2", "npm:someone-elses-extension@2.0.0"]
    }, null, 2));

    const result = run(["--apply", "--project", project], { root, agent });
    assert.equal(result.status, 0, result.stderr);

    for (const relative of platformState) {
      assert.equal(fs.existsSync(path.join(project, relative)), false, `${relative} should be removed`);
    }
    for (const relative of operatorData) {
      assert.equal(fs.existsSync(path.join(project, relative)), true, `${relative} must survive uninstall`);
    }

    // settings.json is Pi's file; only the entry pointing here comes out.
    const settings = JSON.parse(fs.readFileSync(path.join(project, ".pi", "settings.json"), "utf8"));
    assert.deepEqual(settings.packages, ["npm:someone-elses-extension@2.0.0"]);
    assert.equal(settings.defaultProjectTrust, "ask");
  });

  it("does not write to a project during a dry run", () => {
    const root = scratch();
    const agent = agentDir(root, []);
    const project = path.join(root, "project");
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "piagent-profile.json"), "{}\n");

    const result = run(["--project", project], { root, agent });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(project, ".pi", "piagent-profile.json")), true);
  });

  it("fails on a project path that does not exist", () => {
    const root = scratch();
    const result = run(["--apply", "--project", path.join(root, "absent")], { root, agent: agentDir(root, []) });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project path does not exist/);
  });

  it("has side-effect-free help and rejects unknown arguments", () => {
    const root = scratch();
    const agent = agentDir(root, ["npm:@piagent/platform@1.0.2"]);

    const help = run(["--help"], { root, agent });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Usage:/);
    assert.equal(fs.existsSync(path.join(root, "pi-calls.log")), false);

    const bad = run(["--purge-everything"], { root, agent });
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Unknown argument/);
  });

  it("keeps working when pi is not installed", () => {
    // Removing the host first is a normal order of operations; the script has
    // to say what is left rather than fail.
    const root = scratch();
    const agent = agentDir(root, ["npm:@piagent/platform@1.0.2"]);
    const empty = path.join(root, "empty-bin");
    fs.mkdirSync(empty, { recursive: true });
    const result = spawnSync("bash", [script, "--apply"], {
      env: { PATH: `${empty}:/usr/bin:/bin`, PI_CODING_AGENT_DIR: agent, HOME: root },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /pi is not on PATH/);
    assert.match(result.stderr, new RegExp(path.join(agent, "settings.json").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});
