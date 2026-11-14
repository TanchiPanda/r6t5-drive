// P5 媒体元数据解析自测（纯 JS，不调用 ffmpeg/系统命令生成样本）。
//
// 两种模式：
//   1) 直调模式（默认）：临时 sqlite + volume 策略，落盘 fixture 后直接调用
//      media 路由处理器（mock req/res），覆盖解析正确性、404、412、超大文件
//      500ms 内返回且 RSS 不暴涨。
//   2) HTTP 模式：设 INFO_BASE（如 http://127.0.0.1:8108）走真实 Express 路由；
//      若服务上还没挂载 /api/files/info，脚本自动降级为直调模式并注明「待我挂载」。
//
// 样本全部脚本内构造（不下载）：PNG 8×8、JPEG SOF0 16×24、GIF 1×1、BMP 4×3、
// 结构合法 2 秒 MP4（ftyp+moov(mvhd/tkhd)）、1.5 秒 44.1k 单声道 WAV、
// 300MB 前置 moov 假 MP4。WebP / AVIF / MP3 因手工构造编码层不现实，按 SKIP 说明。
//
// 退出码：全部 PASS → 0；任一 FAIL → 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const INFO_BASE = (process.env.INFO_BASE || '').replace(/\/+$/, '');
const EMAIL = process.env.TEST_EMAIL || 'media@p5.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';
const results = [];
const skips = [];

function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

function skip(name, reason) {
  skips.push({ name, reason });
  console.log(`SKIP | ${name} | ${reason}`);
}

// =====================================================================
// 样本字节构造（纯 Buffer 拼装，不依赖 ffmpeg）
// =====================================================================

const u16be = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);
const u16le = (v) => Buffer.from([v & 0xff, (v >> 8) & 0xff]);
const u32be = (v) => Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
const u32le = (v) => Buffer.from([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
const s32be = (v) => u32be(v >>> 0);

// ---- PNG 8×8（IHDR）----
function buildPng(w, h) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13), Buffer.from('IHDR'), u32be(w), u32be(h),
    Buffer.from([8, 6, 0, 0, 0]), Buffer.from([0x1f, 0x15, 0xc4, 0x89]),
    u32be(0), Buffer.from('IEND'), u32be(0),
  ]);
}

// ---- JPEG SOF0 16×24 ----
function buildJpeg(w, h) {
  const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
  const sof0 = Buffer.concat([Buffer.from([8]), u16be(h), u16be(w), Buffer.from([3, 0x11, 0x11])]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00')),
    seg(0xc0, sof0),
    Buffer.from([0xff, 0xd9]),
  ]);
}

// ---- GIF 1×1 ----
function buildGif(w, h) {
  return Buffer.concat([
    Buffer.from('GIF89a'), u16le(w), u16le(h),
    Buffer.from([0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00]),
    Buffer.from([0x2c]), u16le(0), u16le(0), u16le(w), u16le(h),
    Buffer.from([0x00, 0x00, 0x3b]),
  ]);
}

// ---- BMP 4×3（BITMAPINFOHEADER）----
function buildBmp(w, h) {
  const header = Buffer.alloc(14);
  header.write('BM', 0);
  header.writeUInt32LE(54, 2);
  header.writeUInt32LE(54, 10);
  const dib = Buffer.alloc(40);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  return Buffer.concat([header, dib]);
}

// ---- ISO BMFF box 拼装 ----
function box(type, body) {
  return Buffer.concat([u32be(body.length + 8), Buffer.from(type, 'ascii'), body]);
}

