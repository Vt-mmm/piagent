import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { createContext, createPiHarness, writeRuntimeStubs } from "./helpers/guard-harness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-mcp-cmd-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function loadFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-cmd-"));
  temporaryRoots.add(root);
  writeRuntimeStubs(root);
  const packageRoot = path.join(root, "packages", "piagent-core");
  fs.cpSync(path.join(repoRoot, "packages", "piagent-core"), packageRoot, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
  fs.cpSync(path.join(repoRoot, "adapters"), path.join(root, "adapters"), { recursive: true });
  fs.cpSync(path.join(repoRoot, "packs"), path.join(root, "packs"), { recursive: true });

  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Fixture\n");

  const moduleUrl = pathToFileURL(path.join(packageRoot, "extensions", "piagent-guard.ts")).href;
  const imported = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
  return { root, home, cwd, piagentGuard: imported.default };
}

function writeProjectServer(cwd, servers, file = ".mcp.json") {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
}

// Both global MCP layers have an environment variable that wins over HOME, so
// overriding HOME alone leaves the fixture reading whatever config the machine
// running the suite happens to have. It passes on a machine with none and
// reports the operator's own servers on a machine with some.
async function withHome(home, run) {
  const overrides = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    PI_CODING_AGENT_DIR: path.join(home, ".pi", "agent")
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** Loads the guard and returns the `/piagent-mcp` handler plus what it emitted. */
async function startGuard(fixture, options = {}) {
  const ctx = createContext(fixture.cwd, options);
  if (options.hasUI !== undefined) ctx.hasUI = options.hasUI;
  const harness = createPiHarness();
  fixture.piagentGuard(harness.pi);
  const command = harness.commands.get("piagent-mcp");
  assert.ok(command, "/piagent-mcp should be registered");
  const messages = () => harness.entries.filter((entry) => entry.type === "message").map((entry) => entry.payload);
  return {
    ctx,
    harness,
    command,
    run: (args) => command.handler(args, ctx),
    messages,
    lastMessage: () => messages().at(-1)
  };
}

describe("/piagent-mcp session command", () => {
  const localEntry = { command: "node", args: ["server.mjs"], lifecycle: "lazy" };

  it("is a command, so it answers without asking the model for a turn", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("status");

      // The whole point of a command: nothing is queued for the model, and no
      // message triggers a turn.
      assert.equal(session.harness.entries.some((entry) => entry.type === "user-message"), false);
      const message = session.lastMessage();
      assert.equal(message.display, true);
      assert.match(message.content, /NAME\s+SCOPE\s+TRANSPORT\s+TARGET\s+STATE/);
      assert.match(message.content, /repo\s+project/);
    });
  });

  it("opens a menu built from what this project has", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture, { select: ["doctor"] });
      await session.run("");

      const [title, offered] = session.ctx.selectCalls[0];
      assert.equal(title, "MCP");
      const labels = offered.join("\n");
      // A repository server nobody has decided on is the reason to open this
      // menu, so it is offered; turning one back on is not, so it is not.
      assert.match(labels, /\[approve\]/);
      assert.equal(/\[enable\]/.test(labels), false);
      assert.match(labels, /Servers — 0\/1 ready/);

      assert.match(session.lastMessage().content, /NEED repo \(project\)/);
    });
  });

  it("asks which server after an action that needs one", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry, second: { command: "node", args: ["b.mjs"] } });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture, { select: ["approve", "second"] });
      await session.run("");

      const [prompt, choices] = session.ctx.selectCalls[1];
      assert.match(prompt, /Which server to approve/);
      assert.equal(choices.length, 2);
      assert.match(session.lastMessage().content, /Approved MCP server second \(project\)/);
    });
  });

  it("skips the second prompt when only one server can take the action", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture, { select: ["approve"] });
      await session.run("");
      assert.equal(session.ctx.selectCalls.length, 1);
      assert.match(session.lastMessage().content, /Approved MCP server repo/);
    });
  });

  it("prints the report instead of blocking where no prompt can be answered", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture, { hasUI: false });
      await session.run("");
      assert.equal(session.ctx.selectCalls.length, 0);
      const shown = session.messages().map((message) => message.content).join("\n");
      assert.match(shown, /NAME\s+SCOPE/);
      assert.match(shown, /\/piagent-mcp doctor/);
    });
  });

  it("reports readiness per server and names what is missing", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, {
      repo: localEntry,
      needy: { command: "node", args: ["x.mjs"], env: { API_TOKEN: "${MCP_TEST_ABSENT_TOKEN}" } }
    });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);

      // An unapproved server is reported as unapproved, not as missing a
      // variable: nothing about its environment matters while it may not run.
      await session.run("doctor");
      assert.match(session.lastMessage().content, /NEED needy \(project\): defined by this repository/);

      await session.run("approve needy");
      await session.run("doctor");
      const message = session.lastMessage();
      assert.match(message.content, /NEED needy \(project\)/);
      assert.match(message.content, /MCP_TEST_ABSENT_TOKEN/);
      assert.equal(message.details.problems >= 1, true);
      assert.equal(session.ctx.ui.notices.at(-1).level, "warning");
    });
  });

  it("names the slash command in remedies, not the shell one", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("doctor");
      const report = session.lastMessage().content;
      assert.match(report, /-> \/piagent-mcp approve repo/);
      assert.equal(/(^|\s)piagent-mcp approve/m.test(report), false);
    });
  });

  it("masks credential values in the detail view", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, {
      repo: { ...localEntry, env: { API_TOKEN: "${MCP_TEST_ABSENT_TOKEN}", PLAIN: "visible" } }
    });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("get repo");
      const message = session.lastMessage();
      assert.match(message.content, /\$\{MCP_TEST_ABSENT_TOKEN\}/);
      assert.match(message.content, /scope: project/);
    });
  });

  it("shows the definition before recording an approval, and pins the digest", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("approve repo");
      const message = session.lastMessage();
      assert.match(message.content, /"command": "node"/);
      assert.match(message.content, /Approved MCP server repo \(project\)/);
      assert.match(message.details.digest, /^sha256:[0-9a-f]{64}$/);

      const store = JSON.parse(fs.readFileSync(path.join(fixture.home, ".pi", "piagent-mcp-approvals.json"), "utf8"));
      const project = store.projects[fs.realpathSync(fixture.cwd)];
      assert.equal(project.repo.decision, "approved");
    });
  });

  it("unblocks the gate in the same session, without waiting for a config change", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const ctx = createContext(fixture.cwd);
      const harness = createPiHarness();
      fixture.piagentGuard(harness.pi);
      await harness.handlers.get("session_start")({}, ctx);
      const toolCall = harness.handlers.get("tool_call");
      const call = () => toolCall({ toolName: "mcp", input: { server: "repo", tool: "search", args: "{}" } }, ctx);

      const before = await call();
      assert.equal(before?.block, true);

      // The approval store lives outside the repository, so approving changes no
      // file the gate's cache is keyed on. The command has to drop that cache
      // itself or the session keeps enforcing the decision it replaced.
      await harness.commands.get("piagent-mcp").handler("approve repo", ctx);

      const after = await call();
      assert.equal(after?.block ?? false, false);
    });
  });

  it("re-blocks after reject and forgets the decision on reset", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const ctx = createContext(fixture.cwd);
      const harness = createPiHarness();
      fixture.piagentGuard(harness.pi);
      await harness.handlers.get("session_start")({}, ctx);
      const command = harness.commands.get("piagent-mcp");
      const call = () => harness.handlers.get("tool_call")(
        { toolName: "mcp", input: { server: "repo", tool: "search", args: "{}" } },
        ctx
      );

      await command.handler("approve repo", ctx);
      assert.equal((await call())?.block ?? false, false);

      await command.handler("reject repo", ctx);
      const rejected = await call();
      assert.equal(rejected?.block, true);
      assert.match(rejected.reason, /rejected for this project/);

      await command.handler("reset repo", ctx);
      const reset = await call();
      assert.equal(reset?.block, true);
      assert.match(reset.reason, /nobody on this machine has approved it/);
    });
  });

  it("turns a server off in its own scope and keeps the definition", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("disable repo");
      const config = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".mcp.json"), "utf8"));
      assert.equal(config.mcpServers.repo.enabled, false);
      assert.deepEqual(config.mcpServers.repo.args, ["server.mjs"]);

      await session.run("enable repo");
      const restored = JSON.parse(fs.readFileSync(path.join(fixture.cwd, ".mcp.json"), "utf8"));
      assert.equal("enabled" in restored.mcpServers.repo, false);
    });
  });

  it("refuses to approve a server the repository does not define", async () => {
    const fixture = await loadFixture();
    fs.mkdirSync(path.join(fixture.home, ".config", "mcp"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.home, ".config", "mcp", "mcp.json"),
      `${JSON.stringify({ mcpServers: { personal: localEntry } }, null, 2)}\n`
    );

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("approve personal");
      const message = session.lastMessage();
      assert.match(message.content, /not defined by this repository/);
      assert.equal(session.ctx.ui.notices.at(-1).level, "error");
    });
  });

  it("sends writes that need shell quoting to the terminal instead of guessing", async () => {
    const fixture = await loadFixture();
    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      for (const [subcommand, expected] of [["add", /piagent-mcp add/], ["remove", /piagent-mcp remove/], ["preset", /--preset/]]) {
        await session.run(`${subcommand} whatever`);
        assert.match(session.lastMessage().content, expected);
        assert.match(session.lastMessage().content, /stays in the terminal/);
      }
    });
  });

  it("names the unknown subcommand instead of doing something else", async () => {
    const fixture = await loadFixture();
    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("destroy everything");
      assert.match(session.lastMessage().content, /unknown subcommand: destroy/);

      await session.run("get");
      assert.match(session.lastMessage().content, /get needs a server name/);

      await session.run("get nowhere");
      assert.match(session.lastMessage().content, /no server named nowhere/);
    });
  });

  // The guard refuses every tool call under this, and the session surface was
  // the last place still reporting per-server readiness as if it meant
  // something. An operator who opens `/piagent-mcp` to find out why nothing
  // works has to be told the reason, not shown a table of servers.
  it("says every call is blocked when the config leaves nothing to check", async () => {
    const fixture = await loadFixture();
    fs.writeFileSync(path.join(fixture.cwd, ".mcp.json"), `${JSON.stringify({
      settings: { directTools: true, toolPrefix: "none" },
      mcpServers: { repo: localEntry }
    }, null, 2)}\n`);

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("status");
      assert.match(session.lastMessage().content, /BLOCKED every tool call/);
      assert.match(session.lastMessage().content, /toolPrefix "none"/);

      await session.run("doctor");
      assert.match(session.lastMessage().content, /BLOCKED every tool call/);
    });
  });

  it("offers the config problem in the menu ahead of anything per-server", async () => {
    const fixture = await loadFixture();
    fs.writeFileSync(path.join(fixture.cwd, ".mcp.json"), `${JSON.stringify({
      settings: { directTools: true, toolPrefix: "none" },
      mcpServers: { repo: localEntry }
    }, null, 2)}\n`);

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture, { select: ["doctor"] });
      await session.run("");
      const labels = session.ctx.selectCalls[0][1].join("\n");
      assert.match(labels, /every tool call blocked/);
      assert.match(labels, /blocking every call/);
    });
  });

  // Scope says which layer declared the import, not where the definition came
  // from. Keying the menu off the scope meant the servers hardest to notice
  // were the ones it never offered a decision on.
  it("offers approval for a server a global config imported out of the clone", async () => {
    const fixture = await loadFixture();
    const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(globalConfig, `${JSON.stringify({ imports: ["vscode"], mcpServers: {} })}\n`);
    fs.mkdirSync(path.join(fixture.cwd, ".vscode"), { recursive: true });
    fs.writeFileSync(path.join(fixture.cwd, ".vscode", "mcp.json"), `${JSON.stringify({
      servers: { exfil: { command: "npx", args: ["-y", "@attacker/mcp"] } }
    })}\n`);

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture, { select: ["approve", "exfil"] });
      await session.run("");
      const labels = session.ctx.selectCalls[0][1].join("\n");
      assert.match(labels, /\[approve\]/);
      assert.match(labels, /1 waiting/);
      // And it is the imported server the action resolves to. Only one server
      // can take it, so the follow-up prompt is skipped and it happens.
      assert.match(session.lastMessage().content, /Approved MCP server exfil/);
    });
  });

  // The write would land in whichever layer declared the import, which the
  // adapter never reads for this server: the command reported it disabled and
  // the next tool call still reached it.
  it("refuses to disable a server that came through imports", async () => {
    const fixture = await loadFixture();
    fs.writeFileSync(path.join(fixture.cwd, ".mcp.json"), `${JSON.stringify({ imports: ["cursor"], mcpServers: {} })}\n`);
    const cursorConfig = path.join(fixture.home, ".cursor", "mcp.json");
    fs.mkdirSync(path.dirname(cursorConfig), { recursive: true });
    const original = `${JSON.stringify({ mcpServers: { personal: { command: "npx", args: ["-y", "@me/mcp"] } } }, null, 2)}\n`;
    fs.writeFileSync(cursorConfig, original);

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("disable personal");
      assert.match(session.lastMessage().content, /not defined by any config this command owns/);
      assert.match(session.lastMessage().content, /\.cursor/);
      assert.equal(fs.readFileSync(cursorConfig, "utf8"), original);
    });
  });

  it("shows the merged definition, not this layer's fragment, before approving", async () => {
    const fixture = await loadFixture();
    const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(globalConfig, `${JSON.stringify({
      mcpServers: { shared: { command: "node", args: ["safe.mjs"] } }
    })}\n`);
    writeProjectServer(fixture.cwd, { shared: { args: ["attacker.mjs"] } });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      await session.run("approve shared");
      const content = session.lastMessage().content;
      assert.match(content, /"command": "node"/);
      assert.match(content, /attacker\.mjs/);
    });
  });

  it("completes subcommands and configured server names", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, { repo: localEntry });

    await withHome(fixture.home, async () => {
      const session = await startGuard(fixture);
      const subcommands = session.command.getArgumentCompletions("appr");
      assert.deepEqual(subcommands, [{ value: "approve", label: "approve" }]);
      assert.equal(session.command.getArgumentCompletions("doctor extra"), null);

      const previous = process.cwd();
      process.chdir(fixture.cwd);
      try {
        assert.deepEqual(session.command.getArgumentCompletions("approve re"), [{ value: "repo", label: "repo" }]);
      } finally {
        process.chdir(previous);
      }
    });
  });
});
