import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";

import { nativeProjectPickerAvailable, resolveNativeProjectPicker } from "../packages/piagent-webui/gateway/native-project-picker.ts";

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
  assert.equal(resolveNativeProjectPicker({ platform: "win32", environment: { PATH: kdialog.root } }), null);
});
