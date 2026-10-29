import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateMcpApproval } from '../runtime/mcp-repository-gate.mjs';
import { userToolchains } from './toolchain.mjs';
import { fenced } from './untrusted.mjs';

// The member's MCP servers in company sessions. Company sessions load no Pi
// extension of the member's, with one exception: the MCP adapter Piagent
// installs (pi-mcp-adapter in Piagent's own Pi home). It reads the same
// configuration as personal Piagent (piagent-mcp add, ~/.config/mcp/mcp.json,
// a project's .mcp.json, /mcp) and the same logins (/mcp-auth), so a server the
// member added once works in both. The member decides which servers exist;
// company sessions keep the two protections personal Piagent has: a server a
// repository defines runs only once someone on this machine approved it, and
// what a server returns reaches the agent as data, not instructions.

const ADAPTER = 'pi-mcp-adapter';
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const inside = (file, dir) => { const relative = path.relative(dir, file); return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative); };

// The adapter the member installed in Piagent's Pi home and still lists among
// its packages, or null. `piagent studio` starts from a cleared environment, so
// the home is the default one (~/.piagent/agent) unless a caller names another.
export function memberMcpAdapter(home = os.homedir(), agentDir = path.join(home, '.piagent', 'agent')) {
  const packages = readJson(path.join(agentDir, 'settings.json'))?.packages;
  const listed = Array.isArray(packages) && packages.some(entry => new RegExp(`(^|[:/])${ADAPTER}(@|$)`).test(String(typeof entry === 'string' ? entry : entry?.source ?? '')));
  const dir = path.join(agentDir, 'npm', 'node_modules', ADAPTER);
  if (!listed || !fs.existsSync(path.join(dir, 'package.json'))) return null;
  return { agentDir, dir: fs.realpathSync(dir) };
}

// What the adapter and the servers it starts need from a cleared environment:
// Piagent's Pi home (its mcp.json, logins and caches, shared with personal
// Piagent) and a PATH that finds npx, uvx, docker… as in the member's
// Terminal. Nothing else of the member's shell is passed, as for host commands.
export function memberMcpEnvironment(adapter, home = os.homedir(), env = process.env) {
  env.PI_CODING_AGENT_DIR ||= adapter.agentDir;
  const toolchains = userToolchains(home);
  const dirs = [...toolchains.bins, path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', ...(env.PATH ?? '/usr/bin:/bin').split(':')];
  env.PATH = [...new Set(dirs.filter(Boolean))].join(':');
  for (const [name, value] of Object.entries(toolchains.env)) env[name] ||= value;
  return env;
}

// The repository approval gate on every tool call (as personal Piagent's
// guard), and the adapter's results fenced as data.
export function memberMcpGuard(cwd, adapterDir) {
  return pi => {
    const fromAdapter = name => { const source = pi.getAllTools().find(tool => tool.name === name)?.sourceInfo?.path; return !!source && (source === adapterDir || inside(source, adapterDir)); };
    pi.on('tool_call', event => {
      const decision = evaluateMcpApproval(cwd, event.toolName, event.input ?? {});
      return decision.block ? { block: true, reason: decision.reason } : undefined;
    });
    pi.on('tool_result', event => {
      if (!fromAdapter(event.toolName)) return undefined;
      const text = (event.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join('\n');
      const images = (event.content ?? []).filter(part => part?.type === 'image');
      return { content: [{ type: 'text', text: fenced(`Result of MCP tool ${event.toolName}`, text) }, ...images] };
    });
  };
}

// The company session's own extension factories, with the member's MCP added
// when the adapter is installed: [factories, extension paths] for inlineExtensions.
export function withMemberMcp(cwd, factories, home = os.homedir()) {
  const adapter = memberMcpAdapter(home);
  if (!adapter) return [factories, []];
  memberMcpEnvironment(adapter, home);
  return [[...factories, memberMcpGuard(cwd, adapter.dir)], [adapter.dir]];
}
