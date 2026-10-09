import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { developerLicense, developerTools, managedGit, searchToolPath, userToolchains } from './toolchain.mjs';
import { languageEnvironment } from './language-environment.mjs';
import { containerEngine, engineEnvironment } from './container-engine.mjs';
import { DEFAULT_DOMAINS, PackageProxy, memberDomains, proxyEnvironment } from './package-proxy.mjs';
import { BWRAP, bubblewrapArgs, credentialFiles, referenceFolders } from './linux-sandbox.mjs';
import { agentWatchDataDirectory } from './store.mjs';

const TOOL_NAMES = Object.freeze(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
const MAX_WIRE_BYTES = 12 * 1024 * 1024;
const workerPath = fileURLToPath(new URL('./tool-worker.mjs', import.meta.url));
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function literal(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error('managed-path-invalid');
  return JSON.stringify(value);
}
function inside(file, root) { return file === root || file.startsWith(root + path.sep); }
const pattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Folders a member points the agent to for reference (an @ mention, "read
// ~/Documents/old-shop"): their own files on this Mac, external drives and
// the shared folder, read-only. Hidden entries of the home folder (shell
// files, histories, tool configs) and ~/Library (app data, mail, browser
// profiles) stay closed, except the read roots there (toolchains, the SDK).
// Their metadata stays readable as before: Node resolves the SDK under ~/.pi
// through each folder on the way. Seatbelt lets a rule naming file-read-data
// win over one naming file-read* whatever their order, so the roots are left
// out of this rule rather than allowed again after it.
function referenceRules(home, roots) {
  if (!home || /["\\]/.test(home)) return '';
  const opened = roots.filter(root => inside(root, home)).map(root => ` (require-not (subpath ${literal(root)}))`).join('');
  return `(allow file-read* (subpath ${literal(home)}) (subpath "/Volumes") (subpath "/Users/Shared") (subpath "/private/tmp"))
(deny file-read-data file-read-xattr (require-all (require-any (regex #"^${pattern(home)}/\\.") (subpath ${literal(path.join(home, 'Library'))}))${opened}))`;
}

export function managedSeatbelt({ cwd, sdkRoot, runtimeRoot, temporary, node, denied = [], readOnly = false, repository = [], gitDirs = [], toolchains = [], developer = [], browsers = [], network = false, references = null, skills = [], caches = [], loopback = true, license = null, docker = null, proxyPort = null }) {
  // Default-deny protects Keychain/SSH agent/Watch IPC and process inspection.
  // System libraries/toolchains are read-only. Writes stay in this project and
  // a fresh temporary directory. No network exception or unsandboxed fallback.
  // A project inside a larger repository reads that repository (monorepo)
  // and, when writable, its git directories so commits work. Also readable,
  // as on any Mac: installer-based Python/JDKs, the Rosetta runtime (x86_64
  // tools on Apple Silicon) and the time zone database.
  const system = ['/Library/Frameworks', '/Library/Java', '/Library/Apple', '/private/var/db/oah', '/private/var/db/timezone'];
  // An approved network command may also drive the member's Playwright
  // browsers against a server it starts on this Mac (E2E tests).
  // Skill folders (the member's ~/.claude/skills…) are read where installed.
  const readRoots = ['/System', '/usr', '/bin', '/sbin', '/Library/Developer', '/Applications/Xcode.app', '/opt/homebrew', ...system, ...developer, sdkRoot, runtimeRoot, cwd, temporary, ...repository, ...gitDirs, ...toolchains, ...skills, ...caches, ...browsers];
  const filters = readRoots.map(root => `(subpath ${literal(root)})`).join(' ');
  // Package caches persist per project (language-environment.mjs), also for
  // read-only helpers that run checks.
  const writeRoots = [temporary, ...caches, ...(!readOnly ? [cwd, ...gitDirs] : [])];
  // Credential files are unreadable, unwritable and hidden: a stat fails, so a
  // tool that loads them when present (Vite and Next read .env.local) carries
  // on without them instead of failing on a file it was shown. auth.json holds
  // credentials at a project's root (Composer) or in a dot folder (.codex,
  // .composer); one deeper in the source (a translation file) is ordinary, and
  // so are committed templates (.env.example, .env.sample…).
  const projectRoots = [...new Set([cwd, ...repository])];
  // Every command may start servers on this Mac and reach them (a test's
  // own server, a database for integration tests, Playwright's Chromium
  // against the app). The rule names loopback, but the sandbox cannot tell it
  // from all interfaces (0.0.0.0): a server it starts is reachable while it
  // runs. Without approval nothing else is reached: no internet, no name
  // lookups; while a proxy listens on this Mac, not even its servers
  // (localProxyListening: Seatbelt cannot close one port of an open
  // loopback, so the proxy would carry a command out). An approved command
  // (run_with_network) reaches the internet. Chromium needs only its own
  // rendezvous services (org.chromium.*) and the power-management client.
  // TLS through the macOS Security framework (.NET's NuGet, Swift) needs the
  // security server, the system keychain of public roots and the module
  // directory: for approved commands only. The member's keychain files and
  // other system services stay closed.
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
(allow file-read* (literal "/") ${filters} (literal ${literal(node)}) (subpath "/private/etc") (subpath "/dev")${license ? ` (literal ${literal(license)})` : ''})
${referenceRules(references, readRoots)}
(allow file-write* ${writeRoots.map(root => `(subpath ${literal(root)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))
(allow network-bind network-inbound (local ip "localhost:*"))
(allow iokit-open (iokit-user-client-class "RootDomainUserClient"))
(allow mach-register mach-lookup (global-name-regex #"^org\\.chromium\\."))
${proxyPort && !network ? `(allow mach-lookup (global-name "com.apple.trustd.agent") (global-name "com.apple.SecurityServer") (global-name "com.apple.ocspd"))
(allow file-read* (subpath "/private/var/db/mds") (literal "/Library/Keychains/System.keychain") (subpath "/Library/Security/Trust Settings"))
` : ''}${network ? `(allow network-outbound (remote ip))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow system-socket)
(allow mach-lookup (global-name "com.apple.dnssd.service") (global-name "com.apple.trustd.agent") (global-name "com.apple.SystemConfiguration.configd"))
(allow mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.ocspd"))
(allow file-read* (subpath "/private/var/db/mds") (literal "/Library/Keychains/System.keychain") (subpath "/Library/Security/Trust Settings"))${docker ? `
(allow network-outbound (literal ${literal(docker)}))` : ''}` : loopback ? '(allow network-outbound (remote ip "localhost:*"))' : proxyPort ? `(allow network-outbound (remote ip "localhost:${Number(proxyPort)}"))` : ''}
${denied.map(root => `(deny file-read* file-write* (require-all (subpath ${literal(root)})${skills.filter(dir => inside(dir, root) && dir !== root).map(dir => ` (require-not (subpath ${literal(dir)}))`).join('')}))`).join('\n')}
(deny file-read* file-read-metadata file-write* (require-all (require-any (regex #"(^|/)(\\.env([./]|$)|credentials([./]|$)|\\.npmrc$|\\.netrc$)") (regex #"/\\.[^/]+/auth\\.json$") ${projectRoots.map(root => `(literal ${literal(path.join(root, 'auth.json'))})`).join(' ')})
  (require-not (regex #"(^|/)\\.env\\.(example|sample|template|dist|defaults)$"))))
`;
}

// Toolchains from the pinned node/git and Homebrew, compilers and SDK; the
// git identity this project gets on the user's machine (name and email only)
// so commits work. Without network, package managers fail fast instead of
// retrying for minutes.
function toolEnvironment({ git, node, home, temporary, toolchains, developer, identity, scope, browsers, languages }) {
  const PATH = [...new Set([languages.bin, path.dirname(node), ...toolchains.bins, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', ...developer.bins, path.dirname(git), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  // C.UTF-8 is on every Linux; en_US.UTF-8 may not be generated there.
  const locale = process.platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8';
  const common = { ...toolchains.env, ...developer.env, PATH, HOME: home, TMPDIR: temporary, PIAGENT_TOOL_SCOPE: scope, LANG: locale, LC_ALL: locale, RIPGREP_CONFIG_PATH: path.join(home, '.ripgreprc'),
    ...(identity ? { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email } : {}) };
  // The sandbox home is empty: Playwright finds the member's browsers by path.
  const playwright = browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {};
  return { network: { ...common, ...languages.env.network, ...playwright },
    offline: { ...common, ...languages.env.offline, ...playwright, npm_config_fetch_retries: '0', npm_config_fetch_timeout: '5000', PIP_RETRIES: '0', PIP_TIMEOUT: '5' } };
}
// The browsers `npx playwright install` put in the member's cache.
function playwrightBrowsers(userHome) {
  const cache = process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright';
  try { const dir = fs.realpathSync(path.join(userHome, cache)); return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}
// Without network a command still reaches servers on this Mac (a test's own
// server, a database for integration tests), unless a proxy listens here:
// the system's and the environment's proxies, and the usual ports of local
// proxy and VPN clients, which would carry it to the internet.
const LOCAL_PROXY_PORTS = [1080, 1087, 6152, 6153, 7890, 7891, 7897, 8118, 9050, 9150, 10808, 10809];
function localProxyPorts() {
  const ports = new Set(LOCAL_PROXY_PORTS), loopback = host => /^(localhost|127(\.\d+){3}|\[?::1\]?)$/i.test(host);
  try {
    const out = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const kind of ['HTTP', 'HTTPS', 'SOCKS']) {
      const host = new RegExp(`${kind}Proxy : (\\S+)`).exec(out)?.[1], port = Number(new RegExp(`${kind}Port : (\\d+)`).exec(out)?.[1]);
      if (host && loopback(host) && port > 0 && port < 65536) ports.add(port);
    }
  } catch { /* no proxy settings */ }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    try { const url = new URL(process.env[name]); if (loopback(url.hostname) && url.port) ports.add(Number(url.port)); } catch { /* unset or not a URL */ }
  }
  return [...ports].sort((a, b) => a - b);
}
// Whether one of them answers now; checked again every few seconds.
function localProxyListening(ports) {
  return Promise.all(ports.map(port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(250, () => done(false)); socket.once('connect', () => done(true)); socket.once('error', () => done(false));
  }))).then(answers => answers.some(Boolean));
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
  constructor({ cwd, sdkRoot, protectedRoots = [], readOnly = false, commands = false, node = process.execPath, identity, userHome: home, searchTools = true, skills: skillFolders = [], proxyPorts }) {
    // macOS: Seatbelt. Linux, and Windows through WSL2: bubblewrap (linux-sandbox.mjs).
    this.linux = process.platform === 'linux';
    if (process.platform !== 'darwin' && !(this.linux && BWRAP)) throw new Error('managed-sandbox-unavailable');
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
      path.join(userHome, 'Library/Keychains'), agentWatchDataDirectory(userHome),
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
    const toolchains = userToolchains(userHome, this.node), developer = developerTools(), browsers = playwrightBrowsers(userHome);
    const languages = languageEnvironment({ userHome, repositoryTop: this.repositoryTop, home: this.home });
    this.packageCache = languages.cache;
    // The Docker engine, for commands the member approves (run_with_docker).
    this.engine = readOnly ? null : containerEngine({ userHome });
    // A skill folder opens for reading only inside the agent folders (.claude,
    // .codex, .pi, .agents) or outside the home folder's hidden entries, and
    // never when it holds a closed folder (a link to ~/.ssh, the home folder).
    const agentFolders = ['.claude', '.codex', '.pi', '.agents'].map(dir => path.join(userHome, dir));
    const skills = [...new Set(skillFolders.flatMap(dir => { try { return [fs.realpathSync(dir)]; } catch { return []; } }))]
      .filter(dir => dir !== '/' && !/[\x00-\x1f\x7f]/.test(dir) && !narrowed.some(root => inside(root, dir)) && !inside(userHome, dir)
        && (!inside(dir, userHome) || agentFolders.some(root => inside(dir, root)) || !path.relative(userHome, dir).startsWith('.')));
    const base = { cwd: this.cwd, sdkRoot: this.sdkRoot, runtimeRoot: this.runtimeRoot, temporary: this.temporary, node: this.node,
      denied: narrowed, readOnly, repository, gitDirs, toolchains: [...toolchains.roots, ...languages.readRoots], developer: developer.roots,
      browsers: browsers ? [browsers] : [], skills, caches: languages.writeRoots, license: developerLicense() };
    this.userHome = userHome;
    // Only for commands the user approved (run_with_network); credentials stay
    // denied, and so do reference folders: what a command with network can
    // read is the project, not the member's other files.
    this.networkAllowed = !readOnly;
    if (this.linux) {
      const references = referenceFolders(userHome).filter(dir => !narrowed.some(root => inside(dir, root) || inside(root, dir)));
      const empty = path.join(this.temporary, 'empty'); fs.writeFileSync(empty, '', { mode: 0o400 });
      this.linuxBase = { ...base, toolchains: [...base.toolchains, ...base.browsers], references, empty, engineRoots: this.engine?.readRoots ?? [] };
      this.referenceCredentials = credentialFiles(references, { limit: 30_000 });
      this.projectCredentials = { at: 0, files: [] };
    } else {
      this.profile = managedSeatbelt({ ...base, references: userHome });
      // The same without loopback, while a local proxy listens (localProxyListening).
      this.isolatedProfile = managedSeatbelt({ ...base, references: userHome, loopback: false });
      this.proxyPorts = proxyPorts ?? localProxyPorts(); this.proxyCheck = { at: 0, listening: Promise.resolve(false) };
      this.networkProfile = readOnly ? null : managedSeatbelt({ ...base, network: true });
      // An approved network command that also reaches the Docker engine's socket.
      this.dockerProfile = this.engine ? managedSeatbelt({ ...base, network: true, docker: this.engine.socket, toolchains: [...base.toolchains, ...this.engine.readRoots] }) : null;
    }
    // Every process a command starts carries this marker, also one it detaches.
    this.scope = randomUUID();
    this.environment = toolEnvironment({ git: this.git, node: this.node, home: this.home, temporary: this.temporary, toolchains, developer, scope: this.scope, browsers, languages,
      identity: identity !== undefined ? identity : gitIdentity(this.git, this.cwd) });
    if (this.engine) this.environment.docker = { ...this.environment.network, ...engineEnvironment(this.engine, this.home) };
    // Package registries without asking (package-proxy.mjs): commands that
    // write the project reach them through the runtime's proxy; read-only
    // helpers keep no network at all.
    if (!readOnly) this.proxyReady = this.startProxy(base, languages);
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
  // The proxy listens on loopback (macOS: Seatbelt opens its one port even
  // while a local proxy closes the rest of loopback) or on a Unix socket that
  // the worker forwards from inside the command's network namespace (Linux).
  async startProxy(base, languages) {
    this.proxy = new PackageProxy({ domains: [...DEFAULT_DOMAINS, ...memberDomains(this.userHome)] });
    try {
      let url;
      if (this.linux) {
        this.proxySocket = path.join(os.tmpdir(), `piagent-proxy-${randomUUID().slice(0, 8)}.sock`);
        await this.proxy.listen(this.proxySocket);
        url = 'http://127.0.0.1:3128';
        this.environment.offline.PIAGENT_PROXY_SOCKET = '/run/piagent-proxy.sock';
      } else {
        const { port } = await this.proxy.listen();
        url = `http://127.0.0.1:${port}`;
        // TLS through the macOS Security framework (Go, Swift, .NET) verifies
        // the registries' certificates with the system's trust services.
        this.profile = managedSeatbelt({ ...base, references: this.userHome, proxyPort: port });
        this.isolatedProfile = managedSeatbelt({ ...base, references: this.userHome, loopback: false, proxyPort: port });
      }
      const offline = this.environment.offline;
      for (const key of ['npm_config_fetch_retries', 'npm_config_fetch_timeout', 'PIP_RETRIES', 'PIP_TIMEOUT']) delete offline[key];
      Object.assign(offline, proxyEnvironment(url, { mavenOpts: offline.MAVEN_OPTS, gradleOpts: offline.GRADLE_OPTS }), { GOPROXY: languages.env.network.GOPROXY });
      this.proxyUrl = url;
    } catch { await this.proxy.close().catch(() => {}); this.proxy = null; }
  }
  async invoke(name, args, signal, onUpdate, model, { network = false, docker = false } = {}) {
    await this.proxyReady;
    const before = this.proxy?.deniedCount ?? 0;
    try { return await this.#invoke(name, args, signal, onUpdate, model, { network, docker }); }
    catch (error) {
      // A command that failed after the proxy refused a host: name the hosts.
      const refused = !network && !docker && this.proxy ? this.proxy.deniedSince(before) : [];
      if (!refused.length) throw error;
      throw new Error(`managed-domain-blocked: Lệnh thường chỉ tải được từ các registry package quen thuộc (npm, PyPI, Go, crates.io, Maven, Gradle, NuGet, RubyGems, Packagist, pub.dev…). Host bị chặn: ${refused.join(', ')}. Nếu lệnh thật sự cần host này, dùng run_with_network để người dùng duyệt đúng lệnh đó.\n${String(error?.message ?? error)}`);
    }
  }
  async #invoke(name, args, signal, onUpdate, model, { network = false, docker = false } = {}) {
    if (docker && !this.engine) throw new Error('managed-tool-unavailable');
    network ||= docker;
    if (this.#closed || !this.allowed.includes(name) || network && (name !== 'bash' || !this.networkAllowed)) throw new Error('managed-tool-unavailable');
    if (signal?.aborted) throw new Error('managed-tool-cancelled');
    for (const [file, digest] of this.pins) if (hash(file) !== digest) throw new Error('managed-runtime-changed');
    // `~` (as in an @~/… mention) is the member's home folder: the sandbox's
    // own HOME is an empty private folder.
    if (name !== 'bash' && typeof args?.path === 'string' && /^@?~(\/|$)/.test(args.path)) args = { ...args, path: this.userHome + args.path.replace(/^@?~/, '') };
    if (!this.linux && !network && Date.now() - this.proxyCheck.at > 5000) this.proxyCheck = { at: Date.now(), listening: localProxyListening(this.proxyPorts) };
    const isolated = !this.linux && !network && await this.proxyCheck.listening;
    const message = JSON.stringify({ name, args, ...(network ? { network: true } : {}), ...(isolated ? { isolated: true } : {}), ...(docker ? { docker: true } : this.engine ? { engine: true } : {}), model: model ? { input: model.input, inputLimits: model.inputLimits } : undefined }) + '\n';
    if (Buffer.byteLength(message) > MAX_WIRE_BYTES) throw new Error('managed-tool-input-too-large');
    return await new Promise((resolve, reject) => {
      const [sandbox, sandboxArgs] = this.linux ? [BWRAP, this.bubblewrap(network, docker)]
        : ['/usr/bin/sandbox-exec', ['-p', docker ? this.dockerProfile : network ? this.networkProfile : isolated ? this.isolatedProfile : this.profile]];
      const child = spawn(sandbox, [...sandboxArgs, this.node, workerPath, this.sdkPath, this.cwd], {
        cwd: this.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: docker ? this.environment.docker : network ? this.environment.network : this.environment.offline,
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
      // A command stops at its own timeout (at most 30 minutes, for a build
      // and end-to-end suite), else after 10 minutes; other tools after 30 s.
      const seconds = Math.min(Math.max(Number(args?.timeout) || 600, 1), 1800);
      const deadline = setTimeout(() => { failure = new Error('managed-tool-timeout'); terminate(); }, name === 'bash' ? seconds * 1000 + 5000 : 30000);
      deadline.unref();
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.on('data', chunk => {
        // The cap is per message, not per command: a noisy command streams a
        // progress update (the output's last 50KB) every 100ms, so a running
        // total would stop any build or test that prints for ~25 seconds.
        const newline = chunk.lastIndexOf(10);
        bytes = newline < 0 ? bytes + chunk.length : chunk.length - newline - 1;
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
  // bubblewrap arguments for one command: credential files of the project are
  // looked for again every 15 seconds (a file the member just added).
  bubblewrap(network, docker = false) {
    if (Date.now() - this.projectCredentials.at > 15_000)
      this.projectCredentials = { at: Date.now(), files: credentialFiles([this.cwd, ...this.linuxBase.repository]) };
    const credentials = [...this.projectCredentials.files, ...(network ? [] : this.referenceCredentials)];
    const { engineRoots, ...base } = this.linuxBase;
    return bubblewrapArgs({ ...base, references: network ? [] : base.references, network, credentials, proxySocket: network ? null : this.proxySocket,
      ...(docker ? { docker: this.engine.socket, toolchains: [...base.toolchains, ...engineRoots] } : {}) });
  }
  // Processes a command left running (`nohup … &`, a detached child) outlive
  // it with the marker in their environment. They are stopped when a turn ends
  // and when the boundary closes; nothing outside this boundary has the marker.
  async stopStrays() {
    // On Linux a command's processes end with it (its own PID namespace).
    if (this.#children.size || this.linux) return 0;
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
    await this.proxyReady; await this.proxy?.close().catch(() => {});
    if (this.proxySocket) fs.rmSync(this.proxySocket, { force: true });
    fs.rmSync(this.temporary, { recursive: true, force: true });
  }
}
