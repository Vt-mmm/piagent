import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function ownerIsAlive(lockDirectory) {
  try {
    const pid = Number(fs.readFileSync(path.join(lockDirectory, "owner"), "utf8"));
    if (!Number.isSafeInteger(pid) || pid < 1) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function ensureWebUiBuild(root) {
  const index = path.join(root, "packages", "piagent-webui", "dist", "client", "index.html");
  if (fs.existsSync(index)) return;
  const key = createHash("sha256").update(fs.realpathSync(root)).digest("hex").slice(0, 20);
  const lockDirectory = path.join(os.tmpdir(), `piagent-webui-test-build-${key}`);
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDirectory, "owner"), `${process.pid}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (fs.existsSync(index)) return;
      if (!ownerIsAlive(lockDirectory)) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }
      assert.ok(Date.now() < deadline, "timed out waiting for the shared WebUI test build");
      wait(50);
    }
  }
  try {
    if (fs.existsSync(index)) return;
    const result = spawnSync("npm", ["run", "build", "--workspace", "@piagent/webui"], {
      cwd: root, encoding: "utf8"
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(fs.existsSync(index), true, "WebUI build did not produce client/index.html");
  } finally {
    fs.rmSync(lockDirectory, { recursive: true, force: true });
  }
}
