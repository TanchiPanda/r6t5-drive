// OAuth 应用 / 客户端凭据服务（P9-D1）。
// 供桌面客户端与第三方接入：授权码换 token + refresh_token 轮换。
//  - clientSecret 只存 PBKDF2(sha256, 120k, 16B salt) 派生值，明文仅创建时返回一次；
//  - access/refresh token 为高熵随机串，库内存 SHA-256 哈希（无 salt，bearer 标准做法）；
//  - 授权码不落库：内存 Map，10 分钟一次性。
import crypto from 'node:crypto';
import { db } from '../../db.js';
import { nowIso, genId } from '../../lib/format.js';
import {
  badRequest, notFound, oauthInvalidClient, oauthInvalidGrant, oauthScopeDenied,
} from '../../lib/errors.js';

export const SCOPES = ['read', 'write'];
const ACCESS_TTL_MS = 2 * 3600 * 1000;
const REFRESH_TTL_MS = 30 * 86400 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const PBKDF2_ITER = 120000;
const PBKDF2_DIGEST = 'sha256';

// ---------- 哈希 ----------

function hashSecret(secret) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.pbkdf2Sync(String(secret), salt, PBKDF2_ITER, 32, PBKDF2_DIGEST).toString('base64url');
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${hash}`;
}

function verifySecret(secret, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  const salt = parts[2];
  const expected = Buffer.from(parts[3], 'base64url');
  const actual = crypto.pbkdf2Sync(String(secret), salt, iter, expected.length, PBKDF2_DIGEST);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function randomToken(bytesLen = 24) {
  return crypto.randomBytes(bytesLen).toString('base64url');
}

// ---------- 校验工具 ----------

function normalizeScopes(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/).filter(Boolean);
  const set = new Set();
  for (const s of arr) {
    const v = String(s).trim();
    if (!SCOPES.includes(v)) throw badRequest('invalid_input', `未知 scope：${v}`, { field: 'scopes', allowed: SCOPES });
    set.add(v);
  }
  if (set.size === 0) set.add('read');
  return [...set].sort();
}

function assertScopeSubset(requested, granted) {
  const g = new Set(granted);
  for (const s of requested) {
    if (!g.has(s)) throw oauthScopeDenied({ requested, granted });
  }
}

function normalizeRedirectUris(input) {
  const arr = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/).filter(Boolean);
  const out = [];
  for (const u of arr) {
    const v = String(u).trim();
    if (!/^https?:\/\//.test(v)) throw badRequest('invalid_input', `redirect_uri 必须是 http(s) 地址：${v}`, { field: 'redirectUris' });
    if (v.includes('#')) throw badRequest('invalid_input', 'redirect_uri 不允许带 fragment（#）', { field: 'redirectUris' });
    out.push(v);
  }
  return out;
}

// ---------- 客户端 CRUD ----------

function rowToClient(row) {
  if (!row) return null;
  let scopes = ['read'];
  let redirectUris = [];
  try { scopes = JSON.parse(row.scopes || '["read"]'); } catch { /* 兜底 */ }
  try { redirectUris = JSON.parse(row.redirectUris || '[]'); } catch { /* 兜底 */ }
  return {
    id: row.id,
    clientId: row.clientId,
    name: row.name,
    description: row.description || '',
    scopes,
    redirectUris,
    enabled: !!row.enabled,
    secretSet: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt || null,
  };
}

export function listClients() {
  const rows = db.prepare('SELECT * FROM oauth_clients ORDER BY createdAt ASC').all();
  return rows.map(rowToClient);
}

export function getClient(id) {
  return rowToClient(db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id));
}

export function getClientByClientId(clientId) {
  return rowToClient(db.prepare('SELECT * FROM oauth_clients WHERE clientId = ?').get(String(clientId || '')));
}

function rawClientByClientId(clientId) {
  return db.prepare('SELECT * FROM oauth_clients WHERE clientId = ?').get(String(clientId || ''));
}

export function createClient({ name, description, scopes, redirectUris, enabled }) {
  const displayName = String(name || '').trim();
  if (displayName.length < 1 || displayName.length > 64) {
    throw badRequest('invalid_input', '应用名称长度需为 1–64 字', { field: 'name' });
  }
  const scopeList = normalizeScopes(scopes);
  const uris = normalizeRedirectUris(redirectUris);
  const id = genId('oc');
  const clientId = `r6t5oc_${randomToken(16)}`;
  const clientSecret = `r6t5ocs_${randomToken(24)}`;
  const now = nowIso();
  db.prepare(
    `INSERT INTO oauth_clients (id, clientId, clientSecretHash, name, description, scopes, redirectUris, enabled, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, clientId, hashSecret(clientSecret), displayName, String(description || '').trim(),
    JSON.stringify(scopeList), JSON.stringify(uris), enabled === false ? 0 : 1, now, now
  );
  return { item: getClient(id), clientSecret };
}

