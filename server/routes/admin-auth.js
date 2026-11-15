import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { readAdminSession, setAdminCookie, clearCookies, verifyPassword } from '../lib/session.js';
import { writeAudit } from '../services/audit.js';
import { loginFails, recordLoginFail, clearLoginFails, requireAdminApi } from '../middleware/auth.js';
import { unauthorized, badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/format.js';
import { getUserByEmail, publicUser } from '../services/nodes.js';
import { resolveGroup } from '../services/quota.js';

const router = Router();
const FAIL_KEY = 'admin';

router.get('/session', (req, res, next) => {
  const admin = readAdminSession(req, db);
  if (admin && admin.admin) {
    res.json({
      ok: true,
      via: 'password',
      admin: {
        via: 'password',
        passwordSource: getSetting('admin_password_source', 'generated'),
        loginAt: admin.loginAt || null,
      },
    });
    return;
  }
  // sudo 用户组会话：由 requireAdminApi 解析后挂在 req.sudoUser；本路由先跑一次判定
  requireAdminApi(req, res, (err) => {
    if (err) return next(err);
    if (req.sudoUser) {
      writeAudit({ email: req.sudoUser.email, action: 'admin_login', detail: `sudo:${req.sudoUser.email}` });
      res.json({
        ok: true,
        via: 'sudo',
        admin: {
          via: 'sudo',
          email: req.sudoUser.email,
          groupId: req.sudoUser.groupId,
          groupName: req.sudoUser.groupName,
        },
      });
      return;
    }
    next(unauthorized('未登录管理员'));
  });
});

router.post('/login', (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (!password) throw badRequest('invalid_input', '密码不能为空', { field: 'password' });
    if (loginFails(FAIL_KEY) >= 5) {
      const e = new Error('登录尝试过多，请稍后再试');
      e.status = 429; e.code = 'rate_limited'; throw e;
    }
    const hash = getSetting('admin_password_hash');
    if (!verifyPassword(password, hash)) {
      recordLoginFail(FAIL_KEY);
      const e = new Error('管理密码错误');
      e.status = 401; e.code = 'invalid_admin_password'; throw e;
    }
    clearLoginFails(FAIL_KEY);
    const loginAt = nowIso();
    setAdminCookie(res, db, { v: 1, admin: true, loginAt, exp: Date.now() + 12 * 3600 * 1000 });
    setSetting('admin_login_at', loginAt);
    writeAudit({ email: 'admin', action: 'admin_login', ip: req.ip || req.socket?.remoteAddress || '' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  clearCookies(res);
  writeAudit({ email: 'admin', action: 'logout' });
  res.json({ ok: true });
});

export default router;
