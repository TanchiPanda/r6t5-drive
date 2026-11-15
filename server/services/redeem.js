// P9-C 兑换码：批量生成 / 校验 / 兑换 / 禁用 / 删除 / CSV 导出。
import crypto from 'node:crypto';
import { db } from '../db.js';
import { genId, nowIso, isoPlusDays, toInt } from '../lib/format.js';
import {
  badRequest, redeemCodeInvalid, redeemCodeDisabled, redeemCodeExpired,
  redeemCodeExhausted, redeemCodeEmailMismatch, redeemCodeAlreadyUsed,
} from '../lib/errors.js';
import { toBigInt, toByteString, assertMaxSqliteInt } from '../lib/bytes.js';
import { writeLedger, hasRedeemed } from './points.js';
import { getGroupById } from './quota.js';
import { writeAudit } from './audit.js';

// 排除易混字符 0 O 1 l I
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RANDOM_LEN = 12;
const REDEEM_TYPES = new Set(['storage', 'points', 'group']);

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function randomCode() {
  const bytes = crypto.randomBytes(CODE_RANDOM_LEN);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function uniqueCode() {
  for (let i = 0; i < 5; i += 1) {
    const c = randomCode();
    if (!db.prepare('SELECT code FROM redeem_codes WHERE code = ?').get(c)) return c;
  }
  return randomCode() + crypto.randomBytes(4).toString('base64url');
}

function validateBody(body) {
  const type = String(body?.type || '');
  if (!REDEEM_TYPES.has(type)) throw badRequest('invalid_input', '兑换码类型非法', { field: 'type' });

  const out = { type };
  if (type === 'storage') {
    if (body.storageBytes == null || body.storageBytes === '') {
      throw badRequest('invalid_input', '容量码必须填写 storageBytes', { field: 'storageBytes' });
    }
    const bytes = assertMaxSqliteInt(toBigInt(body.storageBytes), 'storageBytes');
    if (bytes <= 0n) throw badRequest('invalid_input', '容量必须大于 0', { field: 'storageBytes' });
    out.storageBytes = toByteString(bytes);
  }
  if (type === 'points') {
    const n = toInt(body.points, NaN);
    if (!Number.isFinite(n) || n <= 0) throw badRequest('invalid_input', '积分码额度需为正整数', { field: 'points' });
    out.points = n;
  }
  if (type === 'group') {
    const days = toInt(body.durationDays, NaN);
    if (!Number.isFinite(days) || days <= 0) throw badRequest('invalid_input', '会员码时长需为正整数天', { field: 'durationDays' });
    if (!body.groupId) throw badRequest('invalid_input', '会员码必须选择目标用户组', { field: 'groupId' });
    const g = getGroupById(String(body.groupId));
    if (!g) throw badRequest('invalid_input', '目标用户组不存在', { field: 'groupId' });
    out.durationDays = days;
    out.groupId = g.id;
  }

  const maxUses = toInt(body.maxUses, 1);
  if (!Number.isFinite(maxUses) || maxUses < 1 || maxUses > 100_000) {
    throw badRequest('invalid_input', '次数需为 1-100000 的整数', { field: 'maxUses' });
  }
  out.maxUses = maxUses;

  if (body.expiresAt) {
    const t = Date.parse(String(body.expiresAt));
    if (Number.isNaN(t)) throw badRequest('invalid_input', '有效期不是合法时间', { field: 'expiresAt' });
    out.expiresAt = new Date(t).toISOString();
  } else {
    out.expiresAt = null;
  }
  out.boundEmail = body.boundEmail ? String(body.boundEmail).toLowerCase().trim() : null;
  return out;
}

/** 批量生成；同批次共享 batchId。 */
export function generateBatch(body, createdBy = null) {
  const count = toInt(body?.count, NaN);
  if (!Number.isFinite(count) || count < 1 || count > 10_000) {
    throw badRequest('invalid_input', '生成数量需为 1-10000', { field: 'count' });
  }
  const prefix = normalizeCode(body?.prefix || '').slice(0, 8);
  const fields = validateBody(body);
  const batchId = genId('batch');
  const ts = nowIso();

  const stmt = db.prepare(
    `INSERT INTO redeem_codes (code, type, storageBytes, points, durationDays, groupId, batchId,
        maxUses, usedCount, boundEmail, expiresAt, status, createdBy, lastUsedAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, NULL, ?)`
  );
  const codes = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      const code = `${prefix}${uniqueCode()}`;
      stmt.run(
        code, fields.type, fields.storageBytes ?? null, fields.points ?? null,
        fields.durationDays ?? null, fields.groupId ?? null, batchId,
        fields.maxUses, fields.boundEmail, fields.expiresAt, createdBy, ts,
      );
      codes.push(code);
    }
  });
  tx();
  writeAudit({ email: createdBy || 'admin', action: 'redeem_generate', target: batchId, detail: `count:${count},type:${fields.type}` });
  return { batchId, codes };
}

