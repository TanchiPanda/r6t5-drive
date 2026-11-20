import crypto from 'node:crypto';
import { getSetting, setSetting } from '../db.js';

/**
 * 账号来源（站点级设置，存 settings.userSource）。
 * - `supabase`（缺省）：登录 / 建号走 Supabase，保持现网行为。
 * - `volume`：本地数据卷账号体系，密码以 scrypt 落 users.passwordHash。
 *
 * 其它模块只通过本文件读写，不要在路由/服务里散写 SQL。
 */

// 2026-11：Supabase 托管账号模式已下线，账号体系固定为数据卷本地账号。
export const SOURCES = ['volume'];
export const DEFAULT_SOURCE = 'volume';
export const SOURCE_SETTING_KEY = 'userSource';
export const SOURCE_CHANGED_AT_KEY = 'userSourceChangedAt';

export function getUserSource() {
  return 'volume';
}

export function setUserSource(src) {
  if (src !== 'volume') throw new Error('Supabase 托管账号模式已下线，仅支持数据卷账号');
  setSetting(SOURCE_SETTING_KEY, 'volume');
}

export function isVolumeSource() {
  return getUserSource() === 'volume';
}

export function getSwitchedAt() {
  return getSetting(SOURCE_CHANGED_AT_KEY, null);
}

export function setSwitchedAt(iso) {
  setSetting(SOURCE_CHANGED_AT_KEY, iso);
}

// ---- 本地账号 scrypt 密码（volume 模式）----
// 格式：scrypt$N$r$p$saltB64$hashB64；salt 16B，hash 64B；N=16384 r=8 p=1
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };
const SALT_BYTES = 16;
const HASH_BYTES = 64;

export function hashLocalPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.scryptSync(String(password), salt, HASH_BYTES, SCRYPT_OPTS);
  return [
    'scrypt',
    SCRYPT_OPTS.N,
    SCRYPT_OPTS.r,
    SCRYPT_OPTS.p,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

export function verifyLocalPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nRaw, rRaw, pRaw, saltB64, hashB64] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (![N, r, p].every(Number.isFinite)) return false;
  let salt, expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false;
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}
