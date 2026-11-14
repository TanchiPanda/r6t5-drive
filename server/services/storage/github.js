// GitHub 只读存储驱动。接口见 docs/storage-drivers.md；config 字段见 docs/api-contract.md「P2-1 github」。
// 零 npm 依赖：仅使用 Node 内置 fetch / stream。
// 键映射：key = rootPath ? rootPath + '/' + logicalPath : logicalPath
import { strategyReadonly, upstreamError, notFound } from '../../lib/errors.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const UA = 'r6t5-drive-github-driver/1.0';
const MAX_PAGES = 3; // per_page=100，最多翻 3 页

const READONLY_MSG = '该目录绑定的是只读 GitHub 仓库策略，不能上传、删除或改名';

function safeParseConfig(strategy) {
  const raw = strategy?.config;
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function normalizeKey(rel) {
  // 拒绝逃逸段（上游已拦，驱动再加一道）
  const segs = String(rel || '').split('/').filter((s) => s !== '');
  for (const seg of segs) {
    if (seg === '.' || seg === '..') throw notFound('路径非法，不能包含 .. 段');
  }
  return segs.join('/');
}

function configOf(strategy) {
  const cfg = safeParseConfig(strategy);
  const repo = String(cfg.repo || '').trim();
  const branch = String(cfg.branch || 'main').trim() || 'main';
  const rootPath = normalizeKey(cfg.rootPath || '');
  const token = typeof cfg.token === 'string' ? cfg.token.trim() : '';
  return { repo, branch, rootPath, token };
}

/** 逻辑路径 → 仓库内对象键 */
function mapKey(cfg, logicalPath) {
  const rel = normalizeKey(logicalPath || '');
  return cfg.rootPath ? `${cfg.rootPath}/${rel}` : rel;
}

/** 构造请求头；token 只存在于请求头，永不进日志/文件 */
function buildHeaders(cfg, accept) {
  const headers = {
    'User-Agent': UA,
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  return headers;
}

function isRateLimited(status, headers) {
  if (status === 429) return true;
  const remaining = headers.get('X-RateLimit-Remaining');
  return status === 403 && remaining === '0';
}

function classifyMessage(status, headers) {
  if (isRateLimited(status, headers)) return 'GitHub API 限流，请稍后重试或配置访问令牌';
  if (status === 401 || status === 403) return '令牌无权限（401/403）：检查 token 是否有效、是否具备该仓库读权限';
  if (status === 404) return '仓库或分支不存在（404）';
  return `GitHub API 返回 ${status}`;
}

/**
 * 发起请求。Node fetch 默认 follow 跟随 302；读取二进制 raw 时同样跟随到
 * raw.githubusercontent.com，然后把响应流原样交回调用方，不做内存缓冲。
 */
async function apiFetch(cfg, url, { accept } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: buildHeaders(cfg, accept), redirect: 'follow' });
  } catch (e) {
    throw upstreamError('github', `网络请求失败：${e.code || e.message}`, { url });
  }
  if (!res.ok) {
    if (isRateLimited(res.status, res.headers)) {
      throw upstreamError('github', 'GitHub API 限流，请稍后重试或配置访问令牌', { status: res.status, url });
    }
    if (res.status >= 500) {
      throw upstreamError('github', `上游服务错误（${res.status}）`, { status: res.status, url });
    }
    // 404 原样交回各方法判断（目录 → 空列表；文件 → not_found）
    if (res.status === 404) {
      const err = upstreamError('github', 'GitHub 资源不存在（404）', { status: res.status, url });
      err.status = 404;
      throw err;
    }
    const msg = classifyMessage(res.status, res.headers);
    const err = upstreamError('github', msg, { status: res.status, url });
    err.status = res.status;
    throw err;
  }
  return res;
}

function listUrl(cfg, key) {
  const q = new URLSearchParams({ ref: cfg.branch, per_page: '100' });
  const tail = key ? `/${encodeURIComponent(key).split('/').map(encodeURIComponent).join('/')}` : '';
  return `${API_BASE}/repos/${cfg.repo}/contents${tail}?${q.toString()}`;
}

