import { db } from '../db.js';
import { nowIso, genId } from '../lib/format.js';
import { parentOf, basenameOf } from '../lib/paths.js';
import { conflict } from '../lib/errors.js';

export function upsertUser({ id, email, displayName = '', groupId = null }) {
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare('UPDATE users SET displayName = ?, groupId = COALESCE(?, groupId) WHERE email = ?')
      .run(displayName, groupId, email);
    return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }
  const uid = id || `u_${Buffer.from(email).toString('hex').slice(0, 16)}`;
  const now = nowIso();
  db.prepare(
    `INSERT INTO users (id, email, displayName, groupId, disabled, status, passwordHash, registeredAt, lastLoginAt, createdAt)
     VALUES (?, ?, ?, ?, 0, 'active', NULL, ?, ?, ?)`
  ).run(uid, email, displayName, groupId, now, null, now);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

export function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
}

export function getNodeByPath(path, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT * FROM nodes WHERE path = ?'
    : 'SELECT * FROM nodes WHERE path = ? AND deletedAt IS NULL';
  return db.prepare(sql).get(path);
}

export function insertNode({ email, parentId, name, path, isDir, sizeBytes = 0, mime = null, storageId = null }) {
  const id = genId('n');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO nodes (id, email, parentId, name, path, isDir, sizeBytes, mime, storageId, deletedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(id, email, parentId, name, path, isDir ? 1 : 0, sizeBytes, mime, storageId, ts, ts);
  return db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
}

export function listChildren(parentPath) {
  return db.prepare(
    `SELECT * FROM nodes WHERE parentId = (SELECT id FROM nodes WHERE path = ?) AND deletedAt IS NULL
     ORDER BY isDir DESC, name COLLATE NOCASE ASC`
  ).all(parentPath);
}

export function childrenCount(nodeId) {
  return db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE parentId = ? AND deletedAt IS NULL').get(nodeId).n;
}

export function descendantsOf(path) {
  const like = `${path}/%`;
  return db.prepare('SELECT * FROM nodes WHERE path = ? OR path LIKE ? ORDER BY path ASC').all(path, like);
}

export function softDeleteRecursive(path) {
  const nodes = descendantsOf(path);
  const ts = nowIso();
  const stmt = db.prepare('UPDATE nodes SET deletedAt = ?, updatedAt = ? WHERE id = ?');
  let count = 0;
  const tx = db.transaction(() => {
    for (const n of nodes) {
      stmt.run(ts, ts, n.id);
      count++;
    }
  });
  tx();
  return count;
}

export function restoreRecursive(path) {
  const nodes = descendantsOf(path);
  // 目标路径已被活跃节点占用时不要硬写（部分唯一索引会约束），明确报冲突
  for (const n of nodes) {
    const active = db.prepare('SELECT id FROM nodes WHERE path = ? AND deletedAt IS NULL').get(n.path);
    if (active && active.id !== n.id) {
      throw conflict('目标路径已存在同名节点，无法恢复', { path: n.path });
    }
  }
  const stmt = db.prepare('UPDATE nodes SET deletedAt = NULL, updatedAt = ? WHERE id = ?');
  const tx = db.transaction(() => {
    for (const n of nodes) stmt.run(nowIso(), n.id);
  });
  tx();
  return nodes;
}

export function deleteNodeRow(id) {
  db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

export function searchNodes(email, q) {
  const like = `%${q}%`;
  return db.prepare(
    `SELECT * FROM nodes WHERE email = ? AND deletedAt IS NULL AND name LIKE ? ORDER BY updatedAt DESC LIMIT 100`
  ).all(email, like);
}

export function fileCount(email) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE email = ? AND deletedAt IS NULL AND isDir = 0`
  ).get(email).n;
}

export function publicUser(user, group) {
  const status = user.status === 'banned' || user.disabled === 1 ? 'banned' : 'active';
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName || '',
    groupId: user.groupId || group?.id || null,
    groupName: group?.name || '',
    isAdmin: false,
    disabled: status === 'banned',
    status,
    source: user.passwordHash ? 'local' : 'supabase',
    registeredAt: user.registeredAt || user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
  };
}

export { parentOf, basenameOf };