export function updateClient(id, fields) {
  const row = db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id);
  if (!row) throw notFound('OAuth 应用不存在');
  const patch = {};
  if (fields.name != null) {
    const n = String(fields.name).trim();
    if (n.length < 1 || n.length > 64) throw badRequest('invalid_input', '应用名称长度需为 1–64 字', { field: 'name' });
    patch.name = n;
  }
  if (fields.description != null) patch.description = String(fields.description).trim();
  if (fields.scopes != null) patch.scopes = JSON.stringify(normalizeScopes(fields.scopes));
  if (fields.redirectUris != null) patch.redirectUris = JSON.stringify(normalizeRedirectUris(fields.redirectUris));
  if (fields.enabled != null) patch.enabled = fields.enabled ? 1 : 0;

  let rotatedSecret = null;
  if (fields.rotateSecret === true) {
    rotatedSecret = `r6t5ocs_${randomToken(24)}`;
    patch.clientSecretHash = hashSecret(rotatedSecret);
  }
  patch.updatedAt = nowIso();

  const keys = Object.keys(patch);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE oauth_clients SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k]), id);
  }
  return { item: getClient(id), clientSecret: rotatedSecret };
}

export function deleteClient(id) {
  const row = db.prepare('SELECT * FROM oauth_clients WHERE id = ?').get(id);
  if (!row) throw notFound('OAuth 应用不存在');
  db.prepare('UPDATE oauth_tokens SET revokedAt = ? WHERE clientId = ? AND revokedAt IS NULL').run(nowIso(), row.clientId);
  db.prepare('DELETE FROM oauth_clients WHERE id = ?').run(id);
  return { ok: true };
}

/** 校验 client_id + client_secret（post 或 basic 同源）。成功返回 client 行（含 hash）。 */
export function authenticateClient(clientId, clientSecret) {
  const row = rawClientByClientId(clientId);
  if (!row || !verifySecret(String(clientSecret || ''), row.clientSecretHash)) {
    throw oauthInvalidClient('client_id 或 client_secret 无效');
  }
  if (row.enabled !== 1) throw oauthInvalidClient('该 OAuth 应用已被禁用');
  return row;
}

// ---------- 授权码（内存，10 分钟一次性） ----------

const codes = new Map();

export function issueCode({ clientId, email, scopes, redirectUri }) {
  const code = randomToken(24);
  codes.set(code, {
    clientId, email, scopes, redirectUri,
    expiresAt: Date.now() + CODE_TTL_MS, used: false,
  });
  return code;
}

export function consumeCode(code, clientId, redirectUri) {
  const rec = codes.get(String(code || ''));
  if (!rec || rec.used || Date.now() > rec.expiresAt) return null;
  if (rec.clientId !== clientId || rec.redirectUri !== redirectUri) return null;
  rec.used = true;
  codes.delete(String(code || ''));
  return { email: rec.email, scopes: rec.scopes };
}

// ---------- 令牌 ----------

