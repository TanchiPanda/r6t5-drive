export function nowIso() {
  return new Date().toISOString();
}

export function isoPlusDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 10) return '…';
  return `${s.slice(0, 7)}…${s.slice(-3)}`;
}

export function truncateIp(ip) {
  if (!ip) return '';
  const v6 = ip.includes(':');
  if (v6) {
    const parts = ip.split(':');
    return parts.slice(0, 2).join(':') + '::x';
  }
  const parts = ip.split('.');
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}.x.x`;
  return 'x.x.x.x';
}

export function toInt(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function genId(prefix) {
  return `${prefix}_${cryptoRandom(10)}`;
}

function cryptoRandom(len) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = requireRandom(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function requireRandom(len) {
  const { randomBytes } = globalThis.crypto || {};
  if (randomBytes) return randomBytes(len);
  const arr = new Uint8Array(len);
  globalThis.crypto.getRandomValues(arr);
  return arr;
}
