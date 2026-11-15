// P5 WebDAV 最小可用集。
// 挂载点：/dav。鉴权仅用 HTTP Basic（用户名=邮箱，密码=应用密码），不读取/不接受 cookie 会话。
// 路由内不套 requireUser；用户态在 Basic 中间件里完成校验。
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { db } from '../db.js';
import { ENV } from '../config.js';
import {
  normalizeLogicalPath, parentOf, basenameOf,
} from '../lib/paths.js';
import {
  badRequest, notFound, conflict, quotaFile, quotaSpace, quotaTraffic,
  strategyReadonly, webdavUnsupported, appPasswordInvalid, forbidden, storageError,
} from '../lib/errors.js';
import {
  getNodeByPath, insertNode, listChildren, softDeleteRecursive,
} from '../services/nodes.js';
import { quotaForUser, quotaBig } from '../services/quota.js';
import { recordTraffic } from '../services/traffic.js';
import { writeAudit } from '../services/audit.js';
import { resolveStorage } from '../services/bindings.js';
import { getDriver, driverCaps } from '../services/storage/driver.js';
import { verifyAppPassword } from '../services/apppasswords.js';
import { nowIso } from '../lib/format.js';
import { multiStatusXml } from '../lib/davxml.js';

const router = Router();

const TMP_DIR = path.join(ENV.STORAGE_ROOT, '.tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 流式落盘上限（与既有上传对齐）
const ALLOWED_METHODS = 'OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL, MOVE';
const REALM = 'r6t5-drive';

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || '';
}

// ---------- Basic Auth ----------

