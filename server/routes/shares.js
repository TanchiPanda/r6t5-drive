// P3 分享路由：
//  - 用户端（登录）：挂在 /api/shares，由 app.js 用 requireUser 挂载
//  - 公开端（免登录）：挂在 /api/share
// 注意：本文件同时导出两个 Router。
import { Router } from 'express';
import { db } from '../db.js';
import { readUserSession } from '../lib/session.js';
import { ApiError, badRequest, forbidden, storageError, shareCodeRequired, unauthorized, shareNotPaid } from '../lib/errors.js';
import { getDriver } from '../services/storage/driver.js';
import { getStrategy as getStrategyById } from '../services/storage/registry.js';
import { sendPreview } from '../services/preview.js';
import { shareRequiresPayment, hasPurchased } from '../services/store.js';
import { requireConfirmed } from '../middleware/auth.js';
import {
  createShare, listMyShares, getMyShare, revokeMyShare,
  loadActiveShare, publicMeta, unlockShare, unlockCookie,
  listShareDir, resolveShareFile, recordDownloadHit, isUnlocked,
} from '../services/shares.js';

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

function sessionEmail(req) {
  const s = readUserSession(req, db);
  return s?.email ? String(s.email).toLowerCase() : null;
}

/** 付费分享：未购买者访问下载/预览 → 402 share_not_paid。 */
function assertPaid(row, req) {
  if (!shareRequiresPayment(row)) return;
  const email = sessionEmail(req);
  if (!hasPurchased(row, { email, recoverToken: req.query.recover || null })) throw shareNotPaid();
}

// ============ 用户端（requireUser 由挂载处加） ============
const userRouter = Router();

// 兜底守卫：若挂载处漏挂 requireUser，返回 401 而不是 500。
userRouter.use((req, res, next) => {
  if (!req.user) return next(unauthorized('未登录'));
  next();
});

userRouter.post('/', requireConfirmed, (req, res, next) => {
  try {
    const item = createShare(req.user, req.body || {});
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

userRouter.get('/', (req, res, next) => {
  try {
    res.json({ items: listMyShares(req.user.email) });
  } catch (e) { next(e); }
});

userRouter.get('/:id', (req, res, next) => {
  try {
    res.json({ item: getMyShare(req.params.id, req.user.email) });
  } catch (e) { next(e); }
});

userRouter.delete('/:id', (req, res, next) => {
  try {
    res.json(revokeMyShare(req.params.id, req.user.email));
  } catch (e) { next(e); }
});

// ============ 公开端（免登录） ============
const publicRouter = Router();

// meta：不强制解锁，只标 locked
publicRouter.get('/:token', (req, res, next) => {
  try {
    const row = loadActiveShare(req.params.token);
    const meta = publicMeta(row);
    res.json({ share: meta, locked: !!row.codeHash && !isUnlocked(req, row) });
  } catch (e) { next(e); }
});

// 解锁
publicRouter.post('/:token/unlock', (req, res, next) => {
  try {
    const row = loadActiveShare(req.params.token);
    const code = (req.body || {}).code;
    unlockShare(row, code, clientIp(req));
    res.append('Set-Cookie', unlockCookie(row));
    res.json({ ok: true, unlocked: true });
  } catch (e) { next(e); }
});

// 目录列举
publicRouter.get('/:token/list', async (req, res, next) => {
  try {
    const row = loadActiveShare(req.params.token);
    if (!isUnlocked(req, row)) throw shareCodeRequired();
    const result = await listShareDir(row, req.query.path);
    res.json(result);
  } catch (e) { next(e); }
});

// 下载
publicRouter.get('/:token/download', async (req, res, next) => {
  try {
    const row = loadActiveShare(req.params.token);
    assertPaid(row, req);
    if (!isUnlocked(req, row)) throw shareCodeRequired();
    const { logical, node, hit } = resolveShareFile(row, req.query.path);
    if (node && node.isDir) throw badRequest('invalid_input', '不能下载目录', { field: 'path' });
    if (!hit || !hit.strategy) {
      throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略');
    }
    const strategy = node?.storageId
      ? getStrategyById(node.storageId) || hit.strategy
      : hit.strategy;

    const name = logical.split('/').pop();
    const size = node ? Number(node.sizeBytes) : undefined;
    const mime = (node && node.mime) || 'application/octet-stream';

    const stream = await getDriver(strategy.type).readStream(strategy, logical, { size, mime, name });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (size != null && Number.isFinite(size)) res.setHeader('Content-Length', size);

    let counted = false;
    const done = () => {
      if (counted) return;
      counted = true;
      recordDownloadHit(row, { email: row.email, ip: clientIp(req), bytes: size || 0 });
    };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', () => { if (!res.headersSent) next(storageError('读取文件失败')); });
    stream.pipe(res);
  } catch (e) { next(e); }
});

// 预览：统一入口，委托给 services/preview.js
publicRouter.get('/:token/preview', async (req, res, next) => {
  try {
    const row = loadActiveShare(req.params.token);
    if (!row.allowPreview) throw forbidden('该分享未开启在线预览');
    assertPaid(row, req);
    if (!isUnlocked(req, row)) throw shareCodeRequired();
    const { logical, node, hit } = resolveShareFile(row, req.query.path);
    if (!hit || !hit.strategy) {
      throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略');
    }
    await sendPreview({ req, res, strategy: hit.strategy, logicalPath: logical, node });
  } catch (e) { next(e); }
});

// 兼容：旧占位路由（/api/share/:token 已在上面定义），避免遗漏
export { userRouter, publicRouter };
export default userRouter;
