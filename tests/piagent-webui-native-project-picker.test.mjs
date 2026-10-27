import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";

import { nativeProjectPickerAvailable, pickNativeProjectFolders, resolveNativeProjectPicker } from "../packages/piagent-webui/gateway/native-project-picker.ts";

const roots = new Set();
afterEach(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); roots.clear(); });

function executable(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-picker-")); roots.add(root);
  const file = path.join(root, name); fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { root, file };
}

it("advertises the Linux folder picker only for an interactive desktop with a supported helper", () => {
  const zenity = executable("zenity");
  const environment = { PATH: zenity.root, WAYLAND_DISPLAY: "wayland-0" };
  const picker = resolveNativeProjectPicker({ platform: "linux", environment });
  assert.equal(picker?.executable, zenity.file);
  assert.deepEqual(picker?.args.slice(0, 4), ["--file-selection", "--directory", "--multiple", "--separator=\n"]);
  assert.equal(nativeProjectPickerAvailable({ platform: "linux", environment }), true);
  assert.equal(nativeProjectPickerAvailable({ platform: "linux", environment: { PATH: zenity.root } }), false);
});

it("falls back to kdialog and stays unavailable on unsupported hosts", () => {
  const kdialog = executable("kdialog");
  const picker = resolveNativeProjectPicker({ platform: "linux", environment: { PATH: kdialog.root, DISPLAY: ":0" } });
  assert.equal(picker?.executable, kdialog.file); assert.equal(picker?.args[0], "--getexistingdirectory");
  assert.equal(resolveNativeProjectPicker({ platform: "win32", environment: { PATH: kdialog.root, SystemRoot: path.join(kdialog.root, "no-windows") } }), null);
});

// From WSL the picker is Windows' own folder dialog (Windows programs run as
// they are there); its C:\… answer is converted to a WSL path.
it("uses Windows' folder dialog from WSL, and on Windows itself when PowerShell is there", () => {
  const powershell = executable("powershell.exe");
  const picker = resolveNativeProjectPicker({ platform: "linux", environment: { PATH: powershell.root, WSL_DISTRO_NAME: "Ubuntu" } });
  assert.equal(picker?.executable, powershell.file);
  assert.equal(picker?.wsl, true);
  assert.deepEqual(picker?.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-STA", "-Command"]);
  assert.match(picker?.args[4] ?? "", /FolderBrowserDialog/);
  assert.equal(resolveNativeProjectPicker({ platform: "linux", environment: { PATH: powershell.root } }), null, "not WSL, no desktop: no picker");
  assert.equal(resolveNativeProjectPicker({ platform: "win32", environment: { SystemRoot: path.join(os.tmpdir(), "no-windows-here") } }), null);
});

// What runs on Windows: PowerShell in STA with a dialog owned by a topmost
// form, its console window hidden, and the path printed as UTF-8 base64.
function windowsSpec() {
  const powershell = executable("powershell.exe");
  return resolveNativeProjectPicker({ platform: "linux", environment: { PATH: powershell.root, WSL_DISTRO_NAME: "Ubuntu" } });
}
const base64 = (text) => Buffer.from(text, "utf8").toString("base64");
function runner(result) {
  const calls = [];
  const run = (file, args, options, callback) => { calls.push({ file, args, options }); setImmediate(() => callback(result.error ?? null, result.stdout ?? "")); };
  return { calls, run };
}

it("builds a Windows picker command that survives the command line and a detached Gateway", () => {
  const picker = windowsSpec();
  assert.equal(picker?.base64, true);
  const script = picker.args[4];
  assert.deepEqual(picker.args, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
  // Node quotes the argument with double quotes on Windows; the script has none.
  assert.equal(script.includes('"'), false);
  assert.match(script, /\$owner\.TopMost = \$true/);
  assert.match(script, /ShowDialog\(\$owner\)/);
  assert.match(script, /ToBase64String\(\[System\.Text\.Encoding\]::UTF8\.GetBytes\(\$dialog\.SelectedPath\)\)/);
  assert.match(script, /DialogResult\]::OK\) \{ exit 1 \}/);
  assert.match(script, /catch \{ \[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\); exit 2 \}$/);
  assert.equal((script.match(/\{/g) ?? []).length, (script.match(/\}/g) ?? []).length);
});

it("spawns the Windows picker hidden and decodes a non-ASCII folder", async () => {
  const picker = { ...windowsSpec(), wsl: undefined };
  const folder = "C:\\Users\\Tâm\\Dự án";
  const { calls, run } = runner({ stdout: `\ufeff${base64(folder)}\r\n` });
  assert.deepEqual(await pickNativeProjectFolders({ picker, run }), [folder]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, picker.executable);
  assert.deepEqual(calls[0].args, picker.args);
  assert.deepEqual(calls[0].options, { timeout: 300_000, maxBuffer: 65_536, windowsHide: true });
});

it("converts the Windows answer for WSL and ignores output that is not base64", async () => {
  const picker = windowsSpec();
  const { run } = runner({ stdout: `WARNING: noise\r\n${base64("C:\\Users\\me\\shop")}\r\n` });
  const converted = [];
  const toWslPath = (folder) => { converted.push(folder); return "/mnt/c/Users/me/shop"; };
  assert.deepEqual(await pickNativeProjectFolders({ picker, run, toWslPath }), ["/mnt/c/Users/me/shop"]);
  assert.deepEqual(converted, ["C:\\Users\\me\\shop"]);
});

it("tells a cancelled dialog from a PowerShell failure", async () => {
  const picker = windowsSpec();
  const failure = (code, extra = {}) => Object.assign(new Error("Command failed"), { code, ...extra });
  await assert.rejects(pickNativeProjectFolders({ picker, run: runner({ error: failure(1) }).run }), /project-import-cancelled/);
  await assert.rejects(pickNativeProjectFolders({ picker, run: runner({ error: failure(2) }).run }), /project-import-picker-failed/);
  await assert.rejects(pickNativeProjectFolders({ picker, run: runner({ error: failure(null, { killed: true, signal: "SIGTERM" }) }).run }), /project-import-picker-failed/);
  await assert.rejects(pickNativeProjectFolders({ picker, run: runner({ error: failure("ENOENT") }).run }), /project-import-picker-failed/);
  await assert.rejects(pickNativeProjectFolders({ picker, run: runner({ stdout: "" }).run }), /project-import-cancelled/);
  await assert.rejects(pickNativeProjectFolders({ picker: null }), /native-project-picker-unavailable/);
});

it("keeps reading plain paths from the macOS and Linux pickers", async () => {
  const { run } = runner({ stdout: "/Users/me/shop/\n/Users/me/api/\n/Users/me/shop/\n" });
  assert.deepEqual(await pickNativeProjectFolders({ picker: { executable: "/usr/bin/osascript", args: [] }, run }), ["/Users/me/shop/", "/Users/me/api/"]);
});