function rowToToken(row) {
  if (!row) return null;
  let scopes = ['read'];
  try { scopes = JSON.parse(row.scopes || '["read"]'); } catch { /* 兜底 */ }
  return {
    id: row.id,
    clientId: row.clientId,
    email: row.email,
    scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
    revokedAt: row.revokedAt,
  };
}

export function issueTokens({ clientId, email, scopes }) {
  const accessToken = `r6t5at_${randomToken(24)}`;
  const refreshToken = `r6t5rt_${randomToken(24)}`;
  const now = Date.now();
  const expiresAt = new Date(now + ACCESS_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(now + REFRESH_TTL_MS).toISOString();
  const id = genId('ot');
  db.prepare(
    `INSERT INTO oauth_tokens (id, clientId, email, scopes, accessHash, refreshHash, expiresAt, refreshExpiresAt, revokedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(
    id, clientId, email, JSON.stringify(scopes), sha256Hex(accessToken), sha256Hex(refreshToken),
    expiresAt, refreshExpiresAt, new Date(now).toISOString()
  );
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TTL_MS / 1000),
    expiresAt,
    refreshExpiresAt,
  };
}

function activeTokenByAccessHash(hash) {
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE accessHash = ?').get(hash);
  if (!row || row.revokedAt) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  const client = db.prepare('SELECT enabled FROM oauth_clients WHERE clientId = ?').get(row.clientId);
  if (!client || client.enabled !== 1) return null;
  return row;
}

/** Bearer 校验：返回 { email, clientId, scopes, clientName } 或 null。 */
export function verifyAccessToken(token) {
  if (!token || typeof token !== 'string') return null;
  const row = activeTokenByAccessHash(sha256Hex(token));
  if (!row) return null;
  const client = db.prepare('SELECT name FROM oauth_clients WHERE clientId = ?').get(row.clientId);
  return {
    email: row.email,
    clientId: row.clientId,
    clientName: client?.name || row.clientId,
    scopes: rowToToken(row).scopes,
  };
}

export function revokeAccessToken(token) {
  const hash = sha256Hex(String(token || ''));
  db.prepare('UPDATE oauth_tokens SET revokedAt = ? WHERE accessHash = ? AND revokedAt IS NULL').run(nowIso(), hash);
  return { ok: true };
}

export function revokeRefreshToken(token) {
  const hash = sha256Hex(String(token || ''));
  db.prepare('UPDATE oauth_tokens SET revokedAt = ? WHERE refreshHash = ? AND revokedAt IS NULL').run(nowIso(), hash);
  return { ok: true };
}

/** refresh_token 轮换：校验通过后撤销旧对，签发新对。 */
export function rotateRefreshToken(refreshToken) {
  const hash = sha256Hex(String(refreshToken || ''));
  const row = db.prepare('SELECT * FROM oauth_tokens WHERE refreshHash = ?').get(hash);
  if (!row || row.revokedAt) throw oauthInvalidGrant('refresh_token 无效或已撤销');
  if (new Date(row.refreshExpiresAt).getTime() < Date.now()) throw oauthInvalidGrant('refresh_token 已过期');
  const client = db.prepare('SELECT enabled, scopes FROM oauth_clients WHERE clientId = ?').get(row.clientId);
  if (!client || client.enabled !== 1) throw oauthInvalidClient('该 OAuth 应用已被禁用');

  db.prepare('UPDATE oauth_tokens SET revokedAt = ? WHERE id = ?').run(nowIso(), row.id);
  const grantedScopes = rowToToken(row).scopes;
  return issueTokens({ clientId: row.clientId, email: row.email, scopes: grantedScopes });
}

export function listTokens(clientId) {
  const rows = db.prepare('SELECT * FROM oauth_tokens WHERE clientId = ? ORDER BY createdAt DESC').all(clientId);
  return rows.map(rowToToken);
}

export { assertScopeSubset, normalizeScopes, normalizeRedirectUris };
