// P9-C 商店 / 订单 / 权益发放与回收。
import crypto from 'node:crypto';
import { db, getSetting } from '../db.js';
import { genId, nowIso, isoPlusDays, toInt } from '../lib/format.js';
import {
  badRequest, productDisabled, pointsDisabled, insufficientPoints,
  orderNotPending, orderAlreadyPaid, orderNotFound, selfPurchaseForbidden,
  anonymousPurchaseDisabled,
} from '../lib/errors.js';
import { toBigInt, toByteString, assertMaxSqliteInt } from '../lib/bytes.js';
import { balance, writeLedger } from './points.js';
import { billingConfig } from './billing-config.js';
import { getDefaultGroup, getGroupById } from './quota.js';
import { writeAudit } from './audit.js';
import { getProvider } from './payment/index.js';

function normalize(email) {
  return String(email || '').toLowerCase();
}

function defaultGroup() {
  const sid = getSetting('defaultGroupId', null);
  if (sid) {
    const g = getGroupById(sid);
    if (g) return g;
  }
  return getDefaultGroup();
}

// ============ 商品 ============

const PRODUCT_TYPES = new Set(['storage_pack', 'group_upgrade']);

function serializeProduct(p) {
  const canPayPoints = !!p.allowPoints && p.pointsPrice != null && Number(p.pointsPrice) > 0;
  return {
    id: p.id,
    name: p.name,
    tag: p.tag || null,
    description: p.description || null,
    type: p.type,
    storageBytes: p.storageBytes != null ? String(p.storageBytes) : null,
    durationDays: Number(p.durationDays || 0),
    groupId: p.groupId || null,
    priceMinor: Number(p.priceMinor || 0),
    pointsPrice: p.pointsPrice == null ? null : Number(p.pointsPrice),
    allowPoints: !!p.allowPoints,
    canPayPoints,
    enabled: !!p.enabled,
    sort: Number(p.sort || 0),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt || null,
  };
}

function validateProductBody(body, { partial = false } = {}) {
  const out = {};
  const type = body.type;
  if (!partial || type != null) {
    if (!PRODUCT_TYPES.has(type)) throw badRequest('invalid_input', '商品类型非法', { field: 'type' });
    out.type = type;
  }
  if (!partial || body.name != null) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 64) throw badRequest('invalid_input', '商品名需为 1-64 字', { field: 'name' });
    out.name = name;
  }
  if (body.tag !== undefined) out.tag = body.tag ? String(body.tag).slice(0, 16) : null;
  if (body.description !== undefined) out.description = body.description ? String(body.description).slice(0, 500) : null;

  const resolvedType = out.type || type;
  if (resolvedType === 'storage_pack') {
    if (!partial || body.storageBytes != null) {
      if (body.storageBytes == null || body.storageBytes === '') {
        throw badRequest('invalid_input', '容量包必须填写 storageBytes', { field: 'storageBytes' });
      }
      const bytes = assertMaxSqliteInt(toBigInt(body.storageBytes), 'storageBytes');
      if (bytes <= 0n) throw badRequest('invalid_input', '容量必须大于 0', { field: 'storageBytes' });
      out.storageBytes = toByteString(bytes);
    }
  }
  if (resolvedType === 'group_upgrade') {
    if (!partial || body.groupId != null) {
      if (!body.groupId) throw badRequest('invalid_input', '会员商品必须选择目标用户组', { field: 'groupId' });
      const g = getGroupById(String(body.groupId));
      if (!g) throw badRequest('invalid_input', '目标用户组不存在', { field: 'groupId' });
      out.groupId = g.id;
    }
    if (!partial || body.durationDays != null) {
      const days = toInt(body.durationDays, NaN);
      if (!Number.isFinite(days) || days <= 0) throw badRequest('invalid_input', '会员时长必须为正整数天', { field: 'durationDays' });
      out.durationDays = days;
    }
  }
  if (!partial || body.durationDays != null) {
    out.durationDays = Number(out.durationDays ?? body.durationDays ?? 0);
  }
  if (!partial || body.priceMinor != null) {
    const n = toInt(body.priceMinor, NaN);
    if (!Number.isFinite(n) || n < 0) throw badRequest('invalid_input', '现金价需为非负整数', { field: 'priceMinor' });
    out.priceMinor = n;
  }
  if (body.pointsPrice !== undefined) {
    out.pointsPrice = body.pointsPrice == null || body.pointsPrice === '' ? null : toInt(body.pointsPrice, NaN);
    if (out.pointsPrice != null && (!Number.isFinite(out.pointsPrice) || out.pointsPrice < 0)) {
      throw badRequest('invalid_input', '积分价需为非负整数或空', { field: 'pointsPrice' });
    }
  }
  if (body.allowPoints !== undefined) out.allowPoints = body.allowPoints ? 1 : 0;
  if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
  if (body.sort !== undefined) out.sort = toInt(body.sort, 0);
  return out;
}

