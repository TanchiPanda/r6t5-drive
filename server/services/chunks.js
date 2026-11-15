// P4 分片上传 + 断点续传业务逻辑。
// 会话表：upload_sessions；分片临时文件落在 TMP_DIR/chunks/<uploadId>/<index>.part。
// 约束：分片原始二进制落盘（不整文件进内存）；complete 用内存锁串行化同一会话；
// 失败路径 try/finally 清理半截临时文件；临时目录自愈 mkdir recursive。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { db } from '../db.js';
import { ENV } from '../config.js';
import { normalizeLogicalPath, validateName, joinLogical } from '../lib/paths.js';
import {
  badRequest, notFound, conflict, strategyReadonly,
  quotaFile, quotaSpace, quotaTraffic,
  uploadSessionNotFound, uploadSessionExpired,
  uploadPartRange, uploadIncomplete, ApiError,
} from '../lib/errors.js';
import { getNodeByPath, insertNode } from './nodes.js';
import { quotaForUser } from './quota.js';
import { recordTraffic } from './traffic.js';
import { writeAudit } from './audit.js';
import { getDriver, driverCaps } from './storage/driver.js';
import { resolveStorage } from './bindings.js';
import { nowIso, genId } from '../lib/format.js';

const TMP_DIR = path.join(ENV.STORAGE_ROOT, '.tmp');
const CHUNKS_ROOT = path.join(TMP_DIR, 'chunks');
fs.mkdirSync(CHUNKS_ROOT, { recursive: true });

const MiB = 1024 * 1024;
const DEFAULT_CHUNK_SIZE = 8 * MiB;
const MIN_CHUNK_SIZE = 1 * MiB;
const MAX_CHUNK_SIZE = 64 * MiB;
const MAX_SIZE_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB
const SESSION_TTL_MS = 24 * 3600 * 1000;

// complete 内存锁：Map<uploadId, Promise>，串行化同一会话的并发 complete
const completeLocks = new Map();

function sessionDir(uploadId) {
  return path.join(CHUNKS_ROOT, uploadId);
}

function partPath(uploadId, index) {
  return path.join(sessionDir(uploadId), `${index}.part`);
}

function mergedPath(uploadId) {
  return path.join(sessionDir(uploadId), 'merged.tmp');
}

function parseReceived(row) {
  let arr = [];
  try { arr = JSON.parse(row.received || '[]'); } catch { arr = []; }
  return Array.isArray(arr) ? arr.map(Number).filter((n) => Number.isInteger(n)) : [];
}

function isExpired(row, now = Date.now()) {
  const exp = Date.parse(row.expiresAt);
  const upd = Date.parse(row.updatedAt);
  return (Number.isFinite(exp) && exp < now) || (Number.isFinite(upd) && now - upd > SESSION_TTL_MS);
}

function missingOf(row) {
  const received = new Set(parseReceived(row));
  const missing = [];
  for (let i = 0; i < Number(row.totalChunks); i += 1) {
    if (!received.has(i)) missing.push(i);
  }
  return missing;
}

/** 会话对外视图（init / list / detail 共用字段） */
export function sessionView(row, { includeMissing = false } = {}) {
  const received = parseReceived(row);
  const view = {
    uploadId: row.id,
    parentPath: row.parentPath,
    name: row.name,
    sizeBytes: Number(row.sizeBytes),
    chunkSize: Number(row.chunkSize),
    totalChunks: Number(row.totalChunks),
    receivedCount: received.length,
    received,
    expiresAt: row.expiresAt,
    status: row.status,
  };
  if (includeMissing) view.missing = missingOf(row);
  return view;
}

function resolveFor(user, logicalPath) {
  const hit = resolveStorage({ email: user.email, logicalPath, user });
  if (!hit || !hit.strategy) {
    throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略，请联系管理员在后台添加一条');
  }
  return hit;
}

function assertWritable(strategy, logicalPath) {
  if (!driverCaps(strategy.type).write || strategy.readOnly) {
    const shown = logicalPath.split('/').slice(1).join('/') || '用户根';
    throw strategyReadonly(`目录「${shown}」绑定的是只读存储策略（${strategy.name}），不能分片上传`, {
      strategyId: strategy.id, strategyType: strategy.type,
    });
  }
}

