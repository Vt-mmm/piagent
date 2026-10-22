import http from 'node:http';
import { redactConfig } from './config.js';

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export function createServer(config) {
  const origins = config.corsOrigins;
  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = origin && origins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true }, cors);
    if (req.method === 'GET' && req.url === '/debug/config') return send(res, 200, redactConfig(config), cors);
    send(res, 404, { error: 'not found' }, cors);
  });
}
