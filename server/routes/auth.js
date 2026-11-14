import { Router } from 'express';
import { db, getSetting } from '../db.js';
import * as supabase from '../services/supabase.js';
import { upsertUser, publicUser } from '../services/nodes.js';
import { quotaForUser, trashCount, trashBytes, resolveGroup } from '../services/quota.js';
import { writeAudit } from '../services/audit.js';
import { setUserCookie, clearCookies, readUserSession } from '../lib/session.js';
import { requireUser } from '../middleware/auth.js';
import { loginFails, recordLoginFail, clearLoginFails } from '../middleware/auth.js';
import { forbidden, badRequest } from '../lib/errors.js';
import { ENV } from '../config.js';

const router = Router();

const EMAIL_RE = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest('invalid_input', '邮箱与密码不能为空', { field: 'email' });
    if (!supabase.isConfigured()) {
      const e = new Error('尚未配置 Supabase');
      e.status = 412; e.code = 'supabase_not_configured'; throw e;
    }
    const key = `${email}|${clientIp(req)}`;
    if (loginFails(key) >= 5) {
      const e = new Error('登录尝试过多，请稍后再试');
      e.status = 429; e.code = 'rate_limited'; throw e;
    }
    const result = await supabase.passwordLogin(email, password);
    if (result.status !== 200 || !result.body?.access_token) {
      recordLoginFail(key);
      const e = new Error('邮箱或密码错误');
      e.status = 401; e.code = 'invalid_credentials'; throw e;
    }
    clearLoginFails(key);
    const body = result.body;
    const uid = body.user?.id || body.sub || email;
    const normalized = String(email).toLowerCase();
    const user = upsertUser({
      id: uid,
      email: normalized,
      displayName: body.user?.email || '',
    });
    const session = {
      v: 1,
      email: normalized,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      exp: Date.now() + (body.expires_in || 3600) * 1000,
      dev: false,
    };
    setUserCookie(res, db, session);
    writeAudit({ email: normalized, action: 'login', ip: clientIp(req) });
    res.json({ ok: true, user: publicUser(user, resolveGroup(user)), setup: { next: 'ready' } });
  } catch (e) { next(e); }
});

router.post('/signup', async (req, res, next) => {
  try {
    if (getSetting('allowSignup', 'false') !== 'true') throw forbidden('未开放自助注册');
    const { email, password } = req.body || {};
    if (!EMAIL_RE.test(email || '')) throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    const c = supabase.getConfig();
    const result = await fetch(`${c.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const text = await result.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (result.status !== 200 && result.status !== 201) {
      const e = new Error('注册失败');
      e.status = 401; e.code = 'invalid_credentials'; e.details = { body }; throw e;
    }
    res.json({ ok: true, pendingConfirm: !body?.confirmed_at });
  } catch (e) { next(e); }
});

router.post('/logout', (req, res) => {
  const payload = readUserSession(req, db);
  const session = payload?.email || req.user?.email || null;
  clearCookies(res);
  if (session) writeAudit({ email: session, action: 'logout', ip: clientIp(req) });
  res.json({ ok: true });
});

const meRouter = Router();
meRouter.get('/', requireUser, (req, res) => {
  const user = req.user;
  res.json({
    user: req.publicUser,
    quota: quotaForUser(user),
    trash: { count: trashCount(user.email), bytes: trashBytes(user.email) },
  });
});

export { meRouter };

router.post('/dev-login', (req, res, next) => {
  try {
    if (!ENV.DEV_AUTH) throw forbidden('DEV_AUTH 未开启，禁止本地登录');
    const { email } = req.body || {};
    const normalized = String(email || '').toLowerCase();
    if (!EMAIL_RE.test(normalized)) throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    const user = upsertUser({ id: `dev_${Buffer.from(normalized).toString('hex').slice(0, 16)}`, email: normalized });
    const session = { v: 1, email: normalized, accessToken: null, refreshToken: null, exp: Date.now() + 7 * 86400000, dev: true };
    setUserCookie(res, db, session);
    writeAudit({ email: normalized, action: 'login', ip: clientIp(req), detail: 'dev-login' });
    res.json({ ok: true, user: publicUser(user, resolveGroup(user)), setup: { next: 'ready' } });
  } catch (e) { next(e); }
});

export default router;
