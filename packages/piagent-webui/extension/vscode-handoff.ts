import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type VSCodeHandoffResult = { state: "settled" | "rejected" | "uncertain"; reasonCode: string | null };

function executable(candidate: string): string | null {
  try {
    if (!path.isAbsolute(candidate)) return null;
    const resolved = fs.realpathSync.native(candidate), stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    fs.accessSync(resolved, fs.constants.X_OK); return resolved;
  } catch { return null; }
}

export function discoverVSCodeCli(input: { platform?: NodeJS.Platform; pathValue?: string } = {}): string | null {
  const platform = input.platform ?? process.platform, candidates: string[] = [];
  if (platform === "darwin") candidates.push("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    path.join(os.homedir(), "Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"));
  for (const directory of String(input.pathValue ?? process.env.PATH ?? "").split(path.delimiter))
    if (directory && path.isAbsolute(directory)) candidates.push(path.join(directory, platform === "win32" ? "code.exe" : "code"));
  for (const candidate of [...new Set(candidates)]) { const resolved = executable(candidate); if (resolved) return resolved; }
  return null;
}

export class VSCodeHandoff {
  readonly #cli: string | null; readonly #timeoutMs: number;
  constructor(options: { cli?: string | null; timeoutMs?: number } = {}) {
    this.#cli = options.cli === undefined ? discoverVSCodeCli() : options.cli ? executable(options.cli) : null;
    this.#timeoutMs = Math.max(500, Math.min(30_000, options.timeoutMs ?? 8_000));
  }
  available(): boolean { return this.#cli !== null; }
  async open(absolutePath: string, line: number | null, column: number | null): Promise<VSCodeHandoffResult> {
    if (!this.#cli) return { state: "rejected", reasonCode: "vscode-cli-unavailable" };
    const location = line === null ? absolutePath : `${absolutePath}:${line}${column === null ? "" : `:${column}`}`;
    return new Promise((resolve) => {
      let settled = false, stderrBytes = 0, timedOut = false;
      const child = spawn(this.#cli!, ["--reuse-window", "--goto", location], { shell: false, windowsHide: true,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, TMPDIR: process.env.TMPDIR,
          SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }, stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) child.kill("SIGKILL"); });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, this.#timeoutMs); timer.unref?.();
      child.once("error", () => { clearTimeout(timer); if (!settled) { settled = true; resolve({ state: "rejected", reasonCode: "vscode-launch-failed" }); } });
      child.once("close", (code) => { clearTimeout(timer); if (settled) return; settled = true;
        resolve(timedOut ? { state: "uncertain", reasonCode: "vscode-launch-timeout" }
          : code === 0 && stderrBytes <= 64 * 1024 ? { state: "settled", reasonCode: null }
            : { state: "rejected", reasonCode: "vscode-launch-failed" }); });
    });
  }
}
