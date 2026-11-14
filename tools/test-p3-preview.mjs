// P3 预览后端自测。两种模式：
//   1) HTTP 模式：环境变量 PREVIEW_BASE 有值（如 http://127.0.0.1:8090），走真实 Express 路由。
//      脚本自己用公开接口造 fixture：dev-login → 必要时兜底建 volume 策略 → multipart 上传，
//      不依赖库里已有数据。服务需以 DEV_AUTH=1 运行；ADMIN_PASSWORD 用于兜底建策略。
//   2) 直调模式：未设 PREVIEW_BASE 时，构造真实 volume 策略 + 临时文件，mock req/res 直接
//      import sendPreview 调用（用于路由尚未挂载的场景）。
//
// 覆盖：图片 200 + Content-Type；EXIF Orientation=6 头；文本 JSON + 超 1MB 413；
// Markdown 渲染后不含 <script / onerror= / javascript: / <iframe；视频 Range 206 +
// Content-Range；非法 Range 416；PDF 200 inline；SVG 415；未知后缀 415；/meta 视图询问。
// 逐条 PASS/FAIL + 汇总，任一失败 exit 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { sendPreview, classify, previewable, unsupportedReason } from '../server/services/preview.js';

const PREVIEW_BASE = (process.env.PREVIEW_BASE || '').replace(/\/+$/, '');
const EMAIL = process.env.TEST_EMAIL || 'preview@x.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';
const results = [];

function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

// ---------- 构造最小 JPEG（含 EXIF Orientation=6） ----------

function u16be(v) { return Buffer.from([(v >> 8) & 0xff, v & 0xff]); }
function u16le(v) { return Buffer.from([v & 0xff, (v >> 8) & 0xff]); }
function u32le(v) { return Buffer.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]); }

/** 拼一个带 EXIF IFD（Orientation=6）的最小 JPEG，返回 Buffer。 */
function jpegWithOrientation(orientation) {
  const endian = Buffer.from('II', 'ascii');
  const magic = u16le(0x002a);
  const ifdOffset = u32le(8);
  const entryCount = u16le(1);
  const tag = u16le(0x0112);
  const type = u16le(3); // SHORT
  const count = u32le(1);
  const value = u16le(orientation);
  const pad = u16le(0);
  const nextIfd = u32le(0);
  const ifd = Buffer.concat([entryCount, tag, type, count, value, pad, nextIfd]);
  const exifBody = Buffer.concat([endian, magic, ifdOffset, ifd]);

  const app1Payload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), exifBody]);
  const segLen = app1Payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u16be(segLen), app1Payload]);

  const soi = Buffer.from([0xff, 0xd8]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, eoi]);
}

// ---------- fixture 字节（两种模式共用） ----------

const pngBytes = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082',
  'hex'
);
const jpegOrient6 = jpegWithOrientation(6);
const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF', 'utf8');
const textBytes = Buffer.from('hello 世界\nconst x = 1;\n', 'utf8');
const mdGood = '# 标题\n\n**粗体** 与 *斜体* 与 `code`\n\n- 列表项\n- 第二项\n\n> 引用\n\n[官网](https://example.com)';
const mdBad = [
  '<script>alert(1)</script>',
  '[x](javascript:alert(1))',
  '<img src=x onerror=alert(1)>',
  '<iframe src="https://evil.example"></iframe>',
  '<object data="evil"></object>',
  'onload=steal',
].join('\n');
const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');
const unknownBytes = Buffer.from('binary-unknown', 'utf8');

// 5MB 假视频（随机字节，便于 Range 校验长度）
const videoSize = 5 * 1024 * 1024;
const videoBytes = Buffer.alloc(videoSize);
for (let i = 0; i < videoSize; i += 1024) crypto.randomBytes(Math.min(1024, videoSize - i)).copy(videoBytes, i);

// 超 1MB 文本
const bigText = Buffer.alloc(1024 * 1024 + 16, 0x61);

