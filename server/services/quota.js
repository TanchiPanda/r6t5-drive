import { db } from '../db.js';
import { trafficUsed7d } from './traffic.js';

export function getDefaultGroup() {
  return db.prepare('SELECT * FROM groups WHERE isDefault = 1').get();
}

export function getGroupById(id) {
  if (!id) return null;
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

export function resolveGroup(user) {
  return getGroupById(user?.groupId) || getDefaultGroup();
}

export function usedBytes(email) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(sizeBytes), 0) AS n FROM nodes WHERE email = ? AND deletedAt IS NULL AND isDir = 0`
  ).get(email);
  return Number(row.n || 0);
}

export function trashBytes(email) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(sizeBytes), 0) AS n FROM nodes WHERE email = ? AND deletedAt IS NOT NULL AND isDir = 0`
  ).get(email);
  return Number(row.n || 0);
}

export function trashCount(email) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM nodes WHERE email = ? AND deletedAt IS NOT NULL AND isDir = 0`
  ).get(email);
  return Number(row.n || 0);
}

export function quotaForUser(user) {
  const group = resolveGroup(user) || {};
  const spaceLimit = Number(group.spaceLimitBytes ?? 10n * 1024n * 1024n * 1024n);
  const maxFile = Number(group.maxFileSizeBytes ?? 2n * 1024n * 1024n * 1024n);
  const trafficLimit = Number(group.traffic7dLimitBytes ?? 5n * 1024n * 1024n * 1024n);
  const used = usedBytes(user.email);
  const trafficUsed = trafficUsed7d(user.email, 'upload');
  return {
    spaceLimitBytes: spaceLimit,
    usedBytes: used,
    spaceRemainingBytes: Math.max(0, spaceLimit - used),
    maxFileSizeBytes: maxFile,
    traffic7dLimitBytes: trafficLimit,
    traffic7dUsedBytes: trafficUsed,
    traffic7dRemainingBytes: Math.max(0, trafficLimit - trafficUsed),
  };
}
