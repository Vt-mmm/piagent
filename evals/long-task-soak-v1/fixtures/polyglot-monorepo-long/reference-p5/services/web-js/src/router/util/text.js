import { DIACRITICS } from '../data.js';

export const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function padLeft(text, width, fill = ' ') {
  let out = String(text);
  while (out.length < width) out = fill + out;
  return out;
}

export function groupDigits(digits, sep) {
  let out = '';
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    out = digits.charAt(i) + out;
    count++;
    if (count % 3 === 0 && i > 0) out = sep + out;
  }
  return out;
}

export function removeDiacritics(text) {
  let out = '';
  for (const ch of text.split('')) out += hasOwn(DIACRITICS, ch) ? DIACRITICS[ch] : ch;
  return out;
}

// Lower-case ASCII letters and digits joined by single dashes.
export function slugify(text) {
  const plain = removeDiacritics(String(text)).toLowerCase();
  let out = '';
  let dash = false;
  for (const ch of plain.split('')) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
      out += ch;
      dash = false;
    } else if (!dash && out.length > 0) {
      out += '-';
      dash = true;
    }
  }
  return out.endsWith('-') ? out.slice(0, -1) : out;
}

export function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.includes(';') || text.includes('"') || text.includes('\n')) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}
