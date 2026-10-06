import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const CLT = '/Library/Developer/CommandLineTools';
const executable = file => { try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; } };
// The developer directory chosen by xcode-select (any Xcode name or location).
function selectedDeveloperDir() {
  try { return fs.realpathSync('/private/var/db/xcode_select_link'); } catch { return null; }
}

// /usr/bin/git is a macOS developer-tools launcher. Inside Seatbelt it may
// misreport an unaccepted Xcode license when its preference lookup is denied.
// Pin the actual installed binary; never widen access to user preferences.
export function managedGit() {
  const selected = selectedDeveloperDir();
  for (const candidate of [`${CLT}/usr/bin/git`, ...(selected ? [path.join(selected, 'usr/bin/git')] : []), '/Applications/Xcode.app/Contents/Developer/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git',
    ...(process.platform === 'linux' ? ['/usr/bin/git'] : [])]) {
    if (executable(candidate)) return fs.realpathSync(candidate);
  }
  throw Error('managed-git-unavailable');
}

// Compilers without the /usr/bin shims, resolved here, outside the sandbox:
// the developer directory the member selected (xcode-select), as their
// Terminal uses it, so a package's tests find XCTest and the compiler matches
// the SDK. The sandbox reads Xcode's license record (tool-boundary.mjs);
// without it xcrun reports an unaccepted license. Otherwise the Command Line
// Tools, else Xcode.app.
const DEVELOPER_LICENSE = '/Library/Preferences/com.apple.dt.Xcode.plist';
export const developerLicense = () => fs.existsSync(DEVELOPER_LICENSE) ? DEVELOPER_LICENSE : null;
let developer;
export function developerTools() {
  if (developer) return developer;
  const selected = selectedDeveloperDir();
  const clang = dev => dev === CLT ? `${CLT}/usr/bin/clang` : path.join(dev, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang');
  const dir = [selected, CLT, '/Applications/Xcode.app/Contents/Developer'].find(dev => dev && executable(clang(dev)));
  if (!dir) return (developer = { roots: [], bins: [], env: {} });
  let sdk = '';
  try {
    sdk = execFileSync('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', DEVELOPER_DIR: dir } }).trim();
    sdk = fs.realpathSync(sdk);
  } catch { sdk = dir === CLT && fs.existsSync(`${CLT}/SDKs/MacOSX.sdk`) ? fs.realpathSync(`${CLT}/SDKs/MacOSX.sdk`) : ''; }
  const bins = dir === CLT ? [`${CLT}/usr/bin`] : [path.join(dir, 'Toolchains/XcodeDefault.xctoolchain/usr/bin'), path.join(dir, 'usr/bin')];
  const app = dir.match(/^(.+?\.app)\/Contents\/Developer$/)?.[1];
  return (developer = { roots: [...new Set([app ?? dir, ...(sdk ? [sdk] : [])])], bins, env: { DEVELOPER_DIR: dir, ...(sdk ? { SDKROOT: sdk } : {}) } });
}

// Certificates the Mac trusts beyond Node's bundled roots (a company CA, a
// TLS-inspecting network) are trusted here too, so Studio and web pages load
// wherever Agent Watch (which uses the system trust store) can connect.
let systemTrust = false;
export async function trustSystemCertificates() {
  if (systemTrust) return; systemTrust = true;
  try {
    const tls = await import('node:tls');
    const system = tls.getCACertificates('system');
    if (system.length) tls.setDefaultCACertificates([...new Set([...tls.getCACertificates('default'), ...system])]);
  } catch { /* older Node: bundled roots only */ }
}

const downloaded = new Map();

