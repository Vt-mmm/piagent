#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { prepareHostContractApproval, writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";

const help = `Usage: piagent approve-verification --project PATH --plan FILE --directory NEW_PRIVATE_PATH [--approve]

Without --approve, validate and preview a host-owned verification plan only.
With --approve, create a new private authority outside the project. Never overwrite it.
No command here executes project code, starts a worker, or calls a model provider.

Plan schema: schemas/host-contract-plan.schema.json
The operator must review the expected results independently of the candidate.
Enable the approved plan by setting PIAGENT_INDEPENDENT_VERIFICATION_CONFIG to
the returned approval.json path before starting the Pi runtime.
`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { process.stdout.write(help); process.exit(0); }
  const options = {}, seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--project", "--plan", "--directory", "--approve"].includes(flag) || seen.has(flag)) throw new Error("Unknown or repeated option");
    seen.add(flag);
    if (flag === "--approve") { options.approved = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    options[flag.slice(2)] = value;
  }
  if (!options.project || !options.plan || !options.directory) throw new Error("--project, --plan and --directory are required");
  const fd = fs.openSync(path.resolve(options.plan), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let plan;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 * 1024) throw new Error("Invalid plan file size or type");
    plan = JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally { fs.closeSync(fd); }
  const fields = ["schemaVersion", "operatorRequestDigest", "backend", "contracts"];
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.schemaVersion !== 1
    || Object.keys(plan).length !== fields.length || fields.some((field) => !Object.hasOwn(plan, field))) throw new Error("Invalid host contract plan");
  const projectRoot = fs.realpathSync.native(options.project), installedRoot = path.resolve(import.meta.dirname, "..");
  const directory = path.resolve(options.directory), parent = fs.realpathSync.native(path.dirname(directory));
  if (parent !== path.dirname(directory)) throw new Error("Authority parent must be canonical");
  const relative = path.relative(projectRoot, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Authority must be outside the candidate project");
  const request = { projectRoot, installedRoot, operatorRequestDigest: plan.operatorRequestDigest, backend: plan.backend, contracts: plan.contracts };
  const preview = prepareHostContractApproval(request);
  const result = options.approved
    ? { status: "approved", ...writeHostContractApproval({ ...request, directory, approved: true }) }
    : { status: "preview-only", directory, payload: preview };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Independent verification approval failed: ${error.message}\n`);
  process.exitCode = 1;
}
