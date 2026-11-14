// 目录 → 存储策略绑定，以及「这条路径到底落在哪个策略上」的解析。
// 优先级：最深匹配的绑定 > 用户组默认策略 > 站点本地默认（docs/storage-drivers.md §5）
import { db, getSetting } from '../db.js';
import { nowIso, genId } from '../lib/format.js';
import { badRequest, conflict, notFound, forbidden } from '../lib/errors.js';

/** 绑定路径：相对用户根，'' 表示用户根本身 */
export function normalizeSubPath(raw) {
  if (raw == null) return '';
  if (typeof raw !== 'string') throw badRequest('invalid_input', '绑定路径必须是字符串', { field: 'subPath' });
  let p = raw.trim();
  if (p.startsWith('/') || p.endsWith('/')) p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '' ) return '';
  if (/[\\\u0000-\u001f]/.test(p)) throw forbidden('绑定路径包含非法字符');
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') throw forbidden('绑定路径包含非法段');
  }
  return segs.join('/');
}

function strategyRow(id) {
  return db.prepare('SELECT * FROM storage_strategies WHERE id = ?').get(id);
}

function enabledStrategy(id) {
  const s = strategyRow(id);
  return s && s.enabled ? s : null;
}

export function listBindings() {
  return db.prepare(
    `SELECT b.*, s.name AS strategyName, s.type AS strategyType, s.readOnly AS strategyReadOnly, s.enabled AS strategyEnabled
       FROM storage_bindings b LEFT JOIN storage_strategies s ON s.id = b.strategyId
      ORDER BY b.subPath ASC, b.createdAt ASC`
  ).all();
}

export function createBinding({ strategyId, scope, email, subPath }) {
  if (!strategyId || !strategyRow(strategyId)) throw notFound('存储策略不存在');
  if (!['site', 'user'].includes(scope)) throw badRequest('invalid_input', "scope 只能是 'site' 或 'user'", { field: 'scope' });
  const sub = normalizeSubPath(subPath);
  const mail = scope === 'user' ? String(email || '').trim().toLowerCase() : null;
  if (scope === 'user' && !mail) throw badRequest('invalid_input', '用户级绑定必须指定邮箱', { field: 'email' });
  const dup = db.prepare('SELECT id FROM storage_bindings WHERE scope = ? AND COALESCE(email, \'\') = ? AND subPath = ?')
    .get(scope, mail || '', sub);
  if (dup) throw conflict('同一目录已存在绑定', { bindingId: dup.id });
  const id = genId('b');
  db.prepare('INSERT INTO storage_bindings (id, strategyId, scope, email, subPath, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, strategyId, scope, mail, sub, nowIso());
  return db.prepare('SELECT * FROM storage_bindings WHERE id = ?').get(id);
}

export function updateBinding(id, fields) {
  const row = db.prepare('SELECT * FROM storage_bindings WHERE id = ?').get(id);
  if (!row) throw notFound('绑定不存在');
  const next = {
    strategyId: fields.strategyId != null ? fields.strategyId : row.strategyId,
    scope: fields.scope != null ? fields.scope : row.scope,
    email: row.email,
    subPath: fields.subPath != null ? normalizeSubPath(fields.subPath) : row.subPath,
  };
  if (!strategyRow(next.strategyId)) throw notFound('存储策略不存在');
  if (!['site', 'user'].includes(next.scope)) throw badRequest('invalid_input', "scope 只能是 'site' 或 'user'", { field: 'scope' });
  if (next.scope === 'user') {
    const mail = String(fields.email != null ? fields.email : row.email || '').trim().toLowerCase();
    if (!mail) throw badRequest('invalid_input', '用户级绑定必须指定邮箱', { field: 'email' });
    next.email = mail;
  } else {
    next.email = null;
  }
  db.prepare('UPDATE storage_bindings SET strategyId = ?, scope = ?, email = ?, subPath = ? WHERE id = ?')
    .run(next.strategyId, next.scope, next.email, next.subPath, id);
  return db.prepare('SELECT * FROM storage_bindings WHERE id = ?').get(id);
}

export function deleteBinding(id) {
  const row = db.prepare('SELECT id FROM storage_bindings WHERE id = ?').get(id);
  if (!row) throw notFound('绑定不存在');
  db.prepare('DELETE FROM storage_bindings WHERE id = ?').run(id);
}

/** 逻辑路径去掉首段 email 后的相对路径（用户根为 ''） */
export function relativeToUser(logicalPath, email) {
  const owner = String(email).toLowerCase();
  return logicalPath.length > owner.length ? logicalPath.slice(owner.length + 1) : '';
}

function groupStrategy(user) {
  if (!user || !user.groupId) return null;
  const g = db.prepare('SELECT defaultStrategyId FROM groups WHERE id = ?').get(user.groupId);
  return g && g.defaultStrategyId ? enabledStrategy(g.defaultStrategyId) : null;
}

function siteDefault() {
  const id = getSetting('defaultStorageId', null);
  if (id) {
    const s = enabledStrategy(id);
    if (s) return s;
  }
  const rows = db.prepare('SELECT * FROM storage_strategies WHERE enabled = 1').all();
  return rows.find((s) => s.type === 'volume') || rows[0] || null;
}

/**
 * 解析某条逻辑路径落在哪个存储策略。
 * @returns {{strategy:object, matchedBy:'binding'|'group'|'local', bindingId?:string, depth?:number}}
 */
export function resolveStorage({ email, logicalPath, user }) {
  const rel = relativeToUser(logicalPath, email);
  let best = null;
  for (const b of listBindings()) {
    if (!b.strategyEnabled) continue;
    if (b.scope === 'user' && String(b.email || '').toLowerCase() !== String(email).toLowerCase()) continue;
    const sub = b.subPath || '';
    const hit = sub === '' || rel === sub || rel.startsWith(sub + '/');
    if (!hit) continue;
    const depth = sub === '' ? 0 : sub.split('/').length;
    const tie = b.scope === 'user' ? 1 : 0; // 同深度时用户级优先
    if (!best || depth > best.depth || (depth === best.depth && tie > best.tie)) {
      best = { depth, tie, binding: b };
    }
  }
  if (best) {
    const strategy = strategyRow(best.binding.strategyId);
    if (strategy && strategy.enabled) {
      return { strategy, matchedBy: 'binding', bindingId: best.binding.id, depth: best.depth };
    }
  }
  const g = groupStrategy(user);
  if (g) return { strategy: g, matchedBy: 'group' };
  const local = siteDefault();
  if (local) return { strategy: local, matchedBy: 'local' };
  return null;
}

export function strategyOf(id) {
  return id ? strategyRow(id) : null;
}
