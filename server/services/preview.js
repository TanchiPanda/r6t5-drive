// P3 在线预览核心。对外只暴露 sendPreview（及供路由/meta 复用的分类辅助函数）。
// 不做鉴权：登录校验、分享校验由调用方完成；响应里不泄露物理路径、策略密钥。
// 仅使用 node 内建模块。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { readPathOf } from './blobs.js';
import { getDriver } from './storage/driver.js';
import { extOfPath, OFFICE_EXT, OFFICE_MIME } from './preview-config.js';
import { ZipReader } from '../lib/zip.js';
import { renderMarkdown, assertSafeHtml } from '../lib/markdown.js';
import {
  notFound, previewUnsupported, previewTooLarge, storageError, badRequest, ApiError,
} from '../lib/errors.js';

// ---- 大小上限 ----
const BINARY_PREVIEW_LIMIT = 200 * 1024 * 1024; // 图片 / PDF / 视频 200 MB
const TEXT_PREVIEW_LIMIT = 1 * 1024 * 1024;     // 文本 / 代码 1 MB
const REMOTE_TEMP_LIMIT = 100 * 1024 * 1024;    // 不支持 Range 的远端策略落临时文件上限 100 MB

// ---- 类型表 ----
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

const VIDEO_MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
};

const PDF_MIME = 'application/pdf';

const AUDIO_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
};

const EPUB_MIME = 'application/epub+zip';
const ZIP_MIME = 'application/zip';

// 文本 / 代码：扩展名 → 代码语言标识（供前端高亮；content 原样返回，转义由前端做）
const TEXT_LANG = {
  txt: 'plaintext', md: 'markdown', log: 'plaintext',
  json: 'json', yml: 'yaml', yaml: 'yaml',
  js: 'javascript', ts: 'typescript', jsx: 'jsx', tsx: 'tsx',
  py: 'python', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c',
  sh: 'shell', css: 'css', html: 'html', csv: 'csv', xml: 'xml',
  ini: 'ini', conf: 'ini', sql: 'sql', rb: 'ruby', php: 'php', rs: 'rust',
  toml: 'toml',
};

const EXT_RE = /\.([a-z0-9]+)$/i;

function extOf(logicalPath) {
  const name = String(logicalPath || '').split('/').pop() || '';
  const m = name.match(EXT_RE);
  return m ? m[1].toLowerCase() : '';
}

/** 分类：image | video | pdf | text | markdown | svg | unsupported */
export function classify(logicalPath, mime) {
  const ext = extOf(logicalPath);
  if (IMAGE_MIME[ext]) return { kind: 'image', ext, mime: IMAGE_MIME[ext], language: null };
  if (ext === 'svg') return { kind: 'svg', ext, mime: 'image/svg+xml', language: null };
  if (VIDEO_MIME[ext]) return { kind: 'video', ext, mime: VIDEO_MIME[ext], language: null };
  if (ext === 'pdf') return { kind: 'pdf', ext, mime: PDF_MIME, language: null };
  if (AUDIO_MIME[ext]) return { kind: 'audio', ext, mime: AUDIO_MIME[ext], language: null };
  if (ext === 'epub') return { kind: 'epub', ext, mime: EPUB_MIME, language: null };
  if (ext === 'zip') return { kind: 'zip', ext, mime: ZIP_MIME, language: null };
  if (ext === 'md') return { kind: 'markdown', ext, mime: 'text/markdown', language: 'markdown' };
  if (TEXT_LANG[ext]) return { kind: 'text', ext, mime: 'text/plain; charset=utf-8', language: TEXT_LANG[ext] };
  // 兜底：MIME 明确是 PDF / 图片 / 文本时按 MIME 归类
  const m = String(mime || '').toLowerCase();
  if (m === PDF_MIME) return { kind: 'pdf', ext, mime: PDF_MIME, language: null };
  if (m.startsWith('image/') && ext !== 'svg') return { kind: 'image', ext, mime: m, language: null };
  if (m.startsWith('video/')) return { kind: 'video', ext, mime: m, language: null };
  if (m.startsWith('text/') || m.includes('json') || m.includes('xml')) {
    return { kind: 'text', ext, mime: 'text/plain; charset=utf-8', language: TEXT_LANG[ext] || 'plaintext' };
  }
  return { kind: 'unsupported', ext, mime: m || 'application/octet-stream', language: null };
}

