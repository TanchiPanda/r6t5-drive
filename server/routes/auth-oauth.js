// P8-B 第三方登录（QQ 互联 / Logto / 通用 OIDC，授权码流）。
// 本文件只建路由，挂载由 app.js 整合。沙箱未做真实联调，状态见 docs/api-contract.md §P8-2。
import { Router } from 'express';
import { db } from '../db.js';
import { upsertUser, getUserByEmail } from '../services/nodes.js';
import { setUserCookie } from '../lib/session.js';
import { writeAudit } from '../services/audit.js';
import { checkEmailAllowed } from '../services/signup-policy.js';
import { integrationNotConfigured, ApiError } from '../lib/errors.js';
import * as oauth from '../services/oauth/index.js';

const router = Router();
const STATE_COOKIE = 'r6t5_oauth_state';

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

function stateCookie(value) {
  return `${STATE_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
}

function errorPage(message) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录失败</title><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/base.css"></head>
<body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div class="card" style="max-width:520px;text-align:center">
    <div class="badge danger" style="margin-bottom:14px">登录失败</div>
    <p class="muted" style="line-height:1.6">${message}</p>
    <div class="row" style="justify-content:center;margin-top:20px"><a class="btn ghost" href="/login">返回登录</a></div>
  </div>
</div></body></html>`;
}

// 免登录：只列已配置的 provider。
router.get('/providers', (req, res) => {
  res.json({ providers: oauth.listProviders() });
});

router.get('/:provider/start', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    const cfg = oauth.getProviderConfig(provider);
    if (!cfg || !cfg.configured) throw integrationNotConfigured(provider, `第三方登录「${provider}」未配置`);
    const state = oauth.signState(provider);
    const url = await oauth.authorizeUrl(provider, state, req);
    res.append('Set-Cookie', stateCookie(state));
    res.redirect(302, url);
  } catch (e) { next(e); }
});

router.get('/:provider/callback', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    const cfg = oauth.getProviderConfig(provider);
    if (!cfg || !cfg.configured) throw integrationNotConfigured(provider, `第三方登录「${provider}」未配置`);

    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const cookies = Object.fromEntries(
      (req.headers.cookie || '').split(';').map((p) => {
        const i = p.indexOf('=');
        return i > 0 ? [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())] : [p.trim(), ''];
      })
    );
    const stateOk = oauth.verifyState(state, provider) && cookies[STATE_COOKIE] === state;
    if (!code || !stateOk) {
      return res.status(400).type('text/html; charset=utf-8').send(errorPage('授权状态无效或已过期，请重新发起登录。'));
    }

    const profile = await oauth.handleCallback(provider, code, req);
    const email = String(profile.email || '').toLowerCase();
    if (!email) return res.status(400).type('text/html; charset=utf-8').send(errorPage('第三方账号未返回可用邮箱。'));

    const policy = checkEmailAllowed(email);
    if (!policy.ok) {
      return res.status(403).type('text/html; charset=utf-8').send(errorPage(policy.message));
    }

    const existing = getUserByEmail(email);
    const user = upsertUser({
      id: existing?.id || `${provider}:${profile.sub || email}`,
      email,
      displayName: profile.name || existing?.displayName || '',
    });
    // 第三方邮箱已在提供商侧验证：pending_* 直接置 active；banned 保持封禁不动。
    if (user.status !== 'banned') {
      db.prepare("UPDATE users SET status = 'active', disabled = 0 WHERE id = ? AND status != 'banned'").run(user.id);
    }

    const session = {
      v: 1,
      email,
      accessToken: null,
      refreshToken: null,
      dev: false,
      local: true,
      oauth: provider,
      exp: Date.now() + 7 * 86400000,
    };
    setUserCookie(res, db, session);
    writeAudit({ email, action: 'oauth_login', ip: clientIp(req), detail: provider });
    res.redirect(302, '/files');
  } catch (e) {
    if (e instanceof ApiError) return next(e);
    res.status(502).type('text/html; charset=utf-8').send(errorPage(`第三方登录回调失败：${e.message}`));
  }
});

export default router;
