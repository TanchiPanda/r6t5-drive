import { Router } from 'express';
import { db } from '../db.js';
import { genId, nowIso } from '../lib/format.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';
import { parseSizeToBytes, assertMaxSqliteInt, toByteString, formatSize } from '../lib/bytes.js';

const router = Router();

function userCount(groupId) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE groupId = ?').get(groupId).n;
}

// better-sqlite3 读回 INTEGER 会截断为 Number（>2^53 失真），因此限额三列在 SELECT 时
// 用 CAST(... AS TEXT) 取十进制字符串；serialize 统一按字符串/整数兼容处理。
const GROUP_LIMIT_COLS = ['spaceLimitBytes', 'maxFileSizeBytes', 'traffic7dLimitBytes'];
const GROUP_SELECT = `
  SELECT *,
    CAST(spaceLimitBytes AS TEXT) AS spaceLimitBytes,
    CAST(maxFileSizeBytes AS TEXT) AS maxFileSizeBytes,
    CAST(traffic7dLimitBytes AS TEXT) AS traffic7dLimitBytes
  FROM groups`;

function serialize(g) {
  const spaceLimitBytes = toByteString(g.spaceLimitBytes);
  const maxFileSizeBytes = toByteString(g.maxFileSizeBytes);
  const traffic7dLimitBytes = toByteString(g.traffic7dLimitBytes);
  return {
    id: g.id,
    name: g.name,
    spaceLimitBytes,
    maxFileSizeBytes,
    traffic7dLimitBytes,
    spaceLimitText: formatSize(g.spaceLimitBytes),
    maxFileSizeText: formatSize(g.maxFileSizeBytes),
    traffic7dLimitText: formatSize(g.traffic7dLimitBytes),
    isDefault: !!g.isDefault,
    defaultStrategyId: g.defaultStrategyId || null,
    allowSelfSignup: !!g.allow_self_signup,
    isSudo: !!g.is_sudo,
    userCount: userCount(g.id),
    createdAt: g.createdAt,
  };
}

function validateStrategyId(id) {
  if (id == null || id === '') return null;
  const s = db.prepare('SELECT id FROM storage_strategies WHERE id = ?').get(id);
  if (!s) throw badRequest('invalid_input', '默认存储策略不存在', { field: 'defaultStrategyId' });
  return id;
}

/**
 * 解析一个限额字段，两种写法二选一（都给则以对象写法为准）：
 *  - `spaceLimitBytes` / `maxFileSizeBytes` / `traffic7dLimitBytes`：数字或十进制字符串（旧客户端兼容）
 *  - `spaceLimit: { value, unit }` / `maxFileSize: { value, unit }` / `traffic7dLimit: { value, unit }`
 * 返回 BigInt；校验 ≥1 且 ≤ MAX_SQLITE_INT。
 */
function parseLimit(body, bytesKey, objectKey) {
  const obj = body[objectKey];
  if (obj && typeof obj === 'object') {
    const bytes = parseSizeToBytes(obj.value, obj.unit);
    return assertMaxSqliteInt(bytes, objectKey);
  }
  const raw = body[bytesKey];
  if (raw == null || raw === '') throw badRequest('invalid_input', `${bytesKey} 必须为大于 0 的整数`, { field: bytesKey });
  const bytes = parseSizeToBytes(raw, 'B');
  return assertMaxSqliteInt(bytes, bytesKey);
}

// PATCH 未显式提供的限额键回退到旧值（旧值已是十进制字符串），避免被对象键误覆盖
function patchLimits(body, group) {
  const out = {};
  if (body.spaceLimitBytes !== undefined) out.spaceLimitBytes = body.spaceLimitBytes;
  else if (body.spaceLimit !== undefined) out.spaceLimit = body.spaceLimit;
  else out.spaceLimitBytes = group.spaceLimitBytes;

  if (body.maxFileSizeBytes !== undefined) out.maxFileSizeBytes = body.maxFileSizeBytes;
  else if (body.maxFileSize !== undefined) out.maxFileSize = body.maxFileSize;
  else out.maxFileSizeBytes = group.maxFileSizeBytes;

  if (body.traffic7dLimitBytes !== undefined) out.traffic7dLimitBytes = body.traffic7dLimitBytes;
  else if (body.traffic7dLimit !== undefined) out.traffic7dLimit = body.traffic7dLimit;
  else out.traffic7dLimitBytes = group.traffic7dLimitBytes;

  return validateLimits(out);
}

