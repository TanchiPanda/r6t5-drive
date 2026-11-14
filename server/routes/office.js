// P5 OnlyOffice 在线编辑（只读预览模式）。
// 两个路由：
//   officeRouter      —— 需登录：GET /office-config 生成编辑器配置 + JWT
//   officePublicRouter —— 免登录：GET /office-file（HMAC 校验后回源文件）、
//                         POST /office-callback（P5 如实拒绝保存回写）
// 未配置 OO_DS_URL / OO_JWT_SECRET 时返回 200 enabled:false + reason，绝不假装可用。

import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { ENV } from '../config.js';
import { normalizeLogicalPath } from '../lib/paths.js';
import { ApiError, notFound, forbidden, badRequest } from '../lib/errors.js';
import { getSecret } from '../lib/session.js';
import { getOnlyOfficeConfig } from '../services/integrations.js';
import {
  documentTypeOf, buildEditorConfig, signJwt, signFileToken, verifyFileToken,
} from '../services/onlyoffice.js';
import { resolveStorage } from '../services/bindings.js';
import { getNodeByPath } from '../services/nodes.js';
import { getDriver } from '../services/storage/driver.js';

const officeRouter = Router();
const officePublicRouter = Router();

const FILE_TOKEN_TTL_MS = 10 * 60 * 1000;

function downloadUrlOf(logical) {
  return `/api/files/download?path=${encodeURIComponent(logical)}`;
}

function resolveTarget(req, logical) {
  const hit = resolveStorage({ email: req.user.email, logicalPath: logical, user: req.user });
  if (!hit || !hit.strategy) {
    throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略，请联系管理员在后台添加一条');
  }
  const node = getNodeByPath(logical);
  if (node && node.isDir) throw notFound('目录不支持在线编辑');
  return { strategy: hit.strategy, node };
}

// ---- 登录态：编辑器配置 ----
officeRouter.get('/office-config', async (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.query.path || ''), email);
    const cfg = getOnlyOfficeConfig();
    const downloadUrl = downloadUrlOf(logical);

    if (!cfg.configured) {
      return res.json({
        enabled: false,
        reason: '未配置 OnlyOffice Document Server（OO_DS_URL）',
        downloadUrl,
      });
    }
    if (!cfg.jwtConfigured) {
      return res.json({
        enabled: false,
        reason: '已配置 OO_DS_URL 但缺少 OO_JWT_SECRET，出于安全未启用编辑器',
        downloadUrl,
      });
    }

    const { node } = resolveTarget(req, logical);
    const title = logical.split('/').pop();
    const documentType = documentTypeOf(title);
    if (!documentType) {
      return res.json({
        enabled: false,
        reason: `文件类型「${title.split('.').pop() || '未知'}」不支持 OnlyOffice 在线预览`,
        downloadUrl,
      });
    }

    const secret = getSecret(db);
    const expMs = Date.now() + FILE_TOKEN_TTL_MS;
    const fileToken = signFileToken({ path: logical, email, expMs }, secret);
    const internalBase = cfg.internalBase || `http://127.0.0.1:${ENV.PORT}`;
    const fileUrl = `${internalBase}/api/files/office-file?path=${encodeURIComponent(logical)}&t=${encodeURIComponent(fileToken)}&inline=1`;
    const callbackUrl = `${internalBase}/api/files/office-callback?path=${encodeURIComponent(logical)}&t=${encodeURIComponent(fileToken)}`;

    const docKey = crypto.createHash('sha1').update(logical).digest('hex').slice(0, 32);
    const { config } = buildEditorConfig({
      documentServerUrl: cfg.documentServerUrl,
      title,
      docKey,
      fileUrl,
      callbackUrl,
      documentType,
      user: { id: req.user.id || email, name: req.user.displayName || email },
    });

    const token = signJwt(config, cfg.jwtSecret);
    res.json({
      enabled: true,
      documentServerUrl: cfg.documentServerUrl,
      config: { ...config, token },
      downloadUrl,
      mode: 'view',
    });
  } catch (e) { next(e); }
});

// ---- 免登录：HMAC 校验后回源文件（Document Server 无用户 cookie）----
officePublicRouter.get('/office-file', async (req, res, next) => {
  try {
    const logical = String(req.query.path || '');
    const token = String(req.query.t || '');
    if (!logical) throw badRequest('invalid_input', '缺少 path 参数', { field: 'path' });
    const secret = getSecret(db);
    const payload = verifyFileToken(token, secret, logical);
    if (!payload) throw forbidden('文件访问链接无效或已过期（HMAC 校验失败）');

    const owner = payload.u || logical.split('/')[0];
    const safeLogical = normalizeLogicalPath(logical, owner);
    const hit = resolveStorage({ email: owner, logicalPath: safeLogical, user: null });
    if (!hit || !hit.strategy) throw notFound('文件不存在');
    const node = getNodeByPath(safeLogical);
    if (node && node.isDir) throw notFound('目录不可下载');

    const strategy = hit.strategy;
    const size = node ? Number(node.sizeBytes) : undefined;
    const mime = (node && node.mime) || 'application/octet-stream';
    const name = safeLogical.split('/').pop();

    const stream = await getDriver(strategy.type).readStream(strategy, safeLogical, { size, mime, name });
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (size != null) res.setHeader('Content-Length', size);
    stream.pipe(res);
    stream.on('error', () => { if (!res.headersSent) next(notFound('文件读取失败')); });
  } catch (e) { next(e); }
});

// ---- 免登录：OnlyOffice 保存回调（P5 只读预览，如实拒绝）----
officePublicRouter.post('/office-callback', async (req, res, next) => {
  try {
    const logical = String(req.query.path || '');
    const token = String(req.query.t || '');
    const secret = getSecret(db);
    const payload = verifyFileToken(token, secret, logical || undefined);
    if (!payload) throw forbidden('回调链接无效或已过期（HMAC 校验失败）');
    // P5 未实现保存回写：只读预览模式，不接收 Document Server 的回写。
    res.json({ error: 1, message: 'P5 未实现保存回写（只读预览模式）' });
  } catch (e) { next(e); }
});

export default officeRouter;
export { officePublicRouter };
