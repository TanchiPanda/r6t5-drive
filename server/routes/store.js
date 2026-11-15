// P9-C 用户端商店路由（挂在 /api/store，requireUser 由挂载处加）。
import { Router } from 'express';
import { balance } from '../services/points.js';
import {
  listProducts, createProductOrder, payPointsOrder,
} from '../services/store.js';
import { redeem, preview } from '../services/redeem.js';
import { billingConfig } from '../services/billing-config.js';
import { quotaForUser, resolveGroup } from '../services/quota.js';
import { badRequest } from '../lib/errors.js';

const router = Router();

router.get('/products', (req, res, next) => {
  try {
    res.json({ items: listProducts() });
  } catch (e) { next(e); }
});

router.get('/me', (req, res, next) => {
  try {
    const user = req.user;
    const group = resolveGroup(user);
    const cfg = billingConfig();
    const quota = quotaForUser(user);
    res.json({
      points: balance(user.email),
      groupId: user.groupId || null,
      groupName: group ? group.name : null,
      groupExpiresAt: user.groupExpiresAt || null,
      spaceLimitBytes: quota.spaceLimitBytes,
      storeNavEnabled: cfg.storeNavEnabled,
      allowAnonymousPurchase: cfg.allowAnonymousPurchase,
      commissionPercent: cfg.commissionPercent,
    });
  } catch (e) { next(e); }
});

router.post('/orders', (req, res, next) => {
  try {
    const { productId } = req.body || {};
    if (!productId) throw badRequest('invalid_input', 'productId 不能为空', { field: 'productId' });
    const { order, payInstructions } = createProductOrder({ email: req.user.email, productId });
    res.status(201).json({ orderNo: order.orderNo, amountMinor: order.amountMinor, payInstructions });
  } catch (e) { next(e); }
});

router.post('/orders/:orderNo/pay-points', (req, res, next) => {
  try {
    const order = payPointsOrder({ email: req.user.email, orderNo: req.params.orderNo });
    res.json({ ok: true, order });
  } catch (e) { next(e); }
});

router.post('/redeem', (req, res, next) => {
  try {
    const code = (req.body || {}).code;
    if (!code) throw badRequest('invalid_input', '兑换码不能为空', { field: 'code' });
    const result = redeem(req.user.email, code);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/redeem/:code/preview', (req, res, next) => {
  try {
    res.json({ item: preview(req.params.code, req.user.email) });
  } catch (e) { next(e); }
});

export default router;
