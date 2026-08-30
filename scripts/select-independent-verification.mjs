#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { compileContractSelection } from "../packages/piagent-core/extensions/acceptance-contract-selection.js";
import { prepareHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";

const help = `Usage: piagent select-verification --project PATH --task FILE --recipe FILE [--library FILE] [--output NEW_FILE]

Compile reusable contract families against exact task criterion text/obligation.
Default library: adapters/node-typescript/contract-families.json
Recipe schema: schemas/contract-selection-recipe.schema.json
This only previews a plan. It never reads candidate source, executes project code,
starts a worker, calls a model or creates verification authority.
The task JSON is a selection input, not evidence. Review the selected semantics,
parameters, expanded checks and unselected criteria before approve-verification.
--output creates a new private plan file only when every requested selection is
unambiguous. It never overwrites a file. Unknown selection exits with status 2.
`;

function read(file, maximum) {
  const fd = fs.openSync(path.resolve(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error("Invalid selection input file");
    const bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
    if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Selection input changed while reading");
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("Selection input must be UTF-8");
    return text;
  } finally { fs.closeSync(fd); }
}

try {
  const args = process.argv.slice(2), options = {};
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { process.stdout.write(help); process.exit(0); }
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!["--project", "--task", "--recipe", "--library", "--output"].includes(flag)
      || Object.hasOwn(options, flag) || !value || value.startsWith("--")) throw new Error("Unknown, repeated or incomplete option");
    options[flag] = value;
  }
  if (!options["--project"] || !options["--task"] || !options["--recipe"]) throw new Error("--project, --task and --recipe are required");
  const installedRoot = path.resolve(import.meta.dirname, ".."), projectRoot = fs.realpathSync.native(options["--project"]);
  const result = compileContractSelection({
    libraryText: read(options["--library"] ?? path.join(installedRoot, "adapters/node-typescript/contract-families.json"), 2 * 1024 * 1024),
    taskText: read(options["--task"], 2 * 1024 * 1024), recipeText: read(options["--recipe"], 512 * 1024)
  });
  if (!result.plan) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = 2; }
  else {
    // Same validation as explicit approval; preview still creates no authority.
    prepareHostContractApproval({ projectRoot, installedRoot, ...result.plan });
    let output;
    if (options["--output"]) {
      output = path.resolve(options["--output"]);
      const fd = fs.openSync(output, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(result.plan, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    process.stdout.write(`${JSON.stringify({ ...result, ...(output ? { output } : {}) }, null, 2)}\n`);
  }
} catch (error) { process.stderr.write(`Contract selection failed: ${error.message}\n`); process.exitCode = 1; }
