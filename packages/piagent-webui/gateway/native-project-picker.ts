import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `wsl`: the picker is Windows' own, run from WSL; its paths are converted.
// `base64`: each line is a UTF-8 path in base64, safe from code pages.
type PickerSpec = { executable: string; args: string[]; wsl?: boolean; base64?: boolean };

// Windows' folder dialog, through PowerShell (also from WSL, where Windows
// programs run as they are). The Gateway runs detached, without a console or
// the foreground: the dialog gets a topmost owner so it opens in front of the
// browser, and the path is printed as base64 so a non-ASCII folder survives
// the console's code page. Cancel exits 1; any PowerShell error exits 2.
const WINDOWS_PICKER = [
  "$ErrorActionPreference = 'Stop'",
  "try { Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Application]::EnableVisualStyles()",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Choose a project folder for Piagent'",
  "$result = $dialog.ShowDialog($owner)",
  "$owner.Dispose()",
  "if ($result -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }",
  "[Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))",
  "exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }"
].join("; ");
const windowsPicker = (executable: string, wsl = false): PickerSpec =>
  ({ executable, args: ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_PICKER], base64: true, ...(wsl ? { wsl } : {}) });
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
  if (platform === "win32") {
    const executable = path.win32.join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return fs.existsSync(executable) ? windowsPicker(executable) : null;
  }
  if (platform === "linux" && environment.WSL_DISTRO_NAME) {
    const executable = executableOnPath("powershell.exe", environment);
    if (executable) return windowsPicker(executable, true);
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

function selectedFolders(stdout: string, base64 = false): string[] {
  const selected: string[] = [];
  for (const raw of stdout.split("\n")) {
    let value = raw.trim(); if (!value) continue;
    if (base64) {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) continue;
      value = Buffer.from(value, "base64").toString("utf8");
    }
    let candidate = value;
    if (value.startsWith("file:")) {
      try { candidate = fileURLToPath(value); } catch { continue; }
    }
    if (candidate.includes("\0") || /[\u0001-\u001f\u007f\ufffd]/.test(candidate) || selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length === 32) break;
  }
  return selected;
}

type RunPicker = (executable: string, args: string[], options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: (error: Error | null, stdout: string) => void) => unknown;
type ToWslPath = (windowsPath: string) => string;

// The folders the operator chose. `run` and `toWslPath` stand in for the
// process spawns in tests.
export function pickNativeProjectFolders(options: { picker?: PickerSpec | null; run?: RunPicker; toWslPath?: ToWslPath } = {}): Promise<string[]> {
  const picker = options.picker === undefined ? resolveNativeProjectPicker() : options.picker;
  if (!picker) return Promise.reject(new Error("native-project-picker-unavailable"));
  const run = options.run ?? (execFile as unknown as RunPicker);
  const toWslPath = options.toWslPath ?? ((folder) => execFileSync("wslpath", ["-u", folder], { encoding: "utf8", timeout: 5000 }).trim());
  return new Promise((resolve, reject) => {
    // windowsHide: no console window of its own next to the dialog; closing
    // that window used to kill the picker.
    run(picker.executable, picker.args, { timeout: 5 * 60_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) {
        const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? (error as unknown as { code: number }).code : null;
        reject(new Error(exitCode === 1 ? "project-import-cancelled" : "project-import-picker-failed")); return;
      }
      let selected = selectedFolders(String(stdout).replace(/\r/g, ""), picker.base64);
      // C:\Users\me\shop, as seen from WSL: /mnt/c/Users/me/shop.
      if (picker.wsl) selected = selected.flatMap((folder) => {
        try { return [toWslPath(folder)]; } catch { return []; }
      });
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
