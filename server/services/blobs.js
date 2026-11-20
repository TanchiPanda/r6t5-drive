// 扁平 Blob 存储：物理对象统一落在 <策略根>/uploads/<索引>/<文件名>，永不 rename/移动。
// 逻辑路径、归属邮箱、用户目录都只存 SQLite；改名/移动/转移所有权 = 纯元数据修改。
import path from 'node:path';
import { db } from '../db.js';
import { nowIso } from '../lib/format.js';
import { getDriver } from './storage/driver.js';

const INDEX_PAD = 8;
export const BLOB_PREFIX = 'uploads';

export function padIndex(id) {
  return String(id).padStart(INDEX_PAD, '0');
}

/** 物理文件名清洗：去掉路径分隔符与控制字符，保留可读性；重名由索引目录天然隔离。 */
export function sanitizeBlobName(name) {
  const base = path.basename(String(name || '').replace(/\\/g, '/'));
  const clean = base.replace(/[/\\\u0000-\u001f]/g, '_').replace(/^\.+$/, '_');
  return clean.slice(0, 200) || 'file';
}

/** 预先占一条 blob 记录，返回 { id, key }；物理写入失败时调用 dropReservedBlob 回滚。 */
export function reserveBlob({ storageId, filename, createdBy = null }) {
  const stmt = db.prepare(
    `INSERT INTO blobs (storageId, storageKey, filename, sizeBytes, mime, sha256, refCount, state, createdAt)
     VALUES (?, ?, ?, 0, NULL, NULL, 0, 'active', ?)`
  );
  const info = stmt.run(storageId, `__reserve__/${Date.now()}-${Math.random().toString(36).slice(2)}`, filename || 'file', nowIso());
  void createdBy;
  const id = Number(info.lastInsertRowid);
  const key = `${BLOB_PREFIX}/${padIndex(id)}/${sanitizeBlobName(filename)}`;
  db.prepare('UPDATE blobs SET storageKey = ?, filename = ? WHERE id = ?').run(key, filename || 'file', id);
  return { id, key };
}

export function dropReservedBlob(id) {
  db.prepare('DELETE FROM blobs WHERE id = ? AND refCount = 0').run(id);
}

/** 一步落盘：占索引号 → 写 uploads/<id>/<文件名> → 完成元数据。写失败自动回滚记录。 */
export async function writeBlobFromTemp({ strategy, filename, tmpFile, sizeBytes, mime, createdBy }) {
  const reserved = reserveBlob({ storageId: strategy.id, filename, createdBy });
  try {
    await getDriver(strategy.type).writeFromTemp(strategy, reserved.key, tmpFile, {
      size: Number(sizeBytes) || 0, mime, name: filename,
    });
  } catch (e) {
    dropReservedBlob(reserved.id);
    throw e;
  }
  return finalizeBlob(reserved.id, { sizeBytes, mime });
}

export function finalizeBlob(id, { sizeBytes, mime, sha256 }) {
  db.prepare('UPDATE blobs SET sizeBytes = ?, mime = ?, sha256 = ?, refCount = 1 WHERE id = ?')
    .run(Number(sizeBytes) || 0, mime || null, sha256 || null, id);
  return getBlob(id);
}

export function getBlob(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM blobs WHERE id = ?').get(id) || null;
}

export function blobsOfNode(node) {
  return node?.blobId ? getBlob(node.blobId) : null;
}

/** 读路径：有 blob 用扁平 key；老数据（无 blobId）继续用逻辑路径。 */
export function readPathOf(node, logicalPath) {
  const blob = blobsOfNode(node);
  return blob ? blob.storageKey : logicalPath;
}

/** 节点改名/移动：仅更新元数据，blob 物理对象不动。 */
export function attachBlob(nodeId, blobId) {
  db.prepare('UPDATE nodes SET blobId = ? WHERE id = ?').run(blobId, nodeId);
}

/** 解除并释放引用；引用归零标记 orphan，由清理任务删除物理对象。 */
export function releaseBlob(blobId) {
  const blob = getBlob(blobId);
  if (!blob) return null;
  const next = Math.max(0, Number(blob.refCount) - 1);
  const state = next === 0 ? 'orphan' : blob.state;
  db.prepare('UPDATE blobs SET refCount = ?, state = ?, deletedAt = ? WHERE id = ?')
    .run(next, state, next === 0 ? nowIso() : blob.deletedAt, blobId);
  return getBlob(blobId);
}

export function listBlobsWithOwner({ limit = 200, offset = 0, q = '' } = {}) {
  const like = q ? `%${q}%` : null;
  const sql = `
    SELECT b.*, n.id AS nodeId, n.email AS ownerEmail, n.path AS userPath, n.deletedAt AS nodeDeletedAt
    FROM blobs b LEFT JOIN nodes n ON n.blobId = b.id
    ${like ? 'WHERE b.storageKey LIKE ? OR n.email LIKE ? OR n.path LIKE ? OR b.filename LIKE ?' : ''}
    ORDER BY b.id DESC LIMIT ? OFFSET ?`;
  const params = like ? [like, like, like, like, limit, offset] : [limit, offset];
  return db.prepare(sql).all(...params);
}
