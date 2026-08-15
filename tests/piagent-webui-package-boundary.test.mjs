import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  compileContracts,
  contractDrift,
  writeContracts
} from "../packages/piagent-webui/scripts/generate-contracts.mjs";

const root = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(root, "packages/piagent-webui");
const temporaryRoots = new Set();

afterEach(() => {
  for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
  temporaryRoots.clear();
});

describe("Piagent private WebUI package boundary", () => {
  it("is private, buildable and exposes only the reviewed sidecar entrypoint", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(pkg.private, true);
    assert.equal(pkg.scripts.publish, undefined);
    assert.equal(pkg.bin, undefined);
    assert.match(pkg.scripts.build, /check:contracts/);
    assert.equal(fs.existsSync(path.join(packageRoot, "server/sidecar-main.ts")), true);
    assert.equal(fs.existsSync(path.join(packageRoot, "extension/piagent-webui.ts")), true);
  });

  it("generates browser declarations deterministically and detects byte or inventory drift", async () => {
    const first = await compileContracts(), second = await compileContracts();
    assert.deepEqual([...first], [...second]);
    assert.equal(contractDrift(first).length, 0);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-contracts-"));
    temporaryRoots.add(temporary);
    writeContracts(first, temporary);
    assert.deepEqual(contractDrift(first, temporary), []);
    fs.appendFileSync(path.join(temporary, "snapshot-v1.ts"), "// drift\n");
    assert.ok(contractDrift(first, temporary).some((error) => /snapshot-v1/.test(error)));
    fs.writeFileSync(path.join(temporary, "orphan.ts"), "export {};\n");
    assert.ok(contractDrift(first, temporary).some((error) => /inventory/.test(error)));
  });

  it("keeps client source browser-only and local-asset-only", () => {
    const files = fs.globSync("client/**/*.{ts,tsx,css,html}", { cwd: packageRoot });
    const source = files.map((file) => fs.readFileSync(path.join(packageRoot, file), "utf8")).join("\n");
    assert.doesNotMatch(source, /(?:from|import\s*)\s*["']node:/);
    assert.doesNotMatch(source, /piagent-core|\/server\//);
    assert.doesNotMatch(source, /https?:\/\//);
    assert.doesNotMatch(source, /serviceWorker|navigator\.serviceWorker|createServer|\.listen\s*\(/);
  });

  it("passes package typecheck and an isolated production build", () => {
    const typecheck = spawnSync("npm", ["run", "typecheck", "--workspace", "@piagent/webui"], { cwd: root, encoding: "utf8" });
    assert.equal(typecheck.status, 0, `typecheck\n${typecheck.stdout}\n${typecheck.stderr}`);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-webui-build-"));
    temporaryRoots.add(temporary);
    const output = path.join(temporary, "client");
    const build = spawnSync(path.join(root, "node_modules", ".bin", "vite"), [
      "build", "--config", path.join(packageRoot, "vite.config.ts"), "--outDir", output, "--emptyOutDir"
    ], { cwd: packageRoot, encoding: "utf8" });
    assert.equal(build.status, 0, `build\n${build.stdout}\n${build.stderr}`);
    assert.equal(fs.existsSync(path.join(output, "index.html")), true);
  });
});