/** 构造结构合法的 MP4：ftyp + moov(mvhd 2s / tkhd 320×240 / stsd avc1)，moov 前置。 */
function buildMp4({ durationSec = 2, width = 320, height = 240, timescale = 1000, codec = 'avc1' } = {}) {
  // mvhd version0: flags(3)+creation(4)+modification(4)+timescale(4)+duration(4)+rate(4)+volume(2)+reserved(2)+matrix(36)+preferred(4)+...
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(0, 4);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(Math.round(durationSec * timescale), 16);
  mvhd.writeUInt32BE(0x00010000, 20); // rate 1.0
  mvhd.writeUInt16BE(0x0100, 24);      // volume 1.0
  // matrix identity at offset 28
  const matrixIdentity = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  matrixIdentity.forEach((v, i) => mvhd.writeUInt32BE(v, 28 + i * 4));

  // tkhd version0: flags(3)+creation(4)+modification(4)+trackId(4)+reserved(4)+duration(4)
  // +reserved(8)+layer(2)+alt(2)+volume(2)+reserved(2)+matrix(36)+width(16.16)+height(16.16)
  // tkhd version0 固定 84 字节；width/height 在 body 内偏移 76 / 80
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(1, 4);
  tkhd.writeUInt32BE(Math.round(durationSec * timescale), 12);
  const tkMatrix = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
  tkMatrix.forEach((v, i) => tkhd.writeUInt32BE(v, 28 + i * 4));
  tkhd.writeUInt32BE((width << 16) >>> 0, 76);
  tkhd.writeUInt32BE((height << 16) >>> 0, 80);

  // stsd: version(1)+flags(3)+entry_count(4)；sample entry: size(4)+format(4)+reserved(6)+refIndex(2)+...
  const stsdEntry = Buffer.alloc(86);
  stsdEntry.writeUInt32BE(86, 0);
  stsdEntry.write(codec, 4, 'ascii');
  stsdEntry.writeUInt16BE(1, 10);
  const stsd = Buffer.concat([Buffer.from([0, 0, 0, 0]), u32be(1), stsdEntry]);
  const stbl = box('stbl', stsd);
  const minf = box('minf', stbl);
  const mdia = box('mdia', minf);
  const trak = box('trak', Buffer.concat([box('tkhd', tkhd), mdia]));
  const moov = box('moov', Buffer.concat([box('mvhd', mvhd), trak]));
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom', 'ascii'), u32be(0x200), Buffer.from('isomavc1', 'ascii')]));
  return Buffer.concat([ftyp, moov]);
}

// ---- WAV：fmt PCM + data 静音块 ----
function buildWav({ durationSec = 1.5, sampleRate = 44100, channels = 1, bitsPerSample = 16 } = {}) {
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = Math.round(durationSec * sampleRate * channels * bytesPerSample);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * channels * bytesPerSample, 8);
  fmt.writeUInt16LE(channels * bytesPerSample, 12);
  fmt.writeUInt16LE(bitsPerSample, 14);
  const data = Buffer.alloc(dataSize, 0);
  const fileSize = 36 + fmt.length + data.length;
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'), u32le(fileSize), Buffer.from('WAVE', 'ascii'),
    Buffer.from('fmt ', 'ascii'), u32le(16), fmt,
    Buffer.from('data', 'ascii'), u32le(dataSize), data,
  ]);
}

const FIXTURES = [
  { key: 'png', name: 'a.png', mime: 'image/png', bytes: buildPng(8, 8) },
  { key: 'jpg', name: 'b.jpg', mime: 'image/jpeg', bytes: buildJpeg(16, 24) },
  { key: 'gif', name: 'c.gif', mime: 'image/gif', bytes: buildGif(1, 1) },
  { key: 'bmp', name: 'd.bmp', mime: 'image/bmp', bytes: buildBmp(4, 3) },
  { key: 'mp4', name: 'clip.mp4', mime: 'video/mp4', bytes: buildMp4({ durationSec: 2, width: 320, height: 240 }) },
  { key: 'wav', name: 'tone.wav', mime: 'audio/wav', bytes: buildWav({ durationSec: 1.5, sampleRate: 44100, channels: 1 }) },
  { key: 'txt', name: 'note.txt', mime: 'text/plain; charset=utf-8', bytes: Buffer.from('hello 世界\n', 'utf8') },
];

// =====================================================================
// 直调模式：临时 sqlite + volume 策略 + mock req/res
// =====================================================================

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r6t5-p5-media-'));
let db, insertNode, getNodeByPath, mediaRouter;

