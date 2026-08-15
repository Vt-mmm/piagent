#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const REF = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,159}$/;

function help() {
  return [
    "Usage: piagent-webui [--session <opaque-session-ref>] [--no-open]",
    "",
    "Opens a WebUI already owned by the current Pi process.",
    "Start it first with /piagent-webui inside the Pi terminal.",
    "This command never creates a second Pi runtime."
  ].join("\n");
}

function parse(argv) {
  let session = null, open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true, session, open };
    if (value === "--no-open") { open = false; continue; }
    if (value === "--session" && typeof argv[index + 1] === "string" && REF.test(argv[index + 1])) { session = argv[index += 1]; continue; }
    throw new Error(`Unknown or invalid option: ${value}`);
  }
  return { help: false, session, open };
}

function launcherDirectory(start) {
  let current = path.resolve(start);
  while (true) {
    const candidate = path.join(current, ".pi", "piagent-state", "webui-launcher");
    try { if (fs.lstatSync(candidate).isDirectory()) return candidate; } catch { /* keep walking */ }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readDescriptor(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8_192 || process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("WebUI launcher descriptor is unsafe");
  }
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  const temporary = fs.realpathSync(os.tmpdir());
  const socket = path.resolve(String(value.controlSocket ?? ""));
  const canonicalSocket = fs.realpathSync(socket);
  if (value.schemaVersion !== 1 || !REF.test(String(value.sessionRef ?? "")) || !REF.test(String(value.projectRef ?? ""))
    || typeof value.controlToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.controlToken)
    || path.relative(temporary, canonicalSocket).startsWith("..") || path.isAbsolute(path.relative(temporary, canonicalSocket))) {
    throw new Error("WebUI launcher descriptor is invalid");
  }
  return { ...value, controlSocket: socket };
}

function requestLaunch(descriptor) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(descriptor.controlSocket);
    let bytes = Buffer.alloc(0), settled = false;
    const fail = (error) => { if (!settled) { settled = true; socket.destroy(); reject(error); } };
    socket.setTimeout(2_000, () => fail(new Error("WebUI sidecar did not respond")));
    socket.once("error", () => fail(new Error("WebUI sidecar is not running; use /piagent-webui in Pi")));
    socket.once("connect", () => socket.write(`${JSON.stringify({ action: "launch", token: descriptor.controlToken })}\n`));
    socket.on("data", (chunk) => {
      if (settled) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 8_192) { fail(new Error("WebUI sidecar response exceeded its limit")); return; }
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!response.ok || typeof response.launchUrl !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=/.test(response.launchUrl)) {
          fail(new Error("WebUI sidecar rejected the launch request")); return;
        }
        settled = true; socket.end(); resolve(response.launchUrl);
      } catch { fail(new Error("WebUI sidecar returned an invalid response")); }
    });
  });
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
  if (!command) return false;
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.unref(); return true;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parse(argv); }
  catch (error) { process.stderr.write(`${error.message}\n${help()}\n`); return 2; }
  if (options.help) { process.stdout.write(`${help()}\n`); return 0; }
  const directory = launcherDirectory(process.cwd());
  if (!directory) { process.stderr.write("No running Piagent WebUI was found. Run /piagent-webui inside the Pi terminal first.\n"); return 1; }
  let descriptors;
  try {
    descriptors = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => readDescriptor(path.join(directory, name)))
      .filter((value) => !options.session || value.sessionRef === options.session);
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "WebUI launcher state is unavailable"}\n`); return 1; }
  if (descriptors.length !== 1) {
    process.stderr.write(descriptors.length === 0
      ? "No matching running WebUI session was found.\n"
      : "More than one WebUI session is running; pass --session <opaque-session-ref>.\n");
    return 1;
  }
  try {
    const url = await requestLaunch(descriptors[0]);
    if (!options.open || !openUrl(url)) process.stdout.write(`${url}\n`);
    else process.stdout.write(`Opened Piagent WebUI for ${descriptors[0].sessionRef}.\n`);
    return 0;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "WebUI could not be opened"}\n`); return 1; }
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(new URL(import.meta.url))) process.exit(await main());

export { help, main, parse, readDescriptor, requestLaunch };
