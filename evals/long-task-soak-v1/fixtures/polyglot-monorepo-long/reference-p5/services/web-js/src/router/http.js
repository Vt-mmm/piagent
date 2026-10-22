// Responses and the error type every handler throws.
import { LEGACY_VERSION } from './data.js';
import { msg } from './messages.js';

export class LegacyError extends Error {
  constructor(status, key, args = []) {
    super(key);
    this.status = status;
    this.key = key;
    this.args = args;
  }

  toBody(lang) {
    return { error: { code: this.key.toUpperCase(), message: msg(lang, this.key, this.args) } };
  }
}

export function fail(status, key, ...args) {
  throw new LegacyError(status, key, args);
}

export function respond(status, body, extraHeaders) {
  const headers = { 'content-type': 'application/json; charset=utf-8', 'x-legacy-version': LEGACY_VERSION, ...(extraHeaders || {}) };
  return { status, headers, body };
}

export function respondText(status, text, contentType) {
  return { status, headers: { 'content-type': contentType, 'x-legacy-version': LEGACY_VERSION }, body: text };
}
