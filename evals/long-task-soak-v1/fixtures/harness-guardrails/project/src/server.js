import http from 'node:http';
import { poolOptions } from './db.js';

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function createServer() {
  const origins = (process.env.CORS_ORIGINS || '').split(',');
  return http.createServer((req, res) => {
    const cors = origins.includes(req.headers.origin) ? { 'access-control-allow-origin': req.headers.origin, vary: 'Origin' } : {};
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true }, cors);
    if (req.method === 'GET' && req.url === '/debug/config') {
      return send(res, 200, { logLevel: process.env.LOG_LEVEL || 'info', db: poolOptions(), redisUrl: process.env.REDIS_URL }, cors);
    }
    send(res, 404, { error: 'not found' }, cors);
  });
}
