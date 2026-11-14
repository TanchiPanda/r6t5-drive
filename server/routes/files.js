import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { db } from '../db.js';
import { ENV } from '../config.js';
import {
  normalizeLogicalPath, validateName, joinLogical, parentOf, basenameOf,
} from '../lib/paths.js';
import {
  badRequest, forbidden, notFound, conflict, quotaFile, quotaSpace, quotaTraffic, storageError,
} from '../lib/errors.js';
import {
  getNodeByPath, insertNode, listChildren, childrenCount, descendantsOf,
  softDeleteRecursive, restoreRecursive, deleteNodeRow, searchNodes, upsertUser,
} from '../services/nodes.js';
import { quotaForUser, resolveGroup } from '../services/quota.js';
import { recordTraffic } from '../services/traffic.js';
import { writeAudit } from '../services/audit.js';
import * as registry from '../services/storage/registry.js';
import * as volume from '../services/storage/volume.js';
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

function ensureRootNode(email) {
  let root = getNodeByPath(email);
  if (!root) {
    root = insertNode({ email, parentId: null, name: email, path: email, isDir: true });
  }
  return root;
}

function itemView(n) {
  if (n.isDir) {
    return {
      name: n.name, path: n.path, type: 'dir', sizeBytes: 0,
      itemCount: childrenCount(n.id), updatedAt: n.updatedAt,
    };
  }
  return {
    name: n.name, path: n.path, type: 'file', sizeBytes: Number(n.sizeBytes),
    mime: n.mime || 'application/octet-stream', updatedAt: n.updatedAt, storageId: n.storageId,
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

function requireStrategy() {
  const s = registry.defaultStrategy();
  if (!s) throw storageError('尚无可用的存储策略，请管理员先添加');
  return s;
}

// ---- 列表 ----
router.get('/', (req, res, next) => {
  try {
    const email = req.user.email;
    const raw = req.query.path || email;
    const logical = normalizeLogicalPath(String(raw), email);
    ensureRootNode(email);
    const dir = getNodeByPath(logical);
    if (!dir) throw notFound('目录不存在');
    if (!dir.isDir) throw badRequest('invalid_input', '目标不是目录', { field: 'path' });
    const children = listChildren(logical).map(itemView);
    res.json({
      path: logical,
      parentPath: parentOf(logical) || email,
      crumbs: crumbsOf(logical),
      items: children,
      quota: quotaForUser(req.user),
    });
  } catch (e) { next(e); }
});

// ---- 建目录 ----
router.post('/folder', (req, res, next) => {
  try {
    const email = req.user.email;
    const { path: parentDir, name } = req.body || {};
    const parentLogical = normalizeLogicalPath(String(parentDir || email), email);
    const dirName = validateName(name);
    ensureRootNode(email);
    const parent = getNodeByPath(parentLogical);
    if (!parent || !parent.isDir) throw notFound('父目录不存在');
    const targetPath = joinLogical(parentLogical, dirName);
    if (getNodeByPath(targetPath)) throw conflict('同名节点已存在', { path: targetPath });
    const strategy = requireStrategy();
    volume.ensureDirFor(strategy, targetPath);
    const node = insertNode({ email, parentId: parent.id, name: dirName, path: targetPath, isDir: true });
    writeAudit({ email, action: 'mkdir', target: targetPath, ip: clientIp(req) });
    res.status(201).json({ path: targetPath, item: itemView(node) });
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

        ensureRootNode(email);
        const parent = getNodeByPath(parentLogical);
        if (!parent || !parent.isDir) { cleanup(); throw notFound('目标目录不存在'); }

        let fileName;
        try {
          fileName = validateName(req.file.originalname);
        } catch (e) { cleanup(); throw e; }

        const quota = quotaForUser(req.user);
        const size = Number(req.file.size);

        // ① 单文件上限
        if (size > quota.maxFileSizeBytes) {
          cleanup();
          throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: size });
        }
        // ② 空间剩余
        if (quota.usedBytes + size > quota.spaceLimitBytes) {
          cleanup();
          throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: size });
        }
        // ③ 7 天上传流量
        if (quota.traffic7dUsedBytes + size > quota.traffic7dLimitBytes) {
          cleanup();
          throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes });
        }

        const targetPath = joinLogical(parentLogical, fileName);
        const existing = getNodeByPath(targetPath);
        const overwrite = String(req.body?.overwrite) === '1';
        if (existing && !overwrite) { cleanup(); throw conflict('同名文件已存在', { path: targetPath }); }

        const strategy = requireStrategy();
        if (existing?.isDir) { cleanup(); throw conflict('同名目录已存在', { path: targetPath }); }

        volume.saveUploaded(strategy, targetPath, tmpFile);

        let node;
        if (existing) {
          db.prepare(
            `UPDATE nodes SET sizeBytes = ?, mime = ?, storageId = ?, updatedAt = ? WHERE id = ?`
          ).run(size, req.file.mimetype, strategy.id, nowIso(), existing.id);
          node = getNodeByPath(targetPath);
        } else {
          node = insertNode({
            email, parentId: parent.id, name: fileName, path: targetPath,
            isDir: false, sizeBytes: size, mime: req.file.mimetype, storageId: strategy.id,
          });
        }
        recordTraffic(email, 'upload', size);
        writeAudit({ email, action: 'upload', target: targetPath, bytes: size, ip: clientIp(req) });
        res.status(201).json({ item: itemView(node), quota: quotaForUser(req.user) });
      } catch (e) { next(e); }
    })();
  });
});