/** 补齐缺失的上级目录节点（与 files.js 同语义） */
function ensureDirNodes(email, logicalDir) {
  let root = getNodeByPath(email);
  if (!root) root = insertNode({ email, parentId: null, name: email, path: email, isDir: true });
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

/**
 * 初始化（或幂等续接）一个分片上传会话。
 * @param {object} user req.user
 * @param {object} body { parentPath, name, sizeBytes, chunkSize?, overwrite? }
 */
export function initSession(user, body = {}) {
  const email = user.email;
  const parentLogical = normalizeLogicalPath(String(body.parentPath || email), email);
  const name = validateName(body.name);
  const targetPath = joinLogical(parentLogical, name);

  const sizeBytes = Number(body.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw badRequest('invalid_input', 'sizeBytes 必须是正整数', { field: 'sizeBytes' });
  }
  if (sizeBytes > MAX_SIZE_BYTES) {
    throw badRequest('invalid_input', '文件大小超出 100 GB 上限', { field: 'sizeBytes', limitBytes: MAX_SIZE_BYTES });
  }

  let chunkSize = body.chunkSize == null ? DEFAULT_CHUNK_SIZE : Number(body.chunkSize);
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE || chunkSize > MAX_CHUNK_SIZE) {
    throw badRequest('invalid_input', 'chunkSize 需在 1–64 MiB 之间', { field: 'chunkSize', minBytes: MIN_CHUNK_SIZE, maxBytes: MAX_CHUNK_SIZE });
  }
  if (chunkSize > sizeBytes) chunkSize = sizeBytes;
  const totalChunks = Math.ceil(sizeBytes / chunkSize);

  // 目录必须存在（远端可补建场景复用 ensureDirNodes；这里先查节点，缺失再补建）
  const parent = getNodeByPath(parentLogical) || ensureDirNodes(email, parentLogical);
  if (!parent || !parent.isDir) throw notFound('父目录不存在');

  // 解析策略并在 init 阶段就拦只读（不等 complete）
  const hit = resolveFor(user, targetPath);
  assertWritable(hit.strategy, targetPath);

  const existing = getNodeByPath(targetPath);
  const overwrite = String(body.overwrite) === '1';
  if (existing && !overwrite) throw conflict('同名文件已存在', { path: targetPath });
  if (existing?.isDir) throw conflict('同名目录已存在', { path: targetPath });

  // 幂等续接：同一用户对同一 (parentPath, name) 已有 active 未过期会话，直接返回
  const now = Date.now();
  const active = db.prepare(
    `SELECT * FROM upload_sessions WHERE email = ? AND parentPath = ? AND name = ? AND status = 'active'`
  ).all(email, parentLogical, name);
  for (const row of active) {
    if (!isExpired(row, now)) return sessionView(row);
  }

  const id = genId('up');
  const expiresAt = new Date(now + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO upload_sessions (id, email, parentPath, name, sizeBytes, chunkSize, totalChunks, received, strategyId, status, createdAt, updatedAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 'active', ?, ?, ?)`
  ).run(id, email, parentLogical, name, sizeBytes, chunkSize, totalChunks, hit.strategy.id, nowIso(), nowIso(), expiresAt);

  const row = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(id);
  return sessionView(row);
}

/** 列出自己的、未过期活动会话（已 completed 的留档行不列入） */
export function listSessions(user) {
  const now = Date.now();
  const rows = db.prepare(
    `SELECT * FROM upload_sessions WHERE email = ? AND status = 'active' ORDER BY updatedAt DESC`
  ).all(user.email);
  return rows.filter((r) => !isExpired(r, now)).map((r) => sessionView(r));
}

function loadOwned(uploadId, email) {
  const row = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(uploadId);
  // 别人的会话按 404 处理（不泄露存在性）
  if (!row || row.email !== email) throw uploadSessionNotFound();
  if (row.status === 'completed') throw uploadIncomplete({ reason: '会话已完成', uploadId });
  if (isExpired(row)) throw uploadSessionExpired();
  return row;
}

/** 会话详情（含 missing），断点续传靠它 */
export function getSession(user, uploadId) {
  const row = loadOwned(uploadId, user.email);
  return sessionView(row, { includeMissing: true });
}

/** 期望的分片字节数（最后一片按余数） */
function expectedPartSize(row, index) {
  const size = Number(row.sizeBytes);
  const chunkSize = Number(row.chunkSize);
  if (index === Number(row.totalChunks) - 1) return size - chunkSize * (Number(row.totalChunks) - 1);
  return chunkSize;
}

/**
 * 接收一片二进制流，落盘到 TMP_DIR/chunks/<id>/<index>.part。
 * 幂等：重复上传同 index 覆盖，received 仍只记一次。
 * @param {object} user req.user
 * @param {string} uploadId
 * @param {number} index
 * @param {import('node:stream').Readable} stream 请求体流
 * @param {number} [contentLength] Content-Length，可有可无
 */
export async function putPart(user, uploadId, index, stream, contentLength) {
  const row = loadOwned(uploadId, user.email);
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= Number(row.totalChunks)) {
    throw uploadPartRange({ index, totalChunks: Number(row.totalChunks) });
  }

  const expected = expectedPartSize(row, idx);
  const dir = sessionDir(uploadId);
  fs.mkdirSync(dir, { recursive: true });
  const target = partPath(uploadId, idx);
  const tmpWrite = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;

  let actual = 0;
  let written = false;
  try {
    await pipeline(stream, fs.createWriteStream(tmpWrite));
    written = true;
    actual = fs.statSync(tmpWrite).size;
    if (contentLength != null && Number.isFinite(Number(contentLength)) && Number(contentLength) !== actual) {
      throw badRequest('invalid_input', '分片字节数与 Content-Length 不符', { index: idx, expected: Number(contentLength), actual });
    }
    if (actual !== expected) {
      throw badRequest('invalid_input', '分片大小不符合预期', { index: idx, expected, actual });
    }
    // 原子替换：避免半截文件覆盖旧分片
    fs.renameSync(tmpWrite, target);

    // 并发安全：多个 worker 同时 PUT 不同分片时，不能基于函数开头读到的旧 row 合并 received，
    // 否则三个请求会互相覆盖、最后落库的 received 少片。这里在事务内重新读取最新行再合并写回。
    const commitTx = db.transaction(() => {
      const latest = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(uploadId);
      const received = parseReceived(latest);
      if (!received.includes(idx)) received.push(idx);
      received.sort((a, b) => a - b);
      db.prepare('UPDATE upload_sessions SET received = ?, updatedAt = ? WHERE id = ?')
        .run(JSON.stringify(received), nowIso(), uploadId);
      return received;
    });
    const received = commitTx();

    console.log(`[uploads] part ${idx} received uploadId=${uploadId} bytes=${actual}`);
    return { index: idx, receivedCount: received.length, totalChunks: Number(row.totalChunks) };
  } catch (e) {
    if (!written) {
      // 流管道已失败，尝试排空避免挂住连接
      try { stream.destroy(); } catch {}
    }
    throw e;
  } finally {
    fs.rmSync(tmpWrite, { force: true });
  }
}

/** 合并所有分片到 merged.tmp（流式逐个 append，不整文件进内存），返回 { mergedPath, size } */
async function mergeSession(row) {
  const dir = sessionDir(row.id);
  fs.mkdirSync(dir, { recursive: true });
  const merged = mergedPath(row.id);
  fs.rmSync(merged, { force: true });
  const total = Number(row.totalChunks);
  let mergedSize = 0;
  try {
    const out = fs.createWriteStream(merged);
    for (let i = 0; i < total; i += 1) {
      const part = partPath(row.id, i);
      if (!fs.existsSync(part)) throw uploadIncomplete({ missing: [i] });
      await pipeline(fs.createReadStream(part), out, { end: false });
      mergedSize += fs.statSync(part).size;
    }
    out.end();
    await new Promise((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
  } catch (e) {
    fs.rmSync(merged, { force: true });
    throw e;
  }
  if (mergedSize !== Number(row.sizeBytes)) {
    fs.rmSync(merged, { force: true });
    throw badRequest('invalid_input', '合并后字节数与声明大小不符', { expected: Number(row.sizeBytes), actual: mergedSize });
  }
  return { merged, size: mergedSize };
}

/** 落盘/记账失败时的兜底清理：分片目录 + merged + 会话行 */
function abortAfterMergeFailure(user, row) {
  try { cleanupSessionDir(row.id); } catch {}
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(row.id);
  void user;
}

/** 清理会话临时目录（分片 + merged），幂等 */
export function cleanupSessionDir(uploadId) {
  fs.rmSync(sessionDir(uploadId), { force: true, recursive: true });
}

/**
 * 完成上传：校验完整性 → 流式合并 → 配额三连 → 落盘 → 建/更新节点 → 记账审计 → 清理。
 * 同一会话并发 complete 由内存锁串行化；第二个并发请求拿到 409 upload_in_progress。
 */
export async function completeSession(user, uploadId, { mime } = {}) {
  const row0 = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(uploadId);
  if (!row0 || row0.email !== user.email) throw uploadSessionNotFound();

  // 已完成：幂等返回现有节点结果（不重复落盘）
  if (row0.status === 'completed') {
    const node = getNodeByPath(joinLogical(row0.parentPath, row0.name));
    if (node) return { item: completeItemView(node), quota: quotaForUser(user) };
    throw uploadSessionNotFound();
  }
  if (isExpired(row0)) throw uploadSessionExpired();

  // 内存锁：同一会话串行化 complete
  const prior = completeLocks.get(uploadId);
  if (prior) {
    throw new ApiError(409, 'upload_in_progress', '该会话正在完成上传，请稍后重试', { uploadId });
  }

  const release = () => { completeLocks.delete(uploadId); };
  const job = (async () => {
    const row = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(uploadId);
    if (!row || row.email !== user.email) throw uploadSessionNotFound();
    if (row.status === 'completed') {
      const node = getNodeByPath(joinLogical(row.parentPath, row.name));
      if (node) return { item: completeItemView(node), quota: quotaForUser(user) };
      throw uploadSessionNotFound();
    }
    if (isExpired(row)) throw uploadSessionExpired();

    const missing = missingOf(row);
    if (missing.length) throw uploadIncomplete({ missing });

    const targetPath = joinLogical(row.parentPath, row.name);
    const hit = resolveFor(user, targetPath);
    assertWritable(hit.strategy, targetPath);

    const size = Number(row.sizeBytes);
    const quota = quotaForUser(user);
    if (size > quota.maxFileSizeBytes) throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: size });
    if (quota.usedBytes + size > quota.spaceLimitBytes) {
      throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: size });
    }
    if (quota.traffic7dUsedBytes + size > quota.traffic7dLimitBytes) {
      throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes });
    }

    const existing = getNodeByPath(targetPath);
    if (existing?.isDir) throw conflict('同名目录已存在', { path: targetPath });

    // 合并阶段失败：保留分片以便断点续传；落盘/记账阶段失败：清理临时目录与会话行，避免半截残留
    const { merged, size: mergedSize } = await mergeSession(row);
    try {
      const finalMime = mime || row.mime || 'application/octet-stream';
      await getDriver(hit.strategy.type).writeFromTemp(hit.strategy, targetPath, merged, {
        size: mergedSize, mime: finalMime, name: row.name,
      });
    } finally {
      fs.rmSync(merged, { force: true });
    }

    let node;
    try {
      if (existing) {
        db.prepare('UPDATE nodes SET sizeBytes = ?, mime = ?, storageId = ?, updatedAt = ? WHERE id = ?')
          .run(mergedSize, mime || existing.mime || 'application/octet-stream', hit.strategy.id, nowIso(), existing.id);
        node = getNodeByPath(targetPath);
      } else {
        const parent = getNodeByPath(row.parentPath) || ensureDirNodes(user.email, row.parentPath);
        node = insertNode({
          email: user.email, parentId: parent.id, name: row.name, path: targetPath,
          isDir: false, sizeBytes: mergedSize, mime: mime || 'application/octet-stream', storageId: hit.strategy.id,
        });
      }
      recordTraffic(user.email, 'upload', mergedSize);
      writeAudit({ email: user.email, action: 'upload', target: targetPath, bytes: mergedSize, ip: null });
    } catch (e) {
      abortAfterMergeFailure(user, row);
      throw e;
    }

    // 成功后清理分片目录；会话行保留为 status='completed'（供重复 complete 幂等复用，上传动作由 audit 表记录）
    cleanupSessionDir(uploadId);
    db.prepare("UPDATE upload_sessions SET status = 'completed', updatedAt = ? WHERE id = ?")
      .run(nowIso(), uploadId);

    return { item: completeItemView(node), quota: quotaForUser(user) };
  })();

  completeLocks.set(uploadId, job);
  try {
    return await job;
  } finally {
    release(null);
  }
}

function completeItemView(node) {
  return {
    name: node.name,
    path: node.path,
    type: 'file',
    sizeBytes: Number(node.sizeBytes),
    mime: node.mime || 'application/octet-stream',
    updatedAt: node.updatedAt,
    storageId: node.storageId || null,
  };
}

/** 中止会话：清理临时目录并删除会话行，幂等 */
export function abortSession(user, uploadId) {
  const row = db.prepare('SELECT * FROM upload_sessions WHERE id = ?').get(uploadId);
  if (row && row.email !== user.email) throw uploadSessionNotFound();
  cleanupSessionDir(uploadId);
  if (row) db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(uploadId);
  return { ok: true };
}

/**
 * 清理过期会话：expiresAt < now 或 updatedAt 超过 24h。
 * 删除会话行并清理对应临时目录，返回清理数量。
 */
export function sweepExpired() {
  const now = Date.now();
  const rows = db.prepare("SELECT * FROM upload_sessions WHERE status = 'active'").all();
  let cleaned = 0;
  for (const row of rows) {
    if (!isExpired(row, now)) continue;
    try { cleanupSessionDir(row.id); } catch (e) { console.warn(`[uploads] 清理临时目录失败 uploadId=${row.id}: ${e.message}`); }
    db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(row.id);
    cleaned += 1;
  }
  console.log(`[uploads] 过期会话扫描完成，清理 ${cleaned} 个`);
  return cleaned;
}
