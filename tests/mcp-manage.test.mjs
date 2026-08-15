import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "scripts", "mcp-manage.mjs");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("piagent-mcp-cli-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-mcp-cli-"));
  temporaryRoots.add(root);
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  return { root, home, project };
}

function run(fixture, args, options = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    cwd: options.cwd ?? fixture.project,
    env: {
      PATH: process.env.PATH,
      HOME: fixture.home,
      XDG_CONFIG_HOME: path.join(fixture.home, ".config"),
      ...options.env
    }
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Readiness answers the first thing that is wrong, and a missing executable
// outranks a missing variable. A test about the environment therefore has to
// supply the executable rather than assume the runner has it: the core preset
// reaches GitHub through Docker, which a macOS runner does not install.
function pathWithStub(fixture, name) {
  const bin = path.join(fixture.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function projectConfigPath(fixture) {
  return path.join(fixture.project, ".mcp.json");
}

describe("piagent-mcp server management", () => {
  it("writes a local server and names the scope and the file it changed", () => {
    const fixture = createFixture();
    const added = run(fixture, ["add", "internal", "--scope", "global", "--", "npx", "-y", "@acme/internal-mcp"]);

    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /Added local MCP server internal/);
    assert.match(added.stdout, /in global scope/);
    assert.match(added.stdout, /File modified: .*mcp\.json/);

    const config = readConfig(path.join(fixture.home, ".config", "mcp", "mcp.json"));
    assert.deepEqual(config.mcpServers.internal.args, ["-y", "@acme/internal-mcp"]);
    assert.equal(config.mcpServers.internal.command, "npx");
    // The safe defaults the baseline exists to carry are applied to a hand-added
    // server too, not only to preset ones.
    assert.equal(config.settings.outputGuard, true);
    assert.equal(config.mcpServers.internal.directTools, false);
  });

  // A credential written into MCP config reaches every client that reads the
  // file, and in project scope it reaches version control.
  it("refuses a literal credential and gives the reference form to use instead", () => {
    const fixture = createFixture();
    const refused = run(fixture, [
      "add", "gh", "--scope", "global",
      "--env", "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_ThisWouldBeARealTokenValue1234",
      "--", "npx", "-y", "@acme/gh-mcp"
    ]);

    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /names a credential/);
    assert.match(refused.stderr, /\$\{GITHUB_PERSONAL_ACCESS_TOKEN\}/);
    assert.ok(!fs.existsSync(path.join(fixture.home, ".config", "mcp", "mcp.json")), "nothing should have been written");

    const accepted = run(fixture, [
      "add", "gh", "--scope", "global",
      "--env", "GITHUB_PERSONAL_ACCESS_TOKEN=${GITHUB_PERSONAL_ACCESS_TOKEN}",
      "--", "npx", "-y", "@acme/gh-mcp"
    ]);
    assert.equal(accepted.status, 0, accepted.stderr);
  });

  it("refuses a credential hidden behind a neutral name, and one in a header", () => {
    const fixture = createFixture();
    const neutral = run(fixture, [
      "add", "x", "--scope", "global",
      "--env", "CONFIG=ghp_ThisWouldBeARealTokenValue1234",
      "--", "npx", "-y", "@acme/x"
    ]);
    assert.equal(neutral.status, 2);
    assert.match(neutral.stderr, /looks like a credential/);

    const header = run(fixture, [
      "add", "y", "--scope", "global",
      "--url", "https://mcp.example.com/mcp",
      "--header", "Authorization: Bearer abcdef0123456789"
    ]);
    assert.equal(header.status, 2);
    assert.match(header.stderr, /cannot be written into MCP config/);

    const referenced = run(fixture, [
      "add", "y", "--scope", "global",
      "--url", "https://mcp.example.com/mcp",
      "--header", "Authorization: Bearer ${ACME_TOKEN}"
    ]);
    assert.equal(referenced.status, 0, referenced.stderr);
  });

  it("accepts https and loopback http, and refuses a plaintext remote", () => {
    const fixture = createFixture();
    assert.equal(run(fixture, ["add", "a", "--scope", "global", "--url", "https://mcp.example.com/mcp"]).status, 0);
    assert.equal(run(fixture, ["add", "b", "--scope", "global", "--url", "http://127.0.0.1:3845/mcp"]).status, 0);

    const plaintext = run(fixture, ["add", "c", "--scope", "global", "--url", "http://mcp.example.com/mcp"]);
    assert.equal(plaintext.status, 2);
    assert.match(plaintext.stderr, /must be https, or http on localhost/);
  });

  it("refuses to overwrite an existing server unless told to", () => {
    const fixture = createFixture();
    assert.equal(run(fixture, ["add", "dup", "--scope", "global", "--url", "https://one.example.com/mcp"]).status, 0);

    const clash = run(fixture, ["add", "dup", "--scope", "global", "--url", "https://two.example.com/mcp"]);
    assert.equal(clash.status, 2);
    assert.match(clash.stderr, /already exists in global scope/);

    const replaced = run(fixture, ["add", "dup", "--scope", "global", "--replace", "--url", "https://two.example.com/mcp"]);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(replaced.stdout, /^Replaced/);
    assert.equal(readConfig(path.join(fixture.home, ".config", "mcp", "mcp.json")).mcpServers.dup.url, "https://two.example.com/mcp");
  });

  it("masks credential values in get and list, and keeps variable names readable", () => {
    const fixture = createFixture();
    fs.writeFileSync(projectConfigPath(fixture), `${JSON.stringify({
      mcpServers: {
        mixed: {
          command: "npx",
          args: ["-y", "@acme/mixed"],
          env: { API_TOKEN: "literal-value-written-by-hand", REFERENCED: "${REFERENCED}" }
        }
      }
    }, null, 2)}\n`);

    const shown = run(fixture, ["get", "mixed"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.ok(!shown.stdout.includes("literal-value-written-by-hand"), shown.stdout);
    assert.match(shown.stdout, /\*\*\*\*\*/);
    // The reference is the name of a variable, so showing it is the point.
    assert.match(shown.stdout, /\$\{REFERENCED\}/);
  });

  // The same rule --env and --header enforce. An address is not a safer place
  // for a token: it lands in the committed file and in request logs besides.
  it("refuses a credential carried in the URL and masks one already on disk", () => {
    const fixture = createFixture();

    const userinfo = run(fixture, ["add", "a", "--scope", "global", "--url", "https://user:s3cret@mcp.example.com/mcp"]);
    assert.equal(userinfo.status, 2);
    assert.match(userinfo.stderr, /must not carry credentials in the address/);
    assert.ok(!userinfo.stderr.includes("s3cret"), userinfo.stderr);

    const query = run(fixture, ["add", "b", "--scope", "global", "--url", "https://mcp.example.com/mcp?api_key=live-value"]);
    assert.equal(query.status, 2);
    assert.match(query.stderr, /looks like a credential/);

    fs.writeFileSync(projectConfigPath(fixture), `${JSON.stringify({
      mcpServers: { legacy: { url: "https://user:s3cret@mcp.example.com/mcp?token=live-value" } }
    }, null, 2)}\n`);
    for (const command of [["get", "legacy"], ["list"]]) {
      const shown = run(fixture, command);
      assert.equal(shown.status, 0, shown.stderr);
      assert.ok(!shown.stdout.includes("s3cret"), `${command[0]}: ${shown.stdout}`);
      assert.ok(!shown.stdout.includes("live-value"), `${command[0]}: ${shown.stdout}`);
    }
  });

  // Global scope, because approval outranks a missing variable on the readiness
  // ladder and a repository-scoped server would report pending first.
  it("reports a bearer token variable that is not set", () => {
    const fixture = createFixture();
    assert.equal(run(fixture, [
      "add", "remote", "--scope", "global",
      "--url", "https://mcp.example.com/mcp",
      "--bearer-token-env-var", "REMOTE_TOKEN"
    ]).status, 0);

    // The field names its variable directly instead of through ${VAR}, which is
    // why the reference scan never saw it and the server read as ready.
    const missing = run(fixture, ["doctor"]);
    assert.match(missing.stdout, /REMOTE_TOKEN/);

    const present = run(fixture, ["doctor"], { env: { REMOTE_TOKEN: "value" } });
    assert.ok(!present.stdout.includes("REMOTE_TOKEN is referenced but not set"), present.stdout);
  });

  it("fails loudly when the decision cannot be written", () => {
    const fixture = createFixture();
    fs.writeFileSync(projectConfigPath(fixture), `${JSON.stringify({
      mcpServers: { repo: { command: "npx", args: ["-y", "@acme/repo"] } }
    }, null, 2)}\n`);
    // A file where the store's directory belongs, so the write cannot succeed.
    fs.writeFileSync(path.join(fixture.home, ".pi"), "not a directory\n");

    const approved = run(fixture, ["approve", "repo"]);
    assert.notEqual(approved.status, 0);
    assert.match(approved.stderr, /could not write/);
  });

  it("names a config layer it cannot parse instead of counting it as empty", () => {
    const fixture = createFixture();
    fs.writeFileSync(projectConfigPath(fixture), "{ not json\n");

    const report = run(fixture, ["doctor"]);
    assert.match(report.stdout, /Unreadable project config/);
  });

  it("names the import a repository config uses to reach other servers", () => {
    const fixture = createFixture();
    fs.writeFileSync(projectConfigPath(fixture), `${JSON.stringify({
      imports: ["vscode"],
      mcpServers: {}
    }, null, 2)}\n`);
    fs.mkdirSync(path.join(fixture.project, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(fixture.project, ".vscode", "mcp.json"), `${JSON.stringify({
      servers: { exfil: { command: "npx", args: ["-y", "@attacker/mcp"] } }
    }, null, 2)}\n`);

    const report = run(fixture, ["doctor"]);
    assert.match(report.stdout, /imports servers from vscode config/);
    // And the server itself is listed, holding at pending like any the
    // repository declares outright.
    const listed = run(fixture, ["list"]);
    assert.match(listed.stdout, /exfil/);
  });

  it("holds a server the repository defines until it is approved here", () => {
    const fixture = createFixture();
    const added = run(fixture, ["add", "repo", "--scope", "project", "--", "npx", "-y", "@acme/repo-mcp"]);
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /not usable until approved/);

    const before = run(fixture, ["list"]);
    assert.match(before.stdout, /repo\s+project\s+stdio\s+.*pending-approval/);

    const approved = run(fixture, ["approve", "repo"]);
    assert.equal(approved.status, 0, approved.stderr);
    assert.match(approved.stdout, /Approved MCP server repo/);
    assert.match(approved.stdout, /Pinned to this definition: sha256:[0-9a-f]{64}/);

    const after = run(fixture, ["list"]);
    assert.match(after.stdout, /repo\s+project\s+stdio\s+.*ready/);

    // The decision belongs to this machine, not to the repository.
    assert.ok(!fs.existsSync(path.join(fixture.project, ".pi", "piagent-mcp-approvals.json")));
    const store = JSON.parse(fs.readFileSync(path.join(fixture.home, ".pi", "piagent-mcp-approvals.json"), "utf8"));
    assert.equal(Object.values(store.projects)[0].repo.decision, "approved");
  });

  // Approval is consent to what the server runs. Editing what it runs is a new
  // question, and the point of pinning the digest is that it gets asked.
  it("returns an approved server to pending when its definition changes", () => {
    const fixture = createFixture();
    run(fixture, ["add", "repo", "--scope", "project", "--", "npx", "-y", "@acme/repo-mcp"]);
    run(fixture, ["approve", "repo"]);
    assert.match(run(fixture, ["list"]).stdout, /repo.*ready/);

    const config = readConfig(projectConfigPath(fixture));
    config.mcpServers.repo.args = ["-y", "@acme/repo-mcp", "--exfiltrate"];
    fs.writeFileSync(projectConfigPath(fixture), `${JSON.stringify(config, null, 2)}\n`);

    const listed = run(fixture, ["list"]);
    assert.match(listed.stdout, /repo.*approval-changed/);
    const shown = run(fixture, ["get", "repo"]);
    assert.match(shown.stdout, /state: approval-changed/);
    assert.match(shown.stdout, /approval: changed/);
  });

  it("keeps a rejected server rejected and forgets the decision on reset", () => {
    const fixture = createFixture();
    run(fixture, ["add", "repo", "--scope", "project", "--", "npx", "-y", "@acme/repo-mcp"]);

    assert.equal(run(fixture, ["reject", "repo"]).status, 0);
    assert.match(run(fixture, ["list"]).stdout, /repo.*rejected/);

    assert.equal(run(fixture, ["reset"]).status, 0);
    assert.match(run(fixture, ["list"]).stdout, /repo.*pending-approval/);
  });

  it("drops the decision when the server is replaced or removed", () => {
    const fixture = createFixture();
    run(fixture, ["add", "repo", "--scope", "project", "--", "npx", "-y", "@acme/repo-mcp"]);
    run(fixture, ["approve", "repo"]);

    const replaced = run(fixture, ["add", "repo", "--scope", "project", "--replace", "--", "npx", "-y", "@acme/other-mcp"]);
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(run(fixture, ["list"]).stdout, /repo.*pending-approval/);

    run(fixture, ["approve", "repo"]);
    assert.equal(run(fixture, ["remove", "repo"]).status, 0);
    const store = JSON.parse(fs.readFileSync(path.join(fixture.home, ".pi", "piagent-mcp-approvals.json"), "utf8"));
    assert.deepEqual(store.projects, {});
  });

  it("refuses to decide on a server the repository does not define", () => {
    const fixture = createFixture();
    run(fixture, ["add", "mine", "--scope", "global", "--url", "https://mcp.example.com/mcp"]);
    const refused = run(fixture, ["approve", "mine"]);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /not defined by this repository/);
  });

  it("turns a server off without losing its definition", () => {
    const fixture = createFixture();
    run(fixture, ["add", "off", "--scope", "global", "--url", "https://mcp.example.com/mcp"]);

    assert.equal(run(fixture, ["disable", "off"]).status, 0);
    assert.equal(readConfig(path.join(fixture.home, ".config", "mcp", "mcp.json")).mcpServers.off.enabled, false);
    assert.match(run(fixture, ["list"]).stdout, /off.*disabled/);

    assert.equal(run(fixture, ["enable", "off"]).status, 0);
    const entry = readConfig(path.join(fixture.home, ".config", "mcp", "mcp.json")).mcpServers.off;
    assert.ok(!Object.hasOwn(entry, "enabled"));
    assert.equal(entry.url, "https://mcp.example.com/mcp");
  });

  it("reports a referenced variable that is not set, and stays quiet about an optional one", () => {
    const fixture = createFixture();
    const PATH = pathWithStub(fixture, "docker");
    run(fixture, ["--preset", "core", "--scope", "global"]);

    const doctor = run(fixture, ["doctor", "--json"], { env: { PATH } });
    const report = JSON.parse(doctor.stdout);
    const byName = Object.fromEntries(report.servers.map((server) => [server.name, server]));

    assert.equal(byName.github.state, "needs-env");
    assert.match(byName.github.detail, /GITHUB_PERSONAL_ACCESS_TOKEN/);
    // Context7 answers without a key; the key only raises the quota.
    assert.equal(byName.context7.state, "ready");

    const withToken = run(fixture, ["doctor", "--json"], { env: { PATH, GITHUB_PERSONAL_ACCESS_TOKEN: "value" } });
    const resolved = JSON.parse(withToken.stdout).servers.find((server) => server.name === "github");
    assert.equal(resolved.state, "ready");
  });

  it("reports an executable that is not installed", () => {
    const fixture = createFixture();
    run(fixture, ["add", "missing", "--scope", "global", "--", "definitely-not-installed-binary"]);
    const report = JSON.parse(run(fixture, ["doctor", "--json"]).stdout);
    const entry = report.servers.find((server) => server.name === "missing");
    assert.equal(entry.state, "needs-command");
    assert.match(entry.detail, /definitely-not-installed-binary is not on PATH/);
  });

  it("uses the local Figma desktop server for design presets until remote OAuth approves this client", () => {
    const fixture = createFixture();
    assert.equal(run(fixture, ["--preset", "design", "--scope", "global"]).status, 0);
    const config = readConfig(path.join(fixture.home, ".config", "mcp", "mcp.json"));
    assert.equal(config.mcpServers["figma-desktop"].url, "http://127.0.0.1:3845/mcp");
    assert.equal(Object.hasOwn(config.mcpServers, "figma"), false);
  });

  it("keeps hand-added servers when a preset is re-applied, and re-pins the ones it owns", () => {
    const fixture = createFixture();
    const config = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, `${JSON.stringify({
      mcpServers: {
        "my-internal": { command: "npx", args: ["-y", "@acme/internal-mcp"] },
        github: { command: "docker", args: ["run", "--hand-edited"] }
      }
    }, null, 2)}\n`);

    assert.equal(run(fixture, ["--preset", "core", "--scope", "global", "--replace"]).status, 0);
    const merged = readConfig(config);
    assert.deepEqual(merged.mcpServers["my-internal"].args, ["-y", "@acme/internal-mcp"]);
    assert.ok(merged.mcpServers.github.args.includes("GITHUB_READ_ONLY=1"));
  });

  it("rejects a bad scope, a bad preset and an unknown option instead of guessing", () => {
    const fixture = createFixture();
    assert.match(run(fixture, ["list", "--scope", "nowhere"]).stderr, /unsupported scope/);
    assert.match(run(fixture, ["--preset", "nonsense"]).stderr, /unknown preset/);
    assert.match(run(fixture, ["add", "x", "--nonsense"]).stderr, /unknown option/);
    assert.match(run(fixture, ["add", "bad name", "--url", "https://x.example.com/mcp"]).stderr, /invalid server name/);
    assert.match(run(fixture, ["get", "absent"]).stderr, /no server named absent/);
  });

  // The guard and this CLI have to agree about a config that stops every tool
  // call. When only the guard knew, `doctor` printed "No MCP servers configured"
  // and exited 0 while nothing in the session could run — an answer that sends
  // the operator to the wrong file, or to no file at all.
  it("reports an import it cannot enumerate instead of reporting nothing", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({ imports: ["codex"], mcpServers: {} })}\n`);
    fs.mkdirSync(path.join(fixture.home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, ".codex", "config.toml"), '[mcp_servers.exfil]\ncommand = "npx"\n');

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stdout, /BLOCKED every tool call/);
    assert.match(doctor.stdout, /cannot enumerate/);
    assert.doesNotMatch(doctor.stdout, /No MCP servers configured/);

    const list = run(fixture, ["list"]);
    assert.equal(list.status, 1, list.stdout);
    assert.match(list.stdout, /BLOCKED every tool call/);
    // Telling somebody to seed a baseline here points them at the wrong file.
    assert.doesNotMatch(list.stdout, /Seed the pinned baseline/);

    const json = JSON.parse(run(fixture, ["doctor", "--json"]).stdout);
    assert.equal(json.unverifiableConfig.length, 1);
  });

  it("reports a config that erases tool origin the same way", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      settings: { directTools: true, toolPrefix: "none" },
      mcpServers: {}
    })}\n`);

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stdout, /toolPrefix "none"/);
  });

  it("reports server-level direct tools that erase origin", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      settings: { toolPrefix: "none" },
      mcpServers: {
        repo: {
          command: "node",
          args: ["server.js"],
          directTools: ["search"]
        }
      }
    })}\n`);

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stdout, /repo/);
    assert.match(doctor.stdout, /directTools/);
    assert.match(doctor.stdout, /toolPrefix "none"/);
  });

  // Scope says which layer named the import; it does not say where the servers
  // came from. A global config importing a repository-relative kind reads them
  // out of the clone, and the gate treats them as the repository's.
  it("does not call a server ready because the layer that imported it is global", () => {
    const fixture = createFixture();
    const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(globalConfig, `${JSON.stringify({ imports: ["vscode"], mcpServers: {} })}\n`);
    fs.mkdirSync(path.join(fixture.project, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(fixture.project, ".vscode", "mcp.json"), `${JSON.stringify({
      servers: { exfil: { command: "npx", args: ["-y", "@attacker/mcp"] } }
    })}\n`);

    const list = run(fixture, ["list", "--json"]);
    const server = JSON.parse(list.stdout).servers.find((row) => row.name === "exfil");
    assert.equal(server.state, "pending-approval");
    // The detail names the file the definition actually came from, not the
    // layer that happened to carry the imports key.
    assert.match(server.detail, /imported from vscode config/);

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.doesNotMatch(doctor.stdout, /PASS: every configured MCP server/);

    // The detail view has to show the decision too. Keying that line off the
    // scope left it blank for exactly the servers whose need for approval is
    // least visible from the config that names them.
    const get = run(fixture, ["get", "exfil"]);
    assert.match(get.stdout, /approval: pending/);
    // And it says which file to edit, because `scope: global` plus a path
    // inside the clone reads as a config this command owns, and it does not.
    assert.match(get.stdout, /origin: import:vscode/);
  });

  // Every surface has to agree that nothing can run. `list --json` was the one
  // that did not: a caller scripting against it read `servers: []` as "nothing
  // configured", and an exit code of 0 agreed, while the guard was refusing
  // every tool call.
  it("reports a blocking config through list --json and its exit code", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      settings: { directTools: true, toolPrefix: "none" },
      mcpServers: {}
    })}\n`);

    const list = run(fixture, ["list", "--json"]);
    assert.equal(list.status, 1, list.stdout);
    const json = JSON.parse(list.stdout);
    assert.equal(json.usable, false);
    assert.equal(json.blockingConfig.length, 1);
    assert.match(json.blockingConfig[0].detail, /toolPrefix "none"/);
  });

  // The two keys are one merged settings block in the adapter, so splitting them
  // across layers used to produce a session with neither key set anywhere a
  // single-layer check would look.
  it("reads settings the way the adapter merges them, across layers", () => {
    const fixture = createFixture();
    const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(globalConfig, `${JSON.stringify({ settings: { directTools: true }, mcpServers: {} })}\n`);
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      settings: { toolPrefix: "none" },
      mcpServers: { repo: { command: "npx", args: ["-y", "@acme/mcp"] } }
    })}\n`);

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stdout, /BLOCKED every tool call/);
    // Both files, because editing either one alone fixes it and naming one
    // sends the reader to a file the other half is not in.
    assert.match(doctor.stdout, /mcp\.json and .*\.mcp\.json/);
  });

  // An import of a kind nothing here can parse is a hole only when the file it
  // names is actually there. Refusing on the declaration alone stopped every
  // session whose repository listed a tool the operator does not have.
  it("ignores an unenumerable import whose config does not exist", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({ imports: ["codex"], mcpServers: {} })}\n`);

    const list = run(fixture, ["list"]);
    assert.equal(list.status, 0, list.stdout);
    assert.doesNotMatch(list.stdout, /BLOCKED every tool call/);
  });

  // `located.file` for an imported server is the other tool's config. Writing it
  // back through this tool's writer would rewrite somebody's Cursor file in a
  // format Cursor does not use.
  it("refuses to remove or disable a server that came through imports", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({ imports: ["cursor"], mcpServers: {} })}\n`);
    const cursorConfig = path.join(fixture.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { personal: { command: "npx", args: ["-y", "@me/mcp"] } } }, null, 2)}\n`;
    fs.writeFileSync(cursorConfig, original);

    for (const argv of [["remove", "personal"], ["disable", "personal"], ["enable", "personal"]]) {
      const result = run(fixture, argv);
      assert.equal(result.status, 2, `${argv[0]}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /not defined by any config this command owns/, argv[0]);
      assert.match(result.stderr, /\.cursor/, argv[0]);
    }
    // The operator's own file is exactly as it was.
    assert.equal(fs.readFileSync(cursorConfig, "utf8"), original);
  });

  // A JSON array parses fine and is not a config. Reading it as empty meant the
  // next write replaced the file with this tool's shape, destroying whatever the
  // document had been.
  it("refuses a config that parses but is not an object", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), '["not", "a", "config"]\n');

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stdout, /not a JSON object/);
  });

  it("keeps import kinds it does not recognise when it writes", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      imports: ["cursor", "some-future-tool"],
      mcpServers: {}
    }, null, 2)}\n`);

    const added = run(fixture, ["add", "local", "--scope", "project", "--", "npx", "-y", "@acme/mcp"]);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    assert.deepEqual(readConfig(projectConfigPath(fixture)).imports, ["cursor", "some-future-tool"]);
  });

  it("refuses to write through a symlinked config", () => {
    const fixture = createFixture();
    const real = path.join(fixture.root, "elsewhere.json");
    fs.writeFileSync(real, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
    fs.symlinkSync(real, projectConfigPath(fixture));

    const added = run(fixture, ["add", "local", "--scope", "project", "--", "npx", "-y", "@acme/mcp"]);
    assert.notEqual(added.status, 0);
    assert.match(added.stderr, /refusing to write through a symlink/);
    assert.deepEqual(readConfig(real).mcpServers, {});
  });

  // Absent and unreadable both read as pending, which is right for the gate and
  // wrong for a write: overwriting a store nobody could parse discards every
  // decision in it, including the ones for other projects.
  it("refuses to write over an approval store it could not read", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      mcpServers: { repo: { command: "npx", args: ["-y", "@acme/mcp"] } }
    })}\n`);
    fs.mkdirSync(path.join(fixture.home, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, ".pi", "piagent-mcp-approvals.json"), "{ this is not json\n");

    const approved = run(fixture, ["approve", "repo", "--force"]);
    assert.notEqual(approved.status, 0);
    assert.match(approved.stderr, /could not write/);
    // Untouched, so whatever it holds can still be recovered by hand.
    assert.equal(fs.readFileSync(path.join(fixture.home, ".pi", "piagent-mcp-approvals.json"), "utf8"), "{ this is not json\n");
  });

  // The adapter merges a same-named server key by key across layers. A
  // repository that declares only `args` runs with a command it never showed.
  it("shows the merged definition when asking for approval", () => {
    const fixture = createFixture();
    const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(globalConfig, `${JSON.stringify({
      mcpServers: { shared: { command: "npx", args: ["-y", "@acme/safe"] } }
    })}\n`);
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({
      mcpServers: { shared: { args: ["-y", "@attacker/mcp"] } }
    })}\n`);

    const approved = run(fixture, ["approve", "shared"]);
    assert.equal(approved.status, 0, approved.stdout + approved.stderr);
    // The command line the operator is consenting to, not the fragment.
    assert.match(approved.stdout, /"command": "npx"/);
    assert.match(approved.stdout, /@attacker\/mcp/);
  });

  it("names an import target that exists but cannot be parsed", () => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.project, ".mcp.json"), `${JSON.stringify({ imports: ["cursor"], mcpServers: {} })}\n`);
    const cursorConfig = path.join(fixture.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    fs.writeFileSync(cursorConfig, "{ broken\n");

    const doctor = run(fixture, ["doctor"]);
    assert.equal(doctor.status, 1, doctor.stdout);
    assert.match(doctor.stdout, /present but unreadable/);
    assert.match(doctor.stdout, /\.cursor/);
  });

  it("is exposed as a command by the package and the dispatcher", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    assert.equal(manifest.bin["piagent-mcp"], "scripts/piagent-cli.mjs");
    const dispatcher = fs.readFileSync(path.join(repoRoot, "scripts", "piagent-cli.mjs"), "utf8");
    assert.match(dispatcher, /"piagent-mcp": "scripts\/mcp-manage\.mjs"/);
  });
});
