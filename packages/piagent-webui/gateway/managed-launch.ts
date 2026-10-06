import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestGatewayControl } from "./control-socket.ts";
import { gatewayProfileState } from "./profile-state.ts";
import { agentWatchDataDirectory, interopEnvironment, storedSlot } from "../../piagent-core/managed/store.mjs";

// The personal dashboard shows company sessions but never runs them: it starts
// the pinned managed entrypoint (its own process and Gateway, `--serve`) the
// way Agent Watch's launcher does, then relays to it. Grants stay inside that
// process; this process only reads the public binding.
export type ManagedLaunchStatus = { schemaVersion: 1; version: "piagent-managed-launch-status-v1"; available: boolean; model: "agent-watch-auto" };
type Binding = { file: string; profile: string; node: string; entrypoint: string; broker: string; brokerSha256: string };

const CLEAN_ENV = { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "xterm-256color", ...interopEnvironment() };
const READY = /^Agent Watch Auto: ready$/m;
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const HEX64 = /^[a-f0-9]{64}$/;

const DEFAULT_AGENT_DIR = path.join(os.homedir(), ".pi", "agent");

// The relay and the company Gateway speak one protocol, so they must be the
// same Piagent release: Agent Watch may still point at another install (nvm,
// Homebrew…) and a company Gateway started before an update keeps running.
const versionAt = (file: string): string | null => { try { return String(JSON.parse(fs.readFileSync(file, "utf8")).version); } catch { return null; } };
const OWN_VERSION = versionAt(fileURLToPath(new URL("../../../package.json", import.meta.url)));
const sameRelease = (pinned: Binding) => OWN_VERSION === null || versionAt(path.join(path.dirname(path.dirname(pinned.entrypoint)), "package.json")) === OWN_VERSION;
const current = (health: { packageVersion?: unknown }) => OWN_VERSION === null || health.packageVersion === OWN_VERSION;

// Agent Watch writes the binding into the personal Pi folder it imported into.
function binding(agentDir: string): Binding | null {
  const file = path.join(agentDir, "agent-watch-managed.json");
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 16_384) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const absolute = (entry: unknown) => typeof entry === "string" && path.isAbsolute(entry);
    if (value?.schema_version !== 1 || value.model !== "agent-watch-auto" || !HEX64.test(String(value.profile_id))
      || !absolute(value.node) || !absolute(value.entrypoint) || !absolute(value.broker) || !HEX64.test(String(value.broker_sha256))) return null;
    return { file, profile: value.profile_id, node: value.node, entrypoint: value.entrypoint, broker: value.broker, brokerSha256: value.broker_sha256 };
  } catch { return null; }
}

export function managedLaunchStatus(agentDir = DEFAULT_AGENT_DIR): ManagedLaunchStatus {
  return { schemaVersion: 1, version: "piagent-managed-launch-status-v1", available: binding(agentDir) !== null, model: "agent-watch-auto" };
}

// A key's slot points at its member's conversation store once it has been
// launched (store.mjs); until then the slot's own folder is asked.
function controlSocket(home: string, profile: string): string {
  const root = path.join(agentWatchDataDirectory(home), "ManagedSessions");
  return gatewayProfileState(path.join(root, storedSlot(root, profile) ?? profile)).controlSocket;
}

// "busy": the Gateway took the connection but has not answered yet. It is
// alive; starting another beside it would leave two on the same store.
async function running(socket: string): Promise<{ packageVersion?: unknown } | "busy" | null> {
  try {
    const reply = await requestGatewayControl(socket, { action: "health" });
    return reply.ok ? (reply.value && typeof reply.value === "object" ? reply.value : {}) : null;
  } catch (error) { return error instanceof Error && error.message === "gateway-control-timeout" ? "busy" : null; }
}

