import { db } from '../../db.js';
import { nowIso, genId } from '../../lib/format.js';

export const PLANNED_TYPES = ['s3', 'github', 'oss', 'cos', 'ks3', 'obs', 'qiniu', 'upyun'];

export function listStrategies() {
  return db.prepare('SELECT * FROM storage_strategies ORDER BY createdAt ASC').all();
}

export function getStrategy(id) {
  return db.prepare('SELECT * FROM storage_strategies WHERE id = ?').get(id);
}

export function listEnabled() {
  return db.prepare('SELECT * FROM storage_strategies WHERE enabled = 1').all();
}

export function createStrategy({ name, type, region, capacityBytes, readOnly, config }) {
  const id = genId('s');
  db.prepare(
    `INSERT INTO storage_strategies (id, name, type, region, capacityBytes, usedBytes, readOnly, enabled, config, createdAt)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?)`
  ).run(id, name, type, region, capacityBytes, readOnly ? 1 : 0, JSON.stringify(config || {}), nowIso());
  return getStrategy(id);
}

export function updateStrategy(id, fields) {
  const allowed = ['name', 'region', 'capacityBytes', 'readOnly', 'enabled', 'config'];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      params.push(k === 'config' ? JSON.stringify(fields.config || {}) : fields[k]);
    }
  }
  if (!sets.length) return getStrategy(id);
  params.push(id);
  db.prepare(`UPDATE storage_strategies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getStrategy(id);
}

export function deleteStrategy(id) {
  db.prepare('DELETE FROM storage_strategies WHERE id = ?').run(id);
}

export function fileCountForStrategy(id) {
  return db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE storageId = ? AND deletedAt IS NULL AND isDir = 0`
  ).get(id).n;
}

export function usedBytesForStrategy(id) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(sizeBytes),0) AS n FROM nodes WHERE storageId = ? AND deletedAt IS NULL AND isDir = 0`
  ).get(id);
  return Number(row.n || 0);
}

export function defaultStrategy() {
  return listEnabled()[0] || null;
}
