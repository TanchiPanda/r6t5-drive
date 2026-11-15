import { db } from '../db.js';
import { nowIso, truncateIp } from '../lib/format.js';

const VALID_ACTIONS = new Set([
  'login', 'logout', 'upload', 'download', 'delete', 'restore', 'rename', 'move',
  'mkdir', 'admin_login', 'settings_update', 'group_create', 'storage_create',
  'user_disable', 'share_create', 'share_revoke', 'compress', 'extract',
  // P6 账号来源 / 本地账号管理
  'user_ban', 'user_unban', 'user_delete', 'user_create', 'user_password',
  'user_source_switch',
  // P7 自助注册 / sudo 用户组
  'signup', 'group_update',
  // P8-B 邮箱确认 / 第三方登录
  'email_confirm', 'oauth_login',
  // P9-C 积分 / 商店 / 兑换码 / 付费分享
  'order_mark_paid', 'order_refund', 'order_cancel', 'points_adjust',
  'redeem_generate', 'redeem_used', 'product_update', 'group_expired',
  'expire_notice', 'share_purchase',
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
