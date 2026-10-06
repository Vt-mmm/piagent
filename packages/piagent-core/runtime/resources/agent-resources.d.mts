export type AgentCommand = { kind: "command" | "skill"; name: string; description: string; argumentHint: string | null;
  origin: "claude" | "codex" | "agents" | "pi"; scope: "project" | "user" };
export function projectFolders(cwd: string, home?: string): string[];
export function agentResourcePaths(options: { cwd: string; home?: string; piDefaults?: boolean }): { skillPaths: string[]; promptPaths: string[] };
export function userSkillFolders(home?: string): string[];
export function listAgentCommands(options: { cwd: string; home?: string }): AgentCommand[];
