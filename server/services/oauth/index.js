// P8-B 第三方登录注册表：QQ 互联 / Logto / 通用 OIDC（授权码流）。
// 只对外暴露「已配置」的 provider；未配置的由路由回 503 integration_not_configured。
import crypto from 'node:crypto';
import { db, getSetting } from '../../db.js';
import { getSecret } from '../../lib/session.js';
import * as oidc from './oidc.js';
import * as logto from './logto.js';
import * as qq from './qq.js';

function str(key) { return (getSetting(key, '') || '').trim(); }

const DEFS = {
  qq: {
    label: qq.LABEL,
    read: () => ({ appId: str('oauth.qq.appId'), appKey: str('oauth.qq.appKey') }),
    configured: (c) => !!c.appId && !!c.appKey,
  },
  logto: {
    label: logto.LABEL,
    read: () => ({
      issuer: str('oauth.logto.issuer'),
      clientId: str('oauth.logto.clientId'),
      clientSecret: str('oauth.logto.clientSecret'),
    }),
    configured: (c) => !!c.issuer && !!c.clientId && !!c.clientSecret,
  },
  oidc: {
    label: '通用 OIDC',
    read: () => ({
      issuer: str('oauth.oidc.issuer'),
      clientId: str('oauth.oidc.clientId'),
      clientSecret: str('oauth.oidc.clientSecret'),
      scope: str('oauth.oidc.scope'),
    }),
    configured: (c) => !!c.issuer && !!c.clientId && !!c.clientSecret,
  },
};

export function getProviderConfig(id) {
  const def = DEFS[id];
  if (!def) return null;
  const config = def.read();
  return { id, label: def.label, config, configured: def.configured(config) };
}

/** 仅返回已配置 provider 的公开元信息。 */
export function listProviders() {
  return Object.keys(DEFS)
    .map((id) => getProviderConfig(id))
    .filter((p) => p.configured)
    .map((p) => ({ id: p.id, label: p.label, startUrl: `/api/auth/oauth/${p.id}/start` }));
}

/** 回调基址：settings.oauth.redirectBase 优先，否则请求 origin。 */
export function redirectBase(req) {
  const fromSetting = str('oauth.redirectBase');
  if (fromSetting) return fromSetting.replace(/\/+$/, '');
  const origin = req?.headers?.origin || (req ? `${req.protocol}://${req.headers.host}` : '');
  return (origin || 'http://localhost').replace(/\/+$/, '');
}

export function callbackUri(id, req) {
  return `${redirectBase(req)}/api/auth/oauth/${id}/callback`;
}

export async function authorizeUrl(id, state, req) {
  const p = getProviderConfig(id);
  if (!p || !p.configured) throw new Error(`provider_not_configured:${id}`);
  const redirectUri = callbackUri(id, req);
  if (id === 'qq') return qq.authorizeUrl(p.config, redirectUri, state);
  if (id === 'logto') return logto.authorizeUrl(p.config, redirectUri, state);
  // 通用 OIDC
  const discovery = await oidc.discover(p.config.issuer);
  return oidc.authorizeUrl({
    discovery,
    clientId: p.config.clientId,
    redirectUri,
    state,
    scope: p.config.scope || 'openid email profile',
  });
}

export async function handleCallback(id, code, req) {
  const p = getProviderConfig(id);
  if (!p || !p.configured) throw new Error(`provider_not_configured:${id}`);
  const redirectUri = callbackUri(id, req);
  if (id === 'qq') return qq.handleCallback(p.config, code, redirectUri);
  if (id === 'logto') return logto.handleCallback(p.config, code, redirectUri);
  const discovery = await oidc.discover(p.config.issuer);
  const tokens = await oidc.exchangeCode({
    discovery,
    clientId: p.config.clientId,
    clientSecret: p.config.clientSecret,
    code,
    redirectUri,
  });
  if (tokens.id_token) {
    const check = oidc.validateIdToken(tokens.id_token, { issuer: p.config.issuer, clientId: p.config.clientId });
    if (!check.valid) throw new Error(`id_token 校验失败：${check.reason}`);
  }
  const profile = await oidc.fetchUserInfo({ discovery, accessToken: tokens.access_token });
  return {
    email: String(profile.email || '').toLowerCase(),
    name: profile.name || profile.username || '',
    sub: profile.sub || tokens.id_token || '',
    raw: profile,
  };
}

// ---- state 签名（存 cookie，防 CSRF）----

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export function signState(provider) {
  const secret = getSecret(db);
  const payload = {
    p: provider,
    exp: Date.now() + 10 * 60 * 1000,
    n: crypto.randomBytes(8).toString('base64url'),
  };
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyState(token, provider) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const secret = getSecret(db);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Date.now()) return null;
    if (payload.p !== provider) return null;
    return payload;
  } catch {
    return null;
  }
}
