// P9-C billing 设置读取/校验（C-2 全部键）。
import { db, getSetting, setSetting } from '../db.js';
import { badRequest } from '../lib/errors.js';

const DEFAULTS = {
  'billing.pointsPerMinorUnit': '1',
  'billing.commissionPercent': '10',
  'billing.allowAnonymousPurchase': 'true',
  'billing.storeNavEnabled': 'false',
  'billing.overQuotaGraceDays': '7',
  'billing.cronNotifyExpr': '0 9 * * *',
  'billing.cronBanExpr': '@every 1h',
  'billing.notifyOnExpireDays': '3',
};

/** 读全部 billing 设置（带类型 coercion）。 */
export function billingConfig() {
  return {
    pointsPerMinorUnit: Math.max(0, Number(getSetting('billing.pointsPerMinorUnit', DEFAULTS['billing.pointsPerMinorUnit'])) || 0),
    commissionPercent: Math.min(100, Math.max(1, Number(getSetting('billing.commissionPercent', DEFAULTS['billing.commissionPercent'])) || 10)),
    allowAnonymousPurchase: getSetting('billing.allowAnonymousPurchase', DEFAULTS['billing.allowAnonymousPurchase']) === 'true',
    storeNavEnabled: getSetting('billing.storeNavEnabled', DEFAULTS['billing.storeNavEnabled']) === 'true',
    overQuotaGraceDays: Math.max(0, Number(getSetting('billing.overQuotaGraceDays', DEFAULTS['billing.overQuotaGraceDays'])) || 0),
    cronNotifyExpr: getSetting('billing.cronNotifyExpr', DEFAULTS['billing.cronNotifyExpr']),
    cronBanExpr: getSetting('billing.cronBanExpr', DEFAULTS['billing.cronBanExpr']),
    notifyOnExpireDays: Math.max(0, Number(getSetting('billing.notifyOnExpireDays', DEFAULTS['billing.notifyOnExpireDays'])) || 0),
  };
}

const INT_KEYS = new Set([
  'billing.pointsPerMinorUnit', 'billing.commissionPercent', 'billing.overQuotaGraceDays', 'billing.notifyOnExpireDays',
]);
const BOOL_KEYS = new Set(['billing.allowAnonymousPurchase', 'billing.storeNavEnabled']);
const EXPR_KEYS = new Set(['billing.cronNotifyExpr', 'billing.cronBanExpr']);

/** PATCH 部分设置；非法值抛 400。返回更新后的完整配置。 */
export function patchBillingConfig(body = {}) {
  for (const [key, raw] of Object.entries(body)) {
    if (!(key in DEFAULTS)) throw badRequest('invalid_input', `未知设置项：${key}`, { field: key });
    let value = raw;
    if (BOOL_KEYS.has(key)) {
      value = value === true || value === 'true' ? 'true' : 'false';
    } else if (INT_KEYS.has(key)) {
      const n = Number(value);
      if (!Number.isFinite(n) || Math.trunc(n) < 0) throw badRequest('invalid_input', '需为非负整数', { field: key });
      if (key === 'billing.commissionPercent' && (n < 1 || n > 100)) {
        throw badRequest('invalid_input', '佣金比例需为 1-100', { field: key });
      }
      value = String(Math.trunc(n));
    } else if (EXPR_KEYS.has(key)) {
      value = String(value || '').trim();
      if (!value) throw badRequest('invalid_input', 'Cron 表达式不能为空', { field: key });
    }
    setSetting(key, value);
  }
  return billingConfig();
}

export { DEFAULTS as BILLING_DEFAULTS };

// 供 cron 模块校验表达式合法性
export function validateExpr(expr) {
  const s = String(expr || '').trim();
  if (!s) return false;
  if (s.startsWith('@every ')) {
    return /^@every\s+\d+\s*(m|min|mins|h|hour|hours)$/i.test(s);
  }
  const parts = s.split(/\s+/);
  return parts.length === 5;
}

// 避免未使用告警（db 预留给后续批量重置）
void db;
