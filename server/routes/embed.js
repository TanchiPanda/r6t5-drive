// 外部在线渲染（Google Docs Viewer / Microsoft 365）需要公网可读的短期 URL。
// 这里签发 10 分钟有效的随机短期令牌，并提供免登录的只读取流端点；
// 令牌只对单个逻辑路径有效，过期即失效，不携带会话 Cookie。
import { Router } from 'express';
import crypto from 'node:crypto';
import { normalizeLogicalPath } from '../lib/paths.js';
import { ApiError, badRequest, notFound } from '../lib/errors.js';
import { resolveStorage } from '../services/bindings.js';
import { getNodeByPath } from '../services/nodes.js';
import { getSetting } from '../db.js';
import { sendEmbedFile } from '../services/preview.js';
import { extOfPath, OFFICE_EXT, readPreviewConfig } from '../services/preview-config.js';
import { writeAudit } from '../services/audit.js';
import { logEvent } from '../lib/log.js';

const TTL_MS = 10 * 60 * 1000;

// 短期令牌只存内存：随机串，不含邮箱或路径，进程重启即全部失效。
// 同一链接会被外部渲染服务多次请求（含 Range），因此不在首次读取后删除，只在过期时清理。
const embedTokens = new Map();

function pruneTokens() {
  const now = Date.now();
  for (const [key, value] of embedTokens) {
    if (!value || value.exp <= now) embedTokens.delete(key);
  }
  // 防御性上限，避免异常刷接口把内存撑大
  if (embedTokens.size > 5000) {
    const keys = Array.from(embedTokens.keys()).slice(0, embedTokens.size - 5000);
    keys.forEach((k) => embedTokens.delete(k));
  }
}

function issueToken(payload) {
  pruneTokens();
  const token = crypto.randomBytes(24).toString('base64url');
  embedTokens.set(token, { p: payload.p, u: payload.u, exp: payload.exp });
  return token;
}

function readToken(token) {
  const hit = embedTokens.get(token);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { embedTokens.delete(token); return null; }
  return hit;
}

export const signRouter = Router();
export const publicRouter = Router();

function baseUrl(req) {
  const configured = String(getSetting('publicUrl', '') || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function isPublicHost(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    return true;
  } catch { return false; }
}

// POST /api/files/embed/sign  { path }  → { url, provider, expiresAt }
signRouter.post('/sign', async (req, res, next) => {
  try {
    const logical = normalizeLogicalPath(String(req.body?.path || ''), req.user.email);
    const ext = extOfPath(logical);
    if (!OFFICE_EXT.includes(ext) && ext !== 'pdf') {
      throw badRequest('embed_unsupported', '该类型不支持外部在线渲染', { ext });
    }
    const provider = readPreviewConfig().office;
    if (ext !== 'pdf' && provider === 'none') {
      throw badRequest('preview_disabled', '站点未启用 Office 在线打开方式，请联系管理员在「设置」里选择');
    }
    const hit = resolveStorage({ email: req.user.email, logicalPath: logical, user: req.user });
    if (!hit || !hit.strategy) throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略');
    const node = getNodeByPath(logical);
    if (!node || node.isDir) throw notFound('文件不存在');

    const payload = { p: logical, exp: Date.now() + TTL_MS, u: req.user.email };
    const token = issueToken(payload);
    const url = `${baseUrl(req)}/api/embed/file?t=${encodeURIComponent(token)}`;
    if (!isPublicHost(url)) {
      throw badRequest('embed_requires_public_url', '在线打开需要公网可访问的站点地址，请先在「设置 → 站点」填写对外地址 publicUrl');
    }
    writeAudit({ email: req.user.email, action: 'embed_open', target: logical, detail: provider });
    logEvent('embed', '生成外部预览链接', { user: req.user.email, target: logical, provider });
    res.json({ ok: true, url, provider, expiresAt: payload.exp });
  } catch (e) { next(e); }
});

// GET /api/embed/file?t=<token>  免登录、只读、inline
publicRouter.get('/file', async (req, res, next) => {
  try {
    const token = String(req.query.t || '');
    const payload = readToken(token);
    if (!payload || !payload.p || !payload.u) throw new ApiError(401, 'embed_token_invalid', '预览链接已失效，请重新打开');
    const logical = normalizeLogicalPath(String(payload.p), payload.u);
    const hit = resolveStorage({ email: payload.u, logicalPath: logical, user: { email: payload.u } });
    if (!hit || !hit.strategy) throw notFound('文件不存在');
    const node = getNodeByPath(logical);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    await sendEmbedFile({ req, res, strategy: hit.strategy, logicalPath: logical, node });
  } catch (e) { next(e); }
});
