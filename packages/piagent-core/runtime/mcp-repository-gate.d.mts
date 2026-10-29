export interface RepositoryMcpGate {
  blocked: Map<string, { state: string; origin: string }>;
  serverNames: Set<string>;
  unverifiable: string[];
}

export const mcpApprovalCache: Map<string, { signature: string; gate: RepositoryMcpGate }>;
export function mcpServerFromToolCall(toolName: string, input: Record<string, unknown>, candidates: Iterable<string>): string | undefined;
export function repositoryMcpGate(cwd: string): RepositoryMcpGate;
export function evaluateMcpApproval(cwd: string, toolName: string, input: Record<string, unknown>): { block: boolean; reason?: string };
