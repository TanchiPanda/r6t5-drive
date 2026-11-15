import { Router } from 'express';
import { db } from '../db.js';
import * as supabase from '../services/supabase.js';
import { upsertUser, usedBytesOf, fileCountOf } from '../services/user-helpers.js';
import { writeAudit } from '../services/audit.js';
import { badRequest, notFound, conflict, notSupportedInSource } from '../lib/errors.js';
import { nowIso, genId } from '../lib/format.js';
import {
  isVolumeSource, hashLocalPassword,
} from '../services/user-source.js';
import * as registry from '../services/storage/registry.js';
import { getDriver } from '../services/storage/driver.js';
import { resolveStorage } from '../services/bindings.js';

const router = Router();

const EMAIL_RE = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

function groupName(groupId) {
  if (!groupId) return '';
  const g = db.prepare('SELECT name FROM groups WHERE id = ?').get(groupId);
  return g?.name || '';
}

function statusOf(u) {
  // 读取以 status 为准，disabled 作为老列兜底
  if (u.status === 'banned' || u.disabled === 1) return 'banned';
  return 'active';
}

function serialize(u) {
  const status = statusOf(u);
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName || '',
    groupId: u.groupId,
    groupName: groupName(u.groupId),
    disabled: status === 'banned',
    status,
    source: u.passwordHash ? 'local' : 'supabase',
    registeredAt: u.registeredAt || u.createdAt || null,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    usedBytes: usedBytesOf(u.email),
    fileCount: fileCountOf(u.email),
  };
}

function findUser(param) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(param)
    || db.prepare('SELECT * FROM users WHERE email = ?').get(param);
}

function validateGroupId(groupId) {
  if (groupId == null || groupId === '') return null;
  const g = db.prepare('SELECT id FROM groups WHERE id = ?').get(groupId);
  if (!g) throw badRequest('invalid_input', '用户组不存在', { field: 'groupId' });
  return groupId;
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
    const body = req.body || {};
    const normalized = String(body.email || '').toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    if (!body.password || String(body.password).length < 6) {
      throw badRequest('invalid_input', '密码至少 6 位', { field: 'password' });
    }
    const groupId = validateGroupId(body.groupId || null);
    const displayName = String(body.displayName || normalized);

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
    if (existing) throw conflict('该邮箱已存在', { field: 'email' });

    if (isVolumeSource()) {
      // volume 模式：本地建号，密码 scrypt 落库。
      const uid = genId('u');
      const now = nowIso();
      const passwordHash = hashLocalPassword(String(body.password));
      db.prepare(
        `INSERT INTO users (id, email, displayName, groupId, disabled, status, passwordHash, registeredAt, lastLoginAt, createdAt)
         VALUES (?, ?, ?, ?, 0, 'active', ?, ?, NULL, ?)`
      ).run(uid, normalized, displayName, groupId, passwordHash, now, now);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      writeAudit({ email: normalized, action: 'user_create', detail: 'local' });
      res.status(201).json({ item: serialize(user) });
      return;
    }

    // supabase 模式：维持现有 Supabase 建号逻辑（不假装本地建号）。
    if (!supabase.isConfigured()) {
      const e = new Error('尚未配置 Supabase');
      e.status = 412; e.code = 'supabase_not_configured'; throw e;
    }
    const created = await supabase.adminCreateUser(normalized, String(body.password));
    if (created.status !== 200 && created.status !== 201) {
      const e = new Error('在 Supabase 创建用户失败');
      e.status = 400; e.code = 'invalid_input'; e.details = { body: created.body }; throw e;
    }
    const uid = created.body?.id || created.body?.user?.id || normalized;
    const user = upsertUser({ id: uid, email: normalized, groupId, displayName });
    writeAudit({ email: normalized, action: 'user_create', detail: 'supabase' });
    res.status(201).json({ item: serialize(user) });
  } catch (e) { next(e); }
});

