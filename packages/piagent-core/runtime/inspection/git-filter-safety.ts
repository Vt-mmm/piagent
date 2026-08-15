import { spawn } from "node:child_process";
import os from "node:os";

const MAX_CONFIG_BYTES = 64 * 1024;
const DRIVER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function environment(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: os.devNull, GIT_PAGER: "cat", PAGER: "cat", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "",
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec } : {}) };
}

export async function localFilterDisableArgs(cwd: string, timeoutMs: number): Promise<string[]> {
  const names = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd,
      "config", "--local", "--includes", "--null", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
    { cwd, env: environment(), shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0, settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; child.kill("SIGKILL"); reject(new Error("git-filter-config-timeout")); } }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length;
      if (bytes > MAX_CONFIG_BYTES && !settled) { settled = true; child.kill("SIGKILL"); reject(new Error("git-filter-config-oversized")); }
      else chunks.push(chunk); });
    child.once("error", () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error("git-filter-config-unavailable")); } });
    child.once("close", (code) => { clearTimeout(timer); if (settled) return; settled = true;
      if (code === 0) resolve(Buffer.concat(chunks));
      else if (code === 1 && bytes === 0) resolve(Buffer.alloc(0));
      else reject(new Error("git-filter-config-unavailable")); });
  });
  const drivers = new Set<string>();
  for (const raw of names.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/i.exec(raw);
    if (!match || !DRIVER.test(match[1])) throw new Error("git-filter-driver-invalid");
    drivers.add(match[1]);
  }
  return [...drivers].sort().flatMap((driver) => ["-c", `filter.${driver}.clean=`, "-c", `filter.${driver}.smudge=`,
    "-c", `filter.${driver}.process=`, "-c", `filter.${driver}.required=false`]);
}
