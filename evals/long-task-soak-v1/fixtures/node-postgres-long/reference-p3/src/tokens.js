import { createHash, randomBytes } from 'node:crypto';
import { BookingError } from './errors.js';

const sha256 = token => createHash('sha256').update(token).digest('hex');

export function tokenMethods(pool) {
  return {
    async createApiToken({ username, role } = {}) {
      if (typeof username !== 'string' || !username.trim()) throw new BookingError('INVALID_INPUT', 'username must be a non-empty string');
      if (role !== 'admin' && role !== 'member') throw new BookingError('INVALID_INPUT', "role must be 'admin' or 'member'");
      const token = randomBytes(24).toString('base64url');
      await pool.query('INSERT INTO api_tokens (token_sha256, username, role) VALUES ($1, $2, $3)', [sha256(token), username.trim(), role]);
      return { token, username: username.trim(), role };
    },
    // → { username, role } or null
    async findApiToken(token) {
      if (typeof token !== 'string' || !token) return null;
      const { rows } = await pool.query('SELECT username, role FROM api_tokens WHERE token_sha256 = $1', [sha256(token)]);
      return rows[0] ?? null;
    },
  };
}
