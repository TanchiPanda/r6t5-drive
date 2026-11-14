import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import { db } from '../db.js';
import { ENV } from '../config.js';
import { normalizeLogicalPath, validateName, joinLogical, parentOf } from '../lib/paths.js';
import {
  badRequest, notFound, conflict, quotaFile, quotaSpace, quotaTraffic, storageError,
  ApiError, strategyReadonly,
} from '../lib/errors.js';
import {
  getNodeByPath, insertNode, listChildren, childrenCount, descendantsOf,
  softDeleteRecursive, searchNodes,
} from '../services/nodes.js';
import { quotaForUser } from '../services/quota.js';
import { recordTraffic } from '../services/traffic.js';
import { writeAudit } from '../services/audit.js';
import * as registry from '../services/storage/registry.js';
import { getDriver, driverCaps } from '../services/storage/driver.js';
import { resolveStorage } from '../services/bindings.js';
import { nowIso } from '../lib/format.js';

const router = Router();

const TMP_DIR = path.join(ENV.STORAGE_ROOT, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, TMP_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024 * 1024 },
});

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

export function ensureRootNode(email) {
  let root = getNodeByPath(email);
  if (!root) root = insertNode({ email, parentId: null, name: email, path: email, isDir: true });
  return root;
}

/** 目标路径的存储策略：绑定 > 用户组默认 > 站点默认 */
function resolveFor(req, logicalPath) {
  const hit = resolveStorage({ email: req.user.email, logicalPath, user: req.user });
  if (!hit || !hit.strategy) {
    throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略，请联系管理员在后台添加一条');
  }
  return hit;
}

function assertWritable(strategy, logicalPath) {
  if (!driverCaps(strategy.type).write || strategy.readOnly) {
    const shown = logicalPath.split('/').slice(1).join('/') || '用户根';
    throw strategyReadonly(`目录「${shown}」绑定的是只读存储策略（${strategy.name}），不能上传、删除或改名`, {
      strategyId: strategy.id, strategyType: strategy.type,
    });
  }
}

function strategyView(hit) {
  const s = hit.strategy;
  return {
    id: s.id, name: s.name, type: s.type,
    readOnly: !!s.readOnly || !driverCaps(s.type).write,
    region: s.region || '',
    matchedBy: hit.matchedBy,
    bindingId: hit.bindingId || null,
    bindingPath: hit.matchedBy === 'binding' ? (hit.bindingPath || '') : null,
  };
}

/** 补齐缺失的上级目录节点（便于直接写入远端已有目录） */
function ensureDirNodes(email, logicalDir) {
  const root = ensureRootNode(email);
  if (logicalDir === email) return root;
  const segs = logicalDir.split('/');
  let acc = segs[0];
  let parent = getNodeByPath(acc) || root;
  for (let i = 1; i < segs.length; i += 1) {
    acc = `${acc}/${segs[i]}`;
    let node = getNodeByPath(acc);
    if (!node) node = insertNode({ email, parentId: parent.id, name: segs[i], path: acc, isDir: true });
    parent = node;
  }
  return parent;
}

function itemView(n, strategy) {
  if (n.isDir) {
    return {
      name: n.name, path: n.path, type: 'dir', sizeBytes: 0,
      itemCount: childrenCount(n.id), updatedAt: n.updatedAt,
    };
  }
  return {
    name: n.name, path: n.path, type: 'file', sizeBytes: Number(n.sizeBytes),
    mime: n.mime || 'application/octet-stream', updatedAt: n.updatedAt,
    storageId: n.storageId || null,
    readOnly: !!(strategy && (strategy.readOnly || !driverCaps(strategy.type).write)),
  };
}

function crumbsOf(logicalPath) {
  const segs = logicalPath.split('/');
  const crumbs = [];
  let acc = '';
  for (const s of segs) {
    acc = acc ? `${acc}/${s}` : s;
    crumbs.push({ label: s, path: acc });
  }
  return crumbs;
}

/** 远端策略的直接子项；失败降级为本地元数据，不阻塞列表 */
async function remoteChildren(strategy, logicalDir) {
  if (!strategy || !driverCaps(strategy.type).list || strategy.type === 'volume') return [];
  try {
    const rows = await getDriver(strategy.type).list(strategy, logicalDir);
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    console.warn(`[storage] 远端列举失败（${strategy.type}:${strategy.name}）：${e.message}`);
    return [];
  }
}