export function listCodes({ batchId = null, status = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (batchId) { where.push('batchId = ?'); params.push(batchId); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const items = db.prepare(
    `SELECT * FROM redeem_codes ${sqlWhere} ORDER BY createdAt DESC LIMIT ?`
  ).all(...params, lim).map(serialize);
  return { items };
}

function serialize(r) {
  return {
    code: r.code,
    type: r.type,
    storageBytes: r.storageBytes != null ? String(r.storageBytes) : null,
    points: r.points == null ? null : Number(r.points),
    durationDays: r.durationDays == null ? null : Number(r.durationDays),
    groupId: r.groupId || null,
    batchId: r.batchId,
    maxUses: Number(r.maxUses),
    usedCount: Number(r.usedCount),
    boundEmail: r.boundEmail || null,
    expiresAt: r.expiresAt || null,
    status: r.status,
    lastUsedAt: r.lastUsedAt || null,
    createdAt: r.createdAt,
  };
}

function loadCode(code) {
  return db.prepare('SELECT * FROM redeem_codes WHERE code = ?').get(normalizeCode(code));
}

function assertUsable(row, email) {
  const em = String(email || '').toLowerCase();
  if (!row || row.status === 'deleted') throw redeemCodeInvalid();
  if (row.status === 'disabled') throw redeemCodeDisabled();
  if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) throw redeemCodeExpired();
  if (row.boundEmail && row.boundEmail !== em) throw redeemCodeEmailMismatch();
  const prior = hasRedeemed(em, row.code);
  if (prior) throw redeemCodeAlreadyUsed({ usedAt: prior.createdAt });
  if (Number(row.usedCount) >= Number(row.maxUses)) throw redeemCodeExhausted();
}

/** 预览：只校验不兑换。 */
export function preview(code, email) {
  const row = loadCode(code);
  if (!row || row.status === 'deleted') throw redeemCodeInvalid();
  let available = true;
  let reason = null;
  try {
    assertUsable(row, email);
  } catch (e) {
    available = false;
    reason = e.code;
  }
  return {
    code: row.code,
    type: row.type,
    granted: grantSummary(row),
    available,
    reason,
    expiresAt: row.expiresAt || null,
    maxUses: Number(row.maxUses),
    usedCount: Number(row.usedCount),
  };
}

function grantSummary(row) {
  if (row.type === 'storage') return { storageBytes: String(row.storageBytes) };
  if (row.type === 'points') return { points: Number(row.points) };
  return { durationDays: Number(row.durationDays), groupId: row.groupId };
}

/** 兑换：校验通过后在同一事务内发放权益。 */
export function redeem(email, code) {
  const em = String(email).toLowerCase();
  const row = loadCode(code);
  assertUsable(row, em);

  const tx = db.transaction(() => {
    if (row.type === 'storage') {
      const expiresAt = Number(row.durationDays || 0) > 0 ? isoPlusDays(Number(row.durationDays)) : null;
      db.prepare(
        `INSERT INTO storage_grants (id, email, bytes, expiresAt, orderId, createdAt) VALUES (?, ?, ?, ?, NULL, ?)`
      ).run(genId('gr'), em, String(row.storageBytes), expiresAt, nowIso());
    } else if (row.type === 'points') {
      writeLedger({ email: em, delta: Number(row.points), source: 'redeem', refType: 'redeem_code', refId: row.code, note: '兑换码充值' });
    } else if (row.type === 'group') {
      const expiresAt = Number(row.durationDays) > 0 ? isoPlusDays(Number(row.durationDays)) : null;
      db.prepare('UPDATE users SET groupId = ?, groupExpiresAt = ? WHERE email = ?').run(row.groupId, expiresAt, em);
    }
    db.prepare('UPDATE redeem_codes SET usedCount = usedCount + 1, lastUsedAt = ? WHERE code = ?').run(nowIso(), row.code);
  });
  tx();
  writeAudit({ email: em, action: 'redeem_used', target: row.code, detail: `type:${row.type}` });
  return { type: row.type, granted: grantSummary(row) };
}

export function disableCode(code) {
  const row = loadCode(code);
  if (!row || row.status === 'deleted') throw redeemCodeInvalid();
  db.prepare("UPDATE redeem_codes SET status = 'disabled' WHERE code = ?").run(row.code);
  return { ok: true };
}

export function deleteCode(code) {
  const row = loadCode(code);
  if (!row) throw redeemCodeInvalid();
  db.prepare("UPDATE redeem_codes SET status = 'deleted' WHERE code = ?").run(row.code);
  return { ok: true };
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

/** CSV 导出：code,type,额度,有效期,次数,状态（UTF-8 BOM 便于 Excel 打开）。 */
export function exportCsv() {
  const rows = db.prepare('SELECT * FROM redeem_codes ORDER BY batchId DESC, code ASC').all();
  const lines = ['code,type,额度,有效期,次数,状态'];
  for (const r of rows) {
    let amount = '';
    if (r.type === 'storage') amount = `${r.storageBytes} B`;
    else if (r.type === 'points') amount = `${r.points} 积分`;
    else amount = `${r.durationDays} 天 → ${r.groupId}`;
    const valid = r.expiresAt || '永久';
    const usage = `${r.usedCount}/${r.maxUses}`;
    lines.push([r.code, r.type, amount, valid, usage, r.status].map(csvEscape).join(','));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
