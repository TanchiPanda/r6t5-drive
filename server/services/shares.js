// P3 分享业务逻辑。
// 提取码明文绝不落库、不进日志；库内只存 PBKDF2 派生值（salt + hash）。
import crypto from 'node:crypto';
import { db } from '../db.js';
import { nowIso, genId, toInt } from '../lib/format.js';
import { normalizeLogicalPath, basenameOf } from '../lib/paths.js';
import {
  badRequest, forbidden, conflict,
  shareNotFound, shareExpired, shareRevoked, shareExceeded,
  shareCodeInvalid,
} from '../lib/errors.js';
import { getNodeByPath, listChildren, getUserByEmail } from './nodes.js';
import { resolveStorage } from './bindings.js';
import { getDriver, driverCaps } from './storage/driver.js';
import { recordTraffic } from './traffic.js';
import { writeAudit } from './audit.js';
import { getSecret, signPayload, verifyToken, parseCookies } from '../lib/session.js';

const PBKDF2_ITER = 100_000;
const PBKDF2_DIGEST = 'sha512';
const PBKDF2_SALT_LEN = 16;
const CODE_MIN = 4;
const CODE_MAX = 16;
const CODE_RE = /^[A-Za-z0-9]+$/;
const MAX_ACTIVE_PER_PATH = 20;
const MAX_DOWNLOADS_CAP = 100_000;

// ---- 提取码派生 ----
function hashCode(code, salt) {
  const hash = crypto.pbkdf2Sync(String(code), salt, PBKDF2_ITER, 32, PBKDF2_DIGEST);
  return hash.toString('hex');
}

function verifyCode(code, row) {
  if (!row.codeHash || !row.codeSalt) return false;
  const expected = Buffer.from(row.codeHash, 'hex');
  const actual = crypto.pbkdf2Sync(String(code), Buffer.from(row.codeSalt, 'hex'), PBKDF2_ITER, expected.length, PBKDF2_DIGEST);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---- token ----
function genToken() {
  return crypto.randomBytes(16).toString('base64url').replace(/=+$/, '');
}

function uniqueToken() {
  for (let i = 0; i < 3; i += 1) {
    const t = genToken();
    const hit = db.prepare('SELECT id FROM shares WHERE token = ?').get(t);
    if (!hit) return t;
  }
  // 极小概率冲突：退化为更长随机串（仍 urlsafe base64）
  return crypto.randomBytes(24).toString('base64url').replace(/=+$/, '');
}

// ---- 有效期解析 ----
function parseExpiresAt(expiresIn) {
  if (expiresIn == null || expiresIn === '' || expiresIn === 'permanent') return null;
  if (typeof expiresIn !== 'string') {
    throw badRequest('invalid_input', 'expiresIn 类型非法', { field: 'expiresIn' });
  }
  const presets = { '1d': 1, '7d': 7, '30d': 30 };
  if (expiresIn in presets) {
    return new Date(Date.now() + presets[expiresIn] * 86400_000).toISOString();
  }
  // ISO8601 字符串
  const t = Date.parse(expiresIn);
  if (Number.isNaN(t)) throw badRequest('invalid_input', 'expiresIn 不是合法的时长或 ISO 时间', { field: 'expiresIn' });
  return new Date(t).toISOString();
}

function codeCookieName(token) {
  return `r6t5_share_${String(token).slice(0, 8)}`;
}

export { codeCookieName };

// ---- 状态计算（UTC 比较）----
export function computeStatus(row, now = Date.now()) {
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt && Date.parse(row.expiresAt) <= now) return 'expired';
  const max = row.maxDownloads == null ? null : Number(row.maxDownloads);
  if (max != null && Number(row.downloadCount || 0) >= max) return 'exhausted';
  return 'active';
}

// ---- 序列化（绝不带出 codeHash/codeSalt / 明文）----
function publicItem(row, { includeEmail = false } = {}) {
  const status = computeStatus(row);
  const out = {
    id: row.id,
    token: row.token,
    url: `/s/${row.token}`,
    name: row.name,
    path: row.path,
    isDir: !!row.isDir,
    expiresAt: row.expiresAt || null,
    maxDownloads: row.maxDownloads == null ? null : Number(row.maxDownloads),
    downloadCount: Number(row.downloadCount || 0),
    allowPreview: !!row.allowPreview,
    paidDownload: !!row.paidDownload,
    pricePoints: row.pricePoints == null ? null : Number(row.pricePoints),
    hasCode: !!row.codeHash,
    createdAt: row.createdAt,
    status,
  };
  if (includeEmail) out.email = row.email;
  out.revokedAt = row.revokedAt || null;
  return out;
}

