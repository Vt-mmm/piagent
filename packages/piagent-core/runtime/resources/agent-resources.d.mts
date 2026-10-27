export type AgentCommand = { kind: "command" | "skill"; name: string; description: string; argumentHint: string | null;
  origin: "claude" | "codex" | "agents" | "pi"; scope: "project" | "user"; plugin?: string };
export type MemberPlugin = { agent: "claude" | "codex"; name: string; root: string; skills: string[]; commands: string[] };
export function projectFolders(cwd: string, home?: string): string[];
export function agentResourcePaths(options: { cwd: string; home?: string; piDefaults?: boolean }): { skillPaths: string[]; promptPaths: string[]; plugins: MemberPlugin[] };
export function userSkillFolders(home?: string): string[];
export function listAgentCommands(options: { cwd: string; home?: string }): AgentCommand[];
