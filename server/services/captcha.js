// P8-B 人机验证（Cloudflare Turnstile 为主，预留 hCaptcha / reCAPTCHA 适配位）。
// 服务端必须验票：前端只拿 siteKey，secret 永不下发。
import { getSetting } from '../db.js';

const BOOL = (v) => v === 'true' || v === '1' || v === true;

const PROVIDERS = {
  turnstile: {
    siteverify: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
  hcaptcha: {
    siteverify: 'https://hcaptcha.com/siteverify',
  },
  recaptcha: {
    siteverify: 'https://www.google.com/recaptcha/api/siteverify',
  },
};

const SCENES = ['onLogin', 'onSignup', 'onRecover'];

function rawConfig() {
  return {
    provider: (getSetting('captcha.provider', '') || '').trim().toLowerCase(),
    siteKey: (getSetting('captcha.siteKey', '') || '').trim(),
    secretKey: (getSetting('captcha.secretKey', '') || '').trim(),
    onLogin: BOOL(getSetting('captcha.onLogin', 'false')),
    onSignup: BOOL(getSetting('captcha.onSignup', 'false')),
    onRecover: BOOL(getSetting('captcha.onRecover', 'false')),
  };
}

/** 面向前端的公开配置（不含 secret）。 */
export function getConfig() {
  const c = rawConfig();
  return {
    provider: c.provider || null,
    siteKey: c.siteKey || null,
    onLogin: c.onLogin,
    onSignup: c.onSignup,
    onRecover: c.onRecover,
  };
}

/**
 * 某场景是否启用：provider + secret + 对应开关三者齐备才算启用。
 * @returns {{enabled:boolean, disabledReason:string|null, provider:string}}
 */
export function isEnabled(scene) {
  const c = rawConfig();
  if (!SCENES.includes(scene)) return { enabled: false, disabledReason: 'unknown_scene', provider: c.provider };
  if (!c.provider || !PROVIDERS[c.provider]) {
    return { enabled: false, disabledReason: 'provider_not_set', provider: c.provider };
  }
  if (!c.secretKey) return { enabled: false, disabledReason: 'missing_secret', provider: c.provider };
  if (!c[scene]) return { enabled: false, disabledReason: 'scene_disabled', provider: c.provider };
  return { enabled: true, disabledReason: null, provider: c.provider };
}

/** 管理接口用：各 provider 可用性与原因。 */
export function providerStatus() {
  const c = rawConfig();
  const out = {};
  for (const id of Object.keys(PROVIDERS)) {
    const active = c.provider === id;
    out[id] = {
      active,
      configured: active && !!c.secretKey,
      disabledReason: !active ? 'not_active' : (!c.secretKey ? 'missing_secret' : null),
    };
  }
  return out;
}

async function postSiteverify(provider, secret, token, ip) {
  const endpoint = PROVIDERS[provider].siteverify;
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, body: json, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 验票。场景未启用 → { ok:true, skipped:true }。
 * @returns {Promise<{ok:boolean, skipped?:boolean, code?:string, reason?:string}>}
 */
export async function verify(token, ip, scene) {
  const gate = isEnabled(scene);
  if (!gate.enabled) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string') {
    return { ok: false, code: 'captcha_missing', reason: '缺少人机验证令牌' };
  }
  const c = rawConfig();
  let result;
  try {
    result = await postSiteverify(gate.provider, c.secretKey, token, ip || '');
  } catch (err) {
    return { ok: false, code: 'captcha_upstream_error', reason: err.message || '验票服务不可达' };
  }
  const success = result.body?.success === true;
  if (!success) {
    return {
      ok: false,
      code: 'captcha_rejected',
      reason: result.body?.['error-codes']?.join(',') || `http_${result.status}`,
    };
  }
  return { ok: true };
}
