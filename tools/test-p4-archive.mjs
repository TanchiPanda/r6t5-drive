// P4 归档自测：流式 zip 下载 / 在线压缩 / 解压防 slip / 只读拦截 / 非法包 / 上限。
//
// 用法（打真实运行中的服务，不自建 harness、不起子进程）：
//   BASE=http://127.0.0.1:8090 node tools/test-p4-archive.mjs
//   （BASE 缺省 http://127.0.0.1:8090）
//
// 挂载探测：POST /api/files/zip/plan 未登录 → 401 视为已挂载，404 视为未挂载。
// 退出码：全部 PASS → 0；任一 FAIL → 1。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8090';
const WORK = '/tmp/p4b';

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

// ---------- HTTP 小工具 ----------
function parseCookies(setCookie) {
  if (!setCookie) return {};
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const out = {};
  for (const c of list) {
    const part = c.split(';')[0];
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

async function req(method, url, { body, cookie, raw } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (raw) { opts.body = raw.body; Object.assign(opts.headers, raw.headers); }
  const res = await fetch(BASE + url, opts);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = text; } }
  const setArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie() : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json, text, set, headers: res.headers };
}

async function downloadBuf(jar, logical) {
  const r = await fetch(BASE + '/api/files/download?path=' + encodeURIComponent(logical), { headers: { Cookie: jar } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function hasUnzip() {
  try { execFileSync('sh', ['-c', 'command -v unzip'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
const unzipAvailable = hasUnzip();

function unzipTest(zipPath) {
  if (!unzipAvailable) return 'SKIP(无 unzip，使用自研 reader 校验)';
  try {
    const out = execFileSync('unzip', ['-t', zipPath], { encoding: 'utf8' });
    return out.trim().split('\n').slice(-2).join(' | ');
  } catch (e) {
    return `FAIL: ${String(e.stdout || e.message).slice(0, 200)}`;
  }
}

// ---------- 挂载探测：401 = 已挂载，404 = 未挂载 ----------
async function probeMounted() {
  try {
    const res = await fetch(BASE + '/api/files/zip/plan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"paths":[]}',
    });
    const mounted = res.status !== 404;
    console.log(`[mount] ${BASE}/api/files/zip/plan status=${res.status} mounted=${mounted}`);
    return mounted;
  } catch (e) {
    console.log(`[mount] 探测失败：${e.message} → 视为未挂载`);
    return false;
  }
}

// ---------- 造数据 ----------
const EMAIL = 'alice@p4.test';
const BIG_SIZE = 10 * 1024 * 1024; // 10 MB
// 每轮唯一后缀：避免上一轮软删（tombstone）节点占用 nodes.path 唯一约束导致 500
const TAG = crypto.randomBytes(3).toString('hex');
const BUNDLE_NAME = `bundle-${TAG}.zip`;
const EXTRACT_DIR = `extracted-${TAG}`;
const EVIL_NAME = `evil-${TAG}.zip`;
const BROKEN_NAME = `broken-${TAG}.zip`;

async function upload(jar, dir, name, buf, mime) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'application/octet-stream' }), name);
  fd.append('overwrite', '1');
  return req('POST', `/api/files/upload?path=${encodeURIComponent(dir)}`, { cookie: jar, raw: { body: fd, headers: {} } });
}

async function cleanupPath(jar, logical) {
  await req('DELETE', `/api/files?path=${encodeURIComponent(logical)}`, { cookie: jar });
}

async function seed() {
  // admin 登录
  const adminLogin = await req('POST', '/api/admin/login', { body: { password: 'test123' } });
  const adminJar = Object.entries(adminLogin.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('造数据. admin 登录 200', adminLogin.status === 200, `status=${adminLogin.status}`);

  // 建可写 volume 策略（rootPath 留空走服务端默认目录）
  const st = await req('POST', '/api/admin/storage', {
    cookie: adminJar,
    body: { acknowledgeDisclosure: true, type: 'volume', name: '本地卷', capacityBytes: 107374182400, region: '本机' },
  });
  let writableId = st.json?.item?.id;
  if (!writableId) {
    const list = await req('GET', '/api/admin/storage', { cookie: adminJar });
    writableId = list.json?.items?.find((i) => i.type === 'volume' && !i.readOnly)?.id;
  }
  check('造数据. 建 volume 策略 201', st.status === 201 || !!writableId, `status=${st.status} id=${writableId}`);

  // 建只读 volume 策略
  const ro = await req('POST', '/api/admin/storage', {
    cookie: adminJar,
    body: { acknowledgeDisclosure: true, type: 'volume', name: '只读卷', capacityBytes: 107374182400, region: '本机', readOnly: true },
  });
  let roId = ro.json?.item?.id;
  if (!roId) {
    const list = await req('GET', '/api/admin/storage', { cookie: adminJar });
    roId = list.json?.items?.find((i) => i.readOnly)?.id;
  }
  check('造数据. 建只读策略 201', ro.status === 201 || !!roId, `status=${ro.status} id=${roId} readOnly=${ro.json?.item?.readOnly}`);

  // dev-login
  const dl = await req('POST', '/api/auth/dev-login', { body: { email: EMAIL } });
  const jar = Object.entries(dl.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('造数据. dev-login 200', dl.status === 200, `status=${dl.status} email=${dl.json?.user?.email}`);

  // 清理上一轮残留（忽略 404）
  await cleanupPath(jar, `${EMAIL}/${BUNDLE_NAME}`);
  await cleanupPath(jar, `${EMAIL}/${EXTRACT_DIR}`);
  await cleanupPath(jar, `${EMAIL}/${EVIL_NAME}`);
  await cleanupPath(jar, `${EMAIL}/${BROKEN_NAME}`);

  // 目录：photos（含 2 文件 + 1 空目录 empty）；ro 先在可写策略上建节点，再绑只读策略
  const mkPhotos = await req('POST', '/api/files/folder', { cookie: jar, body: { path: EMAIL, name: 'photos' } });
  check('造数据. 建 photos 目录 201/409', mkPhotos.status === 201 || mkPhotos.status === 409, `status=${mkPhotos.status}`);
  const mkEmpty = await req('POST', '/api/files/folder', { cookie: jar, body: { path: `${EMAIL}/photos`, name: 'empty' } });
  check('造数据. 建 photos/empty 空目录 201/409', mkEmpty.status === 201 || mkEmpty.status === 409, `status=${mkEmpty.status}`);

  // 先解除上一轮残留的 ro 只读绑定，否则建目录会被既有只读策略 403 拦住
  const bindList = await req('GET', '/api/admin/bindings', { cookie: adminJar });
  for (const b of bindList.json?.items || []) {
    if (b.scope === 'user' && String(b.email || '').toLowerCase() === EMAIL && b.subPath === 'ro') {
      await req('DELETE', `/api/admin/bindings/${b.id}`, { cookie: adminJar });
    }
  }
  const mkRo = await req('POST', '/api/files/folder', { cookie: jar, body: { path: EMAIL, name: 'ro' } });
  check('造数据. 建 ro 目录 201/409', mkRo.status === 201 || mkRo.status === 409, `status=${mkRo.status}`);

  // 上传 3 个根文件（含 10MB）+ photos 下 2 个文件
  const note = Buffer.from('hello-p4-archive-' + 'x'.repeat(200), 'utf8');
  const big = Buffer.alloc(BIG_SIZE, 7);
  const alpha = Buffer.from('alpha-body-0001', 'utf8');
  const beta = Buffer.from('beta-body-0002', 'utf8');

  const upNote = await upload(jar, EMAIL, 'note.txt', note, 'text/plain');
  const upBig = await upload(jar, EMAIL, 'big.bin', big, 'application/octet-stream');
  const upAlpha = await upload(jar, `${EMAIL}/photos`, 'alpha.txt', alpha, 'text/plain');
  const upBeta = await upload(jar, `${EMAIL}/photos`, 'beta.txt', beta, 'text/plain');
  check('造数据. 上传 note.txt 201', upNote.status === 201, `status=${upNote.status} size=${upNote.json?.item?.sizeBytes}`);
  check('造数据. 上传 big.bin(10MB) 201', upBig.status === 201, `status=${upBig.status} size=${upBig.json?.item?.sizeBytes}`);
  check('造数据. 上传 alpha.txt 201', upAlpha.status === 201, `status=${upAlpha.status}`);
  check('造数据. 上传 beta.txt 201', upBeta.status === 201, `status=${upBeta.status}`);

  // 只读绑定：ro 子目录（目录节点已在可写策略上建好；绑定后解析到只读策略）
  const bind = await req('POST', '/api/admin/bindings', {
    cookie: adminJar,
    body: { strategyId: roId, scope: 'user', email: EMAIL, subPath: 'ro' },
  });
  check('造数据. 绑定只读策略到 ro 201', bind.status === 201 || bind.status === 409, `status=${bind.status} bindingId=${bind.json?.item?.id}`);

  return { jar, adminJar, roStrategyId: roId, sources: {
    'note.txt': note, 'big.bin': big, 'photos/alpha.txt': alpha, 'photos/beta.txt': beta,
  } };
}

// ---------- HTTP 用例 ----------
async function runHttpSuite(seedData) {
  const { jar, sources } = seedData;

  // 4.1 打包计划
  const plan = await req('POST', '/api/files/zip/plan', { cookie: jar, body: { paths: [`${EMAIL}/note.txt`, `${EMAIL}/big.bin`, `${EMAIL}/photos`] } });
  check('HTTP. zip/plan 200 条目=4', plan.status === 200 && plan.json?.entries === 4,
    `status=${plan.status} entries=${plan.json?.entries} totalBytes=${plan.json?.totalBytes} tooLarge=${plan.json?.tooLarge}`);

  // 4.2 打包下载：2 文件 + 1 目录
  const dl = await fetch(BASE + '/api/files/zip', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar },
    body: JSON.stringify({ paths: [`${EMAIL}/note.txt`, `${EMAIL}/big.bin`, `${EMAIL}/photos`] }),
  });
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  const ct = dl.headers.get('content-type') || '';
  const entriesHdr = dl.headers.get('x-archive-entries');
  const disp = dl.headers.get('content-disposition') || '';
  check('HTTP. zip 下载 200 + Content-Type application/zip', dl.status === 200 && ct.includes('application/zip'),
    `status=${dl.status} ct=${ct} entries=${entriesHdr} disposition=${disp} bytes=${dlBuf.length}`);
  check('HTTP. X-Archive-Entries=4', entriesHdr === '4', `entries=${entriesHdr}`);

  const dlZip = path.join(WORK, 'download.zip');
  fs.writeFileSync(dlZip, dlBuf);
  console.log(`[compat] unzip -t 结果：${unzipTest(dlZip)}`);

  // 自研 reader 读回：条目数 + CRC + 内容 sha256
  const { ZipReader } = await import('../server/lib/zip.js');
  const reader = ZipReader.open(dlZip);
  const entries = reader.readEntries();
  check('HTTP. 下载包条目数=4', entries.length === 4, `entries=${entries.map((e) => e.name).join(',')}`);
  let allMatch = true;
  const detail = [];
  for (const e of entries) {
    const { stream, verify } = reader.openEntry(e);
    const chunks = [];
    await pipeline(stream, new Writable({ write(c, _, cb) { chunks.push(c); cb(); } }));
    verify();
    const got = Buffer.concat(chunks);
    const expect = sources[e.name];
    const match = expect ? got.equals(expect) : false;
    if (!match) allMatch = false;
    detail.push(`${e.name}:${got.length}B sha=${sha256(got).slice(0, 12)} match=${match}`);
  }
  reader.close();
  check('HTTP. 下载内容 CRC + sha256 全部一致', allMatch, detail.join(' | '));

  // 4.3 10MB 打包：客户端流式分块消费响应，RSS 不随文件线性增长
  const rss0 = process.memoryUsage().rss;
  const bigDl = await fetch(BASE + '/api/files/zip', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: jar },
    body: JSON.stringify({ paths: [`${EMAIL}/big.bin`] }),
  });
  const readerBody = bigDl.body.getReader();
  let consumed = 0;
  for (;;) {
    const { done, value } = await readerBody.read();
    if (done) break;
    consumed += value.length;
  }
  const rss1 = process.memoryUsage().rss;
  const rssDeltaMB = (rss1 - rss0) / 1024 / 1024;
  console.log(`[mem] big.bin=${BIG_SIZE}B 响应=${consumed}B RSS before=${(rss0 / 1048576).toFixed(1)}MB after=${(rss1 / 1048576).toFixed(1)}MB delta=${rssDeltaMB.toFixed(1)}MB`);
  check('HTTP. 10MB 打包 RSS 增量 < 32MB（流式消费，不随文件线性增长）', rssDeltaMB < 32, `delta=${rssDeltaMB.toFixed(1)}MB`);

  // 4.4 在线压缩
  const comp = await req('POST', '/api/files/compress', {
    cookie: jar, body: { paths: [`${EMAIL}/note.txt`, `${EMAIL}/photos`], name: BUNDLE_NAME },
  });
  check('HTTP. compress 201 entries=3', comp.status === 201 && comp.json?.entries === 3,
    `status=${comp.status} path=${comp.json?.item?.path} size=${comp.json?.item?.sizeBytes} entries=${comp.json?.entries}`);
  const bundlePath = comp.json?.item?.path;

  const bundleDl = await downloadBuf(jar, bundlePath);
  const bundleBuf = bundleDl.buf;
  const bundleZip = path.join(WORK, 'bundle.zip');
  fs.writeFileSync(bundleZip, bundleBuf);
  console.log(`[compat] bundle.zip unzip -t：${unzipTest(bundleZip)}`);
  const r2 = ZipReader.open(bundleZip);
  const bEntries = r2.readEntries();
  let bundleMatch = true;
  const bDetail = [];
  for (const e of bEntries) {
    const { stream, verify } = r2.openEntry(e);
    const chunks = [];
    await pipeline(stream, new Writable({ write(c, _, cb) { chunks.push(c); cb(); } }));
    verify();
    const got = Buffer.concat(chunks);
    const expect = sources[e.name];
    const match = expect ? got.equals(expect) : false;
    if (!match) bundleMatch = false;
    bDetail.push(`${e.name}:${got.length}B match=${match}`);
  }
  r2.close();
  check('HTTP. 压缩包回读内容一致', bundleMatch && bEntries.length === 3, bDetail.join(' | '));

  // 4.5 解压到新目录
  const ex = await req('POST', '/api/files/extract', {
    cookie: jar, body: { path: bundlePath, targetPath: `${EMAIL}/${EXTRACT_DIR}` },
  });
  const expectBytes = sources['note.txt'].length + sources['photos/alpha.txt'].length + sources['photos/beta.txt'].length;
  check('HTTP. extract 201 extracted=3', ex.status === 201 && ex.json?.extracted === 3,
    `status=${ex.status} extracted=${ex.json?.extracted} totalBytes=${ex.json?.totalBytes} skipped=${JSON.stringify(ex.json?.skipped)}`);
  check('HTTP. 解压字节数与源一致', String(ex.json?.totalBytes) === String(expectBytes),
    `totalBytes=${ex.json?.totalBytes} expect=${expectBytes}`);

  // 校验解压落盘文件：走下载接口回读 sha256（不直连服务端磁盘）
  const exList = await req('GET', `/api/files?path=${encodeURIComponent(`${EMAIL}/${EXTRACT_DIR}`)}`, { cookie: jar });
  const exNames = (exList.json?.items || []).map((i) => i.name).sort();
  check('HTTP. 解压目录含 note.txt', exNames.includes('note.txt'), `items=${exNames.join(',')}`);
  let exMatch = true;
  const exDetail = [];
  for (const rel of ['note.txt', 'photos/alpha.txt', 'photos/beta.txt']) {
    const logical = `${EMAIL}/${EXTRACT_DIR}/${rel}`;
    const { status, buf } = await downloadBuf(jar, logical);
    const ok = status === 200 && buf.equals(sources[rel]);
    if (!ok) exMatch = false;
    exDetail.push(`${rel}:${status}/${buf.length}B match=${ok}`);
    if (!ok) console.log(`[debug] 下载失败 logical=${logical} url=/api/files/download?path=${encodeURIComponent(logical)} body=${buf.toString('utf8').slice(0, 200)}`);
  }
  check('HTTP. 解压落盘内容与源一致', exMatch, exDetail.join(' | '));

  // 4.6 重复解压同名 → skipped，不覆盖
  const ex2 = await req('POST', '/api/files/extract', {
    cookie: jar, body: { path: bundlePath, targetPath: `${EMAIL}/${EXTRACT_DIR}` },
  });
  check('HTTP. 重复解压全部 skipped 不覆盖', ex2.status === 201 && ex2.json?.extracted === 0 && ex2.json?.skipped?.length === 3,
    `status=${ex2.status} extracted=${ex2.json?.extracted} skipped=${JSON.stringify(ex2.json?.skipped)}`);

  // 4.7 zip slip：手工构造恶意包
  const { ZipWriter } = await import('../server/lib/zip.js');
  const evilNames = ['../evil.txt', '/abs/evil.txt', 'a/../../evil.txt'];
  const chunks = [];
  const sink = new Writable({ write(c, _, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const w = new ZipWriter(sink);
  for (const n of evilNames) await w.addFile(n, Readable.from(['evil-body']));
  await w.finish();
  const evilZip = Buffer.concat(chunks);
  fs.writeFileSync(path.join(WORK, 'evil.zip'), evilZip);

  const upEvil = await upload(jar, EMAIL, EVIL_NAME, evilZip, 'application/zip');
  check('HTTP. 上传 evil.zip 201', upEvil.status === 201, `status=${upEvil.status}`);
  const slip = await req('POST', '/api/files/extract', {
    cookie: jar, body: { path: `${EMAIL}/${EVIL_NAME}`, targetPath: EMAIL },
  });
  check('HTTP. zip slip → 400 zip_slip_blocked',
    slip.status === 400 && slip.json?.error?.code === 'zip_slip_blocked',
    `status=${slip.status} code=${slip.json?.error?.code} entry=${slip.json?.error?.details?.entry}`);

  // 泄漏检查（API 视角）：根目录列表无 evil.txt，下载 evil.txt 仍 404
  const rootList = await req('GET', `/api/files?path=${encodeURIComponent(EMAIL)}`, { cookie: jar });
  const rootNames = (rootList.json?.items || []).map((i) => i.name);
  const evilDl = await downloadBuf(jar, `${EMAIL}/evil.txt`);
  const leaked = rootNames.includes('evil.txt') || evilDl.status !== 404;
  check('HTTP. slip 拦截后目标目录无任何新文件', !leaked, `listed=${rootNames.join(',')} evilDl=${evilDl.status}`);

  // 4.8 非法 zip（截断）
  const truncated = bundleBuf.slice(0, Math.floor(bundleBuf.length / 2));
  const upBad = await upload(jar, EMAIL, BROKEN_NAME, truncated, 'application/zip');
  check('HTTP. 上传 broken.zip 201', upBad.status === 201, `status=${upBad.status}`);
  const bad = await req('POST', '/api/files/extract', {
    cookie: jar, body: { path: `${EMAIL}/${BROKEN_NAME}`, targetPath: `${EMAIL}/${EXTRACT_DIR}` },
  });
  check('HTTP. 截断 zip → 400 zip_invalid',
    bad.status === 400 && bad.json?.error?.code === 'zip_invalid',
    `status=${bad.status} code=${bad.json?.error?.code} msg=${bad.json?.error?.message}`);

  // 4.9 非 zip 文件 → 400 zip_invalid
  const notZip = await req('POST', '/api/files/extract', {
    cookie: jar, body: { path: `${EMAIL}/note.txt`, targetPath: `${EMAIL}/${EXTRACT_DIR}` },
  });
  check('HTTP. 非 zip 文件 → 400 zip_invalid',
    notZip.status === 400 && notZip.json?.error?.code === 'zip_invalid',
    `status=${notZip.status} code=${notZip.json?.error?.code}`);

  // 4.10 只读策略目录：压缩 / 解压均 403
  const roComp = await req('POST', '/api/files/compress', {
    cookie: jar, body: { paths: [`${EMAIL}/note.txt`], targetPath: `${EMAIL}/ro`, name: 'ro.zip' },
  });
  check('HTTP. 只读目录压缩 → 403 strategy_readonly',
    roComp.status === 403 && roComp.json?.error?.code === 'strategy_readonly',
    `status=${roComp.status} code=${roComp.json?.error?.code}`);
  const roEx = await req('POST', '/api/files/extract', {
    cookie: jar, body: { path: bundlePath, targetPath: `${EMAIL}/ro` },
  });
  check('HTTP. 只读目录解压 → 403 strategy_readonly',
    roEx.status === 403 && roEx.json?.error?.code === 'strategy_readonly',
    `status=${roEx.status} code=${roEx.json?.error?.code}`);

  // 4.11 不存在路径 → 404
  const nf = await req('POST', '/api/files/zip', { cookie: jar, body: { paths: [`${EMAIL}/no-such-file`] } });
  check('HTTP. 不存在路径打包 → 404 not_found', nf.status === 404 && nf.json?.error?.code === 'not_found',
    `status=${nf.status} code=${nf.json?.error?.code}`);
}

// ---------- 5) lib/zip 单元级上限与安全用例 ----------
async function runUnitSuite() {
  const { MAX_ENTRIES, MAX_TOTAL_BYTES, ZipWriter, checkSafeEntryName, assertExtractSafe } =
    await import('../server/lib/zip.js');

  // 5.1 条目数上限：第 10001 条抛 zip_too_many_entries
  const chunks = [];
  const sink = new Writable({ write(c, _, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const w = new ZipWriter(sink);
  let hitLimit = false;
  for (let i = 0; i < MAX_ENTRIES + 1; i += 1) {
    try {
      await w.addFile(`f${i}.txt`, Readable.from([Buffer.from('x')]));
    } catch (e) {
      hitLimit = e.code === 'zip_too_many_entries';
      break;
    }
  }
  check('UNIT. 条目数超 10000 → zip_too_many_entries', hitLimit, `limit=${MAX_ENTRIES}`);

  // 5.2 解压总字节上限：两条目各 3GB → zip_too_large
  let tooLarge = false;
  try {
    assertExtractSafe([
      { name: 'a.bin', uncompSize: 3 * 1073741824, compSize: 1, crc: 0, method: 0, externalAttrs: 0, localOffset: 0 },
      { name: 'b.bin', uncompSize: 3 * 1073741824, compSize: 1, crc: 0, method: 0, externalAttrs: 0, localOffset: 0 },
    ], { maxFileSizeBytes: 107374182400 });
  } catch (e) { tooLarge = e.code === 'zip_too_large'; }
  check('UNIT. 解压总字节超 5GB → zip_too_large', tooLarge, `limitBytes=${MAX_TOTAL_BYTES}`);

  // 5.3 单条目超单文件上限 → quota_file
  let quotaHit = false;
  try {
    assertExtractSafe([{ name: 'big.bin', uncompSize: 200 * 1024 * 1024, compSize: 1, crc: 0, method: 0, externalAttrs: 0, localOffset: 0 }],
      { maxFileSizeBytes: 100 * 1024 * 1024 });
  } catch (e) { quotaHit = e.code === 'quota_file'; }
  check('UNIT. 单条目超单文件上限 → quota_file', quotaHit, 'maxFile=100MB entry=200MB');

  // 5.4 安全名矩阵
  const cases = [
    ['../evil.txt', false], ['a/../../evil.txt', false], ['/abs/evil.txt', false],
    ['C:/win/evil.txt', false], ['a\\b.txt', false], ['', false],
    ['a/./b.txt', true], ['normal/file.txt', true],
  ];
  const allSafe = cases.every(([n, expect]) => checkSafeEntryName(n).ok === expect);
  check('UNIT. 条目名 slip 安全矩阵全部符合预期', allSafe,
    cases.map(([n, e]) => `${JSON.stringify(n)}→${checkSafeEntryName(n).ok}`).join(' '));

  // 5.5 损坏包 reader 抛 zip_invalid（截断 EOCD）
  const { ZipReader } = await import('../server/lib/zip.js');
  const half = chunks.slice(0, Math.floor(chunks.length / 2)).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0));
  const badPath = path.join(WORK, 'truncated.zip');
  fs.writeFileSync(badPath, half);
  let invalid = false;
  try { ZipReader.open(badPath).readEntries(); } catch (e) { invalid = e.code === 'zip_invalid'; }
  check('UNIT. 截断包 reader → zip_invalid', invalid, `bytes=${half.length}`);
}

// ---------- 主流程 ----------
try {
  const mounted = await probeMounted();
  if (!mounted) {
    throw new Error('archive 路由未挂载（/api/files/zip/plan 返回 404），请先在 app.js 挂载 archiveRouter');
  }
  const seedData = await seed();
  await runHttpSuite(seedData);
  await runUnitSuite();
} catch (e) {
  console.error('[fatal]', e);
  results.push({ name: 'fatal', ok: false, detail: e.message });
}

const fail = results.filter((r) => !r.ok);
console.log('\n===== 汇总 =====');
console.log(`PASS=${results.length - fail.length}  FAIL=${fail.length}  总计=${results.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