/** 预览是否可被 sendPreview 直出（svg / unsupported 不可）。meta 接口据此给 reason。 */
export function previewable(classification) {
  return ['image', 'video', 'audio', 'pdf', 'epub', 'zip', 'text', 'markdown'].includes(classification.kind);
}

/** 不可预览时的中文说明（供 /meta 使用）。 */
export function unsupportedReason(classification) {
  if (classification.kind === 'svg') return 'SVG 含可执行脚本，出于安全考虑不支持在线预览，请下载查看';
  if (classification.kind === 'unsupported') return '该文件类型暂不支持在线预览，请下载查看';
  return '';
}

/**
 * 外部在线渲染（Google Docs / Microsoft 365）取文件：仅 Office 与 PDF，原样 inline 输出。
 * 调用方负责令牌校验；这里只做类型与大小保护。
 */
export async function sendEmbedFile({ req, res, strategy, logicalPath, node }) {
  const ext = extOfPath(logicalPath);
  if (ext !== 'pdf' && !OFFICE_EXT.includes(ext)) {
    throw previewUnsupported({ reason: 'embed_unsupported' });
  }
  const mime = ext === 'pdf' ? PDF_MIME : (OFFICE_MIME[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  await sendBinary({
    res,
    strategy,
    logicalPath,
    node,
    classification: { kind: 'binary', mime },
    req,
    rangeHeader: null,
  });
}

// ---- 远端 / 本地读取辅助 ----

function driverOf(strategy) {
  return getDriver(strategy.type);
}

/**
 * 取文件大小。优先 node?.sizeBytes；未知时探测（volume 用 stat，其余读流长度）。
 * @returns {Promise<number|null>} 未知返回 null
 */
async function probeSize(strategy, logicalPath, node) {
  if (node && Number.isFinite(Number(node.sizeBytes)) && Number(node.sizeBytes) > 0) {
    return Number(node.sizeBytes);
  }
  if (strategy.type === 'volume') {
    try {
      // 复用驱动的物理路径解析不对外暴露；这里通过驱动 readStream 前先 stat 同名物理路径
      const phys = volumePhysicalPath(strategy, readPathOf(node, logicalPath));
      return fs.statSync(phys).size;
    } catch { return null; }
  }
  return null; // github/s3 不在这里做 HEAD 探测，交由读取时的 Content-Length 判断
}

/** volume 物理路径（与 storage/volume.js 同一套安全解析，仅用于 stat，不回传调用方）。 */
function volumePhysicalPath(strategy, logicalPath) {
  const cfg = strategy?.config ? safeParse(strategy.config) : {};
  const root = path.isAbsolute(cfg.rootPath || '') ? cfg.rootPath : path.resolve(process.cwd(), cfg.rootPath || process.env.STORAGE_ROOT || 'data/volume');
  const email = String(logicalPath).split('/')[0].toLowerCase();
  const base = path.resolve(root, email);
  const rest = String(logicalPath).split('/').slice(1);
  const phys = path.resolve(base, ...rest);
  if (phys !== base && !phys.startsWith(base + path.sep)) throw storageError('物理路径越界');
  return phys;
}

function safeParse(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

/**
 * 读取整个文件为 Buffer（文本 / Markdown / 图片小文件兜底用）。
 * 带大小保护：超出 softLimit 直接抛 previewTooLarge，不继续缓冲。
 */
async function readWhole(strategy, logicalPath, { softLimit, node } = {}) {
  const driver = driverOf(strategy);
  const stream = await driver.readStream(strategy, readPathOf(node, logicalPath), { size: node?.sizeBytes, mime: node?.mime });
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (softLimit != null && total > softLimit) {
      try { stream.destroy(); } catch {}
      throw previewTooLarge({ limitBytes: softLimit, sizeBytes: total });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/**
 * ZIP 条目清单（只读，不解压、不落盘到用户目录）。
 * volume 直接按物理文件解析；远端策略按 ≤100MB 上限落临时文件后解析。
 */
export async function listZipEntries({ strategy, logicalPath, node }) {
  const total = await probeSize(strategy, logicalPath, node);
  if (total != null && total > BINARY_PREVIEW_LIMIT) {
    throw previewTooLarge({ limitBytes: BINARY_PREVIEW_LIMIT, sizeBytes: total });
  }
  let filePath = null;
  let cleanup = null;
  if (strategy.type === 'volume') {
    filePath = volumePhysicalPath(strategy, readPathOf(node, logicalPath));
  } else {
    const tmp = await materializeRemote(strategy, logicalPath, node);
    filePath = tmp.tmpFile;
    cleanup = tmp.cleanup;
  }
  const reader = ZipReader.open(filePath);
  try {
    const entries = reader.readEntries();
    const limit = 2000;
    const items = entries.slice(0, limit).map((e) => ({
      name: e.name,
      isDir: e.isDir,
      size: e.uncompSize,
      compressedSize: e.compSize,
      method: e.method === 8 ? 'deflate' : e.method === 0 ? 'store' : 'other',
    }));
    return {
      count: entries.length,
      truncated: entries.length > limit,
      items,
    };
  } finally {
    reader.close();
    if (cleanup) cleanup();
  }
}

// ---- Range 解析 ----

function parseRange(header, total) {
  if (!header || typeof header !== 'string') return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return { malformed: true };
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start != null && Number.isNaN(start)) return { malformed: true };
  if (end != null && Number.isNaN(end)) return { malformed: true };

  // 后缀区间 bytes=-N
  if (start == null && end != null) {
    start = Math.max(0, total - end);
    end = total - 1;
  } else if (start != null && end == null) {
    end = total - 1;
  }
  if (start == null || end == null) return { malformed: true };
  if (start > end || start >= total) return { unsatisfiable: true, total };
  if (end >= total) end = total - 1;
  return { start, end, total };
}

// ---- EXIF Orientation（纯 JS，仅解析 JPEG tag 0x0112）----

/** 在 JPEG Buffer 中查找 EXIF Orientation（1..8）；找不到返回 null。 */
export function jpegOrientation(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  const len = buf.length;
  while (offset + 4 < len) {
    if (buf[offset] !== 0xff) return null;
    const marker = buf[offset + 1];
    // 掉数据 / 填充段
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2 || offset + 2 + segLen > len) return null;
    if (marker === 0xe1 && buf.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      return readOrientationInExif(buf, offset + 10, segLen - 8);
    }
    offset += 2 + segLen;
  }
  return null;
}

function readOrientationInExif(buf, ifdStart, _segLen) {
  // TIFF 头
  const endian = buf.toString('ascii', ifdStart, ifdStart + 2);
  const little = endian === 'II';
  const read16 = (o) => (little ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const read32 = (o) => (little ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const magic = read16(ifdStart + 2);
  if (magic !== 0x002a) return null;
  const firstIfd = read32(ifdStart + 4);
  let ifd = ifdStart + firstIfd;
  const entries = read16(ifd);
  for (let i = 0; i < entries; i += 1) {
    const e = ifd + 2 + i * 12;
    const tag = read16(e);
    if (tag === 0x0112) {
      const type = read16(e + 2);
      const count = read32(e + 4);
      if (count < 1) return null;
      // SHORT(3)：值直接存在值字段前两字节
      if (type === 3) return read16(e + 8);
      return null;
    }
  }
  return null;
}

// ---- 视频 / 二进制流式输出（含 Range）----

/**
 * 远端不支持 Range 时：≤100MB 落临时文件再按范围读；>100MB 抛 415。
 * 返回 { cleanup, size, stream }。
 */
async function materializeRemote(strategy, logicalPath, node) {
  const driver = driverOf(strategy);
  const stream = await driver.readStream(strategy, readPathOf(node, logicalPath), { size: node?.sizeBytes, mime: node?.mime });
  const tmpFile = path.join(os.tmpdir(), `r6t5-preview-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  let total = 0;
  const out = fs.createWriteStream(tmpFile);
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > REMOTE_TEMP_LIMIT) {
        out.destroy();
        fs.rmSync(tmpFile, { force: true });
        throw previewUnsupported({ reason: 'remote_oversize', limitBytes: REMOTE_TEMP_LIMIT });
      }
      out.write(chunk);
    }
    await new Promise((resolve, reject) => {
      out.end();
      out.on('finish', resolve);
      out.on('error', reject);
    });
    return { tmpFile, size: total, cleanup: () => fs.rmSync(tmpFile, { force: true }) };
  } catch (e) {
    fs.rmSync(tmpFile, { force: true });
    throw e;
  }
}

/** 驱动是否原生支持 Range（meta.range）。 */
function driverSupportsRange(strategy) {
  if (strategy.type === 'volume') return true;
  const driver = driverOf(strategy);
  return !!(driver.caps && driver.caps.range);
}

/**
 * 输出视频 / 图片 / PDF 这类二进制（支持 Range 的主要是视频；图片/PDF 也按全量输出）。
 */
async function sendBinary({ res, strategy, logicalPath, node, classification, req, rangeHeader }) {
  const total = await probeSize(strategy, logicalPath, node);
  const mime = classification.mime;
  const name = String(logicalPath).split('/').pop();

  // 已知大小先判 200MB 上限
  if (total != null && total > BINARY_PREVIEW_LIMIT) {
    throw previewTooLarge({ limitBytes: BINARY_PREVIEW_LIMIT, sizeBytes: total });
  }

  const wantRange = (classification.kind === 'video' || classification.kind === 'audio') && rangeHeader;

  // ---- volume：本地 fs 流，天然支持 start/end ----
  if (strategy.type === 'volume') {
    const phys = volumePhysicalPath(strategy, readPathOf(node, logicalPath));
    let stat;
    try { stat = fs.statSync(phys); } catch { throw notFound('文件不存在'); }
    const size = stat.size;
    if (size > BINARY_PREVIEW_LIMIT) throw previewTooLarge({ limitBytes: BINARY_PREVIEW_LIMIT, sizeBytes: size });

    if (wantRange) {
      const parsed = parseRange(rangeHeader, size);
      if (parsed.malformed) throw badRequest('invalid_range', 'Range 头格式非法');
      if (parsed.unsatisfiable) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416);
        return res.end();
      }
      const { start, end } = parsed;
      res.status(206);
      res.setHeader('Content-Type', mime);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      fs.createReadStream(phys, { start, end }).pipe(res);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    fs.createReadStream(phys).pipe(res);
    return;
  }

  // ---- 支持 Range 的远端驱动（s3）----
  if (driverSupportsRange(strategy)) {
    const driver = driverOf(strategy);
    if (wantRange) {
      // 先取总长度（node 已知则用；否则读一次无 Range 流的 content-length 由驱动 meta 提供）
      let size = total;
      if (size == null) {
        // 用 HEAD 风格：直接 GET 不带 Range，从响应头拿长度后再按范围读
        const probe = await driver.readStream(strategy, readPathOf(node, logicalPath), { size: node?.sizeBytes, mime: node?.mime });
        size = Number(probe.meta?.headers?.['content-length'] || 0) || null;
        try { probe.destroy(); } catch {}
      }
      if (size == null) throw storageError('无法确定远端文件长度，暂不支持 Range 预览');
      const parsed = parseRange(rangeHeader, size);
      if (parsed.malformed) throw badRequest('invalid_range', 'Range 头格式非法');
      if (parsed.unsatisfiable) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416);
        return res.end();
      }
      const { start, end } = parsed;
      const range = `bytes=${start}-${end}`;
      const stream = await driver.readStream(strategy, readPathOf(node, logicalPath), { size, mime, range });
      res.status(206);
      res.setHeader('Content-Type', mime);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      stream.pipe(res);
      return;
    }
    const stream = await driver.readStream(strategy, readPathOf(node, logicalPath), { size: total, mime });
    res.status(200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    if (total != null) res.setHeader('Content-Length', String(total));
    stream.pipe(res);
    return;
  }

  // ---- 不支持 Range 的远端（github）：落临时文件 ----
  const mat = await materializeRemote(strategy, logicalPath, node);
  try {
    if (mat.size > BINARY_PREVIEW_LIMIT) throw previewTooLarge({ limitBytes: BINARY_PREVIEW_LIMIT, sizeBytes: mat.size });
    if (wantRange) {
      const parsed = parseRange(rangeHeader, mat.size);
      if (parsed.malformed) throw badRequest('invalid_range', 'Range 头格式非法');
      if (parsed.unsatisfiable) {
        res.setHeader('Content-Range', `bytes */${mat.size}`);
        res.status(416);
        return res.end();
      }
      const { start, end } = parsed;
      res.status(206);
      res.setHeader('Content-Type', mime);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Range', `bytes ${start}-${end}/${mat.size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
      fs.createReadStream(mat.tmpFile, { start, end }).on('close', mat.cleanup).pipe(res);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(mat.size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    fs.createReadStream(mat.tmpFile).on('close', mat.cleanup).pipe(res);
  } catch (e) {
    mat.cleanup();
    throw e;
  }
}

// ---- 文本 / Markdown ----

async function sendText({ res, strategy, logicalPath, node, classification }) {
  const buf = await readWhole(strategy, logicalPath, { softLimit: TEXT_PREVIEW_LIMIT, node });
  if (buf.length > TEXT_PREVIEW_LIMIT) {
    throw previewTooLarge({ limitBytes: TEXT_PREVIEW_LIMIT, sizeBytes: buf.length });
  }
  const content = buf.toString('utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({
    kind: 'text',
    language: classification.language || 'plaintext',
    content,
    sizeBytes: buf.length,
    truncated: false,
  });
}

async function sendMarkdown({ res, strategy, logicalPath, node }) {
  const buf = await readWhole(strategy, logicalPath, { softLimit: TEXT_PREVIEW_LIMIT, node });
  if (buf.length > TEXT_PREVIEW_LIMIT) {
    throw previewTooLarge({ limitBytes: TEXT_PREVIEW_LIMIT, sizeBytes: buf.length });
  }
  const raw = buf.toString('utf8');
  const html = renderMarkdown(raw);
  assertSafeHtml(html); // 防御纵深：命中非法内容直接抛错，不外泄
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ kind: 'markdown', html, content: raw, sizeBytes: buf.length });
}

// ---- 主入口 ----

/**
 * 对外固定签名：
 *   export async function sendPreview({ req, res, strategy, logicalPath, node })
 * @param {object} req Express 请求（读 headers.Range / query.exif）
 * @param {object} res Express 响应
 * @param {object} strategy 已解析的存储策略对象
 * @param {string} logicalPath 逻辑路径 alice@x.com/inbox/a.png
 * @param {object|null} node getNodeByPath 的节点（远端条目可能为 null）
 */
export async function sendPreview({ req, res, strategy, logicalPath, node }) {
  if (!strategy) throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略');
  const classification = classify(logicalPath, node?.mime);
  const rangeHeader = req?.headers?.range || null;
  const exif = String(req?.query?.exif || '') === '1';

  switch (classification.kind) {
    case 'image': {
      // 图片全量输出；EXIF 方向仅在 exif=1 时解析（纯 JS，不做服务端重编码）
      const buf = await readWhole(strategy, logicalPath, { softLimit: BINARY_PREVIEW_LIMIT, node });
      if (buf.length > BINARY_PREVIEW_LIMIT) {
        throw previewTooLarge({ limitBytes: BINARY_PREVIEW_LIMIT, sizeBytes: buf.length });
      }
      res.setHeader('Content-Type', classification.mime);
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(String(logicalPath).split('/').pop())}`);
      res.setHeader('Content-Length', String(buf.length));
      if (exif) {
        const orient = jpegOrientation(buf);
        if (orient != null) res.setHeader('X-Image-Orientation', String(orient));
      }
      res.end(buf);
      return;
    }
    case 'video':
    case 'audio':
    case 'pdf':
    case 'epub':
      await sendBinary({ res, strategy, logicalPath, node, classification, req, rangeHeader });
      return;
    case 'text':
      await sendText({ res, strategy, logicalPath, node, classification });
      return;
    case 'markdown':
      await sendMarkdown({ res, strategy, logicalPath, node });
      return;
    case 'svg':
      throw previewUnsupported({ reason: 'svg_blocked', hint: 'SVG 含可执行脚本，出于安全考虑不支持在线预览，请下载查看' });
    default:
      throw previewUnsupported({ reason: 'unsupported_type', ext: classification.ext });
  }
}
