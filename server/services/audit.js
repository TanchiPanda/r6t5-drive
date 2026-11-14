import { db } from '../db.js';
import { nowIso, truncateIp } from '../lib/format.js';

const VALID_ACTIONS = new Set([
  'login', 'logout', 'upload', 'download', 'delete', 'restore', 'rename', 'move',
  'mkdir', 'admin_login', 'settings_update', 'group_create', 'storage_create',
  'user_disable', 'share_create',
]);

export function writeAudit({ email, action, target = null, bytes = null, ip = null, detail = null }) {
  if (!VALID_ACTIONS.has(action)) action = 'login';
  db.prepare(
    `INSERT INTO audit (at, email, action, target, bytes, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(nowIso(), email || null, action, target, bytes == null ? null : Number(bytes), truncateIp(ip), detail);
}

export function listAudit({ page = 1, pageSize = 30, action = null, email = null }) {
  page = Math.max(1, Number(page) || 1);
  pageSize = Math.min(200, Math.max(1, Number(pageSize) || 30));
  const where = [];
  const params = [];
  if (action) { where.push('action = ?'); params.push(action); }
  if (email) { where.push('email = ?'); params.push(email); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit ${sqlWhere}`).get(...params).n;
  const items = db.prepare(
    `SELECT id, at, email, action, target, bytes, ip, detail FROM audit ${sqlWhere}
     ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  return { total, page, pageSize, items };
}
