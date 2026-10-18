// Model calls go to Studio with the whole conversation every time (a 200k-token
// Codex context is about 1 MB). On a slow uplink that took longer than Studio
// waited, so once Studio says it accepts gzip request bodies
// (X-Studio-Accept-Encoding: gzip), large bodies go up compressed (about 3x
// smaller; encrypted reasoning does not compress). Nothing else changes.
import { gzipSync } from 'node:zlib';

export const GZIP_MIN_BYTES = 64 * 1024;
const ADVERTISED = 'x-studio-accept-encoding';

const urlOf = (input) => typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url ?? '';

export function compressedFetch(owner, base = (...args) => globalThis.fetch(...args)) {
  return async (input, init = {}) => {
    let next = init;
    const body = init?.body;
    if (owner.studioGzip && typeof body === 'string' && urlOf(input).startsWith(owner.origin) && Buffer.byteLength(body) >= GZIP_MIN_BYTES) {
      const headers = new Headers(init.headers);
      if (!headers.has('content-encoding')) {
        headers.set('content-encoding', 'gzip');
        next = { ...init, headers, body: gzipSync(body, { level: 6 }) };
      }
    }
    const response = await base(input, next);
    if (!owner.studioGzip && String(response.headers?.get?.(ADVERTISED) ?? '').split(',').map((v) => v.trim()).includes('gzip')) owner.studioGzip = true;
    return response;
  };
}
