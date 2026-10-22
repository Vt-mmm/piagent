// Shared formatting helpers of the report engine (one copy of each).
export const CURRENCY = 'VND';

export function fmtMoney(n) {
  var s = String(Math.round(n));
  var neg = s.charAt(0) === '-';
  if (neg) s = s.substring(1);
  var out = '';
  while (s.length > 3) {
    out = '.' + s.substring(s.length - 3) + out;
    s = s.substring(0, s.length - 3);
  }
  return (neg ? '-' : '') + s + out;
}

export function padR(s, n) {
  s = String(s);
  if (s.length > n) return s.substring(0, n - 1) + '~';
  while (s.length < n) s += ' ';
  return s;
}

export function padL(s, n) {
  s = String(s);
  if (s.length > n) return s.substring(0, n - 1) + '~';
  while (s.length < n) s = ' ' + s;
  return s;
}

export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function daysBetween(a, b) {
  return Math.floor((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function addDays(d, n) {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().substring(0, 10);
}

export function fmtPct(x) {
  return (Math.round(x * 1000) / 10).toFixed(1) + '%';
}

export function csvPct(x) {
  return (Math.round(x * 1000) / 10).toFixed(1).replace('.', ',');
}

export function csvCell(v) {
  v = v == null ? '' : String(v);
  if (v.indexOf(';') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}

export function mdCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

export function rep(ch, n) {
  var s = '';
  for (var i = 0; i < n; i++) s += ch;
  return s;
}

export function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
