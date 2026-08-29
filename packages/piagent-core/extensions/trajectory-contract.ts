export const TRAJECTORY_PHASES = Object.freeze([
  "intake", "scout", "plan", "execute", "verify", "repair", "review", "handoff", "terminal"
] as const);

export type TrajectoryPhase = typeof TRAJECTORY_PHASES[number];
