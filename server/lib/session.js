import crypto from 'node:crypto';
import { ENV } from '../config.js';
import { getSetting, setSetting } from '../db.js';

const SID_USER = 'r6t5_sid';
const SID_ADMIN = 'r6t5_admin';

export const COOKIE = { SID_USER, SID_ADMIN };

export function getSecret(db) {
  if (ENV.SESSION_SECRET) return ENV.SESSION_SECRET;
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    setSetting('session_secret', secret);
    console.warn('[warn] 未设置 SESSION_SECRET，已生成随机密钥并落盘；重启后旧会话将失效。');
  }
  return secret;
}

export function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(s) {
  return Buffer.from(s, 'base64url');
}

export function signPayload(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieHeader(name, value, maxAgeSec) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSec}`,
  ];
  return attrs.join('; ');
}

export function setUserCookie(res, db, session) {
  const token = signPayload(session, getSecret(db));
  res.append('Set-Cookie', cookieHeader(SID_USER, token, 7 * 86400));
}

export function setAdminCookie(res, db, session) {
  const token = signPayload(session, getSecret(db));
  res.append('Set-Cookie', cookieHeader(SID_ADMIN, token, 12 * 3600));
}

export function clearCookies(res) {
  res.append('Set-Cookie', `${SID_USER}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.append('Set-Cookie', `${SID_ADMIN}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function readUserSession(req, db) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[SID_USER], getSecret(db));
}

export function readAdminSession(req, db) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[SID_ADMIN], getSecret(db));
}

// ---- 管理员密码 PBKDF2（不落盘明文）----

const PBKDF2_ITER = 120000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITER, 32, 'sha256').toString('base64url');
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'base64url');
  const actual = crypto.pbkdf2Sync(String(password), salt, iter, expected.length, 'sha256');
  return crypto.timingSafeEqual(expected, actual);
}

export function randomPassword(len = 12) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}
