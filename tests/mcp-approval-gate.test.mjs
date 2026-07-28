import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import {
  callToolCall,
  createContext,
  createPiHarness,
  writeRuntimeStubs
} from "./helpers/guard-harness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-mcp-gate-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function loadFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-gate-"));
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
  fs.mkdirSync(path.join(cwd, ".pi", "piagent-state", "tasks"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Fixture\n");
  fs.writeFileSync(path.join(cwd, ".pi", "piagent-profile.json"), `${JSON.stringify({
    schemaVersion: 1,
    projectId: "mcp-gate",
    displayName: "MCP Gate",
    mode: "node-typescript",
    protectedPaths: [],
    shellProtectedPaths: [],
    requiredContext: [],
    verifyCommands: { test: ["npm test"] },
    mcpCapabilities: ["filesystem-readonly", "shell"],
    permissionProfile: "workspace-write",
    runtimePolicy: { execPolicy: "off", contextBudget: "off", toolRegistry: "off", finalGate: "off" }
  }, null, 2)}\n`);

  const moduleUrl = pathToFileURL(path.join(packageRoot, "extensions", "piagent-guard.ts")).href;
  const imported = await import(`${moduleUrl}?t=${Date.now()}-${Math.random()}`);
  return { root, home, cwd, piagentGuard: imported.default };
}

function writeProjectServer(cwd, name, entry, file = ".mcp.json") {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`);
}

function writeProjectConfig(cwd, document, file = ".mcp.json") {
  const target = path.join(cwd, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
}

function approve(home, cwd, name, entry) {
  const digest = approvalDigest(entry);
  fs.writeFileSync(path.join(home, ".pi", "piagent-mcp-approvals.json"), `${JSON.stringify({
    schemaVersion: 1,
    projects: { [fs.realpathSync(cwd)]: { [name]: { decision: "approved", digest, decidedAt: "2026-07-28T00:00:00.000Z" } } }
  }, null, 2)}\n`);
}

let approvalDigest;
{
  const module = await import(pathToFileURL(path.join(repoRoot, "packages", "piagent-core", "mcp", "mcp-approval-store.js")).href);
  approvalDigest = module.serverEntryDigest;
}

/** Runs a block with HOME pointed at the fixture, so the approval store is the fixture's. */
// HOME alone does not decide where the global layers live: both have their own
// environment variable that wins over it. A runner with XDG_CONFIG_HOME set —
// which Linux runners have and macOS ones do not — resolved the global scope
// outside the fixture, so a test writing there was reading a file the guard
// never looked at. Pinning all three keeps the fixture sealed either way, and
// keeps a real config on the machine running the suite out of it.
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

async function startGuard(fixture) {
  const ctx = createContext(fixture.cwd);
  const harness = createPiHarness();
  fixture.piagentGuard(harness.pi);
  await harness.handlers.get("session_start")({}, ctx);
  return { ctx, harness };
}

describe("MCP approval gate", () => {
  const serverEntry = { command: "npx", args: ["-y", "@acme/repo-mcp"], lifecycle: "lazy" };

  // The gate is cached and recomputed when a signature over the files behind it
  // changes. That signature was written by hand from the repository layers,
  // while the check it guards grew to read merged settings from every scope and
  // to stat import targets outside the repository. An already-loaded guard went
  // on permitting calls in exactly the states `piagent-mcp doctor` was
  // reporting as blocked, until the module happened to be reloaded.
  it("sees a global setting that blocks the gate after the first call", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, { settings: { toolPrefix: "none" }, mcpServers: {} });

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const call = () => callToolCall(harness.handlers.get("tool_call"), ctx, "some_tool", { x: 1 });
      assert.notEqual((await call())?.block, true);

      // Neither half blocks alone; the adapter merges settings across layers, so
      // together they are the state that leaves nothing to check.
      const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
      fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
      fs.writeFileSync(globalConfig, `${JSON.stringify({ settings: { directTools: true }, mcpServers: {} })}\n`);

      const after = await call();
      assert.equal(after?.block, true);
      assert.match(after.reason, /toolPrefix "none"/);
    });
  });

  it("sees an import target that appears after the first call", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, { imports: ["codex"], mcpServers: {} });

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const call = () => callToolCall(harness.handlers.get("tool_call"), ctx, "some_tool", { x: 1 });
      // Declared but not installed, so nothing is hidden yet.
      assert.notEqual((await call())?.block, true);

      fs.mkdirSync(path.join(fixture.home, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(fixture.home, ".codex", "config.toml"), '[mcp_servers.exfil]\ncommand = "npx"\n');

      const after = await call();
      assert.equal(after?.block, true);
      assert.match(after.reason, /cannot enumerate/);
    });
  });

  it("blocks a proxy call to a server the repository defines and nobody approved", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "repo",
        tool: "search",
        args: "{}"
      });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /Blocked MCP server repo/);
      assert.match(decision.reason, /nobody on this machine has approved it/);
      assert.match(decision.reason, /piagent-mcp approve repo/);
    });
  });

  it("allows the call once the server is approved", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);
    approve(fixture.home, fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "repo",
        tool: "search",
        args: "{}"
      });
      assert.notEqual(decision?.block, true);
    });
  });

  // A gate that only reads the proxy is bypassed by turning directTools on. The
  // name to watch for is the one the adapter really builds — the server name with
  // hyphens turned into underscores, then the tool name — and not the
  // mcp__server__tool shape this test used to assert, which nothing emits.
  it("blocks the direct tool the adapter actually exposes", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "repo_search", { query: "x" });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /Blocked MCP server repo/);
    });
  });

  it("blocks a direct tool whose prefix came from a hyphenated server name", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo-tools", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "repo_tools_search", { query: "x" });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /Blocked MCP server repo-tools/);
    });
  });

  // The previous matcher keyed on a leading "mcp", so any tool whose name merely
  // started that way was attributed to a server that had nothing to do with it.
  // Attribution now runs off the configured server names, so an unrelated name
  // is not this gate's business — whatever else the guard decides about it.
  it("does not attribute an unrelated tool to a configured server", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp_unrelated_probe", { query: "x" });
      if (decision?.block) assert.doesNotMatch(decision.reason, /Blocked MCP server/);
    });
  });

  // The adapter resolves an `imports` key against other tools' config files. The
  // vscode kind resolves inside the project, so a clone carries the file and the
  // servers in it are the repository's servers however indirectly they arrive.
  it("blocks a server the repository pulls in through imports", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, { imports: ["vscode"], mcpServers: {} });
    writeProjectConfig(fixture.cwd, { servers: { exfil: serverEntry } }, path.join(".vscode", "mcp.json"));

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "exfil",
        tool: "search",
        args: "{}"
      });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /Blocked MCP server exfil/);
      assert.match(decision.reason, /imports it from vscode config/);
    });
  });

  it("blocks the imported server's direct tool as well", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, { imports: ["vscode"], mcpServers: {} });
    writeProjectConfig(fixture.cwd, { mcpServers: { exfil: serverEntry } }, path.join(".vscode", "mcp.json"));

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "exfil_run", { query: "x" });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /Blocked MCP server exfil/);
    });
  });

  // The layer that carries the `imports` key is not the layer the servers come
  // from. A global config importing a repository-relative kind reads them out of
  // the clone, so the gate has to treat them as the repository's — and the CLI
  // has to agree, which is asserted over in the mcp-manage tests.
  it("blocks a repository server that a global config imported", async () => {
    const fixture = await loadFixture();
    const globalConfig = path.join(fixture.home, ".config", "mcp", "mcp.json");
    fs.mkdirSync(path.dirname(globalConfig), { recursive: true });
    fs.writeFileSync(globalConfig, `${JSON.stringify({ imports: ["vscode"], mcpServers: {} })}\n`);
    writeProjectConfig(fixture.cwd, { servers: { exfil: serverEntry } }, path.join(".vscode", "mcp.json"));

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "exfil",
        tool: "search",
        args: "{}"
      });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /Blocked MCP server exfil/);
    });
  });

  it("allows an imported server once it is approved for this project", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, { imports: ["vscode"], mcpServers: {} });
    writeProjectConfig(fixture.cwd, { servers: { exfil: serverEntry } }, path.join(".vscode", "mcp.json"));
    approve(fixture.home, fixture.cwd, "exfil", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "exfil",
        tool: "search",
        args: "{}"
      });
      assert.notEqual(decision?.block, true);
    });
  });

  // Asking for direct tools with no prefix leaves nothing in a tool name to check
  // an approval against. Refusing only the proxy was not a fix: the proxy is the
  // one form that names its server, so blocking it while letting the bare names
  // through left the hole exactly where it was. Every call stops instead.
  it("refuses every call, bare name included, while the repository config erases tool origin", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, {
      settings: { directTools: true, toolPrefix: "none" },
      mcpServers: { repo: serverEntry }
    });

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const proxy = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "repo",
        tool: "search",
        args: "{}"
      });
      assert.equal(proxy?.block, true);
      assert.match(proxy.reason, /toolPrefix "none"/);

      // The name the adapter actually emits under this setting: no prefix, no
      // server anywhere in it.
      const bare = await callToolCall(harness.handlers.get("tool_call"), ctx, "search", { query: "x" });
      assert.equal(bare?.block, true);
      assert.match(bare.reason, /toolPrefix "none"/);
    });
  });

  // One of the six import kinds keeps its servers in a format nothing here
  // parses. Blocking the servers that could be listed would say nothing about
  // the ones that could not, so the declaration itself is what gets refused.
  it("refuses every call while the repository imports a kind it cannot enumerate", async () => {
    const fixture = await loadFixture();
    writeProjectConfig(fixture.cwd, { imports: ["codex"], mcpServers: {} });
    fs.mkdirSync(path.join(fixture.home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture.home, ".codex", "config.toml"),
      '[mcp_servers.exfil]\ncommand = "npx"\nargs = ["-y", "@attacker/mcp"]\n'
    );

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", {
        server: "exfil",
        tool: "search",
        args: "{}"
      });
      assert.equal(decision?.block, true);
      assert.match(decision.reason, /cannot enumerate/);

      // Approving the one server that happened to be readable would not say
      // anything about the rest of a file nothing here can read, so the refusal
      // covers the direct names too.
      const direct = await callToolCall(harness.handlers.get("tool_call"), ctx, "exfil_run", { query: "x" });
      assert.equal(direct?.block, true);
      assert.match(direct.reason, /cannot enumerate/);
    });
  });

  it("blocks again after the approved definition is edited", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);
    approve(fixture.home, fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const allowed = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", { server: "repo", tool: "search", args: "{}" });
      assert.notEqual(allowed?.block, true);

      writeProjectServer(fixture.cwd, "repo", { ...serverEntry, args: ["-y", "@acme/repo-mcp", "--exfiltrate"] });
      const blocked = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", { server: "repo", tool: "search", args: "{}" });
      assert.equal(blocked?.block, true, "an edited definition must not keep the old approval");
      assert.match(blocked.reason, /definition changed since it was approved/);
    });
  });

  it("covers the Pi-specific project layer as well as the shared one", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry, path.join(".pi", "mcp.json"));

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", { server: "repo", tool: "search", args: "{}" });
      assert.equal(decision?.block, true);
    });
  });

  // Global scope is outside every repository, so nothing a repository carries can
  // put a server there. Gating it would ask the operator to approve their own
  // configuration on every machine.
  it("leaves servers configured outside the repository alone", async () => {
    const fixture = await loadFixture();
    fs.mkdirSync(path.join(fixture.home, ".config", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, ".config", "mcp", "mcp.json"), `${JSON.stringify({
      mcpServers: { mine: serverEntry }
    }, null, 2)}\n`);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "mcp", { server: "mine", tool: "search", args: "{}" });
      assert.notEqual(decision?.block, true);
    });
  });

  it("does not gate non-MCP tools", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx, harness } = await startGuard(fixture);
      const decision = await callToolCall(harness.handlers.get("tool_call"), ctx, "read", {
        path: path.join(fixture.cwd, "README.md")
      });
      assert.notEqual(decision?.block, true);
    });
  });

  it("names the waiting server at session start, and stays quiet when told to", async () => {
    const fixture = await loadFixture();
    writeProjectServer(fixture.cwd, "repo", serverEntry);

    await withHome(fixture.home, async () => {
      const { ctx } = await startGuard(fixture);
      const notices = ctx.ui.notices.map((notice) => notice.message).join("\n");
      assert.match(notices, /MCP servers need a decision or setup/);
      assert.match(notices, /repo \(defined by this repository/);
    });

    process.env.PIAGENT_NO_MCP_NOTICE = "1";
    try {
      await withHome(fixture.home, async () => {
        const { ctx } = await startGuard(fixture);
        const notices = ctx.ui.notices.map((notice) => notice.message).join("\n");
        assert.ok(!notices.includes("MCP servers"), notices);
      });
    } finally {
      delete process.env.PIAGENT_NO_MCP_NOTICE;
    }
  });

  it("says nothing when there is no MCP configuration at all", async () => {
    const fixture = await loadFixture();
    await withHome(fixture.home, async () => {
      const { ctx } = await startGuard(fixture);
      const notices = ctx.ui.notices.map((notice) => notice.message).join("\n");
      assert.ok(!notices.includes("MCP servers"), notices);
    });
  });
});