async function setupDirectDb() {
  console.log('[step] setupDirectDb 开始');
  process.env.DB_PATH = path.join(tmpRoot, 'r6t5.db');
  process.env.STORAGE_ROOT = path.join(tmpRoot, 'volume');
  process.env.DEV_AUTH = '1';
  // 延迟加载，确保 env 先就位
  console.log('[step] 导入 db.js');
  const dbMod = await awaitImport('./server/db.js');
  db = dbMod.db;
  console.log('[step] 执行 migrate');
  dbMod.migrate();
  console.log('[step] migrate 完成');
  console.log('[step] 导入 nodes.js');
  const nodesMod = await awaitImport('./server/services/nodes.js');
  insertNode = nodesMod.insertNode;
  getNodeByPath = nodesMod.getNodeByPath;
  console.log('[step] 导入 media.js 路由');
  const routerMod = await awaitImport('./server/routes/media.js');
  mediaRouter = routerMod.default;
  console.log('[step] 导入 registry.js');

  // 落一条 site 级 volume 策略（绑定用户根 ''）
  const registryMod = await awaitImport('./server/services/storage/registry.js');
  console.log('[step] 调用 createStrategy');
  const strat = registryMod.createStrategy({
    name: 'P5 自测本地卷', type: 'volume', region: '本机',
    capacityBytes: 10 * 1024 * 1024 * 1024, readOnly: false,
    config: { rootPath: process.env.STORAGE_ROOT },
  });
  console.log('[step] createStrategy 返回', strat.id);
  console.log('[step] 插入 storage_bindings');
  const bindingsMod = await awaitImport('./server/services/bindings.js');
  // createBinding 需要 group 等；直接插绑定行更稳
  db.prepare('INSERT INTO storage_bindings (id, strategyId, scope, email, subPath, createdAt) VALUES (?,?,?,?,?,?)')
    .run('b-p5-test', strat.id, 'site', null, '', new Date().toISOString());
  console.log('[step] 直调环境初始化完成');
}

async function awaitImport(rel) {
  const abs = path.resolve(process.cwd(), rel);
  return import(pathToFileURL(abs).href);
}

function putLocal(relPath, buf, mime) {
  const logical = `${EMAIL}/${relPath}`;
  const phys = path.join(tmpRoot, 'volume', EMAIL, relPath);
  fs.mkdirSync(path.dirname(phys), { recursive: true });
  fs.writeFileSync(phys, buf);
  const root = getNodeByPath(EMAIL) || insertNode({
    email: EMAIL, parentId: null, name: EMAIL, path: EMAIL, isDir: true,
  });
  const parent = getNodeByPath(path.dirname(logical)) || insertNode({
    email: EMAIL, parentId: root.id, name: path.dirname(logical).split('/').pop(),
    path: path.dirname(logical), isDir: true,
  });
  insertNode({
    email: EMAIL, parentId: parent.id, name: path.basename(logical), path: logical,
    isDir: false, sizeBytes: buf.length, mime, storageId: null,
  });
  return logical;
}

function mockRes() {
  const chunks = [];
  const writable = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  const res = writable;
  res.statusCode = 200;
  res.headers = {};
  res.body = null;
  res.jsonBody = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = String(v); };
  res.json = (obj) => { res.jsonBody = obj; res.body = JSON.stringify(obj); res.headers['content-type'] = 'application/json; charset=utf-8'; res.finished = true; };
  res.end = (buf) => { if (buf != null) chunks.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)); res.body = Buffer.concat(chunks); res.finished = true; };
  return res;
}

/** 直调 media 路由处理器；返回 { status, json }。 */
/** 直接匹配 Router 内的 GET '/' 处理器（Express 子路由路径为空）。 */
function getRouterHandler() {
  const layer = mediaRouter.stack.find((l) => l.route && l.route.methods.get);
  if (!layer) throw new Error('media 路由未注册 GET 处理器');
  return layer.route.stack[0].handle;
}

async function callDirect(logical) {
  const req = { query: { path: logical }, headers: {}, user: { email: EMAIL }, socket: {} };
  const res = mockRes();
  const handler = getRouterHandler();
  let errOut = null;
  await new Promise((resolve) => {
    try {
      const ret = handler(req, res, (err) => { errOut = err; resolve(); });
      if (ret && typeof ret.then === 'function') ret.then(resolve).catch((e) => { errOut = e; resolve(); });
    } catch (e) { errOut = e; resolve(); }
  });
  if (errOut) {
    res.statusCode = errOut.status || 500;
    res.jsonBody = { error: { code: errOut.code || 'internal_error', message: errOut.message, details: errOut.details || {} } };
  }
  return { status: res.statusCode, json: res.jsonBody };
}

// =====================================================================
// HTTP 模式辅助
// =====================================================================

let userCookie = '';

