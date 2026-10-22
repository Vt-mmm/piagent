import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DOMAINS, PackageProxy, mavenSettings, memberDomains } from './package-proxy.mjs';

export async function startBoundaryPackageProxy(boundary, apply) {
  boundary.proxy = new PackageProxy({ domains: [...DEFAULT_DOMAINS, ...memberDomains(boundary.userHome)] });
  try {
    let url;
    if (boundary.linux) {
      boundary.proxySocket = path.join(os.tmpdir(), `piagent-proxy-${randomUUID().slice(0, 8)}.sock`);
      await boundary.proxy.listen(boundary.proxySocket);
      url = 'http://127.0.0.1:3128';
    } else url = `http://127.0.0.1:${(await boundary.proxy.listen()).port}`;
    const settings = path.join(boundary.home, '.m2/settings.xml');
    fs.mkdirSync(path.dirname(settings), { recursive: true, mode: 0o700 });
    fs.writeFileSync(settings, mavenSettings(url), { mode: 0o600 });
    boundary.proxyUrl = url; apply();
  } catch { await boundary.proxy.close().catch(() => {}); boundary.proxy = null; }
}
