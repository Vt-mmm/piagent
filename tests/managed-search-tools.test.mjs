import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it } from "node:test";

import { ensureSearchTools, searchToolPath } from "../packages/piagent-core/managed/toolchain.mjs";

const cleanup = new Set();
afterEach(() => {
  for (const item of cleanup) fs.rmSync(item, { recursive: true, force: true });
  cleanup.clear();
});

// A Pi host whose tools manager has Pi 1.3's signature: ensureTool(tool, onStatus)
// calls onStatus?.(…), so a non-function second argument throws as it does in Pi.
function fakeSdk({ visible = [] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-sdk-")));
  cleanup.add(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(path.join(root, "dist", "utils"), { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, "dist", "utils", "tools-manager.js"), `
import fs from "node:fs";
const bin = ${JSON.stringify(bin)}, visible = new Set(${JSON.stringify(visible)});
export const calls = [];
export function getToolPath(tool) { return visible.has(tool) || fs.existsSync(bin + "/" + tool) ? bin + "/" + tool : null; }
export async function ensureTool(tool, onStatus) {
  calls.push(tool);
  onStatus?.({ type: "info", message: tool + " not found. Downloading..." });
  fs.writeFileSync(bin + "/" + tool, "#!/bin/sh\\n", { mode: 0o755 });
  return bin + "/" + tool;
}
`);
  return { root, bin };
}

it("downloads fd with Pi's current tools-manager signature", async () => {
  const { root, bin } = fakeSdk({ visible: ["rg"] });
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-home-")));
  cleanup.add(home);
  await ensureSearchTools(root, home, 5_000);
  const manager = await import(path.join(root, "dist", "utils", "tools-manager.js"));
  assert.ok(manager.calls.includes("fd"), "fd is fetched when Pi cannot find it");
  assert.equal(searchToolPath("fd", home), path.join(bin, "fd"));
});

it("fetches fd for Pi when only a copy Pi cannot see is installed", async (t) => {
  if (!fs.existsSync("/opt/homebrew/bin/rg")) return t.skip("needs a Homebrew ripgrep");
  const { root } = fakeSdk();
  await ensureSearchTools(root, os.homedir(), 5_000);
  const manager = await import(path.join(root, "dist", "utils", "tools-manager.js"));
  assert.ok(manager.calls.includes("rg"), "a Homebrew copy outside Pi's PATH does not count for the terminal");
});
