import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// What test runners and package managers of the common languages need in the
// company sandbox beyond the toolchains themselves (toolchain.mjs):
// - package caches that persist for the project between conversations,
//   outside the project and private to it: the first install asks for
//   network (run_with_network), later runs work offline;
// - the member's own dependency caches as read-only seeds, where the tool can
//   layer one (Go, Gradle, Maven), so what is already downloaded is reused;
// - the Maven distributions the Maven Wrapper (./mvnw) already unpacked on
//   this Mac, linked read-only into the project's cache, so ./mvnw runs
//   without asking for network; one it has to download stays in the cache;
// - runtimes installed in places the sandbox otherwise keeps closed (JDKs
//   under ~/Library/Java, the Android SDK, the system gem folder, MacPorts);
// - SwiftPM and xcodebuild, which cannot start their own sandbox inside this
//   one: their manifest sandbox is off; this sandbox confines the same
//   processes.
const KEEP_DAYS = 30;
const existing = dir => { try { const real = fs.realpathSync(dir); return fs.statSync(real).isDirectory() ? real : null; } catch { return null; } };

// Unused project caches are removed after a month.
function prune(root, keep) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  const limit = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    try { if (entry.isDirectory() && dir !== keep && fs.statSync(dir).mtimeMs < limit) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* in use or gone */ }
  }
}

function javaHome(userHome) {
  if (process.platform === 'linux') {
    if (process.env.JAVA_HOME) return existing(process.env.JAVA_HOME);
    for (const dir of (process.env.PATH ?? '/usr/bin').split(':')) {
      try { return existing(path.dirname(path.dirname(fs.realpathSync(path.join(dir, 'javac'))))); } catch { /* next */ }
    }
    return null;
  }
  try {
    const home = execFileSync('/usr/libexec/java_home', [], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { HOME: userHome, PATH: '/usr/bin:/bin' } }).trim();
    return existing(home);
  } catch { return null; }
}

// SwiftPM and xcodebuild start sandbox-exec for package manifests and
// plugins; inside this sandbox that fails ("sandbox_apply: Operation not
// permitted"). These wrappers, first on PATH, pass the switch that turns it
// off, then run the member's own swift/xcodebuild found further on PATH.
const SWIFT_WRAPPER = `#!/bin/sh
self=$(cd "$(dirname "$0")" && pwd -P)
real=; IFS=:; for dir in $PATH; do [ "$dir" = "$self" ] && continue; [ -x "$dir/$(basename "$0")" ] && { real="$dir/$(basename "$0")"; break; }; done; unset IFS
[ -n "$real" ] || { echo "$(basename "$0"): not installed" >&2; exit 127; }
case "$(basename "$0"):$1" in
  swift:build|swift:test|swift:run) sub=$1; shift; exec "$real" "$sub" --disable-sandbox "$@" ;;
  swift:package) shift; exec "$real" package --disable-sandbox "$@" ;;
  xcodebuild:*)
    # Build products go to the project's cache (~/Library/Developer is closed).
    derived=; case " $* " in *" -derivedDataPath "*) ;; *" -scheme "*|*" -xctestrun "*|*" -testProductsPath "*) derived="-derivedDataPath $PIAGENT_DERIVED_DATA" ;; esac
    exec "$real" -IDEPackageSupportDisableManifestSandbox=YES -IDEPackageSupportDisablePluginExecutionSandbox=YES $derived "$@" ;;
  *) exec "$real" "$@" ;;
esac
`;

// Each <name>/<hash> distribution folder of the member's Maven Wrapper as a
// link in the project's cache; one already there (linked, or downloaded by an
// approved command) is kept.
function linkDistributions(source, target) {
  let names = [];
  try { names = fs.readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch { return; }
  for (const name of names) {
    let hashes = [];
    try { hashes = fs.readdirSync(path.join(source, name.name), { withFileTypes: true }).filter(entry => entry.isDirectory()); } catch { continue; }
    for (const hash of hashes) {
      const link = path.join(target, name.name, hash.name);
      try { fs.lstatSync(link); continue; } catch { /* not there yet */ }
      try { fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 }); fs.symlinkSync(path.join(source, name.name, hash.name), link); } catch { /* best effort */ }
    }
  }
}