export function listProducts({ includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM products ORDER BY sort ASC, createdAt ASC'
    : 'SELECT * FROM products WHERE enabled = 1 ORDER BY sort ASC, createdAt ASC';
  return db.prepare(sql).all().map(serializeProduct);
}

export function getProduct(id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(String(id));
}

export function getEnabledProduct(id) {
  const p = getProduct(id);
  if (!p || p.enabled !== 1) throw productDisabled({ productId: String(id) });
  return p;
}

export function createProduct(body) {
  const fields = validateProductBody(body);
  const id = genId('pr');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO products (id, name, tag, description, type, storageBytes, durationDays, groupId,
        priceMinor, pointsPrice, allowPoints, enabled, sort, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, fields.name, fields.tag ?? null, fields.description ?? null, fields.type,
    fields.storageBytes ?? null, fields.durationDays ?? 0, fields.groupId ?? null,
    fields.priceMinor ?? 0, fields.pointsPrice ?? null, fields.allowPoints ?? 1,
    fields.enabled ?? 1, fields.sort ?? 0, ts, ts,
  );
  writeAudit({ email: null, action: 'product_update', target: id, detail: `create:${fields.name}` });
  return serializeProduct(getProduct(id));
}

export function updateProduct(id, body) {
  const existing = getProduct(id);
  if (!existing) throw productDisabled({ productId: String(id) });
  const fields = validateProductBody(body, { partial: true });
  const cols = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(`${k} = ?`);
    params.push(v);
  }
  if (!cols.length) return serializeProduct(existing);
  cols.push('updatedAt = ?');
  params.push(nowIso());
  params.push(existing.id);
  db.prepare(`UPDATE products SET ${cols.join(', ')} WHERE id = ?`).run(...params);
  writeAudit({ email: null, action: 'product_update', target: existing.id, detail: 'update' });
  return serializeProduct(getProduct(existing.id));
}

export function softDeleteProduct(id) {
  const existing = getProduct(id);
  if (!existing) throw productDisabled({ productId: String(id) });
  db.prepare('UPDATE products SET enabled = 0, updatedAt = ? WHERE id = ?').run(nowIso(), existing.id);
  writeAudit({ email: null, action: 'product_update', target: existing.id, detail: 'disable' });
  return { ok: true };
}

// ============ 权益发放 / 回收 ============