// 文件名 → 字节 / MIME（HTTP 上传与直调落盘共用同一份清单）
const FIXTURES = [
  { key: 'png', name: 'a.png', mime: 'image/png', bytes: pngBytes },
  { key: 'jpgOrient', name: 'orient6.jpg', mime: 'image/jpeg', bytes: jpegOrient6 },
  { key: 'pdf', name: 'doc.pdf', mime: 'application/pdf', bytes: pdfBytes },
  { key: 'txt', name: 'note.txt', mime: 'text/plain; charset=utf-8', bytes: textBytes },
  { key: 'mdGood', name: 'good.md', mime: 'text/markdown', bytes: Buffer.from(mdGood, 'utf8') },
  { key: 'mdBad', name: 'evil.md', mime: 'text/markdown', bytes: Buffer.from(mdBad, 'utf8') },
  { key: 'svg', name: 'pic.svg', mime: 'image/svg+xml', bytes: svgBytes },
  { key: 'unknown', name: 'data.unknownext', mime: 'application/octet-stream', bytes: unknownBytes },
  { key: 'video', name: 'clip.mp4', mime: 'video/mp4', bytes: videoBytes },
  { key: 'bigTxt', name: 'big.txt', mime: 'text/plain; charset=utf-8', bytes: bigText },
];

// ---------- 直调模式：临时 volume 策略 + 本地落盘 ----------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r6t5-p3-preview-'));
const strategy = {
  id: 's-test-vol',
  type: 'volume',
  name: '自测本地卷',
  config: JSON.stringify({ rootPath: tmpRoot }),
};

function putLocal(relPath, buf) {
  const logical = `${EMAIL}/${relPath}`;
  const phys = path.join(tmpRoot, EMAIL, relPath);
  fs.mkdirSync(path.dirname(phys), { recursive: true });
  fs.writeFileSync(phys, buf);
  return logical;
}

function mockRes() {
  const chunks = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  const res = writable;
  res.statusCode = 200;
  res.headers = {};
  res.body = null;
  res.chunks = chunks;
  res.status = function (code) { this.statusCode = code; return this; };
  res.setHeader = function (k, v) { this.headers[k.toLowerCase()] = String(v); };
  res.getHeader = function (k) { return this.headers[k.toLowerCase()]; };
  res.json = function (obj) {
    this.body = obj; this.jsonBody = obj;
    this.body = JSON.stringify(obj);
    this.headers['content-type'] = 'application/json; charset=utf-8';
    this.finished = true;
  };
  res.end = function (buf) {
    if (buf != null) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    this.body = Buffer.concat(chunks);
    this.finished = true;
  };
  return res;
}

function mockReq(query = {}, headers = {}) {
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
  return { query, headers: lowerHeaders, user: { email: EMAIL } };
}

/** 直调 sendPreview 并把流收集成 Buffer；返回 { status, headers, body, json }。 */
async function callDirect({ logical, node, query, headers }) {
  const res = mockRes();
  const req = mockReq(query, headers);
  const drained = new Promise((resolve) => {
    res.on('finish', resolve);
    res.on('close', resolve);
    setTimeout(resolve, 2000);
  });
  try {
    await sendPreview({ req, res, strategy, logicalPath: logical, node });
  } catch (e) {
    return {
      status: e.status || 500,
      headers: res.headers,
      body: null,
      json: { error: { code: e.code || 'internal_error', message: e.message, details: e.details || {} } },
    };
  }
  await drained;
  let body = res.body;
  if (body == null && res.chunks.length) body = Buffer.concat(res.chunks);
  return { status: res.statusCode, headers: res.headers, body, json: res.jsonBody };
}

// ---------- HTTP 模式辅助 ----------

let userCookie = '';
let adminCookie = '';