// ripgrep and fd for Pi's grep/find, on any member machine: an installed copy,
// else Pi's own downloader run here (outside the sandbox, like personal Pi).
export function searchToolPath(name, userHome = os.homedir()) {
  // Debian and Ubuntu install fd as fdfind.
  const system = process.platform === 'linux' ? [`/usr/bin/${name}`, ...(name === 'fd' ? ['/usr/bin/fdfind'] : [])] : [];
  for (const candidate of [downloaded.get(name), `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, path.join(userHome, '.pi/agent/bin', name), ...system]) {
    if (candidate && executable(candidate)) return fs.realpathSync(candidate);
  }
  return null;
}
export async function ensureSearchTools(sdkRoot, userHome = os.homedir(), timeoutMs = 60_000) {
  const missing = ['rg', 'fd'].filter(name => !searchToolPath(name, userHome));
  if (!missing.length) return;
  let manager;
  try { manager = await import(pathToFileURL(path.join(sdkRoot, 'dist/utils/tools-manager.js')).href); } catch { return; }
  await Promise.all(missing.map(async name => {
    try {
      const found = await Promise.race([manager.ensureTool(name, true), new Promise(resolve => setTimeout(resolve, timeoutMs).unref())]);
      if (typeof found === 'string' && path.isAbsolute(found) && executable(found)) downloaded.set(name, found);
    } catch { /* grep/find fall back to the built-in search */ }
  }));
}

// Version managers and user-level toolchains the sandbox may read (never
// write): only folders that exist on this machine, with their bin folders on
// PATH and the variables their shims need. Credentials inside stay denied by
// the profile's credential rules.
const TOOLCHAINS = [
  { dir: '.nvm' }, { dir: '.fnm' }, { dir: '.local/share/fnm' },
  { dir: '.volta', bin: ['bin'], env: 'VOLTA_HOME' },
  { dir: 'Library/pnpm', bin: [''], env: 'PNPM_HOME' }, { dir: '.local/share/pnpm', bin: [''] },
  { dir: '.bun', bin: ['bin'], env: 'BUN_INSTALL' }, { dir: '.deno', bin: ['bin'] },
  { dir: '.cargo', bin: ['bin'], env: 'CARGO_HOME' }, { dir: '.rustup', env: 'RUSTUP_HOME' },
  { dir: '.pyenv', bin: ['shims', 'bin'], env: 'PYENV_ROOT' }, { dir: '.rbenv', bin: ['shims', 'bin'], env: 'RBENV_ROOT' },
  { dir: 'go', bin: ['bin'], env: 'GOPATH' }, { dir: '.sdkman/candidates', bin: ['java/current/bin', 'gradle/current/bin', 'maven/current/bin'] },
  { dir: '.local/share/mise', bin: ['shims'], env: 'MISE_DATA_DIR' }, { dir: '.asdf', bin: ['shims', 'bin'], env: 'ASDF_DATA_DIR' },
  { dir: '.nodenv', bin: ['shims', 'bin'], env: 'NODENV_ROOT' }, { dir: '.goenv', bin: ['shims', 'bin'], env: 'GOENV_ROOT' },
  { dir: '.jenv', bin: ['shims', 'bin'] }, { dir: '.rvm', bin: ['bin'] },
  { dir: 'miniconda3', bin: ['bin', 'condabin'] }, { dir: 'miniforge3', bin: ['bin', 'condabin'] }, { dir: 'anaconda3', bin: ['bin', 'condabin'] },
  { dir: '.dotnet', bin: [''], env: 'DOTNET_ROOT' }, { dir: '.yarn', bin: ['bin'] },
  { dir: '.npm-global', bin: ['bin'] }, { dir: '.npm-packages', bin: ['bin'] },
  { dir: '.local/bin', bin: [''] },
];
export function userToolchains(userHome = os.homedir(), node = process.execPath) {
  const roots = [], bins = [], env = {};
  for (const tool of TOOLCHAINS) {
    const root = path.join(userHome, tool.dir);
    let real;
    try { real = fs.realpathSync(root); if (!fs.statSync(real).isDirectory()) continue; } catch { continue; }
    roots.push(real);
    for (const bin of tool.bin ?? []) { const dir = path.join(real, bin); if (fs.existsSync(dir)) bins.push(dir); }
    if (tool.env) env[tool.env] = real;
  }
  if (env.GOPATH) env.GOMODCACHE = path.join(env.GOPATH, 'pkg/mod');
  // npm/npx of the pinned node live in its install prefix (nvm, volta, fnm, a
  // tarball install), which may sit outside the system folders.
  const prefix = path.dirname(path.dirname(fs.realpathSync(node)));
  if (prefix !== userHome && prefix !== '/' && fs.existsSync(path.join(prefix, 'lib/node_modules'))) roots.push(prefix);
  return { roots: [...new Set(roots)], bins, env };
}