/** 发放商品权益（调用方需在事务内）。 */
export function grantProduct(email, product, { orderId = null } = {}) {
  const em = normalize(email);
  if (product.type === 'storage_pack') {
    const expiresAt = Number(product.durationDays) > 0 ? isoPlusDays(Number(product.durationDays)) : null;
    db.prepare(
      `INSERT INTO storage_grants (id, email, bytes, expiresAt, orderId, createdAt) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(genId('gr'), em, String(product.storageBytes), expiresAt, orderId, nowIso());
  } else if (product.type === 'group_upgrade') {
    const expiresAt = Number(product.durationDays) > 0 ? isoPlusDays(Number(product.durationDays)) : null;
    db.prepare('UPDATE users SET groupId = ?, groupExpiresAt = ? WHERE email = ?')
      .run(product.groupId, expiresAt, em);
  }
}

/** 回收商品权益（退款时调用，调用方需在事务内）。 */
export function revokeGrant(email, product, { orderId = null } = {}) {
  const em = normalize(email);
  if (product.type === 'storage_pack') {
    const stmt = orderId
      ? 'DELETE FROM storage_grants WHERE email = ? AND orderId = ?'
      : 'DELETE FROM storage_grants WHERE email = ? AND orderId IS NULL';
    db.prepare(stmt).run(em, ...(orderId ? [orderId] : []));
  } else if (product.type === 'group_upgrade') {
    const def = defaultGroup();
    db.prepare('UPDATE users SET groupId = ?, groupExpiresAt = NULL WHERE email = ?')
      .run(def ? def.id : null, em);
  }
}

// ============ 订单 ============

function genOrderNo() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rand = crypto.randomBytes(3).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).padEnd(6, '0');
  return `R6-${ymd}-${rand}`;
}

function genRecoverToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function serializeOrder(o) {
  return {
    id: o.id,
    orderNo: o.orderNo,
    email: o.email || null,
    productId: o.productId || null,
    shareToken: o.shareToken || null,
    amountMinor: Number(o.amountMinor || 0),
    currency: o.currency || 'CNY',
    pointsUsed: Number(o.pointsUsed || 0),
    status: o.status,
    channel: o.channel,
    provider: o.provider,
    recoverToken: o.recoverToken || null,
    providerRef: o.providerRef || null,
    paidAt: o.paidAt || null,
    refundedAt: o.refundedAt || null,
    cancelledAt: o.cancelledAt || null,
    expiresAt: o.expiresAt || null,
    note: o.note || null,
    createdAt: o.createdAt,
  };
}

export function getOrderByOrderNo(orderNo) {
  return db.prepare('SELECT * FROM orders WHERE orderNo = ?').get(String(orderNo));
}

export function listOrders({ status = null, channel = null, email = null } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (channel) { where.push('channel = ?'); params.push(channel); }
  if (email) { where.push('email = ?'); params.push(normalize(email)); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = db.prepare(
    `SELECT * FROM orders ${sqlWhere} ORDER BY createdAt DESC LIMIT 200`
  ).all(...params).map(serializeOrder);
  return { items };
}

/** 现金 / 线下建单：pending，等待管理员 mark-paid。 */
export function createProductOrder({ email, productId }) {
  const em = normalize(email);
  const product = getEnabledProduct(productId);
  const provider = getProvider('manual');
  const id = genId('od');
  const orderNo = genOrderNo();
  const recoverToken = genRecoverToken();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO orders (id, orderNo, email, productId, shareToken, amountMinor, currency, pointsUsed,
        status, channel, provider, recoverToken, providerRef, paidAt, refundedAt, cancelledAt, expiresAt, note, createdAt)
     VALUES (?, ?, ?, ?, NULL, ?, 'CNY', 0, 'pending', 'manual', 'manual', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
  ).run(id, orderNo, em, product.id, Number(product.priceMinor || 0), recoverToken, ts);

  const order = getOrderByOrderNo(orderNo);
  const pay = provider.createOrder({ order: serializeOrder(order) });
  return { order: serializeOrder(order), payInstructions: pay.payInstructions };
}

/** 积分下单并直接发放权益。 */
export function payPointsOrder({ email, orderNo }) {
  const em = normalize(email);
  const order = getOrderByOrderNo(orderNo);
  if (!order || normalize(order.email) !== em) throw orderNotFound();
  if (order.status === 'paid') throw orderAlreadyPaid();
  if (order.status !== 'pending') throw orderNotPending({ status: order.status });
  const product = getEnabledProduct(order.productId);
  if (!product.allowPoints || product.pointsPrice == null) throw pointsDisabled({ productId: product.id });
  const price = Number(product.pointsPrice);
  const bal = balance(em);
  if (bal < price) throw insufficientPoints({ required: price, available: bal });

  const tx = db.transaction(() => {
    writeLedger({
      email: em, delta: -price, source: 'purchase',
      refType: 'order', refId: order.id, note: product.name,
    });
    db.prepare(
      `UPDATE orders SET status = 'paid', channel = 'points', provider = 'points', pointsUsed = ?, paidAt = ?
        WHERE id = ?`
    ).run(price, nowIso(), order.id);
    grantProduct(em, product, { orderId: order.id });
  });
  tx();
  return serializeOrder(getOrderByOrderNo(orderNo));
}

/** 管理员人工标记已支付（manual 渠道唯一的 paid 路径）。 */
export function markOrderPaid(order, adminEmail) {
  if (order.status === 'paid') throw orderAlreadyPaid();
  if (order.status !== 'pending') throw orderNotPending({ status: order.status });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE orders SET status = 'paid', paidAt = ?, providerRef = COALESCE(providerRef, NULL) WHERE id = ?`)
      .run(nowIso(), order.id);
    if (order.productId) {
      const product = getProduct(order.productId);
      if (product) grantProduct(order.email, product, { orderId: order.id });
    }
    if (order.shareToken) {
      db.prepare(
        `INSERT INTO share_purchases (id, email, shareToken, orderId, createdAt) VALUES (?, ?, ?, ?, ?)`
      ).run(genId('sp'), order.email || null, order.shareToken, order.id, nowIso());
    }
  });
  tx();
  writeAudit({ email: adminEmail || 'admin', action: 'order_mark_paid', target: order.orderNo, detail: order.productId || order.shareToken });
  return serializeOrder(getOrderByOrderNo(order.orderNo));
}