function strategyOfNode(node) {
  return node && node.storageId ? registry.getStrategy(node.storageId) : null;
}

// ---- 列表 ----
router.get('/', async (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.query.path || email), email);
    ensureRootNode(email);
    const hit = resolveFor(req, logical);
    const caps = driverCaps(hit.strategy.type);
    const dir = getNodeByPath(logical);
    const virtualRemote = !dir && caps.list && hit.strategy.type !== 'volume';
    if (!dir && !virtualRemote) throw notFound('目录不存在');
    if (dir && !dir.isDir) throw badRequest('invalid_input', '目标不是目录', { field: 'path' });

    const localItems = dir ? listChildren(logical).map((n) => itemView(n, hit.strategy)) : [];
    const remoteItems = await remoteChildren(hit.strategy, logical);
    const seen = new Set(localItems.map((i) => i.path));
    const merged = [...localItems];
    const ro = strategyView(hit).readOnly;
    for (const r of remoteItems) {
      if (seen.has(r.path)) continue;
      merged.push({ ...r, remote: true, readOnly: ro });
    }
    merged.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'dir' ? -1 : 1));

    res.json({
      path: logical,
      parentPath: parentOf(logical) || email,
      crumbs: crumbsOf(logical),
      items: merged,
      strategy: strategyView(hit),
      quota: quotaForUser(req.user),
    });
  } catch (e) { next(e); }
});

// ---- 建目录 ----
router.post('/folder', async (req, res, next) => {
  try {
    const email = req.user.email;
    const { path: parentDir, name } = req.body || {};
    const parentLogical = normalizeLogicalPath(String(parentDir || email), email);
    const dirName = validateName(name);
    const targetPath = joinLogical(parentLogical, dirName);

    const hit = resolveFor(req, targetPath);
    assertWritable(hit.strategy, targetPath);
    if (getNodeByPath(targetPath)) throw conflict('同名节点已存在', { path: targetPath });

    const parent = getNodeByPath(parentLogical) || ensureDirNodes(email, parentLogical);
    if (!parent || !parent.isDir) throw notFound('父目录不存在');

    await getDriver(hit.strategy.type).ensureDir(hit.strategy, targetPath);
    const node = insertNode({
      email, parentId: parent.id, name: dirName, path: targetPath, isDir: true, storageId: hit.strategy.id,
    });
    writeAudit({ email, action: 'mkdir', target: targetPath, ip: clientIp(req) });
    res.status(201).json({ path: targetPath, item: itemView(node, hit.strategy), strategy: strategyView(hit) });
  } catch (e) { next(e); }
});

