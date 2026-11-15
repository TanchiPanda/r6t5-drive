// P8-B 通用 OIDC 授权码流（Discovery / token / userinfo）。
// 说明：零依赖实现，id_token 仅做 iss/aud/exp 声明校验；JWKS 签名验签未实现，
// 风险与上线前补强项见 docs/api-contract.md §P8-2。

async function getJson(url, opts, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

/** OIDC Discovery：<issuer>/.well-known/openid-configuration。 */
export async function discover(issuer) {
  const base = String(issuer || '').replace(/\/+$/, '');
  const res = await getJson(`${base}/.well-known/openid-configuration`, {}, 'discovery');
  if (res.status !== 200 || !res.body?.authorization_endpoint) {
    throw new Error(`OIDC Discovery 失败（${res.status}）`);
  }
  return res.body;
}

export function authorizeUrl({ discovery, clientId, redirectUri, state, scope }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
    scope: scope || 'openid email profile',
  });
  return `${discovery.authorization_endpoint}?${params.toString()}`;
}

/** 用授权码换 token；client_id/secret 走请求体（多数 OIDC / Logto 兼容）。 */
export async function exchangeCode({ discovery, clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await getJson(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }, 'token');
  if (res.status !== 200 || !res.body?.access_token) {
    throw new Error(`OIDC token 交换失败（${res.status}）：${res.raw.slice(0, 200)}`);
  }
  return res.body;
}

export async function fetchUserInfo({ discovery, accessToken }) {
  const res = await getJson(discovery.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 'userinfo');
  if (res.status !== 200 || !res.body) throw new Error(`OIDC userinfo 失败（${res.status}）`);
  return res.body;
}

function decodeJwtPayload(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * 校验 id_token 的 iss / aud / exp（不验签名，见文件头说明）。
 * @returns {{valid:boolean, reason?:string}}
 */
export function validateIdToken(idToken, { issuer, clientId }) {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return { valid: false, reason: 'id_token 不可解析' };
  if (issuer && payload.iss !== issuer) return { valid: false, reason: 'iss 不匹配' };
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (clientId && !aud.includes(clientId)) return { valid: false, reason: 'aud 不匹配' };
  if (payload.exp && Number(payload.exp) * 1000 < Date.now()) return { valid: false, reason: 'id_token 已过期' };
  return { valid: true };
}
