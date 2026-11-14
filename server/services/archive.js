// P4 归档业务：打包下载（流式）/ 在线压缩（落盘 zip）/ 解压（防 zip slip）。
// 约束：不新增 npm 依赖；文件内容流式读写，不整包/整文件缓冲进内存；
//       所有临时写盘在 TMP_DIR 并有上限与 finally 清理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { ENV } from '../config.js';
import { normalizeLogicalPath, validateName, joinLogical, parentOf, basenameOf } from '../lib/paths.js';
import {
  badRequest, notFound, conflict, quotaFile, quotaSpace, quotaTraffic,
  strategyReadonly, ApiError, zipInvalid, zipTooLarge,
} from '../lib/errors.js';
import { getNodeByPath, insertNode, descendantsOf } from './nodes.js';
import { quotaForUser } from './quota.js';
import { recordTraffic } from './traffic.js';
import { writeAudit } from './audit.js';
import { resolveStorage } from './bindings.js';
import { getDriver, driverCaps } from './storage/driver.js';
import * as registry from './storage/registry.js';
import { ZipWriter, ZipReader, assertExtractSafe, MAX_ENTRIES, MAX_TOTAL_BYTES } from '../lib/zip.js';

const TMP_DIR = path.join(ENV.STORAGE_ROOT, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const MIME_BY_EXT = {
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.csv': 'text/csv', '.html': 'text/html', '.mp4': 'video/mp4',
};

function guessMime(name) {
  const i = String(name).lastIndexOf('.');
  const ext = i >= 0 ? String(name).slice(i).toLowerCase() : '';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function randomHex(n = 6) {
  return crypto.randomBytes(n).toString('hex');
}

function clientIpOf(req) {
  return (req && (req.ip || req.socket?.remoteAddress)) || '';
}

/** 目标路径的存储策略；未配置抛 412（与 files.js 一致） */
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
    throw strategyReadonly(`目录「${shown}」绑定的是只读存储策略（${strategy.name}），不能压缩或解压写入`, {
      strategyId: strategy.id, strategyType: strategy.type,
    });
  }
}

/** 节点所在策略：节点记录的 storageId 优先，否则按路径解析 */
function strategyForNode(user, node) {
  if (node.storageId) {
    const s = registry.getStrategy(node.storageId);
    if (s) return s;
  }
  return resolveFor(user, node.path).strategy;
}

/** 补齐缺失的上级目录节点（与 files.js 同名辅助逻辑一致） */
function ensureDirNodes(email, logicalDir, rootNode) {
  let parent = rootNode || getNodeByPath(email);
  if (!parent) {
    parent = insertNode({ email, parentId: null, name: email, path: email, isDir: true });
  }
  if (logicalDir === email) return parent;
  const segs = logicalDir.split('/');
  let acc = segs[0];
  let cur = parent;
  for (let i = 1; i < segs.length; i += 1) {
    acc = `${acc}/${segs[i]}`;
    let node = getNodeByPath(acc);
    if (!node) node = insertNode({ email, parentId: cur.id, name: segs[i], path: acc, isDir: true });
    cur = node;
  }
  return cur;
}

// ====================================================================
// 条目展开与预检
// ====================================================================

/** 把入参路径展开成去重后的扁平文件节点列表；不存在 → 404 */
export function expandEntries(user, paths) {
  const email = user.email;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw badRequest('invalid_input', 'paths 不能为空', { field: 'paths' });
  }
  const files = [];
  const seen = new Set();
  for (const raw of paths) {
    const logical = normalizeLogicalPath(String(raw), email);
    const node = getNodeByPath(logical);
    if (!node) throw notFound('路径不存在', { path: logical });
    if (node.isDir) {
      for (const d of descendantsOf(logical)) {
        if (d.isDir || seen.has(d.path)) continue;
        seen.add(d.path);
        files.push(d);
      }
    } else if (!seen.has(node.path)) {
      seen.add(node.path);
      files.push(node);
    }
  }
  return files;
}

