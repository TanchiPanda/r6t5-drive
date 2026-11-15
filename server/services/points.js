// P9-C 积分流水服务。
// 余额 = SUM(delta)，不单独建余额列；写流水与发权益在同一事务内（调用方包事务或用本模块事务）。
import { db } from '../db.js';
import { genId, nowIso } from '../lib/format.js';
import { badRequest } from '../lib/errors.js';

export const POINT_SOURCES = new Set([
  'purchase', 'redeem', 'commission', 'share_spend', 'refund', 'admin_adjust', 'signup_bonus',
]);

function normalize(email) {
  return String(email || '').toLowerCase();
}

/** 当前积分余额（整数；无流水返回 0）。 */
export function balance(email) {
  const row = db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM points_ledger WHERE email = ?').get(normalize(email));
  return Number(row.n || 0);
}

/**
 * 写一条流水。balanceAfter 为写入时的汇总值（展示用，不参与后续计算）。
 * 必须与权益发放放在同一事务里：本函数自带事务包裹；外层已在事务中时 better-sqlite3
 * 会以 savepoint 嵌套，行为一致。
 *
 * @param {{email:string,delta:number,source:string,refType?:string|null,refId?:string|null,note?:string|null}} arg
 * @returns {number} 写入后的余额
 */
export function writeLedger({ email, delta, source, refType = null, refId = null, note = null }) {
  const em = normalize(email);
  const n = Number(delta);
  if (!Number.isInteger(n)) throw badRequest('invalid_input', '积分变动必须为整数', { field: 'delta' });
  if (!POINT_SOURCES.has(source)) throw badRequest('invalid_input', '流水来源非法', { field: 'source' });

  const tx = db.transaction(() => {
    const before = balance(em);
    const after = before + n;
    db.prepare(
      `INSERT INTO points_ledger (id, email, delta, balanceAfter, source, refType, refId, note, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(genId('pl'), em, n, after, source, refType, refId, note ? String(note) : null, nowIso());
    return after;
  });
  return tx();
}

/** 管理端流水查询。 */
export function listLedger({ email = null, source = null, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (email) { where.push('email = ?'); params.push(normalize(email)); }
  if (source) { where.push('source = ?'); params.push(source); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 50));
  const items = db.prepare(
    `SELECT id, email, delta, balanceAfter, source, refType, refId, note, createdAt
       FROM points_ledger ${sqlWhere}
      ORDER BY id DESC LIMIT ?`
  ).all(...params, lim);
  return { items, total: db.prepare(`SELECT COUNT(*) AS n FROM points_ledger ${sqlWhere}`).get(...params).n };
}

/** 某用户是否已用过某兑换码（查 redeem 类型流水）。 */
export function hasRedeemed(email, code) {
  const row = db.prepare(
    `SELECT id, createdAt FROM points_ledger
      WHERE email = ? AND refType = 'redeem_code' AND refId = ? ORDER BY id DESC LIMIT 1`
  ).get(normalize(email), String(code));
  return row || null;
}
