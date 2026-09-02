import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { stat } from "node:fs/promises";
import { MAX_RESPONSE_BYTES, parseRequest, parseResponse } from "./acceptance-executor/protocol.mjs";
import { executionSourceText } from "./acceptance-executor/module-graph.mjs";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const OWNER_LABEL = "io.piagent.contract-execution";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const DOCKER_COMMAND_FIELDS = ["path", "sha256"];

function inspectPinnedDockerCommand(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || JSON.stringify(Object.keys(binding)) !== JSON.stringify(DOCKER_COMMAND_FIELDS)
    || typeof binding.path !== "string" || !isAbsolute(binding.path)
    || normalize(binding.path) !== binding.path || binding.path.includes("\0")
    || !/^[a-f0-9]{64}$/.test(String(binding.sha256 ?? ""))) {
    throw new TypeError("Invalid pinned Docker command identity");
  }
  let resolved, descriptor, bytes;
  try {
    resolved = fs.realpathSync.native(binding.path);
    if (resolved !== binding.path) throw new Error("noncanonical-path");
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size < 1n || before.size > 1024n * 1024n * 1024n
      || (before.mode & 0o111n) === 0n) throw new Error("unsafe-executable");
    bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true }),
      current = fs.lstatSync(resolved, { bigint: true });
    const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
    if (BigInt(bytes.length) !== before.size || fields.some(field =>
      before[field] !== after[field] || before[field] !== current[field])
      || hash(bytes) !== binding.sha256) throw new Error("identity-mismatch");
  } catch (error) {
    throw new Error(`Pinned Docker command is unavailable or changed: ${error.message}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return { path: resolved, bytes };
}

function pinnedDockerCommand(binding) {
  if (binding === undefined) return "docker";
  return inspectPinnedDockerCommand(binding).path;
}

function materializePinnedDockerCommand(binding) {
  const source = inspectPinnedDockerCommand(binding);
  let directory = null, descriptor;
  try {
    const temporaryRoot = fs.realpathSync.native(os.tmpdir()), root = fs.lstatSync(temporaryRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("unsafe-temporary-root");
    directory = fs.mkdtempSync(join(temporaryRoot, "piagent-docker-"));
    fs.chmodSync(directory, 0o700);
    const target = join(directory, "docker");
    descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW ?? 0), 0o500);
    fs.writeFileSync(descriptor, source.bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o500);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    const prepared = Object.freeze({ path: target, sha256: binding.sha256 });
    pinnedDockerCommand(prepared);
    return Object.freeze({ binding: prepared, cleanup() {
      fs.rmSync(directory, { recursive: true, force: false });
    } });
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (directory) {
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
    }
    throw new Error(`Pinned Docker command could not be materialized: ${error.message}`);
  }
}

function command(socket, args, { input = "", timeoutMs = 5000, signal,
  maxBytes = MAX_RESPONSE_BYTES, dockerCommand } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ reason: "cancelled", code: null, stdout: "" }); return; }
    const env = { ...process.env };
    for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
    let executable;
    try { executable = pinnedDockerCommand(dockerCommand); }
    catch { resolve({ reason: "docker-command-identity-mismatch", code: null, stdout: "" }); return; }
    const child = spawn(executable, ["--host", `unix://${socket}`, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0, reason = null, finished = false;
    const stop = (why) => { reason ??= why; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    function finish(code) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ reason, code, stdout: Buffer.concat(chunks).toString("utf8") });
    }
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop("output-limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => { bytes += chunk.length; if (bytes > maxBytes) stop("output-limit"); });
    child.stdin.on("error", () => {}); // EPIPE is represented by the child exit.
    child.on("error", () => { reason ??= "spawn-error"; finish(null); });
    child.on("close", (code) => finish(code));
    child.stdin.end(input);
  });
}

export function isolatedContainerArguments(imageId, runId) {
  if (!IMAGE_ID.test(imageId) || !/^[a-f0-9-]{36}$/.test(runId)) throw new TypeError("Invalid isolated backend identity");
  return ["create", "--pull", "never", "--name", `piagent-contract-${runId}`, "--label", `${OWNER_LABEL}=${runId}`,
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "65534:65534", "--init", "--pids-limit", "32", "--memory", "256m", "--memory-swap", "256m",
    "--cpus", "1", "--ulimit", "nofile=64:64", "--ulimit", "cpu=10:12", "--log-driver", "none",
    "--env", "LANG=C.UTF-8", "--env", "TZ=UTC", "--workdir", "/executor", "-i", imageId];
}

export function isolatedContainerConfigurationMatches(container) {
  const host = container?.HostConfig;
  const entrypoint = ["timeout", "--signal=KILL", "8s", "node", "--max-old-space-size=96", "/executor/worker.mjs"];
  return Boolean(host && container.Config?.User === "65534:65534" && container.Config?.WorkingDir === "/executor"
    && JSON.stringify(container.Config?.Entrypoint) === JSON.stringify(entrypoint)
    && host.NetworkMode === "none" && host.ReadonlyRootfs === true && host.Privileged === false && host.Init === true
    && JSON.stringify(host.CapDrop) === '["ALL"]' && JSON.stringify(host.SecurityOpt) === '["no-new-privileges"]'
    && host.PidsLimit === 32 && host.Memory === 256 * 1024 * 1024 && host.MemorySwap === host.Memory && host.NanoCpus === 1e9
    && !host.Binds?.length && !host.Devices?.length && !container.Mounts?.length && !host.PidMode && host.IpcMode === "private"
    && host.Ulimits?.some((limit) => limit.Name === "cpu" && limit.Soft === 10 && limit.Hard === 12)
    && host.Ulimits?.some((limit) => limit.Name === "nofile" && limit.Soft === 64 && limit.Hard === 64));
}

