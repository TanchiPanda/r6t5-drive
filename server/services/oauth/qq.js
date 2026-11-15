// P8-B QQ 互联（OAuth2 授权码 + openid）。
// 注意：QQ 开放平台不返回邮箱；按约定用 `<openid>@qq.local` 作为本地账号邮箱，
// 该邮箱不属于真实投递地址，确认状态视为已确认（第三方已验过 openid）。

const AUTHORIZE = 'https://graph.qq.com/oauth2.0/authorize';
const TOKEN = 'https://graph.qq.com/oauth2.0/token';
const ME = 'https://graph.qq.com/oauth2.0/me';
const PROFILE = 'https://graph.qq.com/user/get_user_info';

export const PROVIDER_ID = 'qq';
export const LABEL = 'QQ 互联';

async function getText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseTokenBody(text) {
  try {
    const json = JSON.parse(text);
    return json;
  } catch {
    const params = new URLSearchParams(text);
    return {
      access_token: params.get('access_token'),
      expires_in: Number(params.get('expires_in')),
      refresh_token: params.get('refresh_token'),
    };
  }
}

/** 解析 QQ 的 JSONP 包裹：`callback( {"openid":"..."} )`。 */
function parseJsonp(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export function authorizeUrl(config, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state,
  });
  return `${AUTHORIZE}?${params.toString()}`;
}

export async function handleCallback(config, code, redirectUri) {
  const tokenUrl = `${TOKEN}?${new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.appId,
    client_secret: config.appKey,
  }).toString()}`;
  const tokenText = await getText(tokenUrl);
  const token = parseTokenBody(tokenText);
  if (!token.access_token) throw new Error('QQ token 交换失败');

  const meText = await getText(`${ME}?access_token=${encodeURIComponent(token.access_token)}`);
  const me = parseJsonp(meText);
  if (!me?.openid) throw new Error('QQ 获取 openid 失败');

  const profileText = await getText(`${PROFILE}?${new URLSearchParams({
    access_token: token.access_token,
    oauth_consumer_key: config.appId,
    openid: me.openid,
  }).toString()}`);
  let profile = {};
  try { profile = JSON.parse(profileText); } catch { profile = {}; }

  const email = String(profile.email || '').toLowerCase() || `${me.openid}@qq.local`;
  return {
    email,
    name: profile.nickname || '',
    sub: me.openid,
    raw: profile,
    qqOpenid: me.openid,
  };
}