export function languageEnvironment({ userHome, repositoryTop, home }) {
  const linux = process.platform === 'linux';
  const root = linux ? path.join(process.env.XDG_CACHE_HOME || path.join(userHome, '.cache'), 'piagent/sandbox') : path.join(userHome, 'Library/Caches/Piagent/sandbox');
  const cache = path.join(root, createHash('sha256').update(repositoryTop).digest('hex').slice(0, 24));
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  fs.chmodSync(cache, 0o700);
  const now = new Date(); try { fs.utimesSync(cache, now, now); } catch { /* best effort */ }
  prune(root, cache);
  const at = name => path.join(cache, name);

  // Read-only: runtimes and the member's caches used as seeds.
  const seeds = {
    gradle: existing(path.join(userHome, '.gradle/caches')),
    maven: existing(path.join(userHome, '.m2/repository')),
    go: existing(path.join(process.env.GOMODCACHE || path.join(userHome, 'go/pkg/mod'), 'cache/download')),
    // .NET restores over TLS through the macOS Security framework, closed
    // here: packages the member restored are read from their own folder.
    nuget: existing(path.join(userHome, '.nuget/packages')),
    mavenWrapper: existing(path.join(userHome, '.m2/wrapper/dists')),
  };
  const java = javaHome(userHome), android = existing(path.join(userHome, linux ? 'Android/Sdk' : 'Library/Android/sdk'));
  const readRoots = [...new Set([...Object.values(seeds), java, android, existing(path.join(userHome, 'Library/Java/JavaVirtualMachines')),
    existing('/Library/Ruby'), existing('/opt/local')].filter(Boolean))];

  // ./mvnw looks for its distribution in MAVEN_USER_HOME/wrapper/dists/<name>/<hash>
  // (the sandbox's HOME is an empty folder per conversation).
  if (seeds.mavenWrapper) linkDistributions(seeds.mavenWrapper, at('m2/wrapper/dists'));

  const bin = path.join(home, '.piagent/bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  // (Only macOS: SwiftPM on Linux starts no sandbox of its own.)
  if (!linux) for (const name of ['swift', 'xcodebuild']) fs.writeFileSync(path.join(bin, name), SWIFT_WRAPPER, { mode: 0o755 });
  // pnpm's store: its own settings file, which npm does not read (an npm_config_
  // variable would make every npm command warn about an unknown setting).
  const pnpm = path.join(home, linux ? '.config/pnpm' : 'Library/Preferences/pnpm');
  fs.mkdirSync(pnpm, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(pnpm, 'rc'), `store-dir=${at('pnpm-store')}\n`, { mode: 0o600 });

  const common = {
    npm_config_cache: at('npm'), YARN_CACHE_FOLDER: at('yarn'), BUN_INSTALL_CACHE_DIR: at('bun'), DENO_DIR: at('deno'),
    PIP_CACHE_DIR: at('pip'), UV_CACHE_DIR: at('uv'), POETRY_CACHE_DIR: at('poetry'), XDG_CACHE_HOME: at('xdg'),
    GOPATH: at('go'), GOMODCACHE: at('go/pkg/mod'), GOCACHE: at('go/build'), GOFLAGS: '-modcacherw',
    CARGO_HOME: at('cargo'), GRADLE_USER_HOME: at('gradle'), NUGET_PACKAGES: at('nuget'), COMPOSER_CACHE_DIR: at('composer'),
    PUB_CACHE: at('pub'), GEM_HOME: at('gem'), BUNDLE_PATH: at('bundle'), CP_HOME_DIR: at('cocoapods'), PIAGENT_DERIVED_DATA: at('DerivedData'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    MAVEN_USER_HOME: at('m2'),
    MAVEN_OPTS: [`-Dmaven.repo.local=${at('m2/repository')}`, ...(seeds.maven ? [`-Dmaven.repo.local.tail=${seeds.maven}`] : [])].join(' '),
    ...(seeds.gradle ? { GRADLE_RO_DEP_CACHE: seeds.gradle } : {}),
    ...(seeds.nuget ? { NUGET_FALLBACK_PACKAGES: seeds.nuget } : {}),
    ...(java ? { JAVA_HOME: java } : {}),
    ...(android ? { ANDROID_HOME: android, ANDROID_SDK_ROOT: android } : {}),
  };
  // Go reads modules the member already has from their own cache first; an
  // approved command then goes on to the usual proxies.
  const seed = seeds.go ? `file://${seeds.go},` : '';
  // .NET keeps its named mutexes (NuGet's among them) as files in
  // /tmp/.dotnet, whatever TMPDIR says.
  const dotnet = [path.join(userHome, '.dotnet/dotnet'), '/usr/local/share/dotnet/dotnet', '/opt/homebrew/bin/dotnet'].some(file => fs.existsSync(file));
  // (On Linux the sandbox has its own /tmp.)
  if (dotnet && !linux) try { fs.mkdirSync('/private/tmp/.dotnet', { recursive: true, mode: 0o777 }); } catch { /* another user's */ }
  return {
    cache, readRoots, writeRoots: [cache, ...(dotnet && !linux && existing('/private/tmp/.dotnet') ? ['/private/tmp/.dotnet'] : [])], bin,
    env: {
      // .NET's dual-stack sockets reach 127.0.0.1 as ::ffff:127.0.0.1, which
      // the loopback rule does not name (the test host would not connect).
      offline: { ...common, GOPROXY: `${seed}off`, npm_config_prefer_offline: 'true', DOTNET_SYSTEM_NET_DISABLEIPV6: '1' },
      network: { ...common, GOPROXY: `${seed}${process.env.GOPROXY || 'https://proxy.golang.org,direct'}` },
    },
  };
}
