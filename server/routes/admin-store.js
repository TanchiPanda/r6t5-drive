// P9-C 管理端商店 / 订单 / 兑换码 / billing 设置 / Cron 状态。
import { Router } from 'express';
import {
  listProducts, createProduct, updateProduct, softDeleteProduct,
  listOrders, getOrderByOrderNo, markOrderPaid, refundOrder, cancelOrder,
} from '../services/store.js';
import {
  listCodes, generateBatch, disableCode, deleteCode, exportCsv,
} from '../services/redeem.js';
import { billingConfig, patchBillingConfig } from '../services/billing-config.js';
import { cronStatus, runJob } from '../services/cron.js';
import { orderNotFound } from '../lib/errors.js';

const router = Router();

function adminEmail(req) {
  return req.sudoUser?.email || 'admin';
}

// ---- 商品 CRUD ----
router.get('/products', (req, res, next) => {
  try {
    res.json({ items: listProducts({ includeDisabled: true }) });
  } catch (e) { next(e); }
});

router.post('/products', (req, res, next) => {
  try {
    res.status(201).json({ item: createProduct(req.body || {}) });
  } catch (e) { next(e); }
});

router.patch('/products/:id', (req, res, next) => {
  try {
    res.json({ item: updateProduct(req.params.id, req.body || {}) });
  } catch (e) { next(e); }
});

router.delete('/products/:id', (req, res, next) => {
  try {
    res.json(softDeleteProduct(req.params.id));
  } catch (e) { next(e); }
});

// ---- 订单 ----
router.get('/orders', (req, res, next) => {
  try {
    const { status, channel, email } = req.query;
    res.json(listOrders({ status, channel, email }));
  } catch (e) { next(e); }
});

function loadOrder(req) {
  const order = getOrderByOrderNo(req.params.id);
  if (!order) throw orderNotFound();
  return order;
}

router.post('/orders/:id/mark-paid', (req, res, next) => {
  try {
    const order = markOrderPaid(loadOrder(req), adminEmail(req));
    res.json({ ok: true, order });
  } catch (e) { next(e); }
});

router.post('/orders/:id/refund', (req, res, next) => {
  try {
    const order = refundOrder(loadOrder(req), adminEmail(req));
    res.json({ ok: true, order });
  } catch (e) { next(e); }
});

router.post('/orders/:id/cancel', (req, res, next) => {
  try {
    const order = cancelOrder(loadOrder(req), adminEmail(req));
    res.json({ ok: true, order });
  } catch (e) { next(e); }
});

// ---- 兑换码 ----
// export.csv 必须在 :code 路由之前注册，避免被参数路由吃掉
router.get('/redeem-codes/export.csv', (req, res) => {
  const csv = exportCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="redeem-codes.csv"');
  res.send(csv);
});

router.get('/redeem-codes', (req, res, next) => {
  try {
    res.json(listCodes({ batchId: req.query.batchId, status: req.query.status }));
  } catch (e) { next(e); }
});

router.post('/redeem-codes', (req, res, next) => {
  try {
    const result = generateBatch(req.body || {}, adminEmail(req));
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.patch('/redeem-codes/:code', (req, res, next) => {
  try {
    res.json(disableCode(req.params.code));
  } catch (e) { next(e); }
});

router.delete('/redeem-codes/:code', (req, res, next) => {
  try {
    res.json(deleteCode(req.params.code));
  } catch (e) { next(e); }
});

// ---- billing 设置 ----
router.get('/settings', (req, res) => {
  res.json(billingConfig());
});

router.patch('/settings', (req, res, next) => {
  try {
    res.json(patchBillingConfig(req.body || {}));
  } catch (e) { next(e); }
});

// ---- Cron 状态 / 手动触发 ----
router.get('/cron', (req, res) => {
  res.json(cronStatus());
});

router.post('/cron/:job/run', async (req, res, next) => {
  try {
    const rec = await runJob(req.params.job);
    res.json({ ok: true, job: req.params.job, ...rec });
  } catch (e) { next(e); }
});

export default router;
