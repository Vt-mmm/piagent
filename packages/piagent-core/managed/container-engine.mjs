import fs from 'node:fs';
import path from 'node:path';

// The Docker engine a company command may use once the member approves it
// (run_with_docker): its socket, the CLI and its plugins (compose, buildx).
// The socket is the only thing opened beyond an approved network command:
// containers run in the engine (Docker Desktop's VM, Colima, OrbStack, the
// Linux daemon, Podman's compatible socket), not in this sandbox.
// The CLI gets a configuration folder of its own in the sandbox's home: no
// registry credentials (credsStore, auths), so public images are pulled and
// private registries are not, as with .npmrc.
const isSocket = file => { try { return fs.statSync(file).isSocket(); } catch { return false; } };
const real = file => { try { return fs.realpathSync(file); } catch { return null; } };

function socketCandidates(userHome, env, system) {
  const host = /^unix:\/\/(\/.+)$/.exec(env.DOCKER_HOST ?? '')?.[1];
  const runtime = env.XDG_RUNTIME_DIR;
  return [host, path.join(userHome, '.docker/run/docker.sock'), ...(system ? ['/var/run/docker.sock'] : []), path.join(userHome, '.colima/default/docker.sock'),
    path.join(userHome, '.orbstack/run/docker.sock'), ...(runtime ? [path.join(runtime, 'docker.sock'), path.join(runtime, 'podman/podman.sock')] : [])].filter(Boolean);
}

// The member's CLI plugins (links into the app bundle on macOS).
function cliPlugins(userHome, system) {
  const dirs = [path.join(userHome, '.docker/cli-plugins'), ...!system ? [] : ['/usr/local/lib/docker/cli-plugins', '/usr/libexec/docker/cli-plugins', '/usr/lib/docker/cli-plugins',
    '/Applications/Docker.app/Contents/Resources/cli-plugins', '/opt/homebrew/lib/docker/cli-plugins']];
  const plugins = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^docker-[a-z0-9-]+$/.test(name) || plugins.has(name)) continue;
      const file = real(path.join(dir, name));
      try { if (file && fs.statSync(file).isFile()) plugins.set(name, file); } catch { /* broken link */ }
    }
  }
  return plugins;
}

// `system`: also the machine-wide socket and plugin folders (tests leave them out).
export function containerEngine({ userHome, env = process.env, paths = ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/Applications/Docker.app/Contents/Resources/bin'], system = true } = {}) {
  const socket = socketCandidates(userHome, env, system).map(real).find(file => file && isSocket(file));
  const cli = paths.map(dir => real(path.join(dir, 'docker'))).find(Boolean);
  if (!socket || !cli) return null;
  const plugins = cliPlugins(userHome, system);
  // Read roots: the folders the CLI and plugins live in (/usr is open already).
  const readRoots = [...new Set([cli, ...plugins.values()].map(file => {
    const bundle = /^(\/Applications\/[^/]+\.app)\//.exec(file)?.[1];
    return bundle ?? path.dirname(file);
  }))].filter(dir => !/^\/(usr|bin|sbin|opt\/homebrew)(\/|$)/.test(dir));
  return { socket, cli, plugins, readRoots };
}

// The CLI's configuration in the sandbox's home, and the environment that
// points it (and Testcontainers) at the engine.
export function engineEnvironment(engine, home) {
  const config = path.join(home, '.docker');
  fs.mkdirSync(path.join(config, 'cli-plugins'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config, 'config.json'), '{}\n', { mode: 0o600 });
  for (const [name, file] of engine.plugins) {
    try { fs.symlinkSync(file, path.join(config, 'cli-plugins', name)); } catch { /* already there */ }
  }
  return {
    DOCKER_HOST: `unix://${engine.socket}`, DOCKER_CONFIG: config, DOCKER_CLI_HINTS: 'false',
    // Testcontainers' reaper mounts the engine's socket inside its VM, where
    // Docker Desktop and Colima name it /var/run/docker.sock.
    ...(process.platform === 'darwin' ? { TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE: '/var/run/docker.sock' } : {}),
  };
}
