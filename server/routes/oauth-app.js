// OAuth 应用接入公开端点（P9-D1）。
//  - GET  /api/oauth/authorize  授权页（需登录会话；确认后 302 回 redirect_uri 带 code）
//  - POST /api/oauth/token      授权码 / 刷新令牌换 access_token（post 与 basic 客户端认证）
//  - POST /api/oauth/revoke     撤销令牌
//  - GET  /api/oauth/me         Bearer 访问的当前授权身份
// 注意：本路由与 /api/auth/oauth（第三方社交登录回调）互不相关。
import { Router } from 'express';
import { db } from '../db.js';
import { readUserSession } from '../lib/session.js';
import { getUserByEmail } from '../services/nodes.js';
import {
  badRequest, oauthInvalidClient, oauthInvalidGrant, oauthUnsupportedGrant,
  bearerInvalid,
} from '../lib/errors.js';
import * as oauth from '../services/oauth/apps.js';

const router = Router();

/** 从 Basic 头或表单/JSON body 解析客户端凭据 */
function extractClientCredentials(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    let decoded = '';
    try { decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8'); } catch { decoded = ''; }
    const idx = decoded.indexOf(':');
    if (idx <= 0) return { clientId: '', clientSecret: '' };
    return { clientId: decoded.slice(0, idx), clientSecret: decoded.slice(idx + 1) };
  }
  const body = req.body || {};
  return { clientId: body.client_id || '', clientSecret: body.client_secret || '' };
}

/** Bearer 解析；成功挂 req.oauthPrincipal，否则返回 null */
function resolveBearer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return null;
  const principal = oauth.verifyAccessToken(auth.slice(7).trim());
  return principal;
}

function redirectUriAllowed(client, redirectUri) {
  const uris = client.redirectUris || [];
  return uris.includes(String(redirectUri || ''));
}

function authorizePageHtml({ client, scopeList, redirectUri, state, nextUrl }) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const scopeText = scopeList.join('、');
  const hidden = Object.entries({
    client_id: client.clientId, redirect_uri: redirectUri, response_type: 'code', state: state || '', scope: scopeList.join(' '),
  }).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('\n    ');
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权确认 · R6T5 Drive</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/base.css">
</head><body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div class="card" style="max-width:520px">
    <div class="badge" style="margin-bottom:14px">OAuth 授权</div>
    <h1 style="font-size:var(--fs-xl);margin-bottom:8px">「${esc(client.name)}」请求访问</h1>
    <p class="muted" style="font-size:var(--fs-sm);margin-bottom:16px">
      该应用将获得以下权限：<strong>${esc(scopeText)}</strong>。<br>
      授权后将跳转回：<code>${esc(redirectUri)}</code>
    </p>
    ${client.description ? `<p class="muted" style="font-size:var(--fs-sm);margin-bottom:16px">${esc(client.description)}</p>` : ''}
    <form method="post" action="${esc(nextUrl)}">
      ${hidden}
      <input type="hidden" name="confirm" value="1">
      <div class="row" style="justify-content:flex-end;gap:10px">
        <a class="btn ghost" href="/">取消</a>
        <button class="btn primary" type="submit">同意授权</button>
      </div>
    </form>
  </div>
</div>
</body></html>`;
}

// GET /api/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&state=...&scope=...
router.get('/authorize', (req, res, next) => {
  try {
    const q = req.query || {};
    const session = readUserSession(req, db);
    if (!session || !session.email) {
      const next = encodeURIComponent(req.originalUrl);
      return res.redirect(`/login?next=${next}`);
    }
    const email = String(session.email).toLowerCase();
    const user = getUserByEmail(email);
    if (!user || user.status === 'banned' || user.disabled === 1) {
      throw oauthInvalidGrant('当前账号不可用于授权');
    }

    const client = oauth.getClientByClientId(q.client_id);
    if (!client || !client.enabled) throw oauthInvalidClient('client_id 无效或应用已禁用');
    if (!q.redirect_uri || !redirectUriAllowed(client, q.redirect_uri)) {
      throw badRequest('invalid_redirect_uri', 'redirect_uri 未登记或与登记值不一致（需精确匹配）', { registered: client.redirectUris });
    }
    const requested = oauth.normalizeScopes(q.scope || client.scopes);
    oauth.assertScopeSubset(requested, client.scopes);

    const nextUrl = '/api/oauth/authorize';
    if (q.confirm !== '1') {
      res.type('text/html; charset=utf-8').send(authorizePageHtml({
        client, scopeList: requested, redirectUri: q.redirect_uri, state: q.state, nextUrl,
      }));
      return;
    }

    const code = oauth.issueCode({ clientId: client.clientId, email, scopes: requested, redirectUri: q.redirect_uri });
    const params = new URLSearchParams({ code });
    if (q.state) params.set('state', String(q.state));
    res.redirect(`${q.redirect_uri}?${params.toString()}`);
  } catch (e) { next(e); }
});

// POST /api/oauth/token
router.post('/token', (req, res, next) => {
  try {
    const body = req.body || {};
    const { clientId, clientSecret } = extractClientCredentials(req);
    // 校验客户端（禁用 / 凭据错 → 401 oauth_invalid_client）
    oauth.authenticateClient(clientId, clientSecret);

    const grantType = body.grant_type;
    if (grantType === 'authorization_code') {
      const code = String(body.code || '');
      const redirectUri = String(body.redirect_uri || '');
      const granted = oauth.consumeCode(code, clientId, redirectUri);
      if (!granted) throw oauthInvalidGrant('授权码无效、已过期或已被使用');
      const tokens = oauth.issueTokens({ clientId, email: granted.email, scopes: granted.scopes });
      return res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: granted.scopes.join(' '),
      });
    }
    if (grantType === 'refresh_token') {
      const tokens = oauth.rotateRefreshToken(String(body.refresh_token || ''));
      return res.json({
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: oauth.verifyAccessToken(tokens.accessToken)?.scopes.join(' ') || 'read',
      });
    }
    throw oauthUnsupportedGrant({ grant_type: grantType });
  } catch (e) { next(e); }
});

// POST /api/oauth/revoke  { access_token? | refresh_token? }
router.post('/revoke', (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.access_token) oauth.revokeAccessToken(String(body.access_token));
    if (body.refresh_token) oauth.revokeRefreshToken(String(body.refresh_token));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// GET /api/oauth/me  —— Bearer 访问的授权身份（只开放只读资料，不含文件权限）
router.get('/me', (req, res, next) => {
  try {
    const principal = resolveBearer(req);
    if (!principal) throw bearerInvalid();
    res.json({
      email: principal.email,
      clientId: principal.clientId,
      clientName: principal.clientName,
      scopes: principal.scopes,
    });
  } catch (e) { next(e); }
});

export default router;
