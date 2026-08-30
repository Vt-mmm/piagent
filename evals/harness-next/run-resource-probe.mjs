import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isolatedContainerArguments } from "../../packages/piagent-core/extensions/acceptance-isolated-executor.js";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const socket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
assert.match(imageId ?? "", /^sha256:[a-f0-9]{64}$/);
assert.ok(socket && path.isAbsolute(socket) && fs.statSync(socket).isSocket());
const probe = fs.readFileSync(new URL("./resource-budget-probe.mjs", import.meta.url), "utf8");
const probeDigest = createHash("sha256").update(probe).digest("hex");
const env = { ...process.env };
for (const key of ["DOCKER_CONTEXT", "DOCKER_HOST", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[key];
const docker = (args, input) => execFileSync("docker", ["--host", "unix://" + socket, ...args],
  { env, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000, maxBuffer: 65536 });

for (const [name, source] of [
  ["correct-sum", "export const run = (a,b) => a+b;"],
  ["wrong-sum", "export const run = (a,b) => a-b;"],
  ["infinite", "export const run = () => { while(true) {} };"]
]) {
  for (const stallMs of [0, 600, ...(name === "correct-sum" ? [5200] : [])]) {
    const runId = randomUUID(), args = isolatedContainerArguments(imageId, runId);
    // Retain the same watchdog, memory, CPU, filesystem and network limits.
    // This explicit diagnostic entrypoint cannot produce an acceptance receipt.
    args.splice(args.length - 1, 0, "--entrypoint", "timeout");
    args.push("--signal=KILL", "8s", "node", "--max-old-space-size=96", "--input-type=module", "-e", probe);
    let id;
    try {
      id = docker(args).trim();
      assert.match(id, /^[a-f0-9]{64}$/);
      const [container] = JSON.parse(docker(["inspect", "--type", "container", id]));
      assert.equal(container.Image, imageId);
      assert.equal(container.Config.Labels["io.piagent.contract-execution"], runId);
      assert.equal(container.Config.User, "65534:65534");
      assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.HostConfig.NetworkMode, "none");
      assert.deepEqual(container.Mounts, []);
      const requestText = JSON.stringify({ schemaVersion: 1, source, exportName: "run",
        cases: [{ id: "sum", args: [{ type: "number", value: 2 }, { type: "number", value: 3 }] }] });
      const output = JSON.parse(docker(["start", "--attach", "--interactive", id], JSON.stringify({ requestText, stallMs })));
      assert.equal(output.diagnostic, "resource-budget-probe-v1");
      process.stdout.write(JSON.stringify({ name, imageId, probeDigest, requestDigest: createHash("sha256").update(requestText).digest("hex"), ...output }) + "\n");
    } finally {
      if (id) {
        const [owned] = JSON.parse(docker(["inspect", "--type", "container", id]));
        assert.equal(owned.Id, id); assert.equal(owned.Image, imageId);
        assert.equal(owned.Config.Labels["io.piagent.contract-execution"], runId);
        assert.equal(docker(["rm", "--force", id]).trim(), id);
      }
    }
  }
}
