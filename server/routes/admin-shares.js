// P3 管理端分享路由：挂在 /api/admin/shares，由 app.js 用 requireAdminApi 挂载。
import { Router } from 'express';
import { db } from '../db.js';
import { readAdminSession } from '../lib/session.js';
import { adminListShares, adminRevokeShare } from '../services/shares.js';

const router = Router();

router.get('/', (req, res, next) => {
  try {
    const { status, email, limit } = req.query;
    const result = adminListShares({ status, email, limit });
    res.json(result);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    // 管理员标识：取管理员会话载荷中的标识，缺省记为 admin
    const adminSession = readAdminSession(req, db);
    const adminEmail = adminSession?.email || 'admin';
    res.json(adminRevokeShare(req.params.id, adminEmail));
  } catch (e) { next(e); }
});

export default router;
