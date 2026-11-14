import { Router } from 'express';
import * as supabase from '../services/supabase.js';
import { getSetting } from '../db.js';
import { maskKey } from '../lib/format.js';
import { supabaseUnreachable } from '../lib/errors.js';

const router = Router();

router.get('/', (req, res) => {
  const c = supabase.getConfig();
  const configured = supabase.isConfigured();
  res.json({
    configured,
    url: c.url || '',
    anonKeyMasked: maskKey(c.anonKey),
    serviceKeyMasked: maskKey(c.serviceKey),
    updatedAt: getSetting('supabase_checked_at', null),
    lastCheck: c.lastCheck,
  });
});

router.post('/', async (req, res, next) => {
  try {
    const { url, anonKey, serviceKey } = req.body || {};
    if (!url || !anonKey || !serviceKey) {
      throw supabaseUnreachable('url / anonKey / serviceKey 均不能为空', { field: 'url' });
    }
    // 先全部校验，通过后才单事务落盘；任何一步失败都不写库。
    const check = await supabase.checkConfig({ url, anonKey, serviceKey });
    if (!check.ok) {
      throw supabaseUnreachable(check.reason || '校验失败', { checks: check.checks });
    }
    supabase.saveConfig({ url, anonKey, serviceKey }, check);
    res.json({ ok: true, check: { ok: true, latencyMs: check.latencyMs, checks: check.checks } });
  } catch (e) { next(e); }
});

router.post('/test', async (req, res) => {
  const c = supabase.getConfig();
  if (!c.url || !c.anonKey || !c.serviceKey) {
    return res.json({ ok: false, error: '尚未配置', checks: { auth: false, rest: false, admin: false } });
  }
  const check = await supabase.checkConfig({ url: c.url, anonKey: c.anonKey, serviceKey: c.serviceKey });
  if (check.ok) {
    supabase.saveConfig({ url: c.url, anonKey: c.anonKey, serviceKey: c.serviceKey }, check);
    res.json({ ok: true, latencyMs: check.latencyMs, checks: check.checks });
  } else {
    res.json({ ok: false, error: check.reason, checks: check.checks });
  }
});

router.delete('/', (req, res) => {
  supabase.clearConfig();
  res.json({ ok: true });
});

export default router;
