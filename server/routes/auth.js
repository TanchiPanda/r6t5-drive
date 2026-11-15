import { Router } from 'express';
import { db, getSetting } from '../db.js';
import * as supabase from '../services/supabase.js';
import { upsertUser, publicUser } from '../services/nodes.js';
import { quotaForUser, trashCount, trashBytes, resolveGroup } from '../services/quota.js';
import { writeAudit } from '../services/audit.js';
import { setUserCookie, clearCookies, readUserSession } from '../lib/session.js';
import { requireUser } from '../middleware/auth.js';
import { loginFails, recordLoginFail, clearLoginFails } from '../middleware/auth.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { accountBanned, notSupportedInSource } from '../lib/errors.js';
import { getUserSource, isVolumeSource, verifyLocalPassword } from '../services/user-source.js';
import { ENV } from '../config.js';

const router = Router();

const EMAIL_RE = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

// volume 模式下「账号不存在 / 密码错误」对外完全一致：401 invalid_credentials，
// 仅审计 detail 与服务端日志区分（local_no_user / local_bad_password）。
function localCredentialFail(detail) {
  console.warn(`[auth] local login fail: ${detail}`);
  const e = new Error('邮箱或密码错误');
  e.status = 401; e.code = 'invalid_credentials'; e.details = {};
  return e;
}

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest('invalid_input', '邮箱与密码不能为空', { field: 'email' });
    const normalized = String(email).toLowerCase();
    const source = getUserSource();
    const key = `${normalized}|${clientIp(req)}`;
    if (loginFails(key) >= 5) {
      const e = new Error('登录尝试过多，请稍后再试');
      e.status = 429; e.code = 'rate_limited'; throw e;
    }

    if (source === 'volume') {
      // 本地账号体系：未配置 Supabase 也不应 412，直接走本地校验。
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(normalized);
      if (!user) {
        recordLoginFail(key);
        const e = localCredentialFail('local_no_user');
        writeAudit({ email: normalized, action: 'login', ip: clientIp(req), detail: 'local_no_user' });
        throw e;
      }
      if (user.status === 'banned' || user.disabled === 1) {
        recordLoginFail(key);
        writeAudit({ email: normalized, action: 'login', ip: clientIp(req), detail: 'local_banned' });
        throw accountBanned();
      }
      if (!user.passwordHash || !verifyLocalPassword(String(password), user.passwordHash)) {
        recordLoginFail(key);
        const e = localCredentialFail('local_bad_password');
        writeAudit({ email: normalized, action: 'login', ip: clientIp(req), detail: 'local_bad_password' });
        throw e;
      }
      clearLoginFails(key);
      const now = new Date().toISOString();
      db.prepare('UPDATE users SET lastLoginAt = ? WHERE id = ?').run(now, user.id);
      const session = {
        v: 1,
        email: normalized,
        accessToken: null,
        refreshToken: null,
        dev: false,
        local: true,
        exp: Date.now() + 7 * 86400000,
      };
      setUserCookie(res, db, session);
      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      writeAudit({ email: normalized, action: 'login', ip: clientIp(req), detail: 'local' });
      res.json({ ok: true, user: publicUser(fresh, resolveGroup(fresh)), setup: { next: 'ready' } });
      return;
    }

    // supabase 分支：维持现状
    if (!supabase.isConfigured()) {
      const e = new Error('尚未配置 Supabase');
      e.status = 412; e.code = 'supabase_not_configured'; throw e;
    }
    const result = await supabase.passwordLogin(normalized, password);
    if (result.status !== 200 || !result.body?.access_token) {
      recordLoginFail(key);
      const e = new Error('邮箱或密码错误');
      e.status = 401; e.code = 'invalid_credentials'; throw e;
    }
    clearLoginFails(key);
    const body = result.body;
    const uid = body.user?.id || body.sub || normalized;
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
    // volume 模式：本地账号由管理员创建，不开放自助注册。
    if (isVolumeSource()) {
      throw notSupportedInSource('当前为数据卷账号模式，请由管理员创建账号', { source: 'volume' });
    }
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
