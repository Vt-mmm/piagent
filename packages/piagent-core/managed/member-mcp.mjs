import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { evaluateMcpApproval } from '../runtime/mcp-repository-gate.mjs';
import { mcpWriteAction } from '../runtime/policy/handoff-policy.mjs';
import { userToolchains } from './toolchain.mjs';
import { fenced } from './untrusted.mjs';

// The member's MCP servers in company sessions. Company sessions load no Pi
// extension of the member's, with one exception: the MCP adapter Piagent
// installs (pi-mcp-adapter in Piagent's own Pi home). It reads the same
// configuration as personal Piagent (piagent-mcp add, ~/.config/mcp/mcp.json,
// a project's .mcp.json, /mcp) and the same logins (/mcp-auth), so a server the
// member added once works in both. The member decides which servers exist;
// company sessions keep the protections personal Piagent has: a server a
// repository defines runs only once someone on this machine approved it, a
// tool that writes to the server's system (create, update, push, merge,
// publish, send… in its name) is asked about in every access mode, Bypass
// included, since it hands work to the outside, and what a server returns
// reaches the agent as data, not instructions.

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

// The MCP tool a call runs: the proxy's `tool` (`mcp` with tool and server),
// or a direct tool the adapter registered. null for anything else.
export function mcpToolCalled(toolName, input, fromAdapter) {
  if (toolName === 'mcp') return typeof input?.tool === 'string' && input.tool.trim() ? { tool: input.tool.trim(), server: String(input.server ?? '').trim() } : null;
  return fromAdapter(toolName) ? { tool: toolName, server: '' } : null;
}

// The repository approval gate on every tool call (as personal Piagent's
// guard), the member's approval of an MCP write, and the adapter's results
// fenced as data. Without an owner (no conversation to ask in) a write is refused.
export function memberMcpGuard(cwd, adapterDir, owner = null) {
  return pi => {
    const fromAdapter = name => { const source = pi.getAllTools().find(tool => tool.name === name)?.sourceInfo?.path; return !!source && (source === adapterDir || inside(source, adapterDir)); };
    pi.on('tool_call', async (event, ctx) => {
      const decision = evaluateMcpApproval(cwd, event.toolName, event.input ?? {});
      if (decision.block) return { block: true, reason: decision.reason };
      const called = mcpToolCalled(event.toolName, event.input, fromAdapter);
      const action = called && await mcpWriteAction(called.tool);
      if (!action) return undefined;
      if (!owner) return { block: true, reason: `MCP tool ${called.tool} writes outside (${action}) and no member can approve it here.` };
      const { approve } = await import('./command-tools.mjs');
      const name = called.server ? `${called.server} → ${called.tool}` : called.tool, args = JSON.stringify(event.input?.args ?? event.input ?? {}).slice(0, 600);
      try {
        await approve(owner, event.toolCallId, ctx?.signal, ctx, { toolName: event.toolName, rawAction: { tool: called.tool, server: called.server, input: event.input ?? {} }, commandPreview: name,
          provider: called.server || 'mcp', requestedScope: 'mcp-write-once', reason: `The MCP tool ${name} writes outside this machine (${action}); every access mode asks before a handoff.`, riskClass: 'high',
          allowConsequence: 'Run this exact MCP call once; it changes the system behind that server.', denyConsequence: 'The call does not run; the agent is told you declined.' },
        { title: 'Công cụ MCP ghi ra ngoài', body: `${name}\n${args}\n\nCông cụ này ${action} trên hệ thống của server MCP. Mọi chế độ truy cập, kể cả Bypass, đều hỏi trước việc bàn giao ra ngoài.\n\nĐồng ý: chạy đúng lệnh gọi này một lần.\nTừ chối: không chạy, agent được báo bạn đã từ chối.` });
      } catch { return { block: true, reason: `User denied MCP tool ${name}.` }; }
      return undefined;
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
export function withMemberMcp(cwd, factories, home = os.homedir(), owner = null) {
  const adapter = memberMcpAdapter(home);
  if (!adapter) return [factories, []];
  memberMcpEnvironment(adapter, home);
  return [[...factories, memberMcpGuard(cwd, adapter.dir, owner)], [adapter.dir]];
}
