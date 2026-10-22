import { createHmac, timingSafeEqual } from 'node:crypto';

const b64 = value => Buffer.from(value).toString('base64url');
const sign = (secret, data) => createHmac('sha256', secret).update(data).digest('base64url');

// HS256 JWT with iat/exp (seconds).
export function signToken(payload, config, { now = Date.now() } = {}) {
  const iat = Math.floor(now / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...payload, iat, exp: iat + config.jwt.ttlSeconds }));
  return `${head}.${body}.${sign(config.jwt.secret, `${head}.${body}`)}`;
}

// The payload, or null when the token is malformed, forged or expired.
export function verifyToken(token, config, { now = Date.now() } = {}) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = Buffer.from(sign(config.jwt.secret, `${head}.${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(now / 1000)) return null;
  return payload;
}
