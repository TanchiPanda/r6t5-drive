import { db } from '../db.js';
import { nowIso, truncateIp } from '../lib/format.js';
import { logEvent, currentContext } from '../lib/log.js';

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

// 审计动作 → 日志里的中文说明。未登记的动作退回英文 action。
const ACTION_LABELS = {
  login: '用户登录',
  logout: '用户退出',
  upload: '上传文件',
  download: '下载文件',
  delete: '删除文件',
  restore: '恢复文件',
  rename: '重命名',
  move: '移动文件',
  mkdir: '新建目录',
  admin_login: '管理员登录',
  settings_update: '设置变更',
  group_create: '创建用户组',
  group_update: '修改用户组',
  storage_create: '创建存储策略',
  user_disable: '禁用用户',
  user_ban: '封禁用户',
  user_unban: '解禁用户',
  user_delete: '删除用户',
  user_create: '创建用户',
  user_password: '修改用户密码',
  user_source_switch: '切换账号来源',
  share_create: '创建分享',
  share_revoke: '撤销分享',
  share_purchase: '购买付费分享',
  compress: '压缩',
  extract: '解压',
  signup: '用户注册',
  email_confirm: '邮箱确认',
  oauth_login: '第三方登录',
  order_mark_paid: '订单标记已支付',
  order_refund: '订单退款',
  order_cancel: '取消订单',
  points_adjust: '积分调整',
  redeem_generate: '生成兑换码',
  redeem_used: '兑换码核销',
  product_update: '商品变更',
  group_expired: '用户组到期',
  expire_notice: '到期通知',
};

export function writeAudit({ email, action, target = null, bytes = null, ip = null, detail = null }) {
  if (!VALID_ACTIONS.has(action)) action = 'login';
  db.prepare(
    `INSERT INTO audit (at, email, action, target, bytes, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(nowIso(), email || null, action, target, bytes == null ? null : Number(bytes), truncateIp(ip), detail);

  // 所有写审计的变更同时打一行 docker 日志；标记当前请求已记录，避免重复。
  const ctx = currentContext();
  if (ctx) ctx.logged = true;
  const label = ACTION_LABELS[action] || action;
  logEvent('audit', label, { action, user: email, target, bytes, ip, detail });
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
