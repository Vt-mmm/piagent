import { execFile } from "node:child_process";

export function nativeProjectPickerAvailable(): boolean { return process.platform === "darwin"; }

export function pickNativeProjectFolders(): Promise<string[]> {
  if (!nativeProjectPickerAvailable()) return Promise.reject(new Error("native-project-picker-unavailable"));
  return new Promise((resolve, reject) => {
    const script = [
      'set chosenFolders to choose folder with prompt "Choose project folders for Piagent" with multiple selections allowed',
      'set output to ""',
      'repeat with chosenFolder in chosenFolders',
      'set output to output & POSIX path of chosenFolder & linefeed',
      'end repeat',
      'return output'
    ].join("\n");
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5 * 60_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { reject(new Error("project-import-cancelled")); return; }
      const selected = [...new Set(stdout.split("\n").map((value) => value.trim()).filter(Boolean))].slice(0, 32);
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
