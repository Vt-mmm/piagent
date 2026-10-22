import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function loadPersonalPty(load = () => require('@lydell/node-pty'), platform = process.platform) {
  if (platform === 'win32') return { pty: null, reason: 'terminal-platform-unavailable' };
  try {
    const pty = load();
    if (typeof pty?.spawn !== 'function') throw Error('invalid-pty-module');
    return { pty, reason: null };
  } catch { return { pty: null, reason: 'terminal-native-module-unavailable' }; }
}
export function personalTerminalDiagnostic(load, platform = process.platform) {
  const { reason } = loadPersonalPty(load, platform);
  return { available: reason === null, reasonCode: reason, platform,
    scope: 'personal', nativeModule: '@lydell/node-pty', probe: 'module-load',
    shellSpawnVerified: false };
}
