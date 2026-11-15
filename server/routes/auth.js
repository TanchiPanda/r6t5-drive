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
import { accountBanned, notSupportedInSource, signupClosed, invalidSignup, signupRateLimited } from '../lib/errors.js';
import { getUserSource, isVolumeSource, verifyLocalPassword, hashLocalPassword } from '../services/user-source.js';
import { genId, nowIso } from '../lib/format.js';
import { ENV } from '../config.js';

const router = Router();

const EMAIL_RE = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

// ---- P7 volume 自助注册：同 IP 内存令牌桶 ----
// 容量 5，每分钟补 1 个；失败（含邮箱已存在）同样计数。
const SIGNUP_BUCKET_CAPACITY = 5;
const SIGNUP_REFILL_PER_MIN = 1;
const signupBuckets = new Map();

function signupAllow(ip) {
  const now = Date.now();
  const rec = signupBuckets.get(ip);
  if (!rec) {
    signupBuckets.set(ip, { tokens: SIGNUP_BUCKET_CAPACITY - 1, last: now });
    return true;
  }
  // 按时间补令牌：每分钟补 SIGNUP_REFILL_PER_MIN 个，封顶容量
  const elapsedMin = (now - rec.last) / 60000;
  const refill = BigInt(Math.floor(elapsedMin * SIGNUP_REFILL_PER_MIN));
  if (refill > 0n) {
    rec.tokens = Math.min(SIGNUP_BUCKET_CAPACITY, rec.tokens + Number(refill));
    rec.last = now;
  }
  if (rec.tokens <= 0) return false;
  rec.tokens -= 1;
  return true;
}

/** 注册分配组：开启 allow_self_signup 的组中按 createdAt 最前（id 兜底）取一条。 */
function pickSignupGroup() {
  return db.prepare(
    `SELECT * FROM groups WHERE allow_self_signup = 1 ORDER BY createdAt ASC, id ASC LIMIT 1`
  ).get();
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
    // ---- volume 模式：本地账号自助注册 ----
    if (isVolumeSource()) {
      const { email, password, passwordConfirm } = req.body || {};
      const normalized = String(email || '').toLowerCase();
      const ip = clientIp(req);

      // 先做参数校验：格式/长度/两次一致；非法入参不计入限流桶。
      if (!EMAIL_RE.test(normalized)) throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
      if (!password || String(password).length < 8) {
        throw badRequest('invalid_input', '密码至少 8 位', { field: 'password' });
      }
      if (String(password) !== String(passwordConfirm || '')) {
        throw badRequest('invalid_input', '两次输入的密码不一致', { field: 'passwordConfirm' });
      }

      // 限流：同 IP 令牌桶；通过参数校验的尝试（含邮箱已存在）都计数。
      if (!signupAllow(ip)) throw signupRateLimited({ field: 'email' });

      const group = pickSignupGroup();
      if (!group) {
        writeAudit({ email: normalized, action: 'signup', ip, detail: 'signup_closed' });
        throw signupClosed();
      }

      const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalized);
      if (existing) {
        // 对外统一文案，不暗示已存在/已封禁；仅内部审计记录
        writeAudit({ email: normalized, action: 'signup', ip, detail: 'signup_duplicate' });
        throw invalidSignup();
      }

      const uid = genId('u');
      const now = nowIso();
      const passwordHash = hashLocalPassword(String(password));
      db.prepare(
        `INSERT INTO users (id, email, displayName, groupId, disabled, status, passwordHash, registeredAt, lastLoginAt, createdAt)
         VALUES (?, ?, '', ?, 0, 'active', ?, ?, NULL, ?)`
      ).run(uid, normalized, group.id, passwordHash, now, now);

      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
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
      writeAudit({ email: normalized, action: 'signup', ip, detail: `local:${group.name}` });
      res.status(201).json({ ok: true, user: publicUser(fresh, resolveGroup(fresh)), setup: { next: 'ready' } });
      return;
    }

    // ---- supabase 模式：保持现有行为（allowSignup 设置 + Supabase /auth/v1/signup）----
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

// 注册入口配置：前端据此决定是否展示「注册」入口
router.get('/signup-config', (req, res, next) => {
  try {
    if (isVolumeSource()) {
      const group = pickSignupGroup();
      res.json({
        available: !!group,
        minPasswordLength: 8,
        source: 'volume',
        reason: group ? 'ok' : 'closed',
      });
      return;
    }
    const available = getSetting('allowSignup', 'false') === 'true';
    res.json({
      available,
      minPasswordLength: 8,
      source: 'supabase',
      reason: available ? 'ok' : 'admin_disabled',
    });
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
