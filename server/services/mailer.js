// P8-B 发信服务：SMTP 配置快照 + 一次性邮箱令牌 + 确认邮件模板。
import crypto from 'node:crypto';
import { db, getSetting } from '../db.js';
import { smtpConfig, isConfigured, contactEmail } from './mail-config.js';
import { sendMail } from '../lib/smtp.js';
import { confirmMail } from '../lib/html-mail.js';
import { nowIso } from '../lib/format.js';

export { isConfigured, contactEmail };

const CONFIRM_TTL_MS = 24 * 3600 * 1000; // 确认令牌 24h

/** 解析站点对外地址：settings.publicUrl 优先，否则回落请求 origin。 */
export function resolvePublicUrl(req) {
  const fromSetting = (getSetting('publicUrl', '') || '').trim();
  if (fromSetting) return fromSetting.replace(/\/+$/, '');
  const origin = req?.headers?.origin || (req ? `${req.protocol}://${req.headers.host}` : '');
  return (origin || 'http://localhost').replace(/\/+$/, '');
}

/** 生成一次性令牌：32 字节 base64url。 */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** 落库一枚令牌，返回 { token, expiresAt }。 */
export function issueToken(email, kind, ttlMs = CONFIRM_TTL_MS) {
  const token = newToken();
  const now = nowIso();
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  db.prepare('INSERT INTO email_tokens (token, email, kind, createdAt, expiresAt, usedAt) VALUES (?, ?, ?, ?, ?, NULL)')
    .run(token, String(email).toLowerCase(), kind, now, expiresAt);
  return { token, expiresAt };
}

/** 读取未使用、未过期的令牌；不存在 / 已用 / 过期返回 null。 */
export function findValidToken(token) {
  const row = db.prepare('SELECT * FROM email_tokens WHERE token = ?').get(token);
  if (!row || row.usedAt) return null;
  if (new Date(row.expiresAt).getTime() < Date.now()) return null;
  return row;
}

/** 标记令牌已使用。 */
export function consumeToken(row) {
  db.prepare('UPDATE email_tokens SET usedAt = ? WHERE token = ?').run(nowIso(), row.token);
}

/** 通用发信（C 批找回密码等场景复用）。 */
export async function sendPlain({ to, subject, text, html }) {
  if (!isConfigured()) return { ok: false, code: 'smtp_not_configured', response: 'SMTP 未配置' };
  return sendMail(smtpConfig(), { to, subject, text, html });
}

/** 发送注册确认邮件；失败不抛错，由调用方决定是否回滚（本期不回滚账号）。 */
export async function sendConfirmEmail(email, token, publicUrl) {
  const link = `${publicUrl}/confirm?token=${encodeURIComponent(token)}`;
  const siteName = getSetting('siteName', 'R6T5 Drive');
  const { html, text } = confirmMail({ siteName, link, contactEmail: contactEmail() });
  return sendPlain({ to: email, subject: `请确认邮箱 · ${siteName}`, text, html });
}

/** C 批预留：通用订单/找回邮件，本期与 sendPlain 同实现。 */
export async function sendOrderRecovery(payload) {
  return sendPlain(payload);
}
