import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "test"];
const files = [];
for (const root of roots) {
  const stack = [path.resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && target.endsWith(".js")) files.push(target);
    }
  }
}
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
