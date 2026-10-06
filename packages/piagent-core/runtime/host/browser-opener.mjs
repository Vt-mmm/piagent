import fs from 'node:fs';
import path from 'node:path';

// How this machine opens a link in the member's browser: `open` on macOS,
// `start` on Windows, and from WSL the Windows browser (wslview when
// installed, else explorer.exe, which takes a link as it is: cmd's start
// would split one at &). Elsewhere xdg-open. null: no way here.
export function browserCommand(url, { platform = process.platform, environment = process.env } = {}) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  if (platform !== 'linux') return null;
  const onPath = name => String(environment.PATH ?? '').split(':').filter(Boolean).map(dir => path.join(dir, name)).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
  if (environment.WSL_DISTRO_NAME) {
    const wslview = onPath('wslview');
    if (wslview) return { command: wslview, args: [url] };
    const explorer = onPath('explorer.exe');
    if (explorer) return { command: explorer, args: [url], options: { cwd: '/mnt/c' } };
  }
  return { command: 'xdg-open', args: [url] };
}