function validateLimits(body) {
  return {
    spaceLimitBytes: parseLimit(body, 'spaceLimitBytes', 'spaceLimit'),
    maxFileSizeBytes: parseLimit(body, 'maxFileSizeBytes', 'maxFileSize'),
    traffic7dLimitBytes: parseLimit(body, 'traffic7dLimitBytes', 'traffic7dLimit'),
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare(`${GROUP_SELECT} ORDER BY createdAt ASC`).all();
  res.json({ items: rows.map(serialize) });
});

router.post('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const { name, isDefault } = body;
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 32) {
      throw badRequest('invalid_input', '组名长度需为 1–32 字', { field: 'name' });
    }
    const dup = db.prepare('SELECT id FROM groups WHERE name = ?').get(name.trim());
    if (dup) throw conflict('组名已存在', { field: 'name' });
    const limits = validateLimits(body);
    const defaultStrategyId = validateStrategyId(body.defaultStrategyId);
    const allowSelfSignup = body.allowSelfSignup === true ? 1 : 0;
    const isSudo = body.isSudo === true ? 1 : 0;
    const id = genId('g');
    const ts = nowIso();
    const tx = db.transaction(() => {
      if (isDefault) db.prepare('UPDATE groups SET isDefault = 0').run();
      db.prepare(
        `INSERT INTO groups (id, name, spaceLimitBytes, maxFileSizeBytes, traffic7dLimitBytes, isDefault, defaultStrategyId, allow_self_signup, is_sudo, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name.trim(), limits.spaceLimitBytes.toString(), limits.maxFileSizeBytes.toString(), limits.traffic7dLimitBytes.toString(), isDefault ? 1 : 0, defaultStrategyId, allowSelfSignup, isSudo, ts);
    });
    tx();
    const item = serialize(db.prepare(`${GROUP_SELECT} WHERE id = ?`).get(id));
    writeAudit({ email: 'admin', action: 'group_create', target: item.name });
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const g = db.prepare(`${GROUP_SELECT} WHERE id = ?`).get(req.params.id);
    if (!g) throw notFound('用户组不存在');
    const body = req.body || {};

    const limits = patchLimits(body, g);

    const name = body.name != null ? String(body.name).trim() : g.name;
    if (name.length < 1 || name.length > 32) throw badRequest('invalid_input', '组名长度需为 1–32 字', { field: 'name' });
    const dup = db.prepare('SELECT id FROM groups WHERE name = ? AND id != ?').get(name, g.id);
    if (dup) throw conflict('组名已存在', { field: 'name' });

    let defaultStrategyId = g.defaultStrategyId || null;
    if (body.defaultStrategyId !== undefined) {
      defaultStrategyId = validateStrategyId(body.defaultStrategyId);
    }

    const allowSelfSignup = body.allowSelfSignup === undefined ? g.allow_self_signup : (body.allowSelfSignup === true ? 1 : 0);
    const isSudo = body.isSudo === undefined ? g.is_sudo : (body.isSudo === true ? 1 : 0);

    const sudoChanged = Number(isSudo) !== Number(g.is_sudo);
    const signupChanged = Number(allowSelfSignup) !== Number(g.allow_self_signup);

    const tx = db.transaction(() => {
      if (body.isDefault === true) db.prepare('UPDATE groups SET isDefault = 0').run();
      db.prepare(
        `UPDATE groups SET name = ?, spaceLimitBytes = ?, maxFileSizeBytes = ?, traffic7dLimitBytes = ?, isDefault = ?, defaultStrategyId = ?, allow_self_signup = ?, is_sudo = ?
         WHERE id = ?`
      ).run(name, limits.spaceLimitBytes.toString(), limits.maxFileSizeBytes.toString(), limits.traffic7dLimitBytes.toString(),
        body.isDefault === true ? 1 : g.isDefault, defaultStrategyId, allowSelfSignup, isSudo, g.id);
    });
    tx();

    // 审计：sudo / signup 开关变化单独记录（detail 标注 on/off）
    if (sudoChanged || signupChanged) {
      const parts = [];
      if (sudoChanged) parts.push(`sudo:${isSudo === 1 ? 'on' : 'off'}`);
      if (signupChanged) parts.push(`signup:${allowSelfSignup === 1 ? 'on' : 'off'}`);
      writeAudit({ email: 'admin', action: 'group_update', target: g.name, detail: parts.join(',') });
    }

    res.json({ item: serialize(db.prepare(`${GROUP_SELECT} WHERE id = ?`).get(g.id)) });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const g = db.prepare(`${GROUP_SELECT} WHERE id = ?`).get(req.params.id);
    if (!g) throw notFound('用户组不存在');
    const uc = userCount(g.id);
    if (uc > 0) throw conflict('该组下仍有用户', { userCount: uc });
    if (g.isDefault) throw conflict('默认组不允许删除');
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