// ---- 上传 ----
router.post('/upload', (req, res, next) => {
  const email = req.user.email;
  let parentLogical;
  try {
    parentLogical = normalizeLogicalPath(String(req.query.path || email), email);
  } catch (e) { return next(e); }

  upload.single('file')(req, res, (err) => {
    if (err) return next(err);
    (async () => {
      try {
        if (!req.file) throw badRequest('invalid_input', '缺少文件字段 file', { field: 'file' });
        const tmpFile = req.file.path;
        const cleanup = () => { try { fs.rmSync(tmpFile, { force: true }); } catch {} };

        let fileName;
        try {
          fileName = validateName(req.file.originalname);
        } catch (e) { cleanup(); throw e; }

        const targetPath = joinLogical(parentLogical, fileName);
        // 只读策略先拦，别把临时文件搬进不该去的地方
        const hit = resolveFor(req, targetPath);
        try { assertWritable(hit.strategy, targetPath); } catch (e) { cleanup(); throw e; }

        const parent = getNodeByPath(parentLogical) || ensureDirNodes(email, parentLogical);
        if (!parent || !parent.isDir) { cleanup(); throw notFound('目标目录不存在'); }

        const quota = quotaForUser(req.user);
        const size = Number(req.file.size);

        if (size > quota.maxFileSizeBytes) {
          cleanup();
          throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: size });
        }
        if (quota.usedBytes + size > quota.spaceLimitBytes) {
          cleanup();
          throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: size });
        }
        if (quota.traffic7dUsedBytes + size > quota.traffic7dLimitBytes) {
          cleanup();
          throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes });
        }

        const existing = getNodeByPath(targetPath);
        const overwrite = String(req.body?.overwrite) === '1';
        if (existing && !overwrite) { cleanup(); throw conflict('同名文件已存在', { path: targetPath }); }
        if (existing?.isDir) { cleanup(); throw conflict('同名目录已存在', { path: targetPath }); }

        try {
          await getDriver(hit.strategy.type).writeFromTemp(hit.strategy, targetPath, tmpFile, {
            size, mime: req.file.mimetype, name: fileName,
          });
        } catch (e) { cleanup(); throw e; }
        cleanup();

        let node;
        if (existing) {
          db.prepare('UPDATE nodes SET sizeBytes = ?, mime = ?, storageId = ?, updatedAt = ? WHERE id = ?')
            .run(size, req.file.mimetype, hit.strategy.id, nowIso(), existing.id);
          node = getNodeByPath(targetPath);
        } else {
          node = insertNode({
            email, parentId: parent.id, name: fileName, path: targetPath,
            isDir: false, sizeBytes: size, mime: req.file.mimetype, storageId: hit.strategy.id,
          });
        }
        recordTraffic(email, 'upload', size);
        writeAudit({ email, action: 'upload', target: targetPath, bytes: size, ip: clientIp(req) });
        res.status(201).json({ item: itemView(node, hit.strategy), quota: quotaForUser(req.user), strategy: strategyView(hit) });
      } catch (e) { next(e); }
    })();
  });
});

