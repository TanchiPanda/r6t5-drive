import { Router } from 'express';
import { db } from '../db.js';
import { genId, nowIso } from '../lib/format.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

function userCount(groupId) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE groupId = ?').get(groupId).n;
}

function serialize(g) {
  return {
    id: g.id,
    name: g.name,
    spaceLimitBytes: Number(g.spaceLimitBytes),
    maxFileSizeBytes: Number(g.maxFileSizeBytes),
    traffic7dLimitBytes: Number(g.traffic7dLimitBytes),
    isDefault: !!g.isDefault,
    userCount: userCount(g.id),
    createdAt: g.createdAt,
  };
}

function validateLimits(body) {
  const out = {};
  for (const k of ['spaceLimitBytes', 'maxFileSizeBytes', 'traffic7dLimitBytes']) {
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v <= 0) throw badRequest('invalid_input', `${k} 必须为大于 0 的整数`, { field: k });
    out[k] = Math.trunc(v);
  }
  return out;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM groups ORDER BY createdAt ASC').all();
  res.json({ items: rows.map(serialize) });
});

router.post('/', (req, res, next) => {
  try {
    const { name, isDefault } = req.body || {};
    if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 32) {
      throw badRequest('invalid_input', '组名长度需为 1–32 字', { field: 'name' });
    }
    const dup = db.prepare('SELECT id FROM groups WHERE name = ?').get(name.trim());
    if (dup) throw conflict('组名已存在', { field: 'name' });
    const limits = validateLimits(req.body || {});
    const id = genId('g');
    const ts = nowIso();
    const tx = db.transaction(() => {
      if (isDefault) db.prepare('UPDATE groups SET isDefault = 0').run();
      db.prepare(
        `INSERT INTO groups (id, name, spaceLimitBytes, maxFileSizeBytes, traffic7dLimitBytes, isDefault, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, name.trim(), limits.spaceLimitBytes, limits.maxFileSizeBytes, limits.traffic7dLimitBytes, isDefault ? 1 : 0, ts);
    });
    tx();
    const item = serialize(db.prepare('SELECT * FROM groups WHERE id = ?').get(id));
    writeAudit({ email: 'admin', action: 'group_create', target: item.name });
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g) throw notFound('用户组不存在');
    const body = req.body || {};
    const limits = validateLimits({
      spaceLimitBytes: body.spaceLimitBytes ?? g.spaceLimitBytes,
      maxFileSizeBytes: body.maxFileSizeBytes ?? g.maxFileSizeBytes,
      traffic7dLimitBytes: body.traffic7dLimitBytes ?? g.traffic7dLimitBytes,
    });
    const name = body.name != null ? String(body.name).trim() : g.name;
    if (name.length < 1 || name.length > 32) throw badRequest('invalid_input', '组名长度需为 1–32 字', { field: 'name' });
    const dup = db.prepare('SELECT id FROM groups WHERE name = ? AND id != ?').get(name, g.id);
    if (dup) throw conflict('组名已存在', { field: 'name' });
    const tx = db.transaction(() => {
      if (body.isDefault === true) db.prepare('UPDATE groups SET isDefault = 0').run();
      db.prepare(
        `UPDATE groups SET name = ?, spaceLimitBytes = ?, maxFileSizeBytes = ?, traffic7dLimitBytes = ?, isDefault = ?
         WHERE id = ?`
      ).run(name, limits.spaceLimitBytes, limits.maxFileSizeBytes, limits.traffic7dLimitBytes,
        body.isDefault === true ? 1 : g.isDefault, g.id);
    });
    tx();
    res.json({ item: serialize(db.prepare('SELECT * FROM groups WHERE id = ?').get(g.id)) });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const g = db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id);
    if (!g) throw notFound('用户组不存在');
    const uc = userCount(g.id);
    if (uc > 0) throw conflict('该组下仍有用户', { userCount: uc });
    if (g.isDefault) throw conflict('默认组不允许删除');
    db.prepare('DELETE FROM groups WHERE id = ?').run(g.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
