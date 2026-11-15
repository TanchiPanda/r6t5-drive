// P9-C 公开订单查询（免登录，凭 recoverToken 查验；凭证不对统一 404）。
import { Router } from 'express';
import { getOrderByOrderNo } from '../services/store.js';
import { orderNotFound } from '../lib/errors.js';

const router = Router();

router.get('/:orderNo', (req, res, next) => {
  try {
    const order = getOrderByOrderNo(req.params.orderNo);
    const recover = String(req.query.recover || '');
    if (!order || !recover || order.recoverToken !== recover) throw orderNotFound();
    res.json({
      orderNo: order.orderNo,
      status: order.status,
      productId: order.productId || null,
      shareToken: order.shareToken || null,
      amountMinor: Number(order.amountMinor || 0),
      pointsUsed: Number(order.pointsUsed || 0),
      channel: order.channel,
      paidAt: order.paidAt || null,
      createdAt: order.createdAt,
    });
  } catch (e) { next(e); }
});

export default router;
