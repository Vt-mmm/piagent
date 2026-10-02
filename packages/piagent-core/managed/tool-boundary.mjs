import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { developerTools, managedGit, searchToolPath, userToolchains } from './toolchain.mjs';

const TOOL_NAMES = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
const MAX_WIRE_BYTES = 12 * 1024 * 1024;
const workerPath = fileURLToPath(new URL('./tool-worker.mjs', import.meta.url));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function literal(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('managed-path-invalid');
  return JSON.stringify(value);
}
function inside(file, root) { return file === root || file.startsWith(root + path.sep); }

export function managedSeatbelt({ cwd, sdkRoot, runtimeRoot, temporary, node, denied = [], readOnly = false, repository = [], gitDirs = [], toolchains = [], developer = [], network = false }) {
  // Default-deny protects Keychain/SSH agent/Watch IPC and process inspection.
  // System libraries/toolchains are read-only. Writes stay in this project and
  // a fresh temporary directory. No network exception or unsandboxed fallback.
  // A project inside a larger repository reads that repository (monorepo)
  // and, when writable, its git directories so commits work. Also readable,
  // as on any Mac: installer-based Python/JDKs, the Rosetta runtime (x86_64
  // tools on Apple Silicon) and the time zone database.
  const system = ['/Library/Frameworks', '/Library/Java', '/Library/Apple', '/private/var/db/oah', '/private/var/db/timezone'];
  const readRoots = ['/System', '/usr', '/bin', '/sbin', '/Library/Developer', '/Applications/Xcode.app', '/opt/homebrew', ...system, ...developer, sdkRoot, runtimeRoot, cwd, temporary, ...repository, ...gitDirs, ...toolchains];
  const filters = readRoots.map(root => `(subpath ${literal(root)})`).join(' ');
  const writeRoots = [temporary, ...(!readOnly ? [cwd, ...gitDirs] : [])];
  // Signals reach only processes of this sandbox: a search stops ripgrep at
  // its limit and a cancelled command stops its children, while nothing
  // outside (Agent Watch, the member's apps) can be signalled.
  return `(version 1)
(deny default)
(allow process-fork process-exec)
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd"))
(allow file-read-metadata)
(allow file-read* (literal "/") ${filters} (literal ${literal(node)}) (subpath "/private/etc") (subpath "/dev"))
(allow file-write* ${writeRoots.map(root => `(subpath ${literal(root)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))
${network ? `(allow network-outbound (remote ip))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow system-socket)
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.configd"))` : ''}
${denied.map(root => `(deny file-read* file-write* (subpath ${literal(root)}))`).join('\n')}
(deny file-read* file-write* (regex #"(^|/)(\\.env([./]|$)|auth\\.json$|credentials([./]|$)|\\.npmrc$|\\.netrc$)"))
`;
}

// Toolchains from the pinned node/git and Homebrew, compilers and SDK; the
// git identity this project gets on the user's machine (name and email only)
// so commits work. Without network, package managers fail fast instead of
// retrying for minutes.
function toolEnvironment({ git, node, home, temporary, toolchains, developer, identity, scope }) {
  const PATH = [...new Set([path.dirname(node), ...toolchains.bins, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', ...developer.bins, path.dirname(git), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const network = { ...toolchains.env, ...developer.env, PATH, HOME: home, TMPDIR: temporary, PIAGENT_TOOL_SCOPE: scope, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', RIPGREP_CONFIG_PATH: path.join(home, '.ripgreprc'),
    ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}) };
  return { network, offline: { ...network, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000', PIP_RETRIES: '0', PIP_TIMEOUT: '5' } };
}
// Effective config for this project, as the user's own git would see it:
// global and XDG files, includeIf (e.g. a work email for ~/work) and the
// repository's own settings. `git config --get` runs no hooks or helpers.
function gitIdentity(git, cwd) {
  const read = key => { try { return execFileSync(git, ['-C', cwd, 'config', '--get', key], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' } }).trim(); } catch { return ''; } };
  const name = read('user.name'), email = read('user.email');
  return name && email && name.length <= 200 && email.length <= 200 && !/[\x00-\x1f]/.test(name + email) ? { name, email } : null;
}
// The trusted runtime resolves the repository before any tool runs.
function repositoryRoots(git, cwd, temporary) {
  try {
    const [top, gitDir, commonDir] = execFileSync(git, ['-C', cwd, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: temporary, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' } }).trim().split('\n');
    return { top: fs.realpathSync(top), gitDir: fs.realpathSync(gitDir), commonDir: fs.realpathSync(path.resolve(cwd, commonDir)) };
  } catch { return null; }
}
// Pi's grep/find need ripgrep and fd and would download them, which the
// sandbox forbids. Copy installed binaries into the sandbox home instead.
function provisionSearchTools(home, userHome) {
  // Credential files are unreadable here; ripgrep skips them instead of
  // failing the whole search with a permission error.
  fs.writeFileSync(path.join(home, '.ripgreprc'), ['.env', '.env.*', '.env/**', 'auth.json', 'credentials', 'credentials.*', 'credentials/**', '.npmrc', '.netrc']
    .map(glob => `--glob=!${glob}`).join('\n') + '\n', { mode: 0o600 });
  const bin = path.join(home, '.pi/agent/bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  // Without a copy here the worker uses the built-in search (search-fallback.mjs).
  for (const name of ['rg', 'fd']) {
    const source = searchToolPath(name, userHome);
    if (source) { fs.copyFileSync(source, path.join(bin, name)); fs.chmodSync(path.join(bin, name), 0o755); }
  }
}

export class ManagedToolBoundary {
  #tail = Promise.resolve();
  #children = new Set();
  #closed = false;
  // readOnly: the project cannot be written. commands: bash is offered all
  // the same (a helper that runs checks); it writes only to its temporary
  // directory, and has no network.
  constructor({ cwd, sdkRoot, protectedRoots = [], readOnly = false, commands = false, node = process.execPath, identity, userHome: home, searchTools = true }) {
    if (process.platform !== 'darwin') throw new Error('managed-sandbox-unavailable');
    this.cwd = fs.realpathSync(cwd); this.sdkRoot = fs.realpathSync(sdkRoot);
    this.node = fs.realpathSync(node);
    this.runtimeRoot = fs.realpathSync(path.dirname(workerPath));
    this.sdkPath = path.join(this.sdkRoot, 'dist/index.js');
    this.git = managedGit();
    if (JSON.parse(fs.readFileSync(path.join(this.sdkRoot, 'package.json'), 'utf8')).version !== '0.87.1') throw new Error('managed-sdk-version-unqualified');
    const workerModules = ['search-fallback.mjs', 'sandbox-diagnostic.mjs'].map(name => path.join(this.runtimeRoot, name));
    this.pins = new Map([this.node, this.git, workerPath, ...workerModules, this.sdkPath].map(file => [file, hash(file)]));
    const userHome = fs.realpathSync(home ?? os.homedir());
    if ([userHome, '/', this.sdkRoot, this.runtimeRoot].includes(this.cwd)
      || [this.sdkRoot,this.runtimeRoot,this.node,this.git,...['/opt/homebrew/bin/gh','/usr/local/bin/gh'].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p))].some(p=>inside(p,this.cwd))) throw new Error('managed-project-overlaps-runtime');
    this.temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-tools-')));
    fs.chmodSync(this.temporary, 0o700);
    this.home = path.join(this.temporary, 'home'); fs.mkdirSync(this.home, { mode: 0o700 });
    const denied = [path.join(userHome, '.ssh'), path.join(userHome, '.aws'), path.join(userHome, '.config'),
      path.join(userHome, '.pi'), path.join(userHome, '.codex'), path.join(userHome, '.claude'),
      path.join(userHome, 'Library/Keychains'), path.join(userHome, 'Library/Application Support/AgentWatch'),
      ...protectedRoots.map(p => path.resolve(p))];
    // A pinned SDK may itself be installed under ~/.pi; grant that code only,
    // while keeping the adjacent personal auth/config subtree inaccessible.
    const narrowed = denied.filter(root => !inside(this.sdkRoot, root));
    if (inside(this.sdkRoot, path.join(userHome, '.pi'))) narrowed.push(path.join(userHome, '.pi/agent'));
    const repo = repositoryRoots(this.git, this.cwd, this.temporary);
    const allowedRoot = root => root !== '/' && !inside(userHome, root) && !inside(this.sdkRoot, root) && !inside(this.runtimeRoot, root);
    const repository = repo && repo.top !== this.cwd && allowedRoot(repo.top) ? [repo.top] : [];
    this.repositoryTop = repository[0] ?? this.cwd;
    // A repository above the home folder (a dotfiles repo) is never opened:
    // neither read as a monorepo nor writable through its git directory.
    const gitDirs = repo && (repo.top === this.cwd || allowedRoot(repo.top)) ? [...new Set([repo.gitDir, repo.commonDir])].filter(dir => !inside(dir, this.cwd) && allowedRoot(dir)) : [];
    const toolchains = userToolchains(userHome, this.node), developer = developerTools();
    const base = { cwd: this.cwd, sdkRoot: this.sdkRoot, runtimeRoot: this.runtimeRoot, temporary: this.temporary, node: this.node,
      denied: narrowed, readOnly, repository, gitDirs, toolchains: toolchains.roots, developer: developer.roots };
    this.profile = managedSeatbelt(base);
    // Only for commands the user approved (run_with_network); credentials stay denied.
    this.networkProfile = readOnly ? null : managedSeatbelt({ ...base, network: true });
    // Every process a command starts carries this marker, also one it detaches.
    this.scope = randomUUID();
    this.environment = toolEnvironment({ git: this.git, node: this.node, home: this.home, temporary: this.temporary, toolchains, developer, scope: this.scope,
      identity: identity !== undefined ? identity : gitIdentity(this.git, this.cwd) });
    if (searchTools) provisionSearchTools(this.home, userHome);
    else fs.writeFileSync(path.join(this.home, '.ripgreprc'), '', { mode: 0o600 });
    this.allowed = readOnly ? TOOL_NAMES.filter(name => !['write', 'edit'].includes(name) && (name !== 'bash' || commands)) : [...TOOL_NAMES];
  }
  tools(api) {
    const factories = { read: api.createReadToolDefinition, write: api.createWriteToolDefinition,
      edit: api.createEditToolDefinition, bash: api.createBashToolDefinition,
      grep: api.createGrepToolDefinition, find: api.createFindToolDefinition, ls: api.createLsToolDefinition };
    return this.allowed.map(name => ({ ...factories[name](this.cwd), execute: (_id, args, signal, onUpdate, context) => {
      // One queue spans read and all mutations so two concurrent edit requests
      // observe a deterministic order. Helpers use separate read-only workers.
      const run = this.#tail.then(() => this.invoke(name, args, signal, onUpdate, context?.model));
      this.#tail = run.catch(() => {}); return run;
    } }));
  }
  async invoke(name, args, signal, onUpdate, model, { network = false } = {}) {
    if (this.#closed || !this.allowed.includes(name) || network && (name !== 'bash' || !this.networkProfile)) throw new Error('managed-tool-unavailable');
    if (signal?.aborted) throw new Error('managed-tool-cancelled');
    for (const [file, digest] of this.pins) if (hash(file) !== digest) throw new Error('managed-runtime-changed');
    const message = JSON.stringify({ name, args, ...(network ? { network: true } : {}), model: model ? { input: model.input, inputLimits: model.inputLimits } : undefined }) + '\n';
    if (Buffer.byteLength(message) > MAX_WIRE_BYTES) throw new Error('managed-tool-input-too-large');
    return await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/sandbox-exec', ['-p', network ? this.networkProfile : this.profile, this.node, workerPath, this.sdkPath, this.cwd], {
        cwd: this.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: network ? this.environment.network : this.environment.offline,
      });
      this.#children.add(child);
      const decoder = new StringDecoder('utf8');
      let pending = '', bytes = 0, result, failure, terminated = false, hardStop;
      const terminate = () => {
        if (terminated) return; terminated = true;
        child.stdin.write('{"cancel":true}\n');
        // bash descendants may use separate process groups. Native bash abort
        // handles those first; a hard stop is the last resort, never a refund.
        hardStop = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
        hardStop.unref();
      };
      const abort = () => { failure = new Error('managed-tool-cancelled'); terminate(); };
      child.managedCancel = abort;
      const deadline = setTimeout(() => { failure = new Error('managed-tool-timeout'); terminate(); }, name === 'bash' ? 600000 : 30000);
      deadline.unref();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_WIRE_BYTES) { failure = new Error('managed-tool-output-too-large'); terminate(); return; }
        pending += decoder.write(chunk);
        for (;;) {
          const newline = pending.indexOf('\n'); if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const value = JSON.parse(line);
            if (value.update) onUpdate?.(value.update);
            // A cancel or timeout asked for first stays the reason: the worker
            // then reports how its command ended ("Command aborted").
            else if (value.error) failure ??= new Error(String(value.error).slice(0, 1000));
            else if (value.result) result = value.result;
            else throw new Error('managed-worker-invalid-response');
          } catch { failure = new Error('managed-worker-invalid-response'); terminate(); }
        }
      });
      // Do not relay raw startup diagnostics into model context (paths/env may
      // contain sensitive material). The UI can show this stable failure code.
      child.stderr.on('data', () => {});
      child.on('error', () => { failure = new Error('managed-worker-start-failed'); });
      child.on('close', code => {
        clearTimeout(deadline); if (hardStop) clearTimeout(hardStop);
        this.#children.delete(child); signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !result || pending) reject(new Error('managed-worker-failed'));
        else resolve(result);
      });
      child.stdin.write(message);
      if (signal?.aborted) abort();
    });
  }
  // Processes a command left running (`nohup … &`, a detached child) outlive
  // it with the marker in their environment. They are stopped when a turn ends
  // and when the boundary closes; nothing outside this boundary has the marker.
  async stopStrays() {
    if (this.#children.size) return 0;
    const marker = `PIAGENT_TOOL_SCOPE=${this.scope}`, find = () => {
      try {
        return execFileSync('/bin/ps', ['-axwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 5000 }).split('\n')
          .filter(row => row.includes(marker)).map(row => Number(row.trim().split(/\s+/)[0])).filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
      } catch { return []; }
    };
    const strays = find();
    for (const pid of strays) try { process.kill(pid, 'SIGTERM'); } catch {}
    for (let waited = 0; strays.length && waited < 2000; waited += 100) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!find().length) break;
    }
    for (const pid of find()) try { process.kill(pid, 'SIGKILL'); } catch {}
    return strays.length;
  }
  async dispose() {
    this.#closed = true;
    const stopping = [...this.#children].map(child => new Promise(resolve => { child.once('close', resolve); child.managedCancel(); }));
    await Promise.all(stopping); await this.#tail;
    await this.stopStrays();
    fs.rmSync(this.temporary, { recursive: true, force: true });
  }
}
