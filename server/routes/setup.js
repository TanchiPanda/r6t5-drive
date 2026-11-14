import { Router } from 'express';
import { db, getSetting } from '../db.js';
import * as supabase from '../services/supabase.js';
import { listEnabled } from '../services/storage/registry.js';

const router = Router();

const HINTS = {
  supabase: '请管理员凭管理密码进入设置页配置 Supabase',
  storage: '还没有可用的存储策略，请管理员先添加一条',
  groups: '用户组不足 2 个，请管理员创建用户组',
  site: '站点信息仍是默认值，请补全站点名 / 对外地址 / 默认用户组',
  ready: '配置完成，可以使用邮箱登录',
};

function siteSettings() {
  const siteName = getSetting('siteName', 'R6T5 Drive');
  const publicUrl = getSetting('publicUrl', '');
  const defaultGroupId = getSetting('defaultGroupId', null);
  return { siteName, publicUrl, defaultGroupId };
}

function evaluate() {
  const sbConfigured = supabase.isConfigured();
  const storageReady = listEnabled().length > 0;
  const groupCount = db.prepare('SELECT COUNT(*) AS n FROM groups').get().n;
  const groupsReady = groupCount >= 2;

  const { siteName, publicUrl, defaultGroupId } = siteSettings();
  const defaultGroup = defaultGroupId
    ? db.prepare('SELECT id FROM groups WHERE id = ?').get(defaultGroupId)
    : null;
  const siteReady = !!(
    siteName && siteName !== 'R6T5 Drive' &&
    publicUrl && publicUrl.trim() !== '' &&
    defaultGroup && defaultGroup.id
  );

  let next = 'ready';
  if (!sbConfigured) next = 'supabase';
  else if (!storageReady) next = 'storage';
  else if (!groupsReady) next = 'groups';
  else if (!siteReady) next = 'site';

  const counts = {
    users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    groups: groupCount,
    strategies: db.prepare('SELECT COUNT(*) AS n FROM storage_strategies').get().n,
  };

  return {
    ready: next === 'ready',
    next,
    hint: HINTS[next],
    link: next === 'ready' ? '/login' : '/admin/login',
    linkLabel: next === 'ready' ? '前往登录' : '进入管理后台',
    checks: {
      supabase: sbConfigured,
      storage: storageReady,
      groups: groupsReady,
      site: siteReady,
    },
    site: {
      name: siteName,
      publicUrl,
      defaultGroupId: defaultGroupId || null,
      isDefaultSite: !(siteName && siteName !== 'R6T5 Drive'),
    },
    counts,
  };
}

router.get('/status', (req, res) => {
  res.json(evaluate());
});

// 管理员视角：多带一份配置详情。挂在 /api/admin/setup 下（见 app.js）
export const adminSetupRouter = Router();
adminSetupRouter.get('/status', (req, res) => {
  const body = evaluate();
  const cfg = supabase.getConfig();
  res.json({
    ...body,
    details: {
      supabaseUrl: cfg.url || '',
      lastCheckedAt: getSetting('supabase_checked_at', null),
    },
  });
});

export default router;
