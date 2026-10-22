// Notes on an account (validated and echoed back; the admin UI stores them).
import { MAX_NOTE_LENGTH } from '../data.js';
import { fail, respond } from '../http.js';

const ACCOUNT_ID_RE = /^A-\d{3,6}$/;
const trim = text => text.replace(/^\s+|\s+$/g, '');

export function handleAccountNote(accountId, body) {
  if (!ACCOUNT_ID_RE.test(accountId)) fail(400, 'bad_account', accountId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'bad_body');
  const text = typeof body.text === 'string' ? trim(body.text) : '';
  if (text.length === 0) fail(400, 'note_required');
  if (text.length > MAX_NOTE_LENGTH) fail(400, 'note_too_long', MAX_NOTE_LENGTH);
  const tags = [];
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags)) fail(400, 'bad_tags');
    for (const raw of body.tags) {
      if (typeof raw !== 'string') fail(400, 'bad_tags');
      const tag = trim(raw.toLowerCase());
      if (tag && tags.indexOf(tag) < 0) tags.push(tag);
    }
  }
  tags.sort();
  return respond(201, {
    account_id: accountId,
    text,
    tags,
    words: text.split(/\s+/).length,
    pinned: body.pinned === true || body.pinned === 'true',
    preview: text.length > 40 ? text.substring(0, 37) + '...' : text,
  }, { location: '/v1/accounts/' + accountId + '/notes/draft' });
}
