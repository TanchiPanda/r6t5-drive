import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../config.js';

// 版本更新检查（管理端）。挂载点由 app.js 整合阶段添加：
//   adminApi.use('/update-status', adminUpdateRouter)
// 守卫 requireAdminApi 在挂载时统一套在 adminApi 上，本路由不重复鉴权。

const router = Router();

const REMOTE_URL = 'https://raw.githubusercontent.com/TanchiPanda/r6t5-drive/main/latest.json';
const FETCH_TIMEOUT_MS = 5000;
const SUCCESS_TTL_MS = 5 * 60 * 1000; // 成功结果缓存 5 分钟
const FAILURE_TTL_MS = 60 * 1000;     // 失败结果缓存 60s（避免离线时每次请求都超时）

const VERSION_FILE = path.join(ENV.ROOT, 'VERSION');
const LATEST_FILE = path.join(ENV.ROOT, 'latest.json');

// 内存缓存：仅当前进程有效，不落盘、不跨进程共享。
let cache = { at: 0, ok: false, payload: null };

// 仅供临时探测脚本 / 测试重置缓存；业务代码不调用。
export function _resetUpdateCache() {
  cache = { at: 0, ok: false, payload: null };
}

function readLocalVersion() {
  let version = '';
  let builtAt = null;
  try {
    version = fs.readFileSync(VERSION_FILE, 'utf8').trim();
    builtAt = new Date(fs.statSync(VERSION_FILE).mtimeMs).toISOString();
  } catch {
    // VERSION 缺失：version 留空，builtAt 为 null，接口仍可返回降级结构。
  }
  // 本地 latest.json 的 publishedAt 作为辅助信息一并保留（不参与判定）。
  let publishedAt = null;
  try {
    publishedAt = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8')).publishedAt ?? null;
  } catch {
    /* 忽略损坏的 latest.json */
  }
  return { version, builtAt, publishedAt };
}

async function fetchRemoteLatest() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REMOTE_URL, { signal: ctrl.signal, redirect: 'follow' });
    if (res.status !== 200) {
      return { ok: false, reason: `http_${res.status}` };
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    if (!data || typeof data.version !== 'string') {
      return { ok: false, reason: 'invalid_json' };
    }
    return { ok: true, data };
  } catch {
    // 网络不可达 / 超时 / DNS 失败等统一归为 network，不抛 5xx。
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

router.get('/', async (req, res) => {
  const local = readLocalVersion();
  const current = {
    version: local.version,
    builtAt: local.builtAt,
    serverTime: new Date().toISOString(),
  };

  const now = Date.now();
  const ttl = cache.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
  let cached = false;
  let remote;
  if (cache.payload && now - cache.at < ttl) {
    remote = cache.payload;
    cached = true;
  } else {
    remote = await fetchRemoteLatest();
    cache = { at: now, ok: remote.ok, payload: remote };
  }

  if (!remote.ok) {
    // 离线 / 远端异常 / JSON 非法：一律 HTTP 200 + checked:false，由前端决定是否提示。
    return res.json({ checked: false, reason: remote.reason, current, cached });
  }

  const d = remote.data;
  const latest = {
    version: d.version,
    issueNumber: d.issueNumber ?? null,
    commentId: d.commentId ?? null,
    commentUrl: d.commentUrl ?? '',
    publishedAt: d.publishedAt ?? null,
    upgradeCommand: d.upgradeCommand ?? '',
    notes: d.notes ?? '',
  };

  // 构建号不是语义化版本（YYYYMMDD + 小写字母后缀），不做大小比较：
  // 远端版本字符串与本地不同即视为有更新。
  const hasUpdate = Boolean(local.version) && latest.version !== local.version;

  res.json({ checked: true, current, latest, hasUpdate, cached });
});

export default router;
