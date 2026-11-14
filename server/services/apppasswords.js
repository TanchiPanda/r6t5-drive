// 应用密码（P5：WebDAV Basic Auth 凭据）。
// 明文只在创建时随响应返回一次，库内仅存 PBKDF2(sha512, 10 万次, 16 字节 salt) 的 hex。
// 任何列表 / 视图 / 日志都不回显派生值或明文。
import crypto from 'node:crypto';
import { db } from '../db.js';
import { nowIso, genId } from '../lib/format.js';
import {
  badRequest, conflict, appPasswordNotFound, appPasswordInvalid,
} from '../lib/errors.js';

const PBKDF2_ITER = 100000;
const PBKDF2_DIGEST = 'sha512';
const SALT_LEN = 16;
const HASH_LEN = 32;
const MAX_ACTIVE = 10;
const NAME_MAX = 32;

// base32 风格字符集（仅字母数字，去掉易混字符 0/O、1/l/I）
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function randomToken(segmentLen) {
  const bytes = crypto.randomBytes(segmentLen);
  let out = '';
  for (let i = 0; i < segmentLen; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 形如 r6t5-XXXX-XXXX-XXXX（共 18 位随机 base32 风格字符） */
export function generateAppPassword() {
  const segments = [randomToken(6), randomToken(6), randomToken(6)];
  return `r6t5-${segments.join('-')}`;
}

function derive(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, PBKDF2_ITER, HASH_LEN, PBKDF2_DIGEST).toString('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** 校验名称：1–32 字符；允许同名重复（同用户内仅作提示，不禁止） */
function validateName(name) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw badRequest('invalid_input', '名称不能为空', { field: 'name' });
  }
  const n = name.trim();
  if (n.length > NAME_MAX) throw badRequest('invalid_input', `名称长度需为 1–${NAME_MAX} 字`, { field: 'name' });
  if (/[\u0000-\u001f]/.test(n)) throw badRequest('invalid_input', '名称包含控制字符', { field: 'name' });
  return n;
}

/** 未撤销（active）数量 */
export function activeCount(email) {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM app_passwords WHERE email = ? AND revokedAt IS NULL'
  ).get(normalizeEmail(email));
  return Number(row.n || 0);
}

/** 创建一条应用密码；返回 { item, password }，password 为仅本次可见的明文 */
export function createAppPassword({ email, name }) {
  const mail = normalizeEmail(email);
  const displayName = validateName(name);

  if (activeCount(mail) >= MAX_ACTIVE) {
    throw conflict(`每人最多 ${MAX_ACTIVE} 个未撤销的应用密码，请先撤销不再使用的`, { limit: MAX_ACTIVE });
  }

  const plain = generateAppPassword();
  const salt = crypto.randomBytes(SALT_LEN).toString('hex');
  const hash = derive(plain, salt);
  const id = genId('ap');
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO app_passwords (id, email, name, hash, salt, createdAt, lastUsedAt, revokedAt)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).run(id, mail, displayName, hash, salt, createdAt);

  return { item: { id, name: displayName, createdAt }, password: plain };
}

/** 列表视图：永不返回 password / hash / salt */
export function listAppPasswords(email) {
  const rows = db.prepare(
    `SELECT id, email, name, createdAt, lastUsedAt, revokedAt
       FROM app_passwords WHERE email = ? ORDER BY createdAt DESC`
  ).all(normalizeEmail(email));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  }));
}

function rowOwned(row, email) {
  return row && row.email === normalizeEmail(email);
}

/** 撤销（软删），幂等；只能操作自己的，否则 404 */
export function revokeAppPassword({ id, email }) {
  const mail = normalizeEmail(email);
  const row = db.prepare('SELECT * FROM app_passwords WHERE id = ?').get(String(id || ''));
  if (!rowOwned(row, mail)) throw appPasswordNotFound();
  if (!row.revokedAt) {
    db.prepare('UPDATE app_passwords SET revokedAt = ? WHERE id = ?').run(nowIso(), row.id);
  }
  return { ok: true };
}

/**
 * 校验 Basic Auth 给出的邮箱 + 应用密码。
 * 成功返回用户邮箱（规范化）；失败抛 401 app_password_invalid。
 * 命中后刷新 lastUsedAt；撤销 / 禁用用户不参与这里判断（用户态由调用方核对）。
 */
export function verifyAppPassword({ email, password }) {
  const mail = normalizeEmail(email);
  if (!mail || typeof password !== 'string' || password.length === 0) throw appPasswordInvalid();

  const rows = db.prepare(
    `SELECT * FROM app_passwords WHERE email = ? AND revokedAt IS NULL`
  ).all(mail);

  let matched = null;
  for (const row of rows) {
    const expected = Buffer.from(row.hash, 'hex');
    const actual = crypto.pbkdf2Sync(String(password), row.salt, PBKDF2_ITER, expected.length, PBKDF2_DIGEST);
    if (expected.length === actual.length && crypto.timingSafeEqual(expected, actual)) {
      matched = row;
      break;
    }
  }
  if (!matched) throw appPasswordInvalid();

  db.prepare('UPDATE app_passwords SET lastUsedAt = ? WHERE id = ?').run(nowIso(), matched.id);
  return mail;
}
