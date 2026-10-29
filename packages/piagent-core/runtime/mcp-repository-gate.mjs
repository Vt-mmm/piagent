import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  REPOSITORY_SCOPES,
  collectServers,
  configPathForScope,
  mcpDecisionInputs,
  unverifiableMcpConfig
} from "../mcp/mcp-config-layers.js";
import { approvalState } from "../mcp/mcp-approval-store.js";
import { attributeDirectTool } from "../mcp/mcp-tool-naming.js";

// Servers a repository defines are not usable until somebody on this machine has
// approved them. This is the enforcement point, shared by personal Piagent
// (piagent-guard) and company sessions (managed/member-mcp.mjs): the adapter
// owns the connection and neither can prevent one being opened, but no tool
// call reaches an unapproved server. The residual exposure is the connection
// itself, which is worth stating plainly rather than describing this as a full
// block.

// The same token form the guard's action policy uses: `MCP`, `mcp` and `Mcp`
// all name the adapter's proxy tool.
const actionToken = (value) => String(value)
  .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "");

// Which MCP server a tool call is addressed to. The adapter exposes one proxy
// tool named `mcp` that carries the server in `input.server`, and, under
// directTools, one tool per server tool named `<prefix>_<tool>` where the prefix
// is derived from the server name. Direct names are matched against the servers
// this gate is holding rather than against a fixed pattern, because the prefix
// is the server's own name and there is nothing constant to anchor on.
export function mcpServerFromToolCall(toolName, input, candidates) {
  if (actionToken(toolName) === "mcp") {
    return typeof input?.server === "string" && input.server.trim() ? input.server.trim() : undefined;
  }
  return attributeDirectTool(toolName, candidates);
}

// Recomputed only when one of the files behind the decision changes, because
// this runs on every tool call. Approving or rejecting a server clears the
// project's entry.
export const mcpApprovalCache = new Map();

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "absent";
  }
}

// `blocked`: the servers a call must not reach, with why. `unverifiable`:
// conditions under which no tool call can be checked at all, each with the
// sentence to show. Those are not "a server is unapproved" but "this
// repository's config has put the gate in a state where it cannot tell which
// server a call belongs to", and the only sound answer to that is to stop.
export function repositoryMcpGate(cwd) {
  // Repository scopes plus anything an `imports` key drags in from a file the
  // clone carries. Collecting those here is the whole point: a server the gate
  // never enumerates is a server it silently permits.
  const servers = collectServers({ projectPath: cwd, scopes: [...REPOSITORY_SCOPES] });
  const repositoryFiles = [...REPOSITORY_SCOPES].map((scope) => ({
    scope,
    file: configPathForScope(scope, { projectPath: cwd })
  }));
  // Every file the decision reads, listed by the module that reads them rather
  // than restated here. Building this by hand is what went wrong: the scan grew
  // to read merged settings from all four scopes and to stat import targets
  // outside the repository, the hand-written list did not, and an already-loaded
  // guard went on permitting calls after a personal global config had put the
  // session in the state this gate exists to refuse.
  const signature = [
    ...servers.map((server) => `${server.origin}:${server.name}:${fileSignature(server.file)}`),
    ...repositoryFiles.map((layer) => `layer:${layer.scope}:${fileSignature(layer.file)}`),
    ...mcpDecisionInputs({ projectPath: cwd }).map((file) => `input:${file}:${fileSignature(file)}`),
    `store:${fileSignature(path.join(os.homedir(), ".pi", "piagent-mcp-approvals.json"))}`
  ].join("|");
  const cached = mcpApprovalCache.get(cwd);
  if (cached?.signature === signature) return cached.gate;

  const blocked = new Map();
  for (const server of servers) {
    const state = approvalState({ projectPath: cwd, name: server.name, entry: server.entry });
    if (state.state === "approved") continue;
    // A name defined more than once keeps its blocking entry: the approved copy
    // does not vouch for the one nobody has looked at.
    blocked.set(server.name, { state: state.state, origin: server.origin });
  }

  // Two things a repository-carried config can do that leave nothing to check.
  //
  // It can ask for tools with no prefix, so a direct tool arrives under a bare
  // name carrying no evidence of its server. Refusing only the proxy there was
  // not a fix: the proxy is the one form that names its server, so blocking it
  // and allowing the bare names left the hole exactly where it was.
  //
  // It can also import a kind whose config this platform cannot enumerate, and
  // then the set of servers reaching the session is simply unknown. Blocking the
  // servers that could be listed says nothing about the ones that could not.
  //
  // Both stop every tool call. A repository can make a session refuse to run;
  // it must not be able to make one run a server nobody approved.
  // Read from the shared module rather than decided here, so `piagent-mcp
  // doctor` reports exactly what this refuses. The two disagreeing is how an
  // operator ends up reading "PASS" while every tool call is being stopped.
  const unverifiable = unverifiableMcpConfig({ projectPath: cwd }).map((problem) => problem.detail);

  const gate = { blocked, serverNames: new Set(servers.map((server) => server.name)), unverifiable };
  mcpApprovalCache.set(cwd, { signature, gate });
  return gate;
}

// Whether a tool call may go ahead in `cwd`: `{ block: false }`, or the
// reason it may not, naming the commands that resolve it.
export function evaluateMcpApproval(cwd, toolName, input) {
  const gate = repositoryMcpGate(cwd);

  // Every tool call, not only the ones that look like MCP. Under either of these
  // conditions a call cannot be traced to a server, so there is no such thing as
  // a call this gate can clear.
  if (gate.unverifiable.length > 0) {
    return { block: true, reason: `Blocked every tool call: ${gate.unverifiable.join(" ")}` };
  }

  const server = mcpServerFromToolCall(toolName, input, gate.blocked.keys());
  if (!server) return { block: false };
  const record = gate.blocked.get(server);
  if (!record) return { block: false };
  const explanation = record.state === "rejected"
    ? "it was rejected for this project"
    : record.state === "changed"
      ? "its definition changed since it was approved"
      : record.origin.startsWith("import:")
        ? `this repository imports it from ${record.origin.slice("import:".length)} config and nobody on this machine has approved it here`
        : "this repository defines it and nobody on this machine has approved it";
  return {
    block: true,
    // Named as commands, because this is read inside a session: the reader can
    // run these where they already are, without shelling out.
    reason:
      `Blocked MCP server ${server}: ${explanation}. ` +
      `Review it with \`/piagent-mcp get ${server}\`, then \`/piagent-mcp approve ${server}\` to allow it ` +
      `or \`/piagent-mcp reject ${server}\` to refuse it.`
  };
}
