// P9-C 管理端积分流水查询 / 手工调账。
import { Router } from 'express';
import { listLedger, writeLedger, balance } from '../services/points.js';
import { writeAudit } from '../services/audit.js';
import { badRequest } from '../lib/errors.js';

const router = Router();

router.get('/ledger', (req, res, next) => {
  try {
    const { email, source, limit } = req.query;
    res.json(listLedger({ email, source, limit: Number(limit) || 50 }));
  } catch (e) { next(e); }
});

router.post('/adjust', (req, res, next) => {
  try {
    const { email, delta, note } = req.body || {};
    const em = String(email || '').toLowerCase();
    const n = Number(delta);
    if (!em || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(em)) {
      throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    }
    if (!Number.isInteger(n) || n === 0) {
      throw badRequest('invalid_input', '调账额度必须为非零整数', { field: 'delta' });
    }
    const after = writeLedger({
      email: em, delta: n, source: 'admin_adjust',
      refType: null, refId: null, note: note ? String(note) : '管理员手工调账',
    });
    writeAudit({ email: adminEmail(req), action: 'points_adjust', target: em, detail: `delta:${n},balance:${after}` });
    res.json({ ok: true, email: em, balance: after, points: balance(em) });
  } catch (e) { next(e); }
});

function adminEmail(req) {
  return req.sudoUser?.email || 'admin';
}

export default router;
