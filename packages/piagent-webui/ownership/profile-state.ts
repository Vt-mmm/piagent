import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DESCRIPTOR_MAX_BYTES = 16 * 1024; // Shared by Gateway and terminal ownership adapters.

export type GatewayDescriptor = {
  version: "piagent-gateway-descriptor-v1";
  gatewayInstanceRef: string;
  pid: number;
  startedAt: string;
  origin: string;
  controlSocket: string;
  profileRef: string;
};

export type GatewayProfileState = {
  agentDir: string;
  root: string;
  descriptorFile: string;
  controlSocket: string;
  catalogKeyFile: string;
};

function assertOwnerOnlyDirectory(target: string): void {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("gateway-state-root-invalid");
  fs.chmodSync(target, 0o700);
}

function shortControlSocket(agentDir: string): string {
  if (process.platform === "win32") {
    const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 24);
    return `\\\\.\\pipe\\piagent-${digest}`;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const socketRoot = path.join("/tmp", `piagent-${uid}`);
  fs.mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(socketRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("gateway-control-root-invalid");
  fs.chmodSync(socketRoot, 0o700);
  const digest = createHash("sha256").update(agentDir).digest("hex").slice(0, 32);
  return path.join(socketRoot, `${digest}.sock`);
}

export function gatewayProfileState(agentDirInput?: string): GatewayProfileState {
  const agentDir = path.resolve(agentDirInput || process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  const agentStat = fs.lstatSync(agentDir);
  if (!agentStat.isDirectory() || agentStat.isSymbolicLink()
    || (typeof process.getuid === "function" && agentStat.uid !== process.getuid())) throw new Error("gateway-agent-dir-invalid");
  const canonicalAgentDir = fs.realpathSync(agentDir);
  const root = path.join(canonicalAgentDir, "piagent-gateway");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertOwnerOnlyDirectory(root);
  return {
    agentDir: canonicalAgentDir,
    root,
    descriptorFile: path.join(root, "descriptor.json"),
    controlSocket: shortControlSocket(canonicalAgentDir),
    catalogKeyFile: path.join(root, "catalog.key")
  };
}

export function profileRef(state: GatewayProfileState, key: Buffer): string {
  return `profile_${createHmac("sha256", key).update(state.agentDir).digest("base64url").slice(0, 43)}`;
}

export function readOrCreateCatalogKey(state: GatewayProfileState): Buffer {
  try {
    const descriptor = fs.openSync(state.catalogKeyFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(descriptor, randomBytes(32)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const stat = fs.lstatSync(state.catalogKeyFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error("gateway-catalog-key-invalid");
  fs.chmodSync(state.catalogKeyFile, 0o600);
  const descriptor = fs.openSync(state.catalogKeyFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== 32) throw new Error("gateway-catalog-key-race");
    return fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

export function writeGatewayDescriptor(state: GatewayProfileState, value: GatewayDescriptor): void {
  const temporary = path.join(state.root, `.descriptor-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  if (body.length > DESCRIPTOR_MAX_BYTES) throw new Error("gateway-descriptor-limit");
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, state.descriptorFile);
  fs.chmodSync(state.descriptorFile, 0o600);
}

export function readGatewayDescriptor(state: GatewayProfileState): GatewayDescriptor | null {
  try {
    const stat = fs.lstatSync(state.descriptorFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DESCRIPTOR_MAX_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(state.descriptorFile, "utf8")) as Partial<GatewayDescriptor>;
    if (value.version !== "piagent-gateway-descriptor-v1" || typeof value.gatewayInstanceRef !== "string"
      || typeof value.pid !== "number" || typeof value.startedAt !== "string" || typeof value.origin !== "string"
      || value.controlSocket !== state.controlSocket || typeof value.profileRef !== "string") return null;
    return value as GatewayDescriptor;
  } catch { return null; }
}

export function removeGatewayDescriptor(state: GatewayProfileState, instanceRef: string): void {
  const current = readGatewayDescriptor(state);
  if (current?.gatewayInstanceRef !== instanceRef) return;
  try { fs.unlinkSync(state.descriptorFile); } catch { /* already removed */ }
}
