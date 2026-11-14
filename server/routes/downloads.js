// P5 离线下载（aria2 JSON-RPC）。挂载点：/api/downloads（requireUser 由挂载方套）。
// 任务状态以 aria2 为唯一真相，路由只做透传；不新增数据库表。
// 未配置 ARIA2_RPC：写接口 503 integration_not_configured；列表接口 200 configured:false。
// 下载完成的文件落在 aria2 侧目录，r6t5-drive 不会自动纳入节点元数据（响应里如实给 note）。

import { Router } from 'express';
import { normalizeLogicalPath } from '../lib/paths.js';
import {
  badRequest, notFound, ApiError, strategyReadonly, integrationNotConfigured,
} from '../lib/errors.js';
import { getAria2Config } from '../services/integrations.js';
import { createAria2Client } from '../services/aria2.js';
import { resolveStorage } from '../services/bindings.js';
import { driverCaps } from '../services/storage/driver.js';
import { nowIso } from '../lib/format.js';

const router = Router();

const ALLOWED_PROTOCOLS = ['http:', 'https:', 'ftp:'];

const NOTE = 'aria2 下载完成的文件落在 aria2 侧目录，r6t5-drive 不会自动纳入本文件列表；需另行上传或同步后才可在节点元数据中查看。';

function client() {
  const cfg = getAria2Config();
  if (!cfg.configured) {
    throw integrationNotConfigured('aria2', '离线下载未启用（缺少 ARIA2_RPC 配置）');
  }
  return { cfg, client: createAria2Client(cfg) };
}

/** 校验目标目录可写：策略缺失 412；只读策略 403 strategy_readonly */
function assertDirWritable(req, logicalDir) {
  const hit = resolveStorage({ email: req.user.email, logicalPath: logicalDir, user: req.user });
  if (!hit || !hit.strategy) {
    throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略，请联系管理员在后台添加一条');
  }
  const s = hit.strategy;
  if (!driverCaps(s.type).write || s.readOnly) {
    const shown = logicalDir.split('/').slice(1).join('/') || '用户根';
    throw strategyReadonly(`目录「${shown}」绑定的是只读存储策略（${s.name}），下载完成后无法写入`, {
      strategyId: s.id, strategyType: s.type,
    });
  }
  return hit;
}

/** 逻辑目录 → aria2 侧目录：可选 ARIA2_DIR_MAP 前缀，缺省用「邮箱/相对子目录」做子目录 */
function aria2Dir(cfg, email, logicalDir) {
  const rel = logicalDir.length > email.length ? logicalDir.slice(email.length + 1) : '';
  const parts = [cfg.dirMapPrefix, email, rel].filter(Boolean);
  return parts.join('/');
}

function normalizeDir(raw, email) {
  if (raw == null || raw === '') return email;
  return normalizeLogicalPath(String(raw), email);
}

/** aria2 tellStatus → 对外视图 */
function statusView(st) {
  if (!st) return null;
  const files = Array.isArray(st.files) ? st.files.map((f) => ({
    path: f.path || '',
    length: Number(f.length || 0),
    uris: Array.isArray(f.uris) ? f.uris.map((u) => ({ uri: u.uri || '', status: u.status || '' })) : [],
  })) : [];
  const url = files[0]?.uris[0]?.uri || '';
  return {
    gid: st.gid || '',
    url,
    status: st.status || '',
    totalLength: Number(st.totalLength || 0),
    completedLength: Number(st.completedLength || 0),
    downloadSpeed: Number(st.downloadSpeed || 0),
    files,
    errorCode: st.errorCode != null && st.errorCode !== '' ? Number(st.errorCode) : null,
    errorMessage: st.errorMessage || '',
  };
}

// ---- 列表：未配置也 200，items 为空 ----
router.get('/', async (req, res, next) => {
  try {
    const cfg = getAria2Config();
    if (!cfg.configured) {
      return res.json({ configured: false, items: [], note: NOTE });
    }
    const c = createAria2Client(cfg);
    const [active, waiting, stopped] = await Promise.all([
      c.tellActive(), c.tellWaiting(), c.tellStopped(),
    ]);
    const items = [...(active || []), ...(waiting || []), ...(stopped || [])]
      .map(statusView)
      .filter(Boolean);
    res.json({ configured: true, items, note: NOTE });
  } catch (e) { next(e); }
});

// ---- 新建任务 ----
router.post('/', async (req, res, next) => {
  try {
    const { url, dir } = req.body || {};
    if (typeof url !== 'string' || !url.trim()) {
      throw badRequest('invalid_input', '下载地址 url 不能为空', { field: 'url' });
    }
    let parsed;
    try { parsed = new URL(url.trim()); } catch {
      throw badRequest('invalid_input', '下载地址不是合法 URL', { field: 'url' });
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      throw badRequest('invalid_input', `仅支持 http/https/ftp 协议，收到 ${parsed.protocol}`, { field: 'url' });
    }

    const email = req.user.email;
    const logicalDir = normalizeDir(dir, email);
    assertDirWritable(req, logicalDir);

    const { cfg, client: c } = client();
    const gid = await c.addUri([url.trim()], { dir: aria2Dir(cfg, email, logicalDir) });
    res.status(201).json({
      task: {
        id: gid,
        gid,
        url: url.trim(),
        status: 'active',
        createdAt: nowIso(),
      },
      note: NOTE,
    });
  } catch (e) { next(e); }
});

// ---- 单个任务状态 ----
router.get('/:gid', async (req, res, next) => {
  try {
    const gid = String(req.params.gid || '');
    if (!gid) throw notFound('任务不存在');
    const { client: c } = client();
    let st;
    try {
      st = await c.tellStatus(gid);
    } catch (e) {
      if (e.code === 'upstream_error') throw notFound('下载任务不存在或已被清理');
      throw e;
    }
    if (!st || !st.gid) throw notFound('下载任务不存在或已被清理');
    res.json({ task: statusView(st), note: NOTE });
  } catch (e) { next(e); }
});

// ---- 删除任务（aria2 移除 + 清除下载结果）----
router.delete('/:gid', async (req, res, next) => {
  try {
    const gid = String(req.params.gid || '');
    if (!gid) throw notFound('任务不存在');
    const { client: c } = client();
    try {
      await c.remove(gid);
    } catch (e) {
      // 已结束 / 不存在的任务 remove 可能报错，继续尝试清除结果
      if (e.code !== 'upstream_error') throw e;
    }
    try {
      await c.removeDownloadResult(gid);
    } catch (e) {
      if (e.code !== 'upstream_error') throw e;
    }
    res.json({ ok: true, note: NOTE });
  } catch (e) { next(e); }
});

export default router;
