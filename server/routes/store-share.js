// P9-C 付费分享购买路由（挂在 /api/shares，先于 requireUser 的用户端分享路由注册）。
// - pay-info：免登录
// - buy-points：需登录会话
// - orders：现金下单，匿名是否允许由 billing.allowAnonymousPurchase 控制
import { Router } from 'express';
import { db } from '../db.js';
import { readUserSession } from '../lib/session.js';
import { getUserByEmail } from '../services/nodes.js';
import { loadActiveShare } from '../services/shares.js';
import {
  shareRequiresPayment, hasPurchased, buyShareWithPoints, createShareCashOrder,
} from '../services/store.js';
import { billingConfig } from '../services/billing-config.js';
import { unauthorized, badRequest, shareNotFound } from '../lib/errors.js';

const router = Router();

function sessionEmail(req) {
  const s = readUserSession(req, db);
  return s?.email ? String(s.email).toLowerCase() : null;
}

router.get('/:token/pay-info', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM shares WHERE token = ?').get(String(req.params.token));
    if (!row) throw shareNotFound();
    const email = sessionEmail(req);
    res.json({
      paidDownload: !!row.paidDownload,
      pricePoints: Number(row.pricePoints || 0),
      requiresPayment: shareRequiresPayment(row),
      self: !!email && email === String(row.email).toLowerCase(),
      alreadyPurchased: hasPurchased(row, { email }),
    });
  } catch (e) { next(e); }
});

router.post('/:token/buy-points', (req, res, next) => {
  try {
    const email = sessionEmail(req);
    if (!email) throw unauthorized('未登录');
    const user = getUserByEmail(email);
    if (!user) throw unauthorized('账号不存在');
    const row = loadActiveShare(req.params.token);
    const result = buyShareWithPoints({ buyerEmail: email, share: row });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/:token/orders', (req, res, next) => {
  try {
    const sessionEmailAddr = sessionEmail(req);
    const row = loadActiveShare(req.params.token);
    const bodyEmail = (req.body || {}).email;
    if (bodyEmail != null && bodyEmail !== '' && !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(String(bodyEmail))) {
      throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    }
    const order = createShareCashOrder({ share: row, email: bodyEmail, sessionEmail: sessionEmailAddr });
    res.status(201).json({
      orderNo: order.orderNo,
      recoverToken: order.recoverToken,
      contactEmail: order.email,
      mailSent: false,
    });
  } catch (e) { next(e); }
});

export default router;