function parseBasic(req) {
  const h = req.headers.authorization || '';
  if (!/^Basic\s+/i.test(h)) return null;
  const raw = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  return { email: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

function unauthorized(res, message) {
  res.setHeader('WWW-Authenticate', `Basic realm="${REALM}"`);
  const err = appPasswordInvalid(message);
  res.status(err.status);
  res.type('text/plain; charset=utf-8').send(err.message);
}

/** 校验应用密码；把用户行挂到 req.user。失败走 401 + WWW-Authenticate。 */
function basicAuth(req, res, next) {
  const cred = parseBasic(req);
  if (!cred) return unauthorized(res, '需要 Basic 认证（用户名=邮箱，密码=应用密码）');
  try {
    const email = verifyAppPassword(cred);
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) throw appPasswordInvalid('账号不存在');
    if (user.status === 'banned' || user.disabled === 1) throw forbidden('账号已被封禁');
    req.user = user;
    next();
  } catch (e) {
    if (e.status === 401) return unauthorized(res, e.message);
    next(e);
  }
}

router.use(basicAuth);

// 原始 URL 一旦含 .. 段（含 %2e%2e 编码形式），直接拒绝，避免被代理/路由规范化后绕过。
// 用 router.use 注册到所有路径，不依赖具体路径匹配（规范化后路径可能不再命中 /* ）。
router.use((req, res, next) => {
  const raw = decodeURIComponent(req.originalUrl || req.url);
  const pathname = raw.includes('?') ? raw.slice(0, raw.indexOf('?')) : raw;
  if (pathname.split('/').some((seg) => seg === '..')) return next(forbidden('路径包含非法段（越界）'));
  next();
});

// ---------- 路径映射：WebDAV 相对路径 → 本人逻辑路径 ----------

/**
 * 把 req.params[0]（/dav 之后的相对路径，可能含 %xx）转成逻辑路径。
 * 先解码再 normalizeLogicalPath，防 .. / 绝对路径 / 反斜杠 / 越界。
 */
function toLogical(req) {
  const rel = decodeURIComponent(String(req.params[0] || ''));
  // 任何 .. 段都视为越界拒绝（防穿越）。
  if (rel.includes('..')) throw forbidden('路径包含非法段（越界）');
  const clean = rel.split('/').filter((s) => s !== '' && s !== '.').join('/');
  // normalizeLogicalPath 要求首段是本人 email；这里补首段再校验。
  const logical = normalizeLogicalPath(clean === '' ? req.user.email : `${req.user.email}/${clean}`, req.user.email);
  return logical;
}

function ensureRootNode(email) {
  let root = getNodeByPath(email);
  if (!root) root = insertNode({ email, parentId: null, name: email, path: email, isDir: true });
  return root;
}

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

function relOf(logical, email) {
  const owner = String(email).toLowerCase();
  return logical.length > owner.length ? logical.slice(owner.length + 1) : '';
}

// ---------- 策略 / 只读 / 节点辅助 ----------

function resolveForReq(req, logicalPath) {
  const hit = resolveStorage({ email: req.user.email, logicalPath, user: req.user });
  if (!hit || !hit.strategy) {
    throw badRequest('storage_not_configured', '站点还没有可用的存储策略', {});
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

// ---------- OPTIONS ----------

function optionsReply(req, res) {
  res.setHeader('DAV', '1');
  res.setHeader('Allow', ALLOWED_METHODS);
  res.setHeader('MS-Author-Via', 'DAV');
  res.status(200).end();
}

router.options('/', optionsReply);
router.options('/*', optionsReply);

// ---------- PROPFIND ----------

function propInfoFromNode(node) {
  return {
    relPath: relOf(node.path, node.email),
    isDir: !!node.isDir,
    sizeBytes: Number(node.sizeBytes),
    mime: node.mime || 'application/octet-stream',
    updatedAt: node.updatedAt,
    displayName: node.name,
  };
}

router.propfind('/', (req, res, next) => {
  handlePropfind(req, res, next, '');
});
router.propfind('/*', (req, res, next) => {
  handlePropfind(req, res, next, String(req.params[0] || ''));
});

async function handlePropfind(req, res, next, relRaw) {
  try {
    const decoded = decodeURIComponent(relRaw);
    if (decoded.includes('..')) throw forbidden('路径包含非法段（越界）');
    const clean = decoded.split('/').filter((s) => s !== '' && s !== '.').join('/');
    const logical = clean === '' ? req.user.email : normalizeLogicalPath(`${req.user.email}/${clean}`, req.user.email);
    const depthHeader = String(req.headers.depth || '1').trim().toLowerCase();
    // infinity 一律按 1 处理
    const depth = depthHeader === '0' ? 0 : 1;

    const node = getNodeByPath(logical);
    if (!node) throw notFound('资源不存在');

    const responses = [propInfoFromNode(node)];
    if (depth === 1 && node.isDir) {
      for (const child of listChildren(logical)) responses.push(propInfoFromNode(child));
    }

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Depth', String(depth));
    res.status(207).send(multiStatusXml(responses));
  } catch (e) { next(e); }
}

// ---------- GET / HEAD ----------

async function serveFile(req, res, { headOnly }) {
  const logical = toLogical(req);
  const node = getNodeByPath(logical);
  if (!node) throw notFound('文件不存在');
  if (node.isDir) throw badRequest('invalid_input', '不能下载目录', { field: 'path' });

  const hit = resolveForReq(req, logical);
  const strategy = node.storageId ? db.prepare('SELECT * FROM storage_strategies WHERE id = ?').get(node.storageId) : null;
  const usedStrategy = strategy || hit.strategy;
  const size = Number(node.sizeBytes);
  const mime = node.mime || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  if (size > 0) res.setHeader('Content-Length', size);

  if (headOnly) { res.status(200).end(); return; }

  const stream = await getDriver(usedStrategy.type).readStream(usedStrategy, logical, { size, mime, name: node.name });
  stream.pipe(res);
  let counted = false;
  const done = () => {
    if (counted) return;
    counted = true;
    recordTraffic(req.user.email, 'download', size || 0);
  };
  stream.on('end', done);
  stream.on('close', done);
  stream.on('error', () => { if (!res.headersSent) next(storageError('读取文件失败')); });
}

router.get('/', (req, res) => { res.status(405).setHeader('Allow', ALLOWED_METHODS).end(); });
router.head('/', (req, res) => { res.status(405).setHeader('Allow', ALLOWED_METHODS).end(); });

router.get('/*', async (req, res, next) => {
  try { await serveFile(req, res, { headOnly: false }); } catch (e) { next(e); }
});
router.head('/*', async (req, res, next) => {
  try { await serveFile(req, res, { headOnly: true }); } catch (e) { next(e); }
});

// ---------- PUT ----------

router.put('/*', async (req, res, next) => {
  const email = req.user.email;
  let logical;
  try {
    logical = toLogical(req);
  } catch (e) { return next(e); }

  const tmpFile = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
  const cleanup = () => { try { fs.rmSync(tmpFile, { force: true }); } catch {} };

  try {
    const hit = resolveForReq(req, logical);
    assertWritable(hit.strategy, logical);

    const parentLogical = parentOf(logical);
    const parent = getNodeByPath(parentLogical);
    if (!parent || !parent.isDir) throw conflict('父目录不存在，无法写入（WebDAV 409）', { path: parentLogical });

    // 流式落临时文件，限制大小，不整文件进内存；不监听 data，避免与 pipeline 抢流
    const out = fs.createWriteStream(tmpFile);
    req.on('aborted', () => out.destroy());
    await pipeline(req, out).catch((e) => {
      cleanup();
      throw e;
    });
    // 临时文件已 flush 关闭，stat 取真实大小；兜底用 Content-Length
    let size = 0;
    try { size = fs.statSync(tmpFile).size; } catch { size = 0; }
    const expectedLen = Number(req.headers['content-length']) || NaN;
    if (size === 0 && Number.isFinite(expectedLen) && expectedLen > 0) size = expectedLen;
    if (size > MAX_BODY_BYTES) { cleanup(); throw quotaFile({ limitBytes: MAX_BODY_BYTES, sizeBytes: size }); }

    // 配额三连（覆盖前先校验：覆盖扣减的是旧文件大小，这里按新增保守判断）
    const quota = quotaForUser(req.user);
    const qb = quotaBig(quota);
    const existing = getNodeByPath(logical);
    const sizeBig = BigInt(size);
    const oldSize = existing && !existing.isDir ? BigInt(existing.sizeBytes || 0) : 0n;
    const delta = sizeBig > oldSize ? sizeBig - oldSize : 0n;
    if (sizeBig > qb.maxFile) { cleanup(); throw quotaFile({ limitBytes: quota.maxFileSizeBytes, sizeBytes: size }); }
    if (qb.used + delta > qb.spaceLimit) { cleanup(); throw quotaSpace({ limitBytes: quota.spaceLimitBytes, usedBytes: quota.usedBytes, needBytes: size }); }
    if (qb.trafficUsed + sizeBig > qb.trafficLimit) { cleanup(); throw quotaTraffic({ limitBytes: quota.traffic7dLimitBytes, usedBytes: quota.traffic7dUsedBytes }); }

    if (existing?.isDir) { cleanup(); throw conflict('同名目录已存在', { path: logical }); }

    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream';
    const fileName = basenameOf(logical);

    try {
      await getDriver(hit.strategy.type).writeFromTemp(hit.strategy, logical, tmpFile, { size, mime, name: fileName });
    } catch (e) { cleanup(); throw e; }
    cleanup();

    if (existing) {
      db.prepare('UPDATE nodes SET sizeBytes = ?, mime = ?, storageId = ?, updatedAt = ? WHERE id = ?')
        .run(String(size), mime, hit.strategy.id, nowIso(), existing.id);
    } else {
      insertNode({ email, parentId: parent.id, name: fileName, path: logical, isDir: false, sizeBytes: String(size), mime, storageId: hit.strategy.id });
    }
    recordTraffic(email, 'upload', String(size));
    writeAudit({ email, action: 'upload', target: logical, bytes: String(size), ip: clientIp(req), detail: JSON.stringify({ via: 'webdav' }) });

    res.status(existing ? 204 : 201).end();
  } catch (e) { cleanup(); next(e); }
});

// ---------- DELETE ----------

router.delete('/*', async (req, res, next) => {
  try {
    const logical = toLogical(req);
    const node = getNodeByPath(logical);
    if (!node) throw notFound('节点不存在');
    const hit = resolveForReq(req, logical);
    assertWritable(hit.strategy, logical);

    softDeleteRecursive(logical);
    writeAudit({ email: req.user.email, action: 'delete', target: logical, bytes: Number(node.sizeBytes), ip: clientIp(req), detail: JSON.stringify({ via: 'webdav' }) });
    res.status(204).end();
  } catch (e) { next(e); }
});

// ---------- MKCOL ----------

router.mkcol('/*', async (req, res, next) => {
  try {
    const logical = toLogical(req);
    const hit = resolveForReq(req, logical);
    assertWritable(hit.strategy, logical);

    if (getNodeByPath(logical)) throw webdavUnsupported({ reason: '已存在' });

    const parentLogical = parentOf(logical);
    const parent = getNodeByPath(parentLogical);
    if (!parent || !parent.isDir) throw conflict('父目录不存在，无法创建目录（WebDAV 409）', { path: parentLogical });

    await getDriver(hit.strategy.type).ensureDir(hit.strategy, logical);
    insertNode({
      email: req.user.email, parentId: parent.id, name: basenameOf(logical), path: logical,
      isDir: true, storageId: hit.strategy.id,
    });
    writeAudit({ email: req.user.email, action: 'mkdir', target: logical, ip: clientIp(req), detail: JSON.stringify({ via: 'webdav' }) });
    res.status(201).end();
  } catch (e) { next(e); }
});

// ---------- MOVE ----------

router.move('/*', async (req, res, next) => {
  try {
    const srcLogical = toLogical(req);
    const srcNode = getNodeByPath(srcLogical);
    if (!srcNode) throw notFound('源节点不存在');

    const destRel = parseDestination(req);
    if (!destRel) throw badRequest('invalid_input', '缺少或无法解析 Destination 头', { header: 'Destination' });
    const destLogical = normalizeLogicalPath(`${req.user.email}/${destRel}`, req.user.email);
    if (destLogical === srcLogical) throw badRequest('invalid_input', '源与目标相同', { field: 'Destination' });
    if (destLogical.startsWith(`${srcLogical}/`)) throw badRequest('invalid_input', '不能把目录移动到其子目录', { field: 'Destination' });

    const overwrite = String(req.headers.overwrite || 'T').trim().toUpperCase() !== 'F';
    const existingDest = getNodeByPath(destLogical);
    if (existingDest && !overwrite) {
      const e = new Error('目标已存在且 Overwrite=F');
      e.status = 412; e.code = 'precondition_failed'; throw e;
    }

    const srcHit = resolveForReq(req, srcLogical);
    const destHit = resolveForReq(req, destLogical);
    assertWritable(srcHit.strategy, srcLogical);
    assertWritable(destHit.strategy, destLogical);

    const destParentLogical = parentOf(destLogical);
    let destParent = getNodeByPath(destParentLogical);
    if (!destParent) {
      // 目标父目录缺失：先补目录节点（远端/本地 ensureDir），再校验其存在性
      const destHitForParent = resolveForReq(req, destParentLogical);
      assertWritable(destHitForParent.strategy, destParentLogical);
      await getDriver(destHitForParent.strategy.type).ensureDir(destHitForParent.strategy, destParentLogical);
      destParent = getNodeByPath(destParentLogical) || ensureDirNodes(req.user.email, destParentLogical);
    }
    if (!destParent || !destParent.isDir) throw conflict('目标父目录不存在（WebDAV 409）', { path: destParentLogical });

    const srcStrategy = srcNode.storageId
      ? db.prepare('SELECT * FROM storage_strategies WHERE id = ?').get(srcNode.storageId) || srcHit.strategy
      : srcHit.strategy;
    const destStrategy = destHit.strategy;
    const meta = { size: Number(srcNode.sizeBytes), mime: srcNode.mime, name: basenameOf(destLogical) };

    if (srcStrategy.id === destStrategy.id) {
      if (srcNode.isDir && srcStrategy.type !== 'volume') {
        throw badRequest('storage_unsupported', '远端存储不支持直接移动目录，请逐个文件移动');
      }
      await getDriver(srcStrategy.type).rename(srcStrategy, srcLogical, destLogical, meta);
    } else {
      if (srcNode.isDir) throw badRequest('storage_unsupported', '暂不支持跨存储策略移动目录，请先逐个文件移动');
      await transferAcross(srcStrategy, destStrategy, srcLogical, destLogical, meta);
    }

    // 元数据：目标若已存在（覆盖）先软删旧节点行语义，再改源行
    const tx = db.transaction(() => {
      if (existingDest) softDeleteRecursive(destLogical);
      const destParentId = destParent.id;
      db.prepare('UPDATE nodes SET parentId = ?, name = ?, path = ?, storageId = ?, updatedAt = ? WHERE id = ?')
        .run(destParentId, basenameOf(destLogical), destLogical, destStrategy.id, nowIso(), srcNode.id);
      if (srcNode.isDir) {
        const descendants = db.prepare('SELECT * FROM nodes WHERE path = ? OR path LIKE ? ORDER BY path ASC')
          .all(srcLogical, `${srcLogical}/%`)
          .filter((d) => d.id !== srcNode.id);
        for (const d of descendants) {
          const newDesc = destLogical + d.path.slice(srcLogical.length);
          db.prepare('UPDATE nodes SET path = ?, updatedAt = ? WHERE id = ?').run(newDesc, nowIso(), d.id);
        }
      }
    });
    tx();

    writeAudit({ email: req.user.email, action: 'rename', target: `${srcLogical} → ${destLogical}`, ip: clientIp(req), detail: JSON.stringify({ via: 'webdav' }) });
    res.status(existingDest ? 204 : 201).end();
  } catch (e) { next(e); }
});

/** 解析 Destination 头：支持绝对 URL（http://host/dav/...）与相对路径 /dav/... */
function parseDestination(req) {
  const raw = String(req.headers.destination || '').trim();
  if (!raw) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try { pathname = new URL(raw).pathname; } catch { return null; }
  }
  // 去掉 /dav 前缀
  const prefix = '/dav';
  let rest = pathname;
  if (rest.startsWith(prefix + '/')) rest = rest.slice(prefix.length + 1);
  else if (rest === prefix || rest === prefix + '/') rest = '';
  else if (!rest.startsWith('/')) rest = pathname.slice(1);
  else rest = rest.slice(1);
  rest = decodeURIComponent(rest);
  if (rest.includes('..')) throw forbidden('Destination 路径包含非法段（越界）');
  return rest.split('/').filter((s) => s !== '' && s !== '.').join('/');
}

/** 跨策略搬运：读源 → 临时文件 → 写目标 → 删源（流式，不整文件进内存） */
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

// ---------- 未支持方法 → 405 ----------

const UNSUPPORTED = ['post', 'patch', 'proppatch', 'copy', 'lock', 'unlock'];
function unsupportedHandler(req, res) {
  res.setHeader('Allow', ALLOWED_METHODS);
  const e = webdavUnsupported({ method: req.method });
  res.status(e.status).end();
}
for (const m of UNSUPPORTED) {
  if (typeof router[m] === 'function') {
    router[m]('/', unsupportedHandler);
    router[m]('/*', unsupportedHandler);
  }
}

export default router;