/** 多条逻辑路径的最长公共父目录 */
export function commonParent(paths) {
  const arrs = paths.map((p) => p.split('/'));
  let depth = arrs[0].length;
  for (const a of arrs) {
    let i = 0;
    while (i < a.length && i < depth && a[i] === arrs[0][i]) i += 1;
    depth = i;
  }
  return arrs[0].slice(0, Math.max(0, depth)).join('/');
}

function relToParent(logical, parent) {
  if (!parent) return basenameOf(logical);
  return logical === parent ? basenameOf(logical) : logical.slice(parent.length + 1);
}

/** 打包计划：展开 + 条目数/总字节预检（在写响应头之前完成） */
export function buildPlan(user, paths) {
  const files = expandEntries(user, paths);
  const totalBytes = files.reduce((s, f) => s + Number(f.sizeBytes || 0), 0);
  if (files.length > MAX_ENTRIES) {
    throw zipTooManyEntries({ entries: files.length, limit: MAX_ENTRIES });
  }
  if (BigInt(totalBytes) > MAX_TOTAL_BYTES) {
    throw zipTooLarge({ totalBytes, limitBytes: Number(MAX_TOTAL_BYTES) });
  }
  return {
    files: files.map((f) => ({ name: f.name, path: f.path, sizeBytes: Number(f.sizeBytes || 0) })),
    totalBytes,
    entries: files.length,
    tooLarge: false,
  };
}

// ====================================================================
// 1) 打包下载（流式，不落整包临时文件）
// ====================================================================

function downloadZipName(parent, inputPaths) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  if (parent && parent.includes('/')) return basenameOf(parent) || `download-${stamp}`;
  return `download-${stamp}`;
}

