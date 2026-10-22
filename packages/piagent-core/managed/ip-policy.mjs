import net from 'node:net';

// Whether an address is this machine, a private network or not routable on
// the internet (IANA special-purpose registries). One classifier for every
// outbound check (web-fetch, package-proxy). IPv6 forms that carry an IPv4
// address (mapped, compatible, translated, NAT64, 6to4), dotted or hex, are
// judged by that IPv4 address. Teredo, IPv6 outside 2000::/3, and anything
// that does not parse count as private: fail closed.
const V4_RANGES = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].map(([base, bits]) => [v4Number(base), 2 ** (32 - bits)]);

function v4Number(text) {
  const parts = String(text).split('.');
  if (parts.length !== 4 || !parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)) return null;
  return parts.reduce((value, part) => value * 256 + Number(part), 0);
}
const v4Private = value => V4_RANGES.some(([base, size]) => value >= base && value < base + size);

// Eight 16-bit groups, or null: "::" expanded, a dotted IPv4 tail and a zone id accepted.
function v6Groups(text) {
  let value = String(text).toLowerCase().replace(/%[^%]*$/, '');
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (tail) {
    const v4 = v4Number(tail[1]); if (v4 === null) return null;
    value = value.slice(0, -tail[1].length) + `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [], rest = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  return groups.every(group => /^[0-9a-f]{1,4}$/.test(group)) ? groups.map(group => parseInt(group, 16)) : null;
}

export function privateAddress(address) {
  if (net.isIPv4(String(address))) { const v4 = v4Number(address); return v4 === null || v4Private(v4); }
  const g = v6Groups(address);
  if (!g) return true;
  const zero = (from, to) => g.slice(from, to).every(group => group === 0);
  const v4 = (high, low) => v4Private(high * 0x10000 + low);
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]); // ::ffff:0:0/96 mapped, ::/96 compatible (with :: and ::1)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]); // ::ffff:0:0:0/96 translated
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) ? v4(g[6], g[7]) : true; // NAT64 64:ff9b::/96; 64:ff9b:1::/48 local
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4
  if ((g[0] & 0xe000) !== 0x2000) return true; // not global unicast: 100::/64, fc00::/7, fe80::/10, fec0::/10, ff00::/8, ...
  return g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || (g[1] === 2 && g[2] === 0)) // Teredo, documentation, benchmarking
    || (g[0] & 0xfff0) === 0x3ff0; // 3fff::/20 documentation
}