export const githubDriver = {
  type: 'github',
  caps: { read: true, write: false, list: true, range: false },

  ensureDir() { throw strategyReadonly(READONLY_MSG); },
  writeFromTemp() { throw strategyReadonly(READONLY_MSG); },
  remove() { throw strategyReadonly(READONLY_MSG); },
  rename() { throw strategyReadonly(READONLY_MSG); },

  /**
   * 列出逻辑目录的直接子项。
   * 目录不存在（404）→ 返回 []（空目录显示为空态），不抛错。
   */
  async list(strategy, logicalDir) {
    const cfg = configOf(strategy);
    if (!cfg.repo) throw upstreamError('github', '策略缺少 repo 配置');
    const dirKey = mapKey(cfg, logicalDir || '');

    const entries = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = listUrl(cfg, dirKey);
      let res;
      try {
        res = await apiFetch(cfg, url);
      } catch (e) {
        // 目录不存在（404）→ 空列表，不抛错（空目录显示为空态）
        if (e.status === 404) return [];
        throw e;
      }
      let body;
      try { body = await res.json(); } catch { body = null; }

      if (!Array.isArray(body)) {
        throw upstreamError('github', 'Contents API 返回格式异常', { status: res.status, url });
      }

      for (const entry of body) {
        const relPath = String(entry.path || '').split('/');
        // 去掉 rootPath 前缀，还原为逻辑路径
        const rootSegs = cfg.rootPath ? cfg.rootPath.split('/') : [];
        const logicalSegs = rootSegs.length ? relPath.slice(rootSegs.length) : relPath;
        entries.push({
          name: String(entry.name || logicalSegs[logicalSegs.length - 1] || ''),
          path: logicalSegs.join('/'),
          type: entry.type === 'dir' ? 'dir' : 'file',
          sizeBytes: Number(entry.size || 0),
          updatedAt: null, // Contents API 不提供 mtime，不编造
          remote: true,
        });
      }

      // 分页：Link 头含 rel="next" 则继续翻页
      const link = res.headers.get('link') || '';
      const hasNext = /<[^>]+>;\s*rel="next"/.test(link);
      if (!hasNext || body.length < 100) break;
    }
    return entries;
  },

  /**
   * 流式下载：Contents API 带 raw Accept 头；302 到 raw.githubusercontent.com 由
   * fetch 自动跟随，直接返回响应流（Web ReadableStream），不先 buffer。
   */
  async readStream(strategy, logicalPath) {
    const cfg = configOf(strategy);
    if (!cfg.repo) throw upstreamError('github', '策略缺少 repo 配置');
    const key = mapKey(cfg, logicalPath || '');
    if (!key) throw notFound('文件路径为空');

    let res;
    try {
      res = await apiFetch(cfg, listUrl(cfg, key), { accept: 'application/vnd.github.raw' });
    } catch (e) {
      if (e.status === 404) throw notFound('文件不存在于 GitHub 仓库');
      throw e;
    }

    // 响应体即流；调用方（路由层）按 stream 消费
    return res.body;
  },

  /** 连通性自检，不抛异常；失败返回 ok:false。 */
  async test(strategy) {
    const cfg = configOf(strategy);
    if (!cfg.repo) return { ok: false, message: '策略缺少 repo 配置', details: { branch: cfg.branch } };

    const start = Date.now();
    const repoUrl = `${API_BASE}/repos/${cfg.repo}`;
    let res;
    try {
      res = await fetch(repoUrl, { headers: buildHeaders(cfg), redirect: 'follow' });
    } catch (e) {
      return { ok: false, message: `网络请求失败：${e.code || e.message}`, details: { repo: cfg.repo, branch: cfg.branch } };
    }

    const latencyMs = Date.now() - start;
    const details = { repo: cfg.repo, branch: cfg.branch, latencyMs };
    try {
      const repoJson = await res.json().catch(() => null);
      if (repoJson && typeof repoJson.private === 'boolean') details.private = repoJson.private;
    } catch { /* 忽略解析失败 */ }

    if (!res.ok) {
      return { ok: false, message: classifyMessage(res.status, res.headers), details: { ...details, status: res.status } };
    }

    const branchUrl = `${API_BASE}/repos/${cfg.repo}/branches/${encodeURIComponent(cfg.branch)}`;
    let branchRes;
    try {
      branchRes = await fetch(branchUrl, { headers: buildHeaders(cfg), redirect: 'follow' });
    } catch (e) {
      return { ok: false, message: `分支检查网络失败：${e.code || e.message}`, details };
    }
    if (!branchRes.ok) {
      return { ok: false, message: classifyMessage(branchRes.status, branchRes.headers), details: { ...details, status: branchRes.status } };
    }

    return {
      ok: true,
      message: `已连接：${cfg.repo}@${cfg.branch}`,
      details,
    };
  },
};
