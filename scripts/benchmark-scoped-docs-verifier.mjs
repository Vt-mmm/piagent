import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";

export const SCOPED_DOCS_POLICY = "scoped-configured-docs-policy-v1";
export const SCOPED_DOCS_WORKER = "scoped-configured-docs-worker-v1";
export const SCOPED_DOCS_RECEIPT = "scoped-project-verification-receipt-v3";
export const DOCS_COMMANDS = Object.freeze(["git diff --check",
  'if test -f package.json && node -e "const s=require(\'./package.json\').scripts||{}; process.exit(s.test?0:1)"; then npm test; else test -s README.md || test -d docs; fi']);
export const DOCS_COMMAND_IDS = Object.freeze(["git-diff-check", "conditional-project-test"]);
const sha = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw Object.assign(new Error(code), { supervisorCode: code }); };
const requireThat = (value, code) => { if (!value) fail(code); };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const LIMIT = 256 * 1024;
export const isScopedDocsPolicy = policy => Boolean(policy && typeof policy === "object" && !types.isProxy(policy)
  && Object.getOwnPropertyDescriptor(policy, "version")?.value === SCOPED_DOCS_POLICY);

export function validateScopedDocsPolicy(policy, h) {
  h.exact(policy, ["version", "configuredCommands", "currentFiles", "frozenPolicy", "toolchain"], "invalid-docs-policy");
  h.exact(policy.toolchain, ["gitCommand", "shellCommand", "npmRoot"], "invalid-docs-toolchain");
  requireThat(same(policy.configuredCommands, DOCS_COMMANDS), "unsupported-docs-commands");
  h.validatePaths(policy.currentFiles, 1, 8, "invalid-docs-files");
  requireThat(policy.currentFiles.every(file => /^docs\/[A-Za-z0-9_./-]+\.md$/.test(file)), "invalid-docs-files");
  requireThat(!isScopedDocsPolicy(policy.frozenPolicy), "invalid-docs-frozen-policy");
  h.validatePolicy(policy.frozenPolicy);
  for (const file of Object.values(policy.toolchain)) requireThat(typeof file === "string" && path.isAbsolute(file)
    && path.normalize(file) === file && !/[\\\x00-\x1f\x7f]/.test(file) && fs.realpathSync(file) === file, "invalid-docs-toolchain");
  return h.deepFreeze(structuredClone(policy));
}
function npmIdentity(root, h) {
  requireThat(fs.lstatSync(root).isDirectory(), "invalid-docs-npm-root");
  let size = 0; const entries = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name), info = fs.lstatSync(file), relativePath = path.relative(root, file);
      requireThat(entries.length < 10000, "docs-npm-closure-limit");
      if (info.isDirectory()) walk(file);
      else if (info.isSymbolicLink()) {
        const target = fs.realpathSync(file), relative = path.relative(root, target);
        requireThat(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "docs-npm-closure-link");
        entries.push({ relativePath, link: fs.readlinkSync(file) });
      } else {
        const bytes = h.stableFile(file, 4 * 1024 * 1024, "docs-npm-closure-drift"); size += bytes.length;
        requireThat(size <= 64 * 1024 * 1024, "docs-npm-closure-limit");
        entries.push({ relativePath, bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  walk(root);
  requireThat(entries.some(item => item.relativePath === "bin/npm-cli.js"), "invalid-docs-npm-root");
  return sha(JSON.stringify(entries));
}
function toolIdentity(nodeCommand, policy, h) {
  requireThat(typeof nodeCommand === "string" && path.isAbsolute(nodeCommand) && fs.realpathSync(nodeCommand) === nodeCommand, "invalid-docs-node");
  const command = file => sha(h.stableFile(file, 1024 * 1024 * 1024, "docs-toolchain-drift"));
  return { node: command(nodeCommand), git: command(policy.toolchain.gitCommand),
    shell: command(policy.toolchain.shellCommand), npm: npmIdentity(policy.toolchain.npmRoot, h) };
}
function frozenSnapshot(projectRoot, policy, h) {
  const gitRoot = path.join(projectRoot, ".git");
  requireThat(fs.realpathSync(gitRoot) === gitRoot && fs.lstatSync(gitRoot).isDirectory(), "docs-git-root-unsupported");
  // Bound metadata only; no object traversal, credential discovery or protected
  // worktree content is used. Candidate tools cannot write .git or npm config.
  const metadata = ["config", "HEAD"].map(name => ({ name,
    sha256: sha(h.stableFile(path.join(gitRoot, name), 16 * 1024 * 1024, "docs-git-metadata-drift")) }));
  const index = spawnSync(policy.toolchain.gitCommand, ["-c", "core.fsmonitor=false", "ls-files", "--stage", "-z"],
    { cwd: projectRoot, env: { HOME: projectRoot, PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_DIR: gitRoot, GIT_WORK_TREE: projectRoot },
      encoding: "buffer", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  requireThat(index.status === 0 && Buffer.isBuffer(index.stdout), "docs-git-index-unavailable");
  // Logical mode/blob/path entries are stable across checkout stat-cache updates.
  // Object contents are not opened; changed staged content changes this identity.
  metadata.push({ name: "index-entries", sha256: sha(index.stdout) });
  requireThat(!fs.existsSync(path.join(projectRoot, ".npmrc")) && !fs.existsSync(path.join(projectRoot, ".gitattributes"))
    && !fs.existsSync(path.join(gitRoot, "info/attributes")), "docs-extra-configuration-unsupported");
  for (const file of policy.currentFiles) {
    let parent = path.dirname(file);
    while (parent !== ".") {
      requireThat(!fs.existsSync(path.join(projectRoot, parent, ".gitattributes")), "docs-extra-configuration-unsupported");
      parent = path.dirname(parent);
    }
  }
  return { version: 1, sourceDigest: h.captureFootprint(projectRoot, policy.frozenPolicy).sourceDigest,
    metadata, currentFiles: policy.currentFiles };
}
function currentFiles(projectRoot, policy, h) {
  return policy.currentFiles.map(relativePath => {
    const file = path.join(projectRoot, relativePath);
    requireThat(fs.realpathSync(file) === file, "docs-current-file-path");
    const bytes = h.stableFile(file, 65536, "docs-current-file-drift");
    return { relativePath, byteLength: bytes.length, sha256: sha(bytes) };
  });
}
const sourceDigest = scope => sha(JSON.stringify({ version: 1, frozenSourceDigest: scope.frozenSourceDigest, files: scope.files }));
export function scopedDocsPlanBinding(input, h) {
  const frozen = frozenSnapshot(input.projectRoot, input.policy, h), tools = toolIdentity(input.nodeCommand, input.policy, h),
    frozenSourceDigest = sha(JSON.stringify(frozen)), requestDigest = sha(JSON.stringify(input.policy)),
    environmentDigest = sha(JSON.stringify({ version: 1, tools, environment: "private-empty-home-offline-npm-fixed-git-v1" }));
  // Current document bytes are deliberately separate from the approved policy:
  // every attempt captures them and the signed receipt binds them at settlement.
  const planDigest = sha(JSON.stringify({ version: 2, protocol: input.protocol, requestDigest,
    frozenSourceDigest, environmentDigest, verifierDigest: input.verifierDigest, timeoutMs: input.timeoutMs }));
  const capabilityDigest = sha(JSON.stringify({ version: 3, protocol: input.protocol, planDigest }));
  return h.deepFreeze({ protocol: input.protocol, planDigest, requestDigest, sourceDigest: frozenSourceDigest,
    environmentDigest, verifierDigest: input.verifierDigest, timeoutMs: input.timeoutMs, capabilityDigest });
}
export function prepareScopedDocsAttempt(input, h) {
  requireThat(sha(JSON.stringify(frozenSnapshot(input.projectRoot, input.policy, h))) === input.sourceDigest,
    "docs-frozen-source-drift");
  const docsScope = { kind: "configured-docs-current-v1", commands: [...DOCS_COMMANDS],
    frozenSourceDigest: input.sourceDigest, files: currentFiles(input.projectRoot, input.policy, h) };
  return { docsScope, sourceDigest: sourceDigest(docsScope) };
}
function environment(stage, projectRoot, shellCommand) {
  const empty = name => { const file = path.join(stage, name); fs.writeFileSync(file, "", { flag: "wx", mode: 0o400 }); return file; };
  return { HOME: stage, PATH: path.join(stage, "bin"), LANG: "C", LC_ALL: "C", TZ: "UTC", NODE_NO_WARNINGS: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty("git-global"), GIT_CONFIG_SYSTEM: empty("git-system"),
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_DIR: path.join(projectRoot, ".git"), GIT_WORK_TREE: projectRoot,
    NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_USERCONFIG: empty("npm-user"), NPM_CONFIG_GLOBALCONFIG: empty("npm-global"),
    NPM_CONFIG_CACHE: path.join(stage, "npm-cache"), NPM_CONFIG_SCRIPT_SHELL: shellCommand };
}
function materializeTools(stage, input) {
  fs.mkdirSync(path.join(stage, "bin"), { mode: 0o700 });
  const commands = { node: quote(input.nodeCommand),
    npm: `${quote(input.nodeCommand)} ${quote(path.join(input.policy.toolchain.npmRoot, "bin/npm-cli.js"))}`,
    git: `${quote(input.policy.toolchain.gitCommand)} -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab -c diff.external= -c core.pager=cat` };
  for (const [name, command] of Object.entries(commands)) fs.writeFileSync(path.join(stage, "bin", name),
    `#!${input.policy.toolchain.shellCommand}\nexec ${command} "$@"\n`, { flag: "wx", mode: 0o500 });
}
function execute(command, input, env) {
  return new Promise(resolve => {
    let child, timer, overflow = false, error = false, count = 0;
    const chunks = [], kill = signal => { try { process.kill(-child.pid, signal); } catch {} };
    try { child = spawn(input.policy.toolchain.shellCommand, ["-c", command], { cwd: input.projectRoot, env,
      detached: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { resolve({ status: "error", reason: "docs-spawn-failed" }); return; }
    const abort = () => { kill("SIGTERM"); timer = setTimeout(() => kill("SIGKILL"), 250); };
    const collect = chunk => { count += chunk.length; if (count > LIMIT) { overflow = true; kill("SIGKILL"); }
      else chunks.push(Buffer.from(chunk)); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    input.signal.addEventListener("abort", abort, { once: true }); if (input.signal.aborted) abort();
    child.once("error", () => { error = true; });
    child.once("close", (code, signal) => {
      clearTimeout(timer); input.signal.removeEventListener("abort", abort);
      resolve(input.signal.aborted ? { status: "cancelled", reason: "docs-cancelled" }
        : overflow || error ? { status: "error", reason: overflow ? "docs-output-limit" : "docs-spawn-failed" }
        : { status: "completed", code, signal, outputSha256: sha(Buffer.concat(chunks)), outputBytes: count });
    });
  });
}
export async function runScopedDocsVerification(input, h) {
  let stage, cleanupConfirmed = true, result;
  const current = () => {
    requireThat(sha(JSON.stringify(frozenSnapshot(input.projectRoot, input.policy, h))) === input.docsScope.frozenSourceDigest
      && same(currentFiles(input.projectRoot, input.policy, h), input.docsScope.files), "docs-source-drift");
    const binding = scopedDocsPlanBinding({ ...input, sourceDigest: input.docsScope.frozenSourceDigest }, h);
    requireThat(binding.planDigest === input.planDigest && h.scopedProjectVerifierDigest() === input.verifierDigest,
      "docs-policy-or-toolchain-drift");
  };
  try {
    current(); stage = fs.mkdtempSync(path.join(input.stagingRoot, "docs-verifier-")); fs.chmodSync(stage, 0o700);
    materializeTools(stage, input); const env = environment(stage, input.projectRoot, input.policy.toolchain.shellCommand);
    // The fixed Node project is frozen during this docs policy. Check names
    // before Git can inspect any unexpected changed worktree file.
    const names = spawnSync(path.join(stage, "bin/git"), ["diff", "--no-ext-diff", "--name-only", "-z"],
      { cwd: input.projectRoot, env, encoding: "utf8", timeout: 5000, maxBuffer: LIMIT });
    requireThat(names.status === 0 && names.stdout.split("\0").filter(Boolean).every(file => input.policy.currentFiles.includes(file)),
      "docs-git-scope-drift");
    const commands = [];
    for (const [i, command] of DOCS_COMMANDS.entries()) {
      current(); const observed = await execute(command, input, env); current();
      if (observed.status !== "completed") { result = observed; break; }
      commands.push({ id: DOCS_COMMAND_IDS[i], invocationCount: 1,
        outcome: observed.code === 0 && observed.signal === null ? "passed" : "failed",
        outputSha256: observed.outputSha256, outputBytes: observed.outputBytes });
    }
    if (!result) result = { status: "completed", observation: { schemaVersion: 1, workerVersion: SCOPED_DOCS_WORKER,
      verificationRunId: input.executionRunId, requestDigest: input.requestDigest, sourceDigest: input.sourceDigest,
      commandSetDigest: input.planDigest, outcome: commands.every(row => row.outcome === "passed") ? "passed" : "failed", commands } };
  } catch (error) { result = { status: "error", reason: typeof error?.supervisorCode === "string" ? error.supervisorCode : "docs-execution-error" }; }
  finally { if (stage) try { fs.rmSync(stage, { recursive: true, force: false }); cleanupConfirmed = !fs.existsSync(stage); }
    catch { cleanupConfirmed = false; } }
  const common = { runId: input.executionRunId, requestDigest: input.requestDigest, sourceDigest: input.sourceDigest,
    environmentDigest: input.environmentDigest, planDigest: input.planDigest, cleanupConfirmed, status: result.status };
  return result.status === "completed" ? { ...common, observation: result.observation } : { ...common, reason: result.reason };
}
export function validateScopedDocsScope(scope, receiptSourceDigest, h) {
  h.exact(scope, ["kind", "commands", "frozenSourceDigest", "files"], "invalid-docs-receipt-scope");
  requireThat(scope.kind === "configured-docs-current-v1" && same(scope.commands, DOCS_COMMANDS) && hash(scope.frozenSourceDigest)
    && Array.isArray(scope.files) && scope.files.length >= 1 && scope.files.length <= 8, "invalid-docs-receipt-scope");
  h.validatePaths(scope.files.map(row => row.relativePath), 1, 8, "invalid-docs-receipt-scope");
  for (const row of scope.files) {
    h.exact(row, ["relativePath", "byteLength", "sha256"], "invalid-docs-receipt-scope");
    requireThat(/^docs\/[A-Za-z0-9_./-]+\.md$/.test(row.relativePath) && hash(row.sha256)
      && Number.isSafeInteger(row.byteLength) && row.byteLength >= 0 && row.byteLength <= 65536, "invalid-docs-receipt-scope");
  }
  requireThat(sourceDigest(scope) === receiptSourceDigest, "invalid-docs-receipt-scope");
}