/** 退款：积分单回滚积分并回收权益。 */
export function refundOrder(order, adminEmail) {
  if (order.status !== 'paid') throw orderNotPending({ status: order.status, reason: 'only_paid_refundable' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE orders SET status = 'refunded', refundedAt = ? WHERE id = ?`).run(nowIso(), order.id);
    if (Number(order.pointsUsed || 0) > 0) {
      writeLedger({
        email: order.email, delta: Number(order.pointsUsed), source: 'refund',
        refType: 'order', refId: order.id, note: '订单退款回滚积分',
      });
    }
    if (order.productId) {
      const product = getProduct(order.productId);
      if (product) revokeGrant(order.email, product, { orderId: order.id });
    }
    if (order.shareToken) {
      db.prepare('DELETE FROM share_purchases WHERE orderId = ?').run(order.id);
    }
  });
  tx();
  writeAudit({ email: adminEmail || 'admin', action: 'order_refund', target: order.orderNo, detail: order.productId || order.shareToken });
  return serializeOrder(getOrderByOrderNo(order.orderNo));
}

/** 取消 pending 订单。 */
export function cancelOrder(order, adminEmail) {
  if (order.status !== 'pending') throw orderNotPending({ status: order.status });
  db.prepare(`UPDATE orders SET status = 'cancelled', cancelledAt = ? WHERE id = ?`).run(nowIso(), order.id);
  writeAudit({ email: adminEmail || 'admin', action: 'order_cancel', target: order.orderNo });
  return serializeOrder(getOrderByOrderNo(order.orderNo));
}

// ============ 付费分享 ============

/** 分享是否需要付费。 */
export function shareRequiresPayment(share) {
  return !!share.paidDownload && Number(share.pricePoints || 0) > 0;
}

/** 购买凭证判定：登录邮箱命中 share_purchases；匿名凭 recoverToken 命中已支付订单。 */
export function hasPurchased(share, { email = null, recoverToken = null } = {}) {
  const token = String(share.token);
  if (email) {
    const row = db.prepare(
      'SELECT id FROM share_purchases WHERE email = ? AND shareToken = ? LIMIT 1'
    ).get(normalize(email), token);
    if (row) return true;
  }
  if (recoverToken) {
    const row = db.prepare(
      `SELECT id FROM orders WHERE recoverToken = ? AND shareToken = ? AND status = 'paid' LIMIT 1`
    ).get(String(recoverToken), token);
    if (row) return true;
  }
  // 兜底：orders 表已支付记录（含匿名下单后邮箱落库的情况）
  if (email) {
    const row = db.prepare(
      `SELECT id FROM orders WHERE email = ? AND shareToken = ? AND status = 'paid' LIMIT 1`
    ).get(normalize(email), token);
    if (row) return true;
  }
  return false;
}

/** 积分购买分享：扣买家、按比例给分享者写 commission 流水；禁止自买。 */
export function buyShareWithPoints({ buyerEmail, share }) {
  const buyer = normalize(buyerEmail);
  const seller = normalize(share.email);
  if (buyer === seller) throw selfPurchaseForbidden();
  const price = Number(share.pricePoints) || 0;
  if (!shareRequiresPayment(share) || price <= 0) {
    throw badRequest('invalid_input', '该分享不是付费分享', { field: 'pricePoints' });
  }
  const bal = balance(buyer);
  if (bal < price) throw insufficientPoints({ required: price, available: bal });

  const cfg = billingConfig();
  const commission = Math.floor((price * cfg.commissionPercent) / 100);

  const id = genId('od');
  const orderNo = genOrderNo();
  const tx = db.transaction(() => {
    writeLedger({ email: buyer, delta: -price, source: 'share_spend', refType: 'share', refId: share.token, note: share.name });
    // 佣金为 0 也写一条 delta=0 的 commission 流水（可审计，C-7）
    writeLedger({ email: seller, delta: commission, source: 'commission', refType: 'share', refId: share.token, note: `分享成交佣金：${share.name}` });

    db.prepare(
      `INSERT INTO orders (id, orderNo, email, productId, shareToken, amountMinor, currency, pointsUsed,
          status, channel, provider, recoverToken, providerRef, paidAt, refundedAt, cancelledAt, expiresAt, note, createdAt)
       VALUES (?, ?, ?, NULL, ?, 0, 'CNY', ?, 'paid', 'points', 'points', NULL, NULL, ?, NULL, NULL, NULL, NULL, ?)`
    ).run(id, orderNo, buyer, share.token, price, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO share_purchases (id, email, shareToken, orderId, createdAt) VALUES (?, ?, ?, ?, ?)`
    ).run(genId('sp'), buyer, share.token, id, nowIso());
  });
  tx();
  writeAudit({ email: buyer, action: 'share_purchase', target: share.token, detail: `points:${price},commission:${commission}` });
  return { orderNo, price, commission };
}

/** 分享现金下单（匿名/登录均可，受 allowAnonymousPurchase 控制）。 */
export function createShareCashOrder({ share, email, sessionEmail }) {
  const cfg = billingConfig();
  const contactEmail = normalize(email || sessionEmail || '');
  if (!contactEmail && !cfg.allowAnonymousPurchase) throw anonymousPurchaseDisabled();

  const id = genId('od');
  const orderNo = genOrderNo();
  const recoverToken = genRecoverToken();
  db.prepare(
    `INSERT INTO orders (id, orderNo, email, productId, shareToken, amountMinor, currency, pointsUsed,
        status, channel, provider, recoverToken, providerRef, paidAt, refundedAt, cancelledAt, expiresAt, note, createdAt)
     VALUES (?, ?, ?, NULL, ?, 0, 'CNY', 0, 'pending', 'cash', 'manual', ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`
  ).run(id, orderNo, contactEmail || null, share.token, recoverToken, nowIso());
  return serializeOrder(getOrderByOrderNo(orderNo));
}
