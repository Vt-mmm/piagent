import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Piagent runs Pi from its own home (~/.piagent/agent) so the member's
// personal `pi` stays the stock host: no Piagent package, add-ons, model scope
// or footer panel lands in ~/.pi/agent. Agent Watch still reads its control
// files (runtime record, managed binding, status) from ~/.pi/agent, so those
// stay where Watch looks; Pi itself ignores them.

/** The stock Pi home, the member's personal `pi`. */
export function personalPiAgentDir(home = os.homedir()) {
  return path.resolve(home, ".pi", "agent");
}

/**
 * Where Piagent's Pi keeps settings, packages, login and sessions. An explicit
 * PIAGENT_AGENT_DIR wins; a PI_CODING_AGENT_DIR that points anywhere but the
 * personal home is honoured (tests, benchmarks, custom setups); otherwise
 * ~/.piagent/agent.
 */
export function piagentAgentDir(env = process.env, home = os.homedir()) {
  const own = env.PIAGENT_AGENT_DIR?.trim();
  if (own) return path.resolve(own);
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured && path.resolve(configured) !== personalPiAgentDir(home)) return path.resolve(configured);
  return path.resolve(home, ".piagent", "agent");
}

/** Agent Watch's files: the runtime record, the managed binding and status. */
export function agentWatchControlDir(home = os.homedir()) {
  return personalPiAgentDir(home);
}

function realpath(file) {
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

/**
 * True when this process is the stock `pi` command running from the personal
 * home: Piagent was registered there by an older release or a project's
 * .pi/settings.json, and it stays out of the member's way. Hosts that embed Pi
 * (studio, dashboard gateway, benchmarks) and `piagent` itself are never
 * dormant; PIAGENT_ACTIVE=1 opts a personal `pi` back in.
 */
export function dormantInPersonalPi(env = process.env, home = os.homedir(), argv = process.argv) {
  if (env.PIAGENT_ACTIVE === "1") return false;
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured && path.resolve(configured) !== personalPiAgentDir(home)) return false;
  const entry = argv[1] ? realpath(argv[1]) : "";
  return /[\\/]@earendil-works[\\/]pi-coding-agent[\\/]/.test(entry);
}