// ============ 用户端 ============

/**
 * 创建分享。
 * @param {{email:string, groupId?:string}} user
 * @param {{path:string, expiresIn?:string, code?:string, maxDownloads?:number, allowPreview?:boolean}} body
 */
export function createShare(user, body) {
  const email = String(user.email).toLowerCase();
  const rawPath = String(body?.path || '').trim();
  const logical = normalizeLogicalPath(rawPath, email);
  if (logical === email) throw badRequest('invalid_input', '不能分享用户根目录', { field: 'path' });

  const node = getNodeByPath(logical);
  if (!node) throw badRequest('invalid_input', '路径不存在', { field: 'path' });
  if (String(node.email || '').toLowerCase() !== email) throw forbidden('只能分享本人目录');

  // 同一路径未撤销分享上限
  const activeCount = db.prepare(
    'SELECT COUNT(*) AS n FROM shares WHERE email = ? AND path = ? AND revokedAt IS NULL'
  ).get(email, logical).n;
  if (activeCount >= MAX_ACTIVE_PER_PATH) {
    throw conflict('同一路径未撤销的分享已达上限', { limit: MAX_ACTIVE_PER_PATH, path: logical });
  }

  // 提取码
  let codeHash = null;
  let codeSalt = null;
  const rawCode = body?.code == null ? '' : String(body.code);
  if (rawCode !== '') {
    if (rawCode.length < CODE_MIN || rawCode.length > CODE_MAX || !CODE_RE.test(rawCode)) {
      throw badRequest('invalid_input', '提取码需为 4-16 位字母数字', { field: 'code' });
    }
    const salt = crypto.randomBytes(PBKDF2_SALT_LEN);
    codeSalt = salt.toString('hex');
    codeHash = hashCode(rawCode, salt);
  }

  const expiresAt = parseExpiresAt(body?.expiresIn);

  let maxDownloads = null;
  if (body?.maxDownloads != null && body.maxDownloads !== '') {
    const n = toInt(body.maxDownloads, NaN);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_DOWNLOADS_CAP) {
      throw badRequest('invalid_input', `maxDownloads 需为 1-${MAX_DOWNLOADS_CAP} 的正整数`, { field: 'maxDownloads' });
    }
    maxDownloads = n;
  }

  const allowPreview = body?.allowPreview == null ? true : !!body.allowPreview;

  // P9-C 付费分享：paidDownload=1 时必须有正积分价
  const paidDownload = body?.paidDownload ? 1 : 0;
  let pricePoints = null;
  if (body?.pricePoints != null && body.pricePoints !== '') {
    const p = toInt(body.pricePoints, NaN);
    if (!Number.isFinite(p) || p < 0) {
      throw badRequest('invalid_input', '积分价需为非负整数', { field: 'pricePoints' });
    }
    pricePoints = p;
  }
  if (paidDownload && (!pricePoints || pricePoints <= 0)) {
    throw badRequest('invalid_input', '付费分享必须填写正积分价', { field: 'pricePoints' });
  }

  const token = uniqueToken();
  const id = genId('sh');
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO shares
      (id, token, email, path, name, isDir, codeHash, codeSalt, expiresAt, maxDownloads, downloadCount, allowPreview, paidDownload, pricePoints, revokedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)`
  ).run(
    id, token, email, logical, node.name, node.isDir ? 1 : 0,
    codeHash, codeSalt, expiresAt, maxDownloads, allowPreview ? 1 : 0,
    paidDownload, pricePoints, createdAt,
  );

  writeAudit({ email, action: 'share_create', target: logical, detail: `share:${token}` });

  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
  return publicItem(row);
}

export function listMyShares(email) {
  const rows = db.prepare(
    'SELECT * FROM shares WHERE email = ? ORDER BY createdAt DESC'
  ).all(String(email).toLowerCase());
  return rows.map((r) => publicItem(r));
}

export function getMyShare(id, email) {
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(String(id));
  if (!row || String(row.email).toLowerCase() !== String(email).toLowerCase()) throw shareNotFound();
  return publicItem(row);
}

export function revokeMyShare(id, email) {
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(String(id));
  if (!row || String(row.email).toLowerCase() !== String(email).toLowerCase()) throw shareNotFound();
  if (!row.revokedAt) {
    db.prepare('UPDATE shares SET revokedAt = ? WHERE id = ?').run(nowIso(), row.id);
    writeAudit({ email: String(email).toLowerCase(), action: 'share_revoke', target: row.path, detail: `share:${row.token}` });
  }
  return { ok: true };
}

// ============ 公开访问 ============

/** 加载分享并做基础状态校验（存在/撤销/过期/超次）。返回行；否则抛对应错误。 */
export function loadActiveShare(token) {
  const row = db.prepare('SELECT * FROM shares WHERE token = ?').get(String(token));
  if (!row) throw shareNotFound();
  assertUsable(row);
  return row;
}

function assertUsable(row) {
  if (row.revokedAt) throw shareRevoked();
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) throw shareExpired();
  const max = row.maxDownloads == null ? null : Number(row.maxDownloads);
  if (max != null && Number(row.downloadCount || 0) >= max) throw shareExceeded({ remaining: 0 });
}

/** 是否已通过解锁 cookie（签名校验）。 */
export function isUnlocked(req, row) {
  if (!row.codeHash) return true;
  const cookies = parseCookies(req);
  const token = cookies[codeCookieName(row.token)];
  const payload = verifyToken(token, getSecret(db));
  return !!payload && payload.token === row.token;
}

/** 按分享所有者解析存储策略（带上用户组，便于命中组默认策略）。 */
function resolveForShare(row, logical) {
  const owner = getUserByEmail(row.email);
  return resolveStorage({ email: row.email, logicalPath: logical, user: owner || { email: row.email } });
}

/** 公开 meta：不强制解锁，只标 locked。 */
export function publicMeta(row) {
  const status = computeStatus(row);
  const max = row.maxDownloads == null ? null : Number(row.maxDownloads);
  const remaining = max == null ? null : Math.max(0, max - Number(row.downloadCount || 0));
  return {
    name: row.name,
    isDir: !!row.isDir,
    allowPreview: !!row.allowPreview,
    paidDownload: !!row.paidDownload,
    pricePoints: row.pricePoints == null ? null : Number(row.pricePoints),
    hasCode: !!row.codeHash,
    expiresAt: row.expiresAt || null,
    maxDownloads: row.maxDownloads == null ? null : max,
    downloadCount: Number(row.downloadCount || 0),
    remaining,
    status,
  };
}

// ---- 提取码错误限流（内存态：同 IP+token 连续错 5 次，15 分钟内一律 403）----
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 5;
const failMap = new Map();

function failRecordKey(token, ip) {
  return `${token}|${ip || ''}`;
}

function failsExceeded(token, ip) {
  const rec = failMap.get(failRecordKey(token, ip));
  if (!rec) return false;
  if (Date.now() - rec.at > FAIL_WINDOW_MS) { failMap.delete(failRecordKey(token, ip)); return false; }
  return rec.count >= FAIL_MAX;
}

function recordFail(token, ip) {
  const key = failRecordKey(token, ip);
  const rec = failMap.get(key);
  if (!rec || Date.now() - rec.at > FAIL_WINDOW_MS) failMap.set(key, { count: 1, at: Date.now() });
  else rec.count += 1;
}

function clearFails(token, ip) {
  failMap.delete(failRecordKey(token, ip));
}

/** 校验提取码；成功返回 { ok:true, unlocked:true }，失败抛 shareCodeInvalid。 */
export function unlockShare(row, code, ip) {
  if (failsExceeded(row.token, ip)) throw shareCodeInvalid({ reason: 'too_many_attempts' });
  if (!row.codeHash) return { ok: true, unlocked: true };
  if (!code || typeof code !== 'string' || !verifyCode(code, row)) {
    recordFail(row.token, ip);
    throw shareCodeInvalid();
  }
  clearFails(row.token, ip);
  return { ok: true, unlocked: true };
}

/** 生成解锁 cookie 的 Set-Cookie 条目（由路由层 append 到 res）。 */
export function unlockCookie(row) {
  const secret = getSecret(db);
  const value = signPayload({ token: row.token }, secret);
  const name = codeCookieName(row.token);
  return `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 86400}`;
}

// ---- 目录内路径校验 ----
function resolveSharePath(row, queryPath) {
  if (!row.isDir) {
    // 单文件分享：path 忽略，直接用分享路径
    return row.path;
  }
  const base = row.path;
  const raw = String(queryPath || base).trim();
  const normalized = normalizeLogicalPath(raw, row.email);
  if (normalized !== base && !normalized.startsWith(base + '/')) {
    throw forbidden('路径不在分享目录内');
  }
  return normalized;
}

function crumbsOf(logicalPath) {
  const segs = logicalPath.split('/');
  const crumbs = [];
  let acc = '';
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s;
    crumbs.push({ label: s, path: acc });
  }
  return crumbs;
}

/** 目录列举：本地元数据 ∪ 远端策略列举，按 path 去重。 */
export async function listShareDir(row, queryPath) {
  if (!row.isDir) throw badRequest('invalid_input', '单文件分享不支持目录列举', { field: 'path' });
  const logical = resolveSharePath(row, queryPath);
  const dirNode = getNodeByPath(logical);
  if (dirNode && !dirNode.isDir) throw badRequest('invalid_input', '目标不是目录', { field: 'path' });

  const localItems = dirNode ? listChildren(logical).map((n) => ({
    name: n.name,
    path: n.path,
    type: n.isDir ? 'dir' : 'file',
    sizeBytes: Number(n.sizeBytes || 0),
    mime: n.mime || 'application/octet-stream',
    updatedAt: n.updatedAt,
  })) : [];

  // 远端列举（失败只 warn，返回空）
  let remoteItems = [];
  try {
    const hit = resolveForShare(row, logical);
    if (hit?.strategy && driverCaps(hit.strategy.type).list && hit.strategy.type !== 'volume') {
      const rows = await getDriver(hit.strategy.type).list(hit.strategy, logical);
      remoteItems = Array.isArray(rows) ? rows : [];
    }
  } catch (e) {
    console.warn(`[shares] 远端列举失败：${e.message}`);
    remoteItems = [];
  }

  const seen = new Set(localItems.map((i) => i.path));
  const merged = [...localItems];
  for (const r of remoteItems) {
    if (!r?.path || seen.has(r.path)) continue;
    seen.add(r.path);
    merged.push({
      name: r.name || basenameOf(r.path),
      path: r.path,
      type: r.type === 'dir' ? 'dir' : 'file',
      sizeBytes: Number(r.sizeBytes || 0),
      mime: r.mime || 'application/octet-stream',
      updatedAt: r.updatedAt || null,
    });
  }
  merged.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1));

  return { path: logical, crumbs: crumbsOf(logical), items: merged };
}

/** 解析分享内文件的策略与节点（下载/预览共用）。 */
export function resolveShareFile(row, queryPath) {
  const logical = resolveSharePath(row, queryPath);
  const node = getNodeByPath(logical);
  const hit = resolveForShare(row, logical);
  return { logical, node, hit };
}

/** 下载成功后记账：downloadCount+1、写 share_hits、给创建者记下载流量。 */
export function recordDownloadHit(row, { email, ip, bytes }) {
  db.prepare('UPDATE shares SET downloadCount = downloadCount + 1 WHERE id = ?').run(row.id);
  db.prepare(
    `INSERT INTO share_hits (id, shareId, email, ip, action, at) VALUES (?, ?, ?, ?, 'download', ?)`
  ).run(genId('hit'), row.id, row.email, ip || null, nowIso());
  recordTraffic(row.email, 'download', Number(bytes) || 0);
}

// ============ 管理端 ============

export function adminListShares({ status, email, limit } = {}) {
  const where = [];
  const params = [];
  if (email) { where.push('email = ?'); params.push(String(email).toLowerCase()); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';

  let rows = db.prepare(
    `SELECT * FROM shares ${sqlWhere} ORDER BY createdAt DESC`
  ).all(...params);

  // 状态过滤在内存做（status 是计算字段）；total 与过滤后结果保持一致
  if (status) rows = rows.filter((r) => computeStatus(r) === status);
  const total = rows.length;

  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  rows = rows.slice(0, lim);

  const items = rows.map((r) => {
    const item = publicItem(r, { includeEmail: true });
    item.revokedAt = r.revokedAt || null;
    return item;
  });
  return { items, total };
}

export function adminRevokeShare(id, adminEmail) {
  const row = db.prepare('SELECT * FROM shares WHERE id = ?').get(String(id));
  if (!row) throw shareNotFound();
  if (!row.revokedAt) {
    db.prepare('UPDATE shares SET revokedAt = ? WHERE id = ?').run(nowIso(), row.id);
  }
  writeAudit({
    email: adminEmail || 'admin',
    action: 'share_revoke',
    target: row.path,
    detail: `share:${row.token}`,
  });
  return { ok: true };
}