// ---- 下载 ----
router.get('/download', (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.query.path || ''), email);
    const node = getNodeByPath(logical);
    if (!node) throw notFound('文件不存在');
    if (node.isDir) throw badRequest('invalid_input', '不能下载目录', { field: 'path' });
    const strategy = registry.getStrategy(node.storageId) || requireStrategy();
    const stream = volume.openReadStream(strategy, logical);
    const inline = String(req.query.inline) === '1';
    const encoded = encodeURIComponent(node.name);
    res.setHeader('Content-Type', node.mime || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`
    );
    res.setHeader('Content-Length', Number(node.sizeBytes));
    stream.pipe(res);
    stream.on('end', () => {
      recordTraffic(email, 'download', Number(node.sizeBytes));
      writeAudit({ email, action: 'download', target: logical, bytes: Number(node.sizeBytes), ip: clientIp(req) });
    });
    stream.on('error', () => { if (!res.headersSent) next(storageError('读取文件失败')); });
  } catch (e) { next(e); }
});

// ---- 重命名 ----
router.post('/rename', (req, res, next) => {
  try {
    const email = req.user.email;
    const { path: srcPath, newName } = req.body || {};
    const srcLogical = normalizeLogicalPath(String(srcPath), email);
    const node = getNodeByPath(srcLogical);
    if (!node) throw notFound('节点不存在');
    const name = validateName(newName);
    const parentDir = parentOf(srcLogical);
    const destPath = joinLogical(parentDir, name);
    if (getNodeByPath(destPath)) throw conflict('同名节点已存在', { path: destPath });

    const strategy = registry.getStrategy(node.storageId) || requireStrategy();
    volume.renamePhysical(strategy, srcLogical, destPath);

    const tx = db.transaction(() => {
      db.prepare('UPDATE nodes SET name = ?, path = ?, updatedAt = ? WHERE id = ?')
        .run(name, destPath, nowIso(), node.id);
      if (node.isDir) {
        const prefix = `${srcLogical}/`;
        const descendants = descendantsOf(srcLogical).filter((d) => d.id !== node.id);
        for (const d of descendants) {
          const newDesc = destPath + d.path.slice(srcLogical.length);
          db.prepare('UPDATE nodes SET path = ?, updatedAt = ? WHERE id = ?').run(newDesc, nowIso(), d.id);
        }
      }
    });
    tx();
    writeAudit({ email, action: 'rename', target: `${srcLogical} → ${destPath}`, ip: clientIp(req) });
    res.json({ item: itemView(getNodeByPath(destPath)) });
  } catch (e) { next(e); }
});

// ---- 移动 ----
router.post('/move', (req, res, next) => {
  try {
    const email = req.user.email;
    const { path: srcPath, targetPath } = req.body || {};
    const srcLogical = normalizeLogicalPath(String(srcPath), email);
    const destDir = normalizeLogicalPath(String(targetPath), email);
    const node = getNodeByPath(srcLogical);
    if (!node) throw notFound('节点不存在');
    const destDirNode = getNodeByPath(destDir);
    if (!destDirNode || !destDirNode.isDir) throw notFound('目标目录不存在');
    const destPath = joinLogical(destDir, node.name);
    if (getNodeByPath(destPath)) throw conflict('同名节点已存在', { path: destPath });

    const strategy = registry.getStrategy(node.storageId) || requireStrategy();
    volume.renamePhysical(strategy, srcLogical, destPath);

    const tx = db.transaction(() => {
      db.prepare('UPDATE nodes SET parentId = ?, path = ?, updatedAt = ? WHERE id = ?')
        .run(destDirNode.id, destPath, nowIso(), node.id);
      if (node.isDir) {
        const descendants = descendantsOf(srcLogical).filter((d) => d.id !== node.id);
        for (const d of descendants) {
          const newDesc = destPath + d.path.slice(srcLogical.length);
          db.prepare('UPDATE nodes SET path = ?, updatedAt = ? WHERE id = ?').run(newDesc, nowIso(), d.id);
        }
      }
    });
    tx();
    writeAudit({ email, action: 'move', target: `${srcLogical} → ${destPath}`, ip: clientIp(req) });
    res.json({ item: itemView(getNodeByPath(destPath)) });
  } catch (e) { next(e); }
});

// ---- 软删 ----
router.delete('/', (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.query.path || ''), email);
    const node = getNodeByPath(logical);
    if (!node) throw notFound('节点不存在');
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
    const items = rows.map((n) => ({ ...itemView(n), highlight: n.name }));
    res.json({ items, total: items.length });
  } catch (e) { next(e); }
});

export default router;
