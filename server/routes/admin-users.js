import { Router } from 'express';
import { db } from '../db.js';
import * as supabase from '../services/supabase.js';
import { upsertUser, usedBytesOf, fileCountOf } from '../services/user-helpers.js';
import { writeAudit } from '../services/audit.js';
import { badRequest, notFound, conflict } from '../lib/errors.js';

const router = Router();

function groupName(groupId) {
  if (!groupId) return '';
  const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId);
  return g?.name || '';
}

function serialize(u) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName || '',
    groupId: u.groupId,
    groupName: groupName(u.groupId),
    disabled: !!u.disabled,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
    usedBytes: usedBytesOf(u.email),
    fileCount: fileCountOf(u.email),
  };
}

router.get('/', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
  const where = [];
  const params = [];
  if (req.query.q) { where.push('email LIKE ?'); params.push(`%${req.query.q}%`); }
  if (req.query.groupId) { where.push('groupId = ?'); params.push(req.query.groupId); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM users ${sqlWhere}`).get(...params).n;
  const rows = db.prepare(
    `SELECT * FROM users ${sqlWhere} ORDER BY createdAt DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, items: rows.map(serialize) });
});

router.post('/', async (req, res, next) => {
  try {
    if (!supabase.isConfigured()) {
      const e = new Error('尚未配置 Supabase');
      e.status = 412; e.code = 'supabase_not_configured'; throw e;
    }
    const { email, password, groupId } = req.body || {};
    const normalized = String(email || '').toLowerCase();
    if (!/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(normalized)) throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    if (!password || String(password).length < 6) throw badRequest('invalid_input', '密码至少 6 位', { field: 'password' });
    const created = await supabase.adminCreateUser(normalized, password);
    if (created.status !== 200 && created.status !== 201) {
      const e = new Error('在 Supabase 创建用户失败');
      e.status = 400; e.code = 'invalid_input'; e.details = { body: created.body }; throw e;
    }
    const uid = created.body?.id || created.body?.user?.id || normalized;
    const user = upsertUser({ id: uid, email: normalized, groupId: groupId || null });
    writeAudit({ email: normalized, action: 'user_disable', detail: 'create' });
    res.status(201).json({ item: serialize(user) });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
      || db.prepare('SELECT * FROM users WHERE email = ?').get(req.params.id);
    if (!u) throw notFound('用户不存在');
    const body = req.body || {};
    if (body.groupId != null) {
      const g = body.groupId ? db.prepare('SELECT id FROM groups WHERE id = ?').get(body.groupId) : null;
      if (body.groupId && !g) throw badRequest('invalid_input', '用户组不存在', { field: 'groupId' });
      db.prepare('UPDATE users SET groupId = ? WHERE id = ?').run(body.groupId || null, u.id);
    }
    if (body.displayName != null) db.prepare('UPDATE users SET displayName = ? WHERE id = ?').run(String(body.displayName), u.id);
    if (body.disabled != null) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, u.id);
      writeAudit({ email: u.email, action: 'user_disable', detail: body.disabled ? 'disable' : 'enable' });
    }
    res.json({ item: serialize(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  } catch (e) { next(e); }
});

router.post('/sync', async (req, res, next) => {
  try {
    if (!supabase.isConfigured()) {
      const e = new Error('尚未配置 Supabase');
      e.status = 412; e.code = 'supabase_not_configured'; throw e;
    }
    const result = await supabase.adminListUsers();
    if (result.status !== 200) throw conflict('拉取 Supabase 用户失败', { body: result.body });
    const list = result.body?.users || result.body || [];
    let added = 0, updated = 0;
    const tx = db.transaction(() => {
      for (const su of list) {
        const email = String(su.email || '').toLowerCase();
        if (!email) continue;
        const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
        if (existing) {
          updated++;
          db.prepare('UPDATE users SET displayName = ? WHERE email = ?').run(su.email || '', email);
        } else {
          added++;
          upsertUser({ id: su.id || email, email });
        }
      }
    });
    tx();
    const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({ ok: true, added, updated, total });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)
      || db.prepare('SELECT * FROM users WHERE email = ?').get(req.params.id);
    if (!u) throw notFound('用户不存在');
    if (u.disabled) throw conflict('用户已处于禁用状态');
    db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(u.id);
    writeAudit({ email: u.email, action: 'user_disable', detail: 'delete' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
