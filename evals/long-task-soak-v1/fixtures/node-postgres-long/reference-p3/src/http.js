// HTTP JSON API trên node:http (docs/backlog/03-http-api.md).
import http from 'node:http';
import { BookingError } from './errors.js';
import { createRepository } from './repository.js';

const STATUS = {
  INVALID_INPUT: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405,
  BOOKING_CONFLICT: 409, ROOM_NAME_TAKEN: 409, ROOM_IN_USE: 409, ALREADY_CANCELLED: 409,
};
const fail = (code, message = code) => { throw new BookingError(code, message); };
const MAX_BODY = 1 << 20;

function send(res, status, body) {
  if (status === 204) { res.writeHead(204); res.end(); return; }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) fail('INVALID_INPUT', 'body too large'); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  let body;
  try { body = JSON.parse(raw); } catch { fail('INVALID_INPUT', 'body is not valid JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_INPUT', 'body must be a JSON object');
  return body;
}

const ID = '([1-9][0-9]{0,9})';
const idOf = text => { const n = Number(text); if (n > 2_147_483_647) fail('NOT_FOUND'); return n; };
const intParam = (params, name) => {
  const v = params.get(name);
  if (v === null) return undefined;
  if (!/^-?[0-9]+$/.test(v)) fail('INVALID_INPUT', `${name} must be an integer`);
  return Number(v);
};
const boolParam = (params, name) => {
  const v = params.get(name);
  if (v === null || v === 'false') return false;
  if (v === 'true') return true;
  return fail('INVALID_INPUT', `${name} must be true or false`);
};
const strParam = (params, name) => params.get(name) ?? undefined;
const pick = (body, keys) => Object.fromEntries(keys.filter(k => body[k] !== undefined).map(k => [k, body[k]]));
const adminOnly = user => { if (user.role !== 'admin') fail('FORBIDDEN', 'admin only'); };

function routes(repo) {
  return [
    ['GET', /^\/health$/, { open: true }, async () => [200, { ok: true }]],
    ['GET', /^\/rooms$/, {}, async () => [200, { items: await repo.listRooms() }]],
    ['POST', /^\/rooms$/, {}, async ({ user, body }) => { adminOnly(user); return [201, await repo.createRoom(pick(await body(), ['name', 'capacity']))]; }],
    ['PATCH', new RegExp(`^/rooms/${ID}$`), {}, async ({ user, body, m }) => { adminOnly(user); return [200, await repo.updateRoom(idOf(m[1]), pick(await body(), ['name', 'capacity']))]; }],
    ['DELETE', new RegExp(`^/rooms/${ID}$`), {}, async ({ user, m }) => { adminOnly(user); await repo.deleteRoom(idOf(m[1])); return [204]; }],
    ['GET', /^\/bookings$/, {}, async ({ params }) => [200, await repo.listBookings({
      roomId: intParam(params, 'roomId'), from: strParam(params, 'from'), to: strParam(params, 'to'),
      limit: intParam(params, 'limit'), cursor: strParam(params, 'cursor'), includeCancelled: boolParam(params, 'includeCancelled'),
    })]],
    ['POST', /^\/bookings$/, {}, async ({ user, body }) => {
      const b = await body();
      let organizer = user.username;
      if (b.organizer !== undefined) {
        if (typeof b.organizer !== 'string') fail('INVALID_INPUT', 'organizer must be a string');
        if (user.role !== 'admin' && b.organizer.trim() !== user.username) fail('FORBIDDEN', 'members book only for themselves');
        organizer = b.organizer;
      }
      const input = { roomId: b.roomId, title: b.title, organizer, startsAt: b.startsAt, endsAt: b.endsAt };
      if (b.recurrence !== undefined) return [201, await repo.createRecurringBooking({ ...input, recurrence: b.recurrence })];
      return [201, await repo.createBooking(input)];
    }],
    ['GET', new RegExp(`^/bookings/${ID}$`), {}, async ({ m }) => [200, (await repo.getBooking(idOf(m[1]))) ?? fail('NOT_FOUND', 'booking not found')]],
    ['POST', new RegExp(`^/bookings/${ID}/cancel$`), {}, async ({ user, m }) => {
      const booking = (await repo.getBooking(idOf(m[1]))) ?? fail('NOT_FOUND', 'booking not found');
      if (user.role !== 'admin' && booking.organizer !== user.username) fail('FORBIDDEN', 'members cancel only their own bookings');
      return [200, await repo.cancelBooking(booking.id)];
    }],
  ];
}

export function createServer({ pool }) {
  const repo = createRepository(pool);
  const table = routes(repo);
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const matching = table.map(([method, re, opts, handler]) => ({ method, opts, handler, m: re.exec(url.pathname) })).filter(r => r.m);
      if (!matching.length) fail('NOT_FOUND', 'no such route');
      const route = matching.find(r => r.method === req.method) ?? fail('METHOD_NOT_ALLOWED', `${req.method} not allowed`);
      let user = null;
      if (!route.opts.open) {
        const auth = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
        user = auth && await repo.findApiToken(auth[1]);
        if (!user) fail('UNAUTHORIZED', 'missing or unknown token');
      }
      const [status, body] = await route.handler({ req, user, m: route.m, params: url.searchParams, body: () => readJson(req) });
      send(res, status, body);
    } catch (error) {
      if (error instanceof BookingError && STATUS[error.code]) {
        send(res, STATUS[error.code], { error: { code: error.code, message: error.message, ...(error.conflicts ? { conflicts: error.conflicts } : {}) } });
      } else {
        send(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
      }
    }
  });
}