// Same foreground step as Agent Watch: macOS may ask once to let this build of
// the broker read its Keychain item. Nothing secret comes back. Exit 67 means
// the imported key is no longer connected in Agent Watch.
async function authorize(pinned: Binding): Promise<void> {
  if (fs.realpathSync(pinned.broker) !== pinned.broker || sha256(pinned.broker) !== pinned.brokerSha256) throw new Error("managed-launch-binding-changed");
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(pinned.broker, ["managed-authorize", "--profile", pinned.profile], { cwd: "/", stdio: "ignore", env: CLEAN_ENV, timeout: 180_000, killSignal: "SIGKILL" });
    child.once("error", () => resolve(null));
    child.once("exit", (exit) => resolve(exit));
  });
  if (code === 67) throw new Error("managed-profile-disconnected");
  if (code !== 0) throw new Error("managed-keychain-approval-required");
}

// The control socket of a running company Gateway, without launching one.
export async function attachCompanyGateway(agentDir = DEFAULT_AGENT_DIR, home = os.homedir()): Promise<string | null> {
  const pinned = binding(agentDir);
  if (!pinned || !sameRelease(pinned)) return null;
  const socket = controlSocket(home, pinned.profile);
  const health = await running(socket);
  return health && health !== "busy" && current(health) ? socket : null;
}

let inFlight: Promise<string> | null = null;

// Returns the company Gateway's control socket, starting it when needed.
export function ensureCompanyGateway(agentDir = DEFAULT_AGENT_DIR, home = os.homedir(), timeoutMs = 45_000): Promise<string> {
  inFlight ??= start(agentDir, home, timeoutMs).finally(() => { inFlight = null; });
  return inFlight;
}

async function start(agentDir: string, home: string, timeoutMs: number): Promise<string> {
  const pinned = binding(agentDir);
  if (!pinned) throw new Error("managed-config-missing");
  if (!sameRelease(pinned)) throw new Error("managed-launch-version-mismatch");
  const socket = controlSocket(home, pinned.profile);
  let health = await running(socket);
  for (const started = Date.now(); health === "busy"; health = await running(socket)) {
    if (Date.now() - started > timeoutMs) throw new Error("managed-launch-busy");
  }
  if (health && current(health)) return socket;
  if (health) {
    // A company Gateway from before the update: stop it (its transcripts stay
    // on disk) and start this release.
    try { await requestGatewayControl(socket, { action: "stop" }); } catch { /* already stopping */ }
    for (const started = Date.now(); await running(socket);) {
      if (Date.now() - started > 15_000) throw new Error("managed-launch-stale-runtime");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await authorize(pinned);
  // Startup failures are reported on stderr as `Agent Watch: managed-…`; the
  // log is private and removed once the process is ready or has exited.
  const directory = path.join(agentWatchDataDirectory(home), "ManagedLaunch");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  const log = path.join(directory, `launch-${process.pid}-${Date.now()}.log`);
  const fd = fs.openSync(log, "wx", 0o600);
  let exited = false;
  try {
    const child = spawn(pinned.node, [pinned.entrypoint, "--config", pinned.file, "--serve"],
      { cwd: "/", detached: true, stdio: ["ignore", fd, fd], env: CLEAN_ENV });
    child.once("exit", () => { exited = true; }); child.once("error", () => { exited = true; }); child.unref();
  } finally { fs.closeSync(fd); }
  try {
    for (const started = Date.now(); Date.now() - started < timeoutMs;) {
      const text = fs.readFileSync(log, "utf8");
      // The launch may just have pointed this slot at the member's store.
      if (READY.test(text)) return controlSocket(home, pinned.profile);
      if (exited) throw new Error(text.match(/Agent Watch: (managed-[a-z:_-]+)\./)?.[1] ?? "managed-launch-failed");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("managed-launch-timeout");
  } finally { fs.rmSync(log, { force: true }); }
}

// The personal dashboard's connector for company sessions (CompanyRelay).
export function agentWatchCompanyConnector(agentDir = DEFAULT_AGENT_DIR, home = os.homedir()) {
  return { configured: () => binding(agentDir) !== null, ensure: () => ensureCompanyGateway(agentDir, home), attach: () => attachCompanyGateway(agentDir, home) };
}