async function inspectOwned(socket, target, imageId, runId, dockerCommand) {
  const inspected = await command(socket, ["inspect", "--type", "container", target],
    { maxBytes: 64 * 1024, dockerCommand });
  if (inspected.code !== 0 || inspected.reason) return null;
  try {
    const [container] = JSON.parse(inspected.stdout);
    if (!CONTAINER_ID.test(container?.Id) || container.Image !== imageId || container.Config?.Labels?.[OWNER_LABEL] !== runId) return null;
    return container;
  } catch { return null; }
}

/**
 * HOST-ONLY execution adapter. The caller must authorize and pin the local
 * socket and built worker image; a model-supplied image is not an approved
 * verifier. This adapter cannot mint an acceptance receipt or grant completion.
 * No host workspace mounts, environment forwarding, image pulling, or fallback
 * to host evaluation. Expected answers are not part of the worker protocol.
 */
export async function runIsolatedContract(options = {}) {
  const { requestText, imageId, dockerSocket, dockerCommand, timeoutMs = 10000, signal,
    executionRunId, profile, ...unknown } = options;
  if (Object.keys(unknown).length) throw new TypeError("Invalid isolated executor configuration");
  const request = parseRequest(requestText);
  if (typeof imageId !== "string" || !IMAGE_ID.test(imageId) || typeof dockerSocket !== "string"
    || !isAbsolute(dockerSocket) || dockerSocket.includes("\0")
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 30000
    || (executionRunId !== undefined && (typeof executionRunId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(executionRunId)))
    || request.schemaVersion === 2 && JSON.stringify(profile) !== JSON.stringify(request.profile)
    || request.schemaVersion === 1 && profile !== undefined) throw new TypeError("Invalid isolated executor configuration");
  const preparedDockerCommand = dockerCommand === undefined ? null : materializePinnedDockerCommand(dockerCommand),
    activeDockerCommand = preparedDockerCommand?.binding;
  try {
    const requestDigest = hash(requestText);
    const sourceDigest = hash(executionSourceText(request));
    // A durable host reservation can provide its freshly generated UUID so a
    // restarted host can locate exactly its worker, never by a broad name scan.
    const runId = executionRunId ?? randomUUID();
    const base = { runId, requestDigest, sourceDigest, imageId, ...(request.schemaVersion === 2 ? { profileDigest: request.profile.digest } : {}) };
    let socketReady = false;
    try { socketReady = (await stat(dockerSocket)).isSocket(); } catch {}
    if (!socketReady) return { ...base, status: "error", reason: "local-backend-unavailable", cleanupConfirmed: true };
    if (signal?.aborted) return { ...base, status: "cancelled", reason: "cancelled-before-create", cleanupConfirmed: true };
    if (executionRunId && await inspectOwned(dockerSocket, `piagent-contract-${runId}`, imageId, runId, activeDockerCommand)) {
      return { ...base, status: "error", reason: "reserved-execution-id-conflict", cleanupConfirmed: false };
    }
    let containerId = null;
    let result = { ...base, status: "error", reason: "container-create-failed" };
    let cleanupConfirmed = false;
    try {
      const created = await command(dockerSocket, isolatedContainerArguments(imageId, runId),
        { maxBytes: 4096, signal, dockerCommand: activeDockerCommand });
      const target = created.stdout.trim();
      const container = await inspectOwned(dockerSocket,
        CONTAINER_ID.test(target) ? target : `piagent-contract-${runId}`, imageId, runId, activeDockerCommand);
      if (!container) return { ...result, cleanupConfirmed: false };
      containerId = container.Id;
      if (!isolatedContainerConfigurationMatches(container)) {
        result = { ...base, status: "error", reason: "container-configuration-rejected" };
      } else if (created.reason || created.code !== 0) {
        result = { ...base, status: created.reason === "cancelled" ? "cancelled" : "error", reason: "container-create-incomplete" };
      } else {
        const executed = await command(dockerSocket, ["start", "--attach", "--interactive", containerId],
          { input: requestText, timeoutMs, signal, dockerCommand: activeDockerCommand });
        const state = await inspectOwned(dockerSocket, containerId, imageId, runId, activeDockerCommand);
        if (executed.reason || executed.code !== 0 || !state || state.State?.Running || state.State?.OOMKilled || state.State?.ExitCode !== 0) {
          const reason = executed.reason ?? (state?.State?.OOMKilled ? "container-memory-limit" : "worker-exit-failed");
          result = { ...base, status: reason === "cancelled" ? "cancelled" : reason === "timeout" ? "timeout" : "error", reason };
        } else {
          try {
            const observation = parseResponse(executed.stdout, request, requestDigest);
            result = { ...base, status: observation.status, observation };
          } catch { result = { ...base, status: "error", reason: "invalid-worker-observation" }; }
        }
      }
    } finally {
      if (containerId) {
        // Only this freshly created, label/image-checked container is disposable.
        // Removal must succeed before an observation can be admitted downstream.
        const removed = await command(dockerSocket, ["rm", "--force", containerId],
          { maxBytes: 4096, dockerCommand: activeDockerCommand });
        cleanupConfirmed = removed.code === 0 && !removed.reason && removed.stdout.trim() === containerId;
      }
    }
    if (!cleanupConfirmed) return { ...base, status: "error", reason: "container-cleanup-unconfirmed", cleanupConfirmed: false };
    return { ...result, cleanupConfirmed };
  } finally {
    preparedDockerCommand?.cleanup();
  }
}
