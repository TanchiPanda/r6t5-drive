import { getSetting, setSetting, db } from '../db.js';
import { nowIso } from '../lib/format.js';

const TIMEOUT_MS = 6000;

export function getConfig() {
  const url = getSetting('supabase_url');
  const anonKey = getSetting('supabase_anon_key');
  const serviceKey = getSetting('supabase_service_key');
  const lastCheckRaw = getSetting('supabase_last_check');
  let lastCheck = null;
  try { lastCheck = lastCheckRaw ? JSON.parse(lastCheckRaw) : null; } catch { lastCheck = null; }
  return { url, anonKey, serviceKey, lastCheck };
}

export function isConfigured() {
  const c = getConfig();
  return !!(c.url && c.anonKey && c.serviceKey && c.lastCheck?.ok);
}

async function fetchJson(url, options = {}, timeout = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

/** 三步校验：health / anon settings / service admin users。全部通过才返回 ok。 */
export async function checkConfig({ url, anonKey, serviceKey }) {
  const base = normalizeBase(url);
  if (!/^https?:\/\/.+/i.test(base)) {
    return { ok: false, reason: 'URL 必须以 http:// 或 https:// 开头', checks: { auth: false, rest: false, admin: false } };
  }
  const started = Date.now();

  // 1. health
  let health;
  try {
    health = await fetchJson(`${base}/auth/v1/health`);
  } catch (e) {
    return { ok: false, reason: `无法连接 ${base}（${e.name || 'network'}）`, checks: { auth: false, rest: false, admin: false } };
  }
  if (health.status < 200 || health.status >= 300) {
    return { ok: false, reason: `health 检查返回 ${health.status}`, checks: { auth: false, rest: false, admin: false } };
  }

  // 2. anon settings
  let settings;
  try {
    settings = await fetchJson(`${base}/auth/v1/settings`, { headers: { apikey: anonKey } });
  } catch (e) {
    return { ok: false, reason: `anon key 校验请求失败（${e.name || 'network'}）`, checks: { auth: true, rest: false, admin: false } };
  }
  if (settings.status !== 200) {
    return { ok: false, reason: `anon key 校验返回 ${settings.status}`, checks: { auth: true, rest: false, admin: false } };
  }

  // 3. service admin users
  let admin;
  try {
    admin = await fetchJson(`${base}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
  } catch (e) {
    return { ok: false, reason: `service key 校验请求失败（${e.name || 'network'}）`, checks: { auth: true, rest: true, admin: false } };
  }
  if (admin.status !== 200) {
    return { ok: false, reason: `service key 校验返回 ${admin.status}`, checks: { auth: true, rest: true, admin: false } };
  }

  return {
    ok: true,
    latencyMs: Date.now() - started,
    checks: { auth: true, rest: true, admin: true },
  };
}

export function saveConfig({ url, anonKey, serviceKey }, check) {
  const run = db.transaction(() => {
    setSetting('supabase_url', normalizeBase(url));
    setSetting('supabase_anon_key', anonKey);
    setSetting('supabase_service_key', serviceKey);
    setSetting('supabase_checked_at', nowIso());
    setSetting('supabase_last_check', JSON.stringify({ ok: check.ok, at: nowIso(), latencyMs: check.latencyMs }));
  });
  run();
}

export function clearConfig() {
  setSetting('supabase_url', null);
  setSetting('supabase_anon_key', null);
  setSetting('supabase_service_key', null);
  setSetting('supabase_last_check', null);
  setSetting('supabase_checked_at', null);
}

export async function passwordLogin(email, password) {
  const c = getConfig();
  if (!c.url || !c.anonKey) throw Object.assign(new Error('not configured'), { code: 'supabase_not_configured' });
  const res = await fetchJson(`${c.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return res;
}

export async function refreshTokens(refreshToken) {
  const c = getConfig();
  const res = await fetchJson(`${c.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: c.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return res;
}

export async function fetchUser(accessToken) {
  const c = getConfig();
  return fetchJson(`${c.url}/auth/v1/user`, {
    headers: { apikey: c.anonKey, Authorization: `Bearer ${accessToken}` },
  });
}

export async function adminListUsers() {
  const c = getConfig();
  return fetchJson(`${c.url}/auth/v1/admin/users?page=1&per_page=1000`, {
    headers: { apikey: c.serviceKey, Authorization: `Bearer ${c.serviceKey}` },
  });
}

export async function adminCreateUser(email, password) {
  const c = getConfig();
  return fetchJson(`${c.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: c.serviceKey, Authorization: `Bearer ${c.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
}