// ---- 下载（本地节点 / 远端条目都支持）----
router.get('/download', async (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.query.path || ''), email);
    const node = getNodeByPath(logical);
    if (node && node.isDir) throw badRequest('invalid_input', '不能下载目录', { field: 'path' });

    const hit = resolveFor(req, logical);
    const strategy = strategyOfNode(node) || hit.strategy;
    const name = logical.split('/').pop();
    const size = node ? Number(node.sizeBytes) : undefined;
    const mime = (node && node.mime) || 'application/octet-stream';

    const stream = await getDriver(strategy.type).readStream(strategy, logical, { size, mime, name });

    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `${String(req.query.inline) === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (size != null) res.setHeader('Content-Length', size);
    stream.pipe(res);
    let counted = false;
    const done = () => {
      if (counted) return;
      counted = true;
      recordTraffic(email, 'download', size || 0);
      writeAudit({ email, action: 'download', target: logical, bytes: size || 0, ip: clientIp(req) });
    };
    stream.on('end', done);
    stream.on('close', done);
    stream.on('error', () => { if (!res.headersSent) next(storageError('读取文件失败')); });
  } catch (e) { next(e); }
});

/** 跨策略搬运：读源 → 落本地临时文件 → 写目标 → 删源（全程流式） */
async function transferAcross(fromStrategy, toStrategy, srcPath, destPath, meta) {
  const tmpFile = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  const src = await getDriver(fromStrategy.type).readStream(fromStrategy, srcPath, meta);
  try {
    await pipeline(src, fs.createWriteStream(tmpFile));
    await getDriver(toStrategy.type).writeFromTemp(toStrategy, destPath, tmpFile, meta);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
  await getDriver(fromStrategy.type).remove(fromStrategy, srcPath, meta);
}

async function relocate(req, { srcLogical, destPath, newParentId, newName, isDir }) {
  const node = getNodeByPath(srcLogical);
  const srcHit = resolveFor(req, srcLogical);
  const destHit = resolveFor(req, destPath);
  assertWritable(srcHit.strategy, srcLogical);
  assertWritable(destHit.strategy, destPath);

  const srcStrategy = strategyOfNode(node) || srcHit.strategy;
  const destStrategy = destHit.strategy;
  const meta = { size: Number(node.sizeBytes), mime: node.mime, name: newName || node.name };

  if (srcStrategy.id === destStrategy.id) {
    if (isDir && srcStrategy.type !== 'volume') {
      throw new ApiError(400, 'storage_unsupported', '远端存储不支持直接移动目录，请逐个文件移动');
    }
    await getDriver(srcStrategy.type).rename(srcStrategy, srcLogical, destPath, meta);
  } else {
    if (isDir) throw new ApiError(400, 'storage_unsupported', '暂不支持跨存储策略移动目录，请先逐个文件移动');
    await transferAcross(srcStrategy, destStrategy, srcLogical, destPath, meta);
  }

  const tx = db.transaction(() => {
    db.prepare('UPDATE nodes SET parentId = ?, name = ?, path = ?, storageId = ?, updatedAt = ? WHERE id = ?')
      .run(newParentId, newName || node.name, destPath, destStrategy.id, nowIso(), node.id);
    if (node.isDir) {
      const descendants = descendantsOf(srcLogical).filter((d) => d.id !== node.id);
      for (const d of descendants) {
        const newDesc = destPath + d.path.slice(srcLogical.length);
        db.prepare('UPDATE nodes SET path = ?, updatedAt = ? WHERE id = ?').run(newDesc, nowIso(), d.id);
      }
    }
  });
  tx();
}

// ---- 重命名 ----
router.post('/rename', async (req, res, next) => {
  try {
    const email = req.user.email;
    const { path: srcPath, newName } = req.body || {};
    const srcLogical = normalizeLogicalPath(String(srcPath), email);
    const name = validateName(newName);
    const node = getNodeByPath(srcLogical);
    if (!node) throw notFound('节点不存在');
    const destPath = joinLogical(parentOf(srcLogical), name);
    if (getNodeByPath(destPath)) throw conflict('同名节点已存在', { path: destPath });

    await relocate(req, { srcLogical, destPath, newParentId: node.parentId, newName: name, isDir: !!node.isDir });
    const hit = resolveFor(req, destPath);
    writeAudit({ email, action: 'rename', target: `${srcLogical} → ${destPath}`, ip: clientIp(req) });
    res.json({ item: itemView(getNodeByPath(destPath), hit.strategy), strategy: strategyView(hit) });
  } catch (e) { next(e); }
});

// ---- 移动 ----
router.post('/move', async (req, res, next) => {
  try {
    const email = req.user.email;
    const { path: srcPath, targetPath } = req.body || {};
    const srcLogical = normalizeLogicalPath(String(srcPath), email);
    const destDir = normalizeLogicalPath(String(targetPath), email);
    const node = getNodeByPath(srcLogical);
    if (!node) throw notFound('节点不存在');
    const destDirNode = getNodeByPath(destDir);
    if (!destDirNode || !destDirNode.isDir) throw notFound('目标目录不存在');
    if (destDir === srcLogical || destDir.startsWith(`${srcLogical}/`)) {
      throw badRequest('invalid_input', '不能把目录移动到自身或其子目录', { field: 'targetPath' });
    }
    const destPath = joinLogical(destDir, node.name);
    if (getNodeByPath(destPath)) throw conflict('同名节点已存在', { path: destPath });

    await relocate(req, { srcLogical, destPath, newParentId: destDirNode.id, isDir: !!node.isDir });
    const hit = resolveFor(req, destPath);
    writeAudit({ email, action: 'move', target: `${srcLogical} → ${destPath}`, ip: clientIp(req) });
    res.json({ item: itemView(getNodeByPath(destPath), hit.strategy), strategy: strategyView(hit) });
  } catch (e) { next(e); }
});

// ---- 软删 ----
router.delete('/', (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.query.path || ''), email);
    const node = getNodeByPath(logical);
    if (!node) throw notFound('节点不存在');
    const hit = resolveFor(req, logical);
    assertWritable(hit.strategy, logical);

    const count = softDeleteRecursive(logical);
    writeAudit({ email, action: 'delete', target: logical, bytes: Number(node.sizeBytes), ip: clientIp(req) });
    res.json({ ok: true, trashed: count });
  } catch (e) { next(e); }
});

// ---- 搜索 ----
router.get('/search', (req, res, next) => {
  try {
    const email = req.user.email;
    const q = String(req.query.q || '').trim();
    if (!q) throw badRequest('invalid_input', '搜索关键词不能为空', { field: 'q' });
    const rows = searchNodes(email, q);
    const items = rows.map((n) => ({ ...itemView(n, strategyOfNode(n)), highlight: n.name }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
});

export default router;
export { strategyOfNode };