router.post('/:id/password', (req, res, next) => {
  try {
    const u = findUser(req.params.id);
    if (!u) throw notFound('用户不存在');
    const { password } = req.body || {};
    if (!password || String(password).length < 6) {
      throw badRequest('invalid_input', '密码至少 6 位', { field: 'password' });
    }
    // Supabase 来源：密码需在 Supabase 侧修改（与该用户是否带本地 hash 无关）。
    if (!isVolumeSource()) {
      throw notSupportedInSource('Supabase 账号密码请在 Supabase 侧修改', { source: 'supabase' });
    }
    const passwordHash = hashLocalPassword(String(password));
    db.prepare('UPDATE users SET passwordHash = ? WHERE id = ?').run(passwordHash, u.id);
    writeAudit({ email: u.email, action: 'user_password', detail: 'admin-reset' });
    res.json({ ok: true, item: serialize(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const u = findUser(req.params.id);
    if (!u) throw notFound('用户不存在');
    const body = req.body || {};
    if (body.groupId != null) {
      const g = body.groupId ? db.prepare('SELECT id FROM groups WHERE id = ?').get(body.groupId) : null;
      if (body.groupId && !g) throw badRequest('invalid_input', '用户组不存在', { field: 'groupId' });
      db.prepare('UPDATE users SET groupId = ? WHERE id = ?').run(body.groupId || null, u.id);
    }
    if (body.displayName != null) db.prepare('UPDATE users SET displayName = ? WHERE id = ?').run(String(body.displayName), u.id);

    if (body.status != null) {
      if (!['active', 'banned'].includes(body.status)) {
        throw badRequest('invalid_input', "status 只能是 'active' 或 'banned'", { field: 'status' });
      }
      const banned = body.status === 'banned';
      // status 与 disabled 两列同步写入；读取以 status 为准。
      db.prepare('UPDATE users SET status = ?, disabled = ? WHERE id = ?')
        .run(body.status, banned ? 1 : 0, u.id);
      writeAudit({
        email: u.email,
        action: banned ? 'user_ban' : 'user_unban',
        detail: body.status,
      });
    } else if (body.disabled != null) {
      // 兼容老字段：disabled 同样落到 status 同步。
      const banned = !!body.disabled;
      db.prepare('UPDATE users SET status = ?, disabled = ? WHERE id = ?')
        .run(banned ? 'banned' : 'active', banned ? 1 : 0, u.id);
      writeAudit({
        email: u.email,
        action: banned ? 'user_ban' : 'user_unban',
        detail: banned ? 'disable' : 'enable',
      });
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

/** 清空某 email 名下全部节点（含回收站），并通过存储驱动删除物理对象与目录。 */
function purgeUserFiles(email) {
  const nodes = db.prepare('SELECT * FROM nodes WHERE email = ?').all(email);
  let nodesDeleted = 0;
  let bytesDeleted = 0;
  const fallback = resolveStorage({ email, logicalPath: `${email}/`, user: null })?.strategy
    || registry.defaultStrategy();

  for (const n of nodes) {
    const strategy = registry.getStrategy(n.storageId) || fallback;
    if (strategy && !n.isDir) {
      try {
        const ret = getDriver(strategy.type).remove(strategy, n.path, { size: Number(n.sizeBytes), mime: n.mime });
        if (ret && typeof ret.then === 'function') {
          ret.catch((e) => console.warn('[storage] 永久删除远端对象失败：', e.message));
        }
      } catch (e) {
        console.warn('[storage] 永久删除失败：', e.message);
      }
    }
    if (!n.isDir) bytesDeleted += Number(n.sizeBytes) || 0;
    nodesDeleted++;
  }
  db.prepare('DELETE FROM nodes WHERE email = ?').run(email);

  // 删除物理用户目录（volume 驱动；其它驱动兜底忽略）
  if (fallback) {
    try {
      getDriver(fallback.type).remove(fallback, `${email}/`, { isDir: true });
    } catch (e) {
      console.warn('[storage] 删除用户目录失败：', e.message);
    }
  }
  return { nodes: nodesDeleted, bytes: bytesDeleted };
}

router.delete('/:id', (req, res, next) => {
  try {
    const u = findUser(req.params.id);
    if (!u) throw notFound('用户不存在');
    const email = u.email;
    const deleteFiles = req.query.deleteFiles === '1' || req.query.deleteFiles === 'true';
    const isLocal = !!u.passwordHash;

    let deletedFiles = { nodes: 0, bytes: 0 };
    if (deleteFiles) {
      deletedFiles = purgeUserFiles(email);
    }

    // 清理该账号的附属本地记录（分享 / 应用密码 / 上传会话 / 流量 / 分享命中）
    const ownedShareIds = db.prepare('SELECT id FROM shares WHERE email = ?').all(email).map((r) => r.id);
    if (ownedShareIds.length) {
      const ph = ownedShareIds.map(() => '?').join(',');
      db.prepare(`DELETE FROM share_hits WHERE shareId IN (${ph})`).run(...ownedShareIds);
    }
    db.prepare('DELETE FROM share_hits WHERE email = ?').run(email);
    db.prepare('DELETE FROM shares WHERE email = ?').run(email);
    db.prepare('DELETE FROM app_passwords WHERE email = ?').run(email);
    db.prepare('DELETE FROM upload_sessions WHERE email = ?').run(email);
    db.prepare('DELETE FROM traffic WHERE email = ?').run(email);
    db.prepare("DELETE FROM storage_bindings WHERE scope = 'user' AND email = ?").run(email);

    // 删账号 = 删除 users 行（本地账号彻底消失）。
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);

    // Supabase 账号（无 passwordHash）只删本地记录，远端用户保留。
    const supabaseUserKept = !isLocal;
    writeAudit({
      email,
      action: 'user_delete',
      detail: `files:${deleteFiles ? 'deleted' : 'kept'}${supabaseUserKept ? ',supabase:kept' : ''}`,
    });

    res.json({
      ok: true,
      email,
      supabaseUserKept,
      message: supabaseUserKept
        ? 'Supabase 中的用户未被删除，仅清除了本地记录'
        : '账号已删除',
      deletedFiles,
    });
  } catch (e) { next(e); }
});

export default router;
