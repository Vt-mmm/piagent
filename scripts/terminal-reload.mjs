#!/usr/bin/env node
// `piagent reload`: every open Piagent Terminal on this machine (`piagent`
// and `piagent studio`) loads the installed release when it is idle; a task
// running in one finishes first. The conversation stays open. piagent-update
// asks the same once it installed a release.
import fs from "node:fs";
import { requestTerminalReload } from "../packages/piagent-core/runtime/update/terminal-reload.mjs";

if (process.argv.slice(2).some((arg) => ["--help", "-h"].includes(arg))) {
  console.log("Usage: piagent reload\n\nEvery open Piagent Terminal (piagent, piagent studio) loads the installed release when it is idle.\nA task running in one finishes first; the conversation stays open.");
  process.exit(0);
}
const manifest = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
requestTerminalReload({ version: manifest.version, piHost: manifest.peerDependencies?.["@earendil-works/pi-coding-agent"] ?? null });
console.log(`Piagent ${manifest.version}: các Terminal đang mở (piagent, piagent studio) sẽ nạp bản này khi rảnh; Terminal đang chạy task thì nạp khi task xong. Cuộc trò chuyện giữ nguyên.`);