function cookiesFrom(headers) {
  const arr = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return arr.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

async function httpJson(method, url, { body, cookie } = {}) {
  const opts = { method, headers: { Cookie: cookie || '' } };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  return { status: r.status, ok: r.ok, json, setCookie: cookiesFrom(r.headers) };
}

async function httpUpload(fx, parent) {
  const fd = new FormData();
  fd.append('overwrite', '1');
  fd.append('file', new File([fx.bytes], fx.name, { type: fx.mime }));
  const r = await fetch(`${INFO_BASE}/api/files/upload?path=${encodeURIComponent(parent)}`, {
    method: 'POST', headers: { Cookie: userCookie }, body: fd,
  });
  const ct = r.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8')); } catch { json = null; } }
  if (!r.ok) throw new Error(`上传 ${fx.name} 失败 status=${r.status} code=${json?.error?.code || ''}`);
  return json?.item?.path || `${parent}/${fx.name}`;
}

async function httpInfo(logical) {
  const qs = new URLSearchParams({ path: logical }).toString();
  const r = await fetch(`${INFO_BASE}/api/files/info?${qs}`, { headers: { Cookie: userCookie } });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  return { status: r.status, json };
}

// =====================================================================
// 运行
// =====================================================================

async function main() {
  console.log(`== P5 媒体元数据自测 · INFO_BASE=${INFO_BASE || '(直调模式)'} email=${EMAIL} ==\n`);
  console.log('[step] 进入 main，准备初始化直调环境…');

  let mode = 'DIRECT';
  if (INFO_BASE) {
    // 探测路由是否已挂载
    const probe = await httpJson('GET', `${INFO_BASE}/api/files/info?path=${encodeURIComponent(EMAIL)}`);
    if (probe.status === 404 && probe.json?.error?.code === 'not_found') {
      console.log('[mount] /api/files/info 404 → 尚未挂载，本次按直调模式自测（待我在 app.js 挂载）\n');
      mode = 'DIRECT';
    } else {
      mode = 'HTTP';
    }
  }

  let files = {};

  if (mode === 'HTTP') {
    const dl = await httpJson('POST', `${INFO_BASE}/api/auth/dev-login`, { body: { email: EMAIL } });
    userCookie = dl.setCookie;
    check('HTTP. dev-login 建立会话', dl.ok && !!userCookie, `status=${dl.status} cookie=${userCookie ? '已携带' : '空'}`);

    // 兜底：若无可用策略，管理员登录建一条 volume
    const probe = await httpJson('GET', `${INFO_BASE}/api/files?path=${encodeURIComponent(EMAIL)}`, { cookie: userCookie });
    if (probe.json?.error?.code === 'storage_not_configured') {
      console.log('[setup] 探测到 storage_not_configured，兜底创建 volume 策略…');
      const al = await httpJson('POST', `${INFO_BASE}/api/admin/login`, { body: { password: ADMIN_PASSWORD } });
      const adminCookie = al.setCookie;
      const created = await httpJson('POST', `${INFO_BASE}/api/admin/storage`, {
        cookie: adminCookie,
        body: { name: 'P5 自测本地卷', type: 'volume', capacityBytes: 10 * 1024 * 1024 * 1024, readOnly: false, acknowledgeDisclosure: true, config: { rootPath: '' } },
      });
      console.log(`[setup] 创建 volume 策略：status=${created.status} ${created.json?.item?.name || ''}`);
    }

    const parent = `${EMAIL}/inbox`;
    const mk = await httpJson('POST', `${INFO_BASE}/api/files/folder`, { cookie: userCookie, body: { path: EMAIL, name: 'inbox' } });
    for (const fx of FIXTURES) {
      try { files[fx.key] = await httpUpload(fx, parent); console.log(`[setup] 上传 ${fx.name} → ${files[fx.key]} (${fx.bytes.length} bytes)`); }
      catch (e) { check(`上传 fixture ${fx.name}`, false, e.message); files[fx.key] = `${parent}/${fx.name}`; }
    }
  } else {
    await setupDirectDb();
    console.log('[step] 落盘 fixtures');
    for (const fx of FIXTURES) files[fx.key] = putLocal(`inbox/${fx.name}`, fx.bytes, fx.mime);
    console.log('[step] fixtures 落盘完成');
  }

  const call = mode === 'HTTP' ? httpInfo : callDirect;
  console.log('[step] 开始逐条断言');

  // ---- 1. PNG 8×8 ----
  {
    console.log('[step] 用例 1 PNG');
    const r = await call(files.png);
    console.log('[step] 用例 1 返回', JSON.stringify(r));
    const m = r.json?.media;
    check('1. PNG 解析宽高 8×8', r.status === 200 && r.json?.parsed === true && m?.width === 8 && m?.height === 8 && m?.format === 'png',
      `status=${r.status} kind=${r.json?.kind} media=${JSON.stringify(m)}`);
  }

  // ---- 2. JPEG SOF0 16×24 ----
  {
    const r = await call(files.jpg);
    const m = r.json?.media;
    check('2. JPEG SOF0 解析宽高 16×24', r.status === 200 && r.json?.parsed === true && m?.width === 16 && m?.height === 24 && m?.format === 'jpeg',
      `status=${r.status} kind=${r.json?.kind} media=${JSON.stringify(m)}`);
  }

  // ---- 3. GIF 1×1 ----
  {
    const r = await call(files.gif);
    const m = r.json?.media;
    check('3. GIF 逻辑屏幕描述符 1×1', r.status === 200 && r.json?.parsed === true && m?.width === 1 && m?.height === 1 && m?.format === 'gif',
      `status=${r.status} kind=${r.json?.kind} media=${JSON.stringify(m)}`);
  }

  // ---- 4. BMP 4×3 ----
  {
    const r = await call(files.bmp);
    const m = r.json?.media;
    check('4. BMP 文件头解析宽高 4×3', r.status === 200 && r.json?.parsed === true && m?.width === 4 && m?.height === 3 && m?.format === 'bmp',
      `status=${r.status} kind=${r.json?.kind} media=${JSON.stringify(m)}`);
  }

  // ---- 5. MP4：时长 2s / 320×240 / codec avc1 ----
  {
    const r = await call(files.mp4);
    const m = r.json?.media;
    const ok = r.status === 200 && r.json?.parsed === true && m?.durationSec === 2 && m?.width === 320 && m?.height === 240 && m?.codec === 'avc1';
    check('5. MP4(moov 前置) 时长 2s / 320×240 / avc1', ok,
      `status=${r.status} kind=${r.json?.kind} media=${JSON.stringify(m)} reason=${r.json?.reason || ''}`);
  }

  // ---- 6. WAV：1.5s / 44100 / 单声道 / pcm ----
  {
    const r = await call(files.wav);
    const m = r.json?.media;
    const ok = r.status === 200 && r.json?.parsed === true && m?.durationSec === 1.5 && m?.sampleRate === 44100 && m?.channels === 1 && m?.codec === 'pcm';
    check('6. WAV 1.5s / 44100Hz / 单声道', ok,
      `status=${r.status} kind=${r.json?.kind} media=${JSON.stringify(m)}`);
  }

  // ---- 7. 未知类型：kind=other, parsed:false, 中文 reason，不 500 ----
  {
    const r = await call(files.txt);
    const ok = r.status === 200 && r.json?.kind === 'other' && r.json?.parsed === false && typeof r.json?.reason === 'string' && r.json.media === null;
    check('7. 未知类型返回 kind=other / parsed:false / 中文 reason', ok,
      `status=${r.status} body=${JSON.stringify(r.json)}`);
  }

  // ---- 8. 不存在路径 → 404 ----
  {
    const missing = `${EMAIL}/inbox/does-not-exist.mp4`;
    const r = await call(missing);
    check('8. 不存在文件返回 404', r.status === 404, `status=${r.status} code=${r.json?.error?.code || ''}`);
  }

  // ---- 9. 300MB 前置 moov 假 MP4：500ms 内返回，RSS 不暴涨 ----
  {
    const bigSize = 300 * 1024 * 1024;
    const head = buildMp4({ durationSec: 2, width: 320, height: 240 });
    const bigName = 'big-300mb.mp4';
    let bigLogical;

    if (mode === 'HTTP') {
      // HTTP 模式：分片上传（chunkSize 8MiB，最后一片余数）
      const chunkSize = 8 * 1024 * 1024;
      const totalChunks = Math.ceil(bigSize / chunkSize);
      const init = await httpJson('POST', `${INFO_BASE}/api/uploads/init`, {
        cookie: userCookie,
        body: { parentPath: `${EMAIL}/inbox`, name: bigName, sizeBytes: bigSize, chunkSize, mime: 'video/mp4' },
      });
      const upId = init.json?.item?.id;
      if (!upId) { check('9. 300MB 假 MP4 分片初始化', false, `init status=${init.status} body=${JSON.stringify(init.json)}`); }
      else {
        // 第 0 片带合法头部，其余填零；逐片 PUT 原始二进制
        for (let i = 0; i < totalChunks; i += 1) {
          const start = i * chunkSize;
          const end = Math.min(bigSize, start + chunkSize);
          const len = end - start;
          let part;
          if (i === 0) {
            part = Buffer.alloc(len, 0);
            head.copy(part, 0);
          } else {
            part = Buffer.alloc(len, 0);
          }
          const pr = await fetch(`${INFO_BASE}/api/uploads/${upId}/part/${i}`, {
            method: 'PUT', headers: { Cookie: userCookie, 'Content-Length': String(len) }, body: part,
          });
          if (!pr.ok) { check(`9. 分片 ${i} 上传`, false, `status=${pr.status}`); break; }
        }
        await httpJson('POST', `${INFO_BASE}/api/uploads/${upId}/complete`, { cookie: userCookie, body: { mime: 'video/mp4' } });
      }
      bigLogical = `${EMAIL}/inbox/${bigName}`;
    } else {
      // 直调模式：落一个稀疏文件（头部合法，其余零字节），节点大小记 300MB
      const phys = path.join(tmpRoot, 'volume', EMAIL, 'inbox', bigName);
      fs.mkdirSync(path.dirname(phys), { recursive: true });
      const fd = fs.openSync(phys, 'w');
      fs.writeSync(fd, head, 0, head.length, 0);
      fs.truncateSync(phys, bigSize); // 稀疏扩展，不实际写满 300MB
      fs.closeSync(fd);
      const parent = getNodeByPath(`${EMAIL}/inbox`);
      insertNode({ email: EMAIL, parentId: parent.id, name: bigName, path: `${EMAIL}/inbox/${bigName}`, isDir: false, sizeBytes: bigSize, mime: 'video/mp4', storageId: null });
      bigLogical = `${EMAIL}/inbox/${bigName}`;
    }

    const rssBefore = process.memoryUsage().rss;
    const started = Date.now();
    const r = await call(bigLogical);
    const elapsed = Date.now() - started;
    const rssAfter = process.memoryUsage().rss;
    const m = r.json?.media;
    const timeOk = elapsed < 500;
    const rssGrowthMb = Math.max(0, (rssAfter - rssBefore) / 1024 / 1024);
    const rssOk = rssGrowthMb < 64; // 头部仅 ≤2MB，允许小幅度 GC 波动
    check('9. 300MB 前置 moov 假 MP4 500ms 内返回且解析正常',
      r.status === 200 && r.json?.parsed === true && m?.durationSec === 2 && m?.width === 320 && m?.height === 240 && timeOk,
      `status=${r.status} elapsed=${elapsed}ms media=${JSON.stringify(m)}`);
    check('10. 300MB 文件读取后 RSS 不暴涨（增量 <64MB）', rssOk,
      `rssBefore=${(rssBefore / 1024 / 1024).toFixed(1)}MB rssAfter=${(rssAfter / 1024 / 1024).toFixed(1)}MB growth=${rssGrowthMb.toFixed(1)}MB`);
  }

  // ---- SKIP 清单 ----
  skip('WebP(VP8/VP8L/VP8X)', '手工构造 RIFF chunk 与 VP8 帧头/LZ77 编码层不现实；解析分支已实现，需真实 WebP 样本回归。');
  skip('AVIF(ispe box)', 'AVIF 需 AV1 封装与 meta/iprp/ipco 层级 box，手工构造不现实；ispe 解析分支已实现，需真实 AVIF 样本回归。');
  skip('MP3(Xing/Info 时长)', '本机 ffmpeg 仅作开发期参考、不进运行时；脚本内未构造 MP3 帧（帧同步/位率表/Xing 解析分支已实现，需真实 MP3 样本回归）。');
  skip('HEIC/HEIF、FLAC、OGG/OPUS、AAC 裸流', '本期未实现对应解析器，接口返回 parsed:false + reason。');

  // ---- 汇总 ----
  const failed = results.filter((x) => !x.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过；SKIP ${skips.length} 项`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('自测流程异常：', e?.stack || e);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('未处理的 Promise 拒绝：', reason?.stack || reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('未捕获异常：', err?.stack || err);
  process.exit(1);
});
