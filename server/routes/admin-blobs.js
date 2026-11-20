// 管理端「文件索引」：按 Blob 维度管理物理对象与所有权（存储策略/索引号/归属邮箱/用户路径/实际文件名）。
import express from 'express';
import path from 'node:path';
import { db } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';
import { nowIso } from '../lib/format.js';
import { getStrategy } from '../services/storage/registry.js';
import { getDriver } from '../services/storage/driver.js';
import { getNodeByPath } from '../services/nodes.js';
import { getBlob, listBlobsWithOwner, releaseBlob } from '../services/blobs.js';


const router = express.Router();

function serialize(row) {
  const strategy = getStrategy(row.storageId);
  return {
    id: row.id,
    index: String(row.id).padStart(8, '0'),
    storageId: row.storageId,
    strategyName: strategy?.name || '',
    strategyType: strategy?.type || '',
    storageKey: row.storageKey,
    filename: row.filename,
    sizeBytes: Number(row.sizeBytes || 0),
    mime: row.mime,
    refCount: row.refCount,
    state: row.state,
    createdAt: row.createdAt,
    ownerEmail: row.ownerEmail || null,
    userPath: row.userPath || null,
    nodeId: row.nodeId || null,
    nodeDeleted: !!row.nodeDeletedAt,
  };
}

router.get('/', (req, res, next) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = listBlobsWithOwner({ limit, offset, q: String(req.query.q || '').trim() });
    res.json({ items: rows.map(serialize), limit, offset });
  } catch (e) { next(e); }
});

/** 转移所有权：只改 nodes.email / path / parentId，物理对象与索引号不动。 */
router.post('/:id/transfer', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const blob = getBlob(id);
    if (!blob) throw notFound('文件索引不存在');
    const node = db.prepare('SELECT * FROM nodes WHERE blobId = ? AND deletedAt IS NULL').get(id);
    if (!node) throw notFound('该索引没有活跃节点');
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw badRequest('invalid_input', '邮箱格式不正确', { field: 'email' });
    if (!db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw notFound('目标用户不存在');
    const destDir = String(req.body?.path || email).trim().replace(/\/+$/, '') || email;
    if (destDir !== email && !destDir.startsWith(`${email}/`)) throw badRequest('invalid_input', '目标路径必须位于目标用户名下', { field: 'path' });
    const destPath = `${destDir}/${node.name}`;
    if (getNodeByPath(destPath)) throw conflict('目标路径已存在同名文件', { path: destPath });
    const destParent = getNodeByPath(destDir);
    if (!destParent || !destParent.isDir) throw notFound('目标目录不存在');

    db.prepare('UPDATE nodes SET email = ?, parentId = ?, path = ?, updatedAt = ? WHERE id = ?')
      .run(email, destParent.id, destPath, nowIso(), node.id);
    writeAudit({ email: 'admin', action: 'transfer', target: `${node.path} → ${destPath}`, ip: req.ip, detail: JSON.stringify({ blobId: id }) });
    res.json({ ok: true, item: serialize({ ...blob, ownerEmail: email, userPath: destPath, nodeId: node.id }) });
  } catch (e) { next(e); }
});

/** 删除：soft=软删节点（用户可在回收站恢复）；hard=直接释放引用，物理对象归零后标记 orphan。 */
router.delete('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const blob = getBlob(id);
    if (!blob) throw notFound('文件索引不存在');
    const node = db.prepare('SELECT * FROM nodes WHERE blobId = ? AND deletedAt IS NULL').get(id);
    if (!node) throw notFound('该索引没有活跃节点');
    if (String(req.query.mode) === 'hard') {
      db.prepare('UPDATE nodes SET deletedAt = ?, updatedAt = ? WHERE id = ?').run(nowIso(), nowIso(), node.id);
      releaseBlob(id);
    } else {
      db.prepare('UPDATE nodes SET deletedAt = ?, updatedAt = ? WHERE id = ?').run(nowIso(), nowIso(), node.id);
    }
    writeAudit({ email: 'admin', action: 'delete', target: node.path, bytes: Number(blob.sizeBytes), ip: req.ip, detail: JSON.stringify({ blobId: id, mode: req.query.mode || 'soft' }) });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** 管理员下载：按索引号直接取物理对象，不依赖用户路径。 */
router.get('/:id/download', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const blob = getBlob(id);
    if (!blob) throw notFound('文件索引不存在');
    const strategy = getStrategy(blob.storageId);
    if (!strategy) throw notFound('存储策略不存在');
    const stream = await getDriver(strategy.type).readStream(strategy, blob.storageKey, { size: Number(blob.sizeBytes), mime: blob.mime, name: blob.filename });
    res.setHeader('Content-Type', blob.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(blob.filename))}`);
    if (blob.sizeBytes) res.setHeader('Content-Length', String(blob.sizeBytes));
    stream.pipe(res);
  } catch (e) { next(e); }
});

export default router;
