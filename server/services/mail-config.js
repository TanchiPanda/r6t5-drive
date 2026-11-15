// P8-B SMTP 配置读取 / 脱敏。密码只在库里，回显绝不发明文。
import { getSetting } from '../db.js';

const BOOL = (v) => v === 'true' || v === '1' || v === true;

/** 读取完整配置（含密码，仅供发信内部使用，禁止直接回给前端）。 */
export function smtpConfig() {
  const portRaw = Number(getSetting('smtp.port', ''));
  return {
    host: (getSetting('smtp.host', '') || '').trim(),
    port: Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : 587,
    username: (getSetting('smtp.username', '') || '').trim(),
    password: getSetting('smtp.password', '') || '',
    secure: BOOL(getSetting('smtp.secure', 'false')),
    fromName: (getSetting('smtp.fromName', '') || '').trim(),
    fromEmail: (getSetting('smtp.fromEmail', '') || '').trim(),
    replyTo: (getSetting('smtp.replyTo', '') || '').trim(),
    connTimeoutMs: Math.max(1000, Number(getSetting('smtp.connTimeoutMs', '')) || 10000),
  };
}

/** 是否已配置可发信：需要 host 与发信地址。 */
export function isConfigured() {
  const c = smtpConfig();
  return !!c.host && !!c.fromEmail;
}

/** 联系邮箱回落顺序：replyTo → fromEmail → null。 */
export function contactEmail() {
  const c = smtpConfig();
  return c.replyTo || c.fromEmail || null;
}

/** 密码脱敏：有值回 `****` + 末 2 位（短密码不显示尾部），无值 `''`。 */
export function maskPassword(pw) {
  if (!pw) return '';
  const s = String(pw);
  return s.length > 2 ? `****${s.slice(-2)}` : '****';
}

/** 面向管理接口的脱敏快照（无密码明文）。 */
export function maskedConfig() {
  const c = smtpConfig();
  return {
    configured: isConfigured(),
    host: c.host,
    port: c.port,
    username: c.username,
    secure: c.secure,
    fromName: c.fromName,
    fromEmail: c.fromEmail,
    replyTo: c.replyTo,
    connTimeoutMs: c.connTimeoutMs,
    contactEmail: contactEmail(),
    passwordSet: !!c.password,
    passwordMasked: maskPassword(c.password),
  };
}
