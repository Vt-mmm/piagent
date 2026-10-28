export function personalPiAgentDir(home?: string): string;
export function piagentAgentDir(env?: NodeJS.ProcessEnv, home?: string): string;
export function agentWatchControlDir(home?: string): string;
export function dormantInPersonalPi(env?: NodeJS.ProcessEnv, home?: string, argv?: string[]): boolean;
