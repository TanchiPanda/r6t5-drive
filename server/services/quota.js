import { db } from '../db.js';
import { trafficUsed7d } from './traffic.js';
import { toBigInt, toByteString, formatSize } from '../lib/bytes.js';
import { nowIso } from '../lib/format.js';

// 无组时默认值（BigInt 常量，1024 进制）：10 GiB 空间 / 2 GiB 单文件 / 5 GiB 流量
const DEFAULT_SPACE_LIMIT = 10n * 1024n * 1024n * 1024n;
const DEFAULT_MAX_FILE = 2n * 1024n * 1024n * 1024n;
const DEFAULT_TRAFFIC_LIMIT = 5n * 1024n * 1024n * 1024n;

// 限额三列 SELECT 时 CAST 成 TEXT，规避 better-sqlite3 读回 INTEGER 截断为 Number。
const GROUP_SELECT = `
  SELECT *,
    CAST(spaceLimitBytes AS TEXT) AS spaceLimitBytes,
    CAST(maxFileSizeBytes AS TEXT) AS maxFileSizeBytes,
    CAST(traffic7dLimitBytes AS TEXT) AS traffic7dLimitBytes
  FROM groups`;

export function getDefaultGroup() {
  return db.prepare(`${GROUP_SELECT} WHERE isDefault = 1`).get();
}

export function getGroupById(id) {
  if (!id) return null;
  return db.prepare(`${GROUP_SELECT} WHERE id = ?`).get(id);
}

export function resolveGroup(user) {
  return getGroupById(user?.groupId) || getDefaultGroup();
}

/**
 * 未过期容量加成之和（BigInt）。expiresAt 为 null = 永久；否则只算尚未到期的 grant。
 * 字节列存十进制字符串，读取后 CAST TEXT，全程 BigInt 累加。
 */
export function grantBytes(email) {
  const now = nowIso();
  const rows = db.prepare(
    `SELECT CAST(bytes AS TEXT) AS b FROM storage_grants
      WHERE email = ? AND (expiresAt IS NULL OR expiresAt > ?)`
  ).all(String(email).toLowerCase(), now);
  let sum = 0n;
  for (const r of rows) sum += toBigInt(r.b || 0);
  return sum;
}

/** 已用空间（BigInt 汇总；节点 sizeBytes 是 INTEGER 列）。 */
export function usedBytes(email) {
  const row = db.prepare(
    `SELECT COALESCE(SUM(sizeBytes), 0) AS n FROM nodes WHERE email = ? AND deletedAt IS NULL AND isDir = 0`
  ).get(email);
  return toBigInt(row.n || 0);
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

/**
 * 配额：限额/已用均以 BigInt 计算；对外 Bytes 字段为十进制字符串（避免 Number 精度丢失），
 * 另附人类可读 text 字段。内部比较请用本函数返回的 BigInt 辅助字段（后缀 `Big`）。
 */
export function quotaForUser(user) {
  const group = resolveGroup(user) || {};
  const spaceLimit = (group.spaceLimitBytes != null ? toBigInt(group.spaceLimitBytes) : DEFAULT_SPACE_LIMIT)
    + grantBytes(user.email);
  const maxFile = group.maxFileSizeBytes != null ? toBigInt(group.maxFileSizeBytes) : DEFAULT_MAX_FILE;
  const trafficLimit = group.traffic7dLimitBytes != null ? toBigInt(group.traffic7dLimitBytes) : DEFAULT_TRAFFIC_LIMIT;
  const used = usedBytes(user.email);
  const trafficUsed = toBigInt(trafficUsed7d(user.email, 'upload'));
  const spaceRemaining = spaceLimit > used ? spaceLimit - used : 0n;
  const trafficRemaining = trafficLimit > trafficUsed ? trafficLimit - trafficUsed : 0n;

  return {
    spaceLimitBytes: toByteString(spaceLimit),
    usedBytes: toByteString(used),
    spaceRemainingBytes: toByteString(spaceRemaining),
    maxFileSizeBytes: toByteString(maxFile),
    traffic7dLimitBytes: toByteString(trafficLimit),
    traffic7dUsedBytes: toByteString(trafficUsed),
    traffic7dRemainingBytes: toByteString(trafficRemaining),
    spaceLimitText: formatSize(spaceLimit),
    usedText: formatSize(used),
    spaceRemainingText: formatSize(spaceRemaining),
    maxFileSizeText: formatSize(maxFile),
    traffic7dLimitText: formatSize(trafficLimit),
    traffic7dUsedText: formatSize(trafficUsed),
    traffic7dRemainingText: formatSize(trafficRemaining),
  };
}

/** 内部比较用 BigInt 视图（不对外契约承诺；避免 BigInt 进入 JSON 响应）。 */
export function quotaBig(quota) {
  return {
    spaceLimit: toBigInt(quota.spaceLimitBytes),
    maxFile: toBigInt(quota.maxFileSizeBytes),
    trafficLimit: toBigInt(quota.traffic7dLimitBytes),
    used: toBigInt(quota.usedBytes),
    trafficUsed: toBigInt(quota.traffic7dUsedBytes),
  };
}