export async function streamZipDownload({ user, paths, req, res }) {
  const plan = buildPlan(user, paths);
  const parent = commonParent(plan.files.map((f) => f.path));
  const zipName = downloadZipName(parent, paths);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}.zip`);
  res.setHeader('X-Archive-Entries', String(plan.entries));

  const writer = new ZipWriter(res);
  let aborted = false;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    writer.abort();
  };
  req.on('aborted', onAbort);
  res.on('close', onAbort);

  let finishedOk = false;
  try {
    for (const f of plan.files) {
      if (aborted) break;
      const strategy = strategyForNode(user, f);
      const driver = getDriver(strategy.type);
      const stream = await driver.readStream(strategy, f.path, { size: f.sizeBytes, mime: f.mime, name: f.name });
      await writer.addFile(relToParent(f.path, parent), stream);
    }
    if (!aborted) {
      await writer.finish();
      res.end();
      finishedOk = true;
    }
  } catch (e) {
    writer.abort();
    if (!res.headersSent) throw e;
    // 响应头已发出，无法再转 JSON；记录后断开
    console.warn(`[archive] 打包下载中断：${e.code || e.message}（entries=${plan.entries}）`);
    res.destroy();
    return;
  } finally {
    req.removeListener('aborted', onAbort);
    res.removeListener('close', onAbort);
    if (finishedOk) {
      recordTraffic(user.email, 'download', plan.totalBytes);
      writeAudit({ email: user.email, action: 'download', target: plan.files.map((f) => f.path).join(','), bytes: plan.totalBytes, ip: clientIpOf(req) });
    }
  }
}

// ====================================================================
// 2) 在线压缩：临时 zip → 目标策略落盘
// ====================================================================

function normalizeZipName(raw, fallbackBase) {
  let name = raw ? validateName(raw) : `${fallbackBase}.zip`;
  if (!/\.zip$/i.test(name)) name = `${name}.zip`;
  return name;
}

export async function compress({ user, paths, targetPath, name }) {
  const plan = buildPlan(user, paths);
  if (plan.entries === 0) throw badRequest('invalid_input', '没有可打包的文件', { field: 'paths' });

  const email = user.email;
  const firstLogical = normalizeLogicalPath(String(paths[0]), email);
  const dirLogical = targetPath ? normalizeLogicalPath(String(targetPath), email) : parentOf(firstLogical);
  const dirNode = getNodeByPath(dirLogical);
  if (!dirNode || !dirNode.isDir) throw notFound('目标目录不存在', { path: dirLogical });

  const hit = resolveFor(user, dirLogical);
  assertWritable(hit.strategy, dirLogical);

  const zipName = normalizeZipName(name, basenameOf(firstLogical));
  const target = joinLogical(dirLogical, zipName);
  if (getNodeByPath(target)) throw conflict('同名文件已存在', { path: target });

  // 配额预检（以未压缩总量作为保守上界）
  const quota = quotaForUser(user);
  const estimate = plan.totalBytes;
  if (estimate > quota.maxFileSizeBytes) throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: estimate });
  if (quota.usedBytes + estimate > quota.spaceLimitBytes) {
    throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: estimate });
  }
  if (quota.traffic7dUsedBytes + estimate > quota.traffic7dLimitBytes) {
    throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes });
  }

  const parent = commonParent(plan.files.map((f) => f.path));
  const tmpZip = path.join(TMP_DIR, `compress-${Date.now()}-${randomHex()}.zip`);
  let zipBytes = 0;
  let out = null;
  try {
    out = fs.createWriteStream(tmpZip);
    const writer = new ZipWriter(out);
    for (const f of plan.files) {
      const strategy = strategyForNode(user, f);
      const driver = getDriver(strategy.type);
      const stream = await driver.readStream(strategy, f.path, { size: f.sizeBytes, mime: f.mime, name: f.name });
      await writer.addFile(relToParent(f.path, parent), stream);
    }
    await writer.finish();
    out.end();
    await new Promise((resolve, reject) => {
      out.once('finish', resolve);
      out.once('error', reject);
    });
    zipBytes = fs.statSync(tmpZip).size;

    // 落盘前按真实 zip 字节复核配额
    if (zipBytes > quota.maxFileSizeBytes) throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: zipBytes });
    if (quota.usedBytes + zipBytes > quota.spaceLimitBytes) {
      throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: zipBytes });
    }
    if (quota.traffic7dUsedBytes + zipBytes > quota.traffic7dLimitBytes) {
      throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes });
    }

    await getDriver(hit.strategy.type).writeFromTemp(hit.strategy, target, tmpZip, {
      size: zipBytes, mime: 'application/zip', name: zipName,
    });
  } finally {
    if (out && !out.destroyed) out.destroy();
    fs.rmSync(tmpZip, { force: true });
  }

  const node = insertNode({
    email, parentId: dirNode.id, name: zipName, path: target,
    isDir: false, sizeBytes: zipBytes, mime: 'application/zip', storageId: hit.strategy.id,
  });
  recordTraffic(email, 'upload', zipBytes);
  writeAudit({ email, action: 'compress', target, bytes: zipBytes });

  return {
    item: {
      name: node.name, path: node.path, type: 'file', sizeBytes: zipBytes,
      mime: node.mime, updatedAt: node.updatedAt, storageId: node.storageId,
    },
    entries: plan.entries,
  };
}

// ====================================================================
// 3) 解压（防 zip slip；先全量解到临时目录，校验通过后再落目标策略）
// ====================================================================

export async function extract({ user, path: srcPath, targetPath }) {
  const email = user.email;
  const srcLogical = normalizeLogicalPath(String(srcPath), email);
  const node = getNodeByPath(srcLogical);
  if (!node) throw notFound('文件不存在', { path: srcLogical });
  if (node.isDir) throw badRequest('invalid_input', '解压源必须是文件', { field: 'path' });

  const looksZip = /\.zip$/i.test(node.name) || node.mime === 'application/zip';
  if (!looksZip) throw zipInvalid('仅支持 .zip 压缩包', { name: node.name, mime: node.mime });

  const dirLogical = targetPath ? normalizeLogicalPath(String(targetPath), email) : parentOf(srcLogical);
  const existingDir = getNodeByPath(dirLogical);
  if (existingDir && !existingDir.isDir) throw badRequest('invalid_input', '目标不是目录', { field: 'targetPath' });

  const hit = resolveFor(user, dirLogical);
  assertWritable(hit.strategy, dirLogical);

  // 目标目录可不存在：通过只读校验后再补齐目录节点（与上传建目录逻辑一致）
  const dirNode = ensureDirNodes(email, dirLogical);

  const quota = quotaForUser(user);
  const staging = path.join(TMP_DIR, 'extract', `${Date.now()}-${randomHex()}`);
  fs.mkdirSync(path.join(staging, 'stage'), { recursive: true });
  const tmpZip = path.join(staging, 'source.zip');
  let reader = null;

  try {
    // 源包先拷到临时文件（流式），再由 reader 定位解析
    const srcStrategy = strategyForNode(user, node);
    const src = await getDriver(srcStrategy.type).readStream(srcStrategy, srcLogical, {
      size: Number(node.sizeBytes), mime: node.mime, name: node.name,
    });
    await pipeline(src, fs.createWriteStream(tmpZip));

    reader = ZipReader.open(tmpZip);
    const entries = reader.readEntries();

    // 安全 + 上限校验：任一命中即整体中止，不落任何文件
    const totalBytes = assertExtractSafe(entries, quota);

    if (totalBytes > Math.max(0, quota.spaceLimitBytes - quota.usedBytes)) {
      throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: totalBytes });
    }
    if (totalBytes > Math.max(0, quota.traffic7dLimitBytes - quota.traffic7dUsedBytes)) {
      throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes });
    }

    // 第一遍：解到暂存目录；同名先记 skipped（不覆盖）
    const staged = [];
    const skipped = [];
    const dirEntries = [];
    for (const e of entries) {
      if (e.isDir) { dirEntries.push(e); continue; }
      const destPath = joinLogical(dirLogical, e.name);
      if (getNodeByPath(destPath)) {
        skipped.push({ name: e.name, reason: 'exists' });
        continue;
      }
      const stageFile = path.join(staging, 'stage', e.name);
      // 物理路径二次确认仍在 staging 之内
      const resolvedStage = path.resolve(stageFile);
      if (resolvedStage !== path.join(staging, 'stage') && !resolvedStage.startsWith(path.join(staging, 'stage') + path.sep)) {
        throw zipInvalid('暂存路径越界', { entry: e.name });
      }
      fs.mkdirSync(path.dirname(resolvedStage), { recursive: true });
      await reader.extractToFile(e, resolvedStage);
      staged.push({ entry: e, stageFile: resolvedStage, destPath });
    }

    // 第二遍：落目标策略 + 建节点
    for (const { entry, stageFile, destPath } of staged) {
      const parentNode = ensureDirNodes(email, parentOf(destPath), dirNode);
      await getDriver(hit.strategy.type).writeFromTemp(hit.strategy, destPath, stageFile, {
        size: entry.uncompSize, mime: guessMime(entry.name), name: basenameOf(entry.name),
      });
      insertNode({
        email, parentId: parentNode.id, name: basenameOf(entry.name), path: destPath,
        isDir: false, sizeBytes: entry.uncompSize, mime: guessMime(entry.name), storageId: hit.strategy.id,
      });
    }
    for (const e of dirEntries) {
      const dirPath = joinLogical(dirLogical, e.name.replace(/\/$/, ''));
      if (!getNodeByPath(dirPath)) ensureDirNodes(email, dirPath, dirNode);
    }

    recordTraffic(email, 'upload', totalBytes);
    writeAudit({ email, action: 'extract', target: srcLogical, bytes: totalBytes });

    return { extracted: staged.length, skipped, totalBytes };
  } finally {
    if (reader) reader.close();
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ====================================================================
// 4) 打包计划（前端预检）
// ====================================================================

export function planArchive(user, paths) {
  const plan = buildPlan(user, paths);
  return {
    files: plan.files,
    totalBytes: plan.totalBytes,
    entries: plan.entries,
    tooLarge: BigInt(plan.totalBytes) > MAX_TOTAL_BYTES,
  };
}