function cookiesFrom(headers) {
  const arr = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return arr.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

async function httpJson(method, url, { body, cookie, headers = {} } = {}) {
  const opts = { method, headers: { Cookie: cookie || '', ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  return { status: r.status, ok: r.ok, headers: r.headers, body: buf, json, setCookie: cookiesFrom(r.headers) };
}

async function httpLogin() {
  const r = await httpJson('POST', `${PREVIEW_BASE}/api/auth/dev-login`, { body: { email: EMAIL } });
  userCookie = r.setCookie;
  return { ok: r.ok && !!userCookie, status: r.status };
}

/** 探测存储策略；412 时用管理员登录兜底建一条 volume 策略。 */
async function ensureStrategy() {
  const probe = await httpJson('GET', `${PREVIEW_BASE}/api/files?path=${encodeURIComponent(EMAIL)}`, { cookie: userCookie });
  const code = probe.json?.error?.code || '';
  if (code !== 'storage_not_configured') return;

  console.log('[setup] 探测到 storage_not_configured，兜底创建 volume 存储策略…');
  const login = await httpJson('POST', `${PREVIEW_BASE}/api/admin/login`, { body: { password: ADMIN_PASSWORD } });
  if (!login.ok) {
    console.log(`[setup] 管理员登录失败 status=${login.status} code=${login.json?.error?.code || ''}，无法兜底建策略`);
    return;
  }
  adminCookie = login.setCookie;
  const created = await httpJson('POST', `${PREVIEW_BASE}/api/admin/storage`, {
    cookie: adminCookie,
    body: {
      name: 'P3 自测本地卷',
      type: 'volume',
      capacityBytes: 10 * 1024 * 1024 * 1024,
      readOnly: false,
      acknowledgeDisclosure: true,
      config: { rootPath: '' },
    },
  });
  console.log(`[setup] 兜底创建 volume 存储策略：status=${created.status} ${created.json?.item?.name || ''}`);
}

/** multipart 上传单个 fixture 到 <EMAIL>/inbox，返回逻辑路径。 */
async function httpUpload(fx) {
  const fd = new FormData();
  fd.append('overwrite', '1');
  fd.append('file', new File([fx.bytes], fx.name, { type: fx.mime }));
  const parent = `${EMAIL}/inbox`;
  const r = await fetch(`${PREVIEW_BASE}/api/files/upload?path=${encodeURIComponent(parent)}`, {
    method: 'POST',
    headers: { Cookie: userCookie },
    body: fd,
  });
  const ct = r.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8')); } catch { json = null; } }
  if (!r.ok) {
    throw new Error(`上传 ${fx.name} 失败 status=${r.status} code=${json?.error?.code || ''} msg=${json?.error?.message || ''}`);
  }
  return json?.item?.path || `${parent}/${fx.name}`;
}

async function httpCall(logical, { query = {}, headers = {} } = {}) {
  const qs = new URLSearchParams({ path: logical, ...query }).toString();
  const r = await fetch(`${PREVIEW_BASE}/api/files/preview?${qs}`, {
    headers: { Cookie: userCookie, ...headers },
  });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  return {
    status: r.status,
    headers: Object.fromEntries(r.headers.entries()),
    body: buf,
    json,
  };
}

async function httpMeta(logical) {
  const qs = new URLSearchParams({ path: logical }).toString();
  const r = await fetch(`${PREVIEW_BASE}/api/files/preview/meta?${qs}`, { headers: { Cookie: userCookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; }
  return { status: r.status, json };
}

// ---------- 运行 ----------

async function main() {
  const mode = PREVIEW_BASE ? 'HTTP' : 'DIRECT';
  console.log(`== P3 预览自测 · 模式=${mode} ${PREVIEW_BASE ? `base=${PREVIEW_BASE} email=${EMAIL}` : `tmpRoot=${tmpRoot}`} ==\n`);

  // 准备 fixture：直调落本地临时卷；HTTP 走公开接口上传
  const files = {};
  if (mode === 'HTTP') {
    const ok = await httpLogin();
    check('dev-login 建立会话', ok.ok, `status=${ok.status} cookie=${userCookie ? '已携带' : '空'}`);
    await ensureStrategy();
    for (const fx of FIXTURES) {
      try {
        files[fx.key] = await httpUpload(fx);
        console.log(`[setup] 上传 ${fx.name} → ${files[fx.key]} (${fx.bytes.length} bytes)`);
      } catch (e) {
        check(`上传 fixture ${fx.name}`, false, e.message);
        files[fx.key] = `${EMAIL}/inbox/${fx.name}`;
      }
    }
  } else {
    for (const fx of FIXTURES) files[fx.key] = putLocal(`inbox/${fx.name}`, fx.bytes);
  }

  const call = mode === 'HTTP'
    ? httpCall
    : (logical, opts = {}) => callDirect({ logical, ...opts });

  // 1. 图片 PNG 200 + Content-Type
  {
    const r = await call(files.png);
    const ct = (r.headers['content-type'] || r.headers['Content-Type'] || '');
    check('1. PNG 预览 200 且 Content-Type=image/png',
      r.status === 200 && ct.includes('image/png'),
      `status=${r.status} content-type=${ct} bytes=${r.body?.length ?? 0}`);
  }

  // 2. EXIF Orientation=6 → X-Image-Orientation: 6
  {
    const r = await call(files.jpgOrient, { query: { exif: '1' } });
    const orient = r.headers['x-image-orientation'] || r.headers['X-Image-Orientation'];
    check('2. JPEG EXIF Orientation=6 回传 X-Image-Orientation:6',
      r.status === 200 && orient === '6',
      `status=${r.status} orientation=${orient ?? '(未回传)'} bytes=${r.body?.length ?? 0}`);
  }

  // 3. 文本 JSON：kind=text / language / content / sizeBytes / truncated=false
  {
    const r = await call(files.txt);
    const j = r.json;
    check('3. 文本返回 JSON kind=text 且字段完整',
      r.status === 200 && j?.kind === 'text' && j.language === 'plaintext' &&
      j.content === textBytes.toString('utf8') && j.sizeBytes === textBytes.length && j.truncated === false,
      `status=${r.status} kind=${j?.kind} language=${j?.language} size=${j?.sizeBytes} truncated=${j?.truncated}`);
  }

  // 4. 超 1MB 文本 → 413 preview_too_large
  {
    const r = await call(files.bigTxt);
    const code = r.json?.error?.code || '';
    check('4. 超 1MB 文本返回 413 preview_too_large',
      r.status === 413 && code === 'preview_too_large',
      `status=${r.status} code=${code} size=${bigText.length}`);
  }

  // 5. Markdown 正常渲染（标题/粗体/斜体/代码/列表/引用/链接）
  {
    const r = await call(files.mdGood);
    const html = r.json?.html || '';
    const ok = r.status === 200 && r.json?.kind === 'markdown' &&
      html.includes('<h1>') && html.includes('<strong>') && html.includes('<em>') &&
      html.includes('<code>') && html.includes('<ul>') && html.includes('<blockquote>') &&
      html.includes('href="https://example.com"');
    check('5. Markdown 白名单语法渲染成功', ok,
      `status=${r.status} kind=${r.json?.kind} html=${html.slice(0, 120).replace(/\n/g, ' ')}`);
  }

  // 6. Markdown 恶意输入：断言不含 <script / onerror= / javascript: / <iframe / <object
  {
    const r = await call(files.mdBad);
    const html = String(r.json?.html || '');
    const lowered = html.toLowerCase();
    const forbidden = ['<script', 'onerror=', 'javascript:', '<iframe', '<object', 'onload='];
    const hits = forbidden.filter((f) => lowered.includes(f));
    check('6. Markdown 恶意输入 XSS 全部被过滤',
      r.status === 200 && hits.length === 0,
      `status=${r.status} 命中=${hits.length ? hits.join(',') : '无'} html=${html.slice(0, 160).replace(/\n/g, ' ')}`);
  }

  // 7. PDF 200 inline
  {
    const r = await call(files.pdf);
    const ct = (r.headers['content-type'] || r.headers['Content-Type'] || '');
    const cd = (r.headers['content-disposition'] || r.headers['Content-Disposition'] || '');
    check('7. PDF 200 inline 且 Content-Type=application/pdf',
      r.status === 200 && ct.includes('application/pdf') && cd.startsWith('inline'),
      `status=${r.status} content-type=${ct} disposition=${cd}`);
  }

  // 8. SVG → 415 preview_unsupported
  {
    const r = await call(files.svg);
    const code = r.json?.error?.code || '';
    check('8. SVG 返回 415 preview_unsupported',
      r.status === 415 && code === 'preview_unsupported',
      `status=${r.status} code=${code}`);
  }

  // 9. 未知后缀 → 415 preview_unsupported
  {
    const r = await call(files.unknown);
    const code = r.json?.error?.code || '';
    check('9. 未知后缀返回 415 preview_unsupported',
      r.status === 415 && code === 'preview_unsupported',
      `status=${r.status} code=${code}`);
  }

  // 10. 视频 Range bytes=0-99 → 206 + Content-Range bytes 0-99/5242880 + Accept-Ranges
  {
    const r = await call(files.video, { headers: { Range: 'bytes=0-99' } });
    const cr = r.headers['content-range'] || r.headers['Content-Range'] || '';
    const ar = r.headers['accept-ranges'] || r.headers['Accept-Ranges'] || '';
    check('10. 视频 Range bytes=0-99 → 206 + 正确 Content-Range',
      r.status === 206 && cr === `bytes 0-99/${videoSize}` && ar === 'bytes' && r.body.length === 100,
      `status=${r.status} content-range=${cr} accept-ranges=${ar} bytes=${r.body.length}`);
  }

  // 11. 视频越界 Range bytes=999999999- → 416
  {
    const r = await call(files.video, { headers: { Range: 'bytes=999999999-' } });
    const cr = r.headers['content-range'] || r.headers['Content-Range'] || '';
    check('11. 越界 Range → 416 + Content-Range bytes */total',
      r.status === 416 && cr === `bytes */${videoSize}`,
      `status=${r.status} content-range=${cr}`);
  }

  // 12. 视频无 Range → 200 全量
  {
    const r = await call(files.video);
    check('12. 视频无 Range → 200 全量',
      r.status === 200 && r.body.length === videoSize,
      `status=${r.status} bytes=${r.body.length}/${videoSize}`);
  }

  // 13. /meta 视图询问：文本可预览；SVG 不可预览且带中文 reason（不抛 415）
  {
    const metaTxt = mode === 'HTTP' ? await httpMeta(files.txt) : await httpMetaDirect(files.txt);
    const metaSvg = mode === 'HTTP' ? await httpMeta(files.svg) : await httpMetaDirect(files.svg);
    const okTxt = metaTxt.status === 200 && metaTxt.json?.kind === 'text' && metaTxt.json?.previewable === true;
    const okSvg = metaSvg.status === 200 && metaSvg.json?.kind === 'svg' && metaSvg.json?.previewable === false &&
      /SVG/.test(metaSvg.json?.reason || '');
    check('13. /meta 文本可预览、SVG 不可预览并返回中文 reason',
      okTxt && okSvg,
      `txt=${JSON.stringify(metaTxt.json)} svg=${JSON.stringify(metaSvg.json)}`);
  }

  // 汇总
  const failed = results.filter((x) => !x.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

// 直调模式下的 /meta：复用 classify 逻辑构造与路由一致的 meta 视图
function httpMetaDirect(logical) {
  const classification = classify(logical, null);
  const json = {
    kind: classification.kind,
    name: logical.split('/').pop(),
    sizeBytes: null,
    mime: classification.mime,
    language: classification.language || undefined,
    strategy: { type: strategy.type, name: strategy.name },
    previewable: previewable(classification),
    reason: previewable(classification) ? '' : unsupportedReason(classification),
  };
  return Promise.resolve({ status: 200, json });
}

main().catch((e) => {
  console.error('自测流程异常：', e?.stack || e);
  process.exit(1);
});
