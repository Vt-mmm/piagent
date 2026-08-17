import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PickerSpec = { executable: string; args: string[] };
type PickerEnvironment = Readonly<Record<string, string | undefined>>;

function executableOnPath(name: string, environment: PickerEnvironment): string | null {
  for (const directory of String(environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* try the next PATH entry */ }
  }
  return null;
}

// The browser deliberately cannot reveal an absolute directory path. The
// Gateway therefore uses the desktop's own picker and receives only the paths
// the operator selected. macOS ships AppleScript; Linux desktops commonly ship
// one of the freedesktop-facing dialog helpers below.
export function resolveNativeProjectPicker(options: { platform?: NodeJS.Platform; environment?: PickerEnvironment } = {}): PickerSpec | null {
  const platform = options.platform ?? process.platform, environment = options.environment ?? process.env;
  if (platform === "darwin") {
    try { fs.accessSync("/usr/bin/osascript", fs.constants.X_OK); } catch { return null; }
    const script = [
      'set chosenFolders to choose folder with prompt "Choose project folders for Piagent" with multiple selections allowed',
      'set output to ""',
      'repeat with chosenFolder in chosenFolders',
      'set output to output & POSIX path of chosenFolder & linefeed',
      'end repeat',
      'return output'
    ].join("\n");
    return { executable: "/usr/bin/osascript", args: ["-e", script] };
  }
  if (platform !== "linux" || !(environment.DISPLAY || environment.WAYLAND_DISPLAY)) return null;
  for (const name of ["zenity", "qarma"]) {
    const executable = executableOnPath(name, environment);
    if (executable) return { executable, args: ["--file-selection", "--directory", "--multiple", "--separator=\n",
      "--title=Choose project folders for Piagent"] };
  }
  const kdialog = executableOnPath("kdialog", environment);
  return kdialog ? { executable: kdialog, args: ["--getexistingdirectory", process.cwd(), "--title", "Choose a project folder for Piagent"] } : null;
}

export function nativeProjectPickerAvailable(options: { platform?: NodeJS.Platform; environment?: PickerEnvironment } = {}): boolean {
  return resolveNativeProjectPicker(options) !== null;
}

function selectedFolders(stdout: string): string[] {
  const selected: string[] = [];
  for (const raw of stdout.split("\n")) {
    const value = raw.trim(); if (!value) continue;
    let candidate = value;
    if (value.startsWith("file:")) {
      try { candidate = fileURLToPath(value); } catch { continue; }
    }
    if (candidate.includes("\0") || /[\u0001-\u001f\u007f]/.test(candidate) || selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length === 32) break;
  }
  return selected;
}

export function pickNativeProjectFolders(): Promise<string[]> {
  const picker = resolveNativeProjectPicker();
  if (!picker) return Promise.reject(new Error("native-project-picker-unavailable"));
  return new Promise((resolve, reject) => {
    execFile(picker.executable, picker.args, { timeout: 5 * 60_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) {
        const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code : null;
        reject(new Error(exitCode === 1 ? "project-import-cancelled" : "project-import-picker-failed")); return;
      }
      const selected = selectedFolders(stdout);
      if (!selected.length) { reject(new Error("project-import-cancelled")); return; }
      resolve(selected);
    });
  });
}

export async function pickNativeProjectFolder(): Promise<string> {
  const [selected] = await pickNativeProjectFolders();
  if (!selected) throw new Error("project-import-cancelled");
  return selected;
}
