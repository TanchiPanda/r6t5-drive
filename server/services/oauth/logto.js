// P8-B Logto：复用通用 OIDC，issuer 即 Logto 端点（ Discovery 路径同 OIDC 约定）。
import * as oidc from './oidc.js';

export const PROVIDER_ID = 'logto';
export const LABEL = 'Logto';

export async function authorizeUrl(config, redirectUri, state) {
  const discovery = await oidc.discover(config.issuer);
  return oidc.authorizeUrl({
    discovery,
    clientId: config.clientId,
    redirectUri,
    state,
    scope: config.scope || 'openid email profile',
  });
}

export async function handleCallback(config, code, redirectUri) {
  const discovery = await oidc.discover(config.issuer);
  const tokens = await oidc.exchangeCode({
    discovery,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    redirectUri,
  });
  if (tokens.id_token) {
    const check = oidc.validateIdToken(tokens.id_token, { issuer: config.issuer, clientId: config.clientId });
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
