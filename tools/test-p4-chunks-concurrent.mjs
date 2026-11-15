// P4 并发分片上传自测：同一会话 3 个 worker 并发 PUT 不同分片，验证 received 不丢片。
// 用法：
//   服务已起（/api/uploads 已挂载，requireUser 守卫）：
//     BASE=http://127.0.0.1:8093 node tools/test-p4-chunks-concurrent.mjs
// 退出码：全部 PASS → 0；任一 FAIL → 1。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8093';
const DB_PATH = process.env.DB_PATH || path.join(REPO_ROOT, 'data', 'r6t5.db');

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

async function req(method, base, url, { cookie, json, raw } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (raw) {
    opts.body = raw.buffer;
    opts.headers['Content-Type'] = raw.contentType || 'application/octet-stream';
  } else if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  const res = await fetch(base + url, opts);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let body = null;
  if (ct.includes('json')) { try { body = JSON.parse(text); } catch { body = text; } }
  const setCookieArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setCookieArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json: body, text, buf, set, headers: res.headers };
}

function jarOf(set) {
  return Object.entries(set).map(([k, v]) => `${k}=${v}`).join('; ');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const MiB = 1024 * 1024;
const ALICE = 'alice@p4.test';

// ---------- 探测挂载 ----------
let upMounted = false;
try {
  const probe = await req('GET', BASE, '/api/uploads');
  upMounted = probe.status === 401;
  console.log(`[mount] /api/uploads 探测 status=${probe.status} → mounted=${upMounted}`);
} catch (e) {
  console.log(`[mount] 探测失败：${e.message} → 视为未挂载`);
}
if (!upMounted) {
  console.error('[fatal] /api/uploads 未挂载（404 或连接失败）。');
  process.exit(1);
}

// ---------- 造数据：管理员登录 → volume 策略 → dev-login alice → inbox 目录 ----------
const adminLogin = await req('POST', BASE, '/api/admin/login', { json: { password: process.env.ADMIN_PASSWORD || 'test123' } });
const adminJar = jarOf(adminLogin.set);
check('setup. 管理员登录 200', adminLogin.status === 200, `status=${adminLogin.status}`);

const adminList = await req('GET', BASE, '/api/admin/storage', { cookie: adminJar });
let volume = (adminList.json?.items || []).find((s) => s.type === 'volume' && s.enabled);
if (!volume) {
  const created = await req('POST', BASE, '/api/admin/storage', {
    cookie: adminJar,
    json: { name: '本地卷', type: 'volume', capacityBytes: 107374182400, acknowledgeDisclosure: true, config: {} },
  });
  volume = created.json?.item;
  check('setup. 创建 volume 策略 201', created.status === 201, `status=${created.status} id=${volume?.id}`);
} else {
  check('setup. 复用已有 volume 策略', true, `id=${volume.id}`);
}

const dlA = await req('POST', BASE, '/api/auth/dev-login', { json: { email: ALICE } });
const aliceJar = jarOf(dlA.set);
check('setup. dev-login alice 200', dlA.status === 200, `status=${dlA.status}`);

const mk = await req('POST', BASE, '/api/files/folder', { cookie: aliceJar, json: { path: ALICE, name: 'inbox' } });
check('setup. 建目录 inbox 201（已存在则 409 幂等）', mk.status === 201 || mk.status === 409, `status=${mk.status}`);

// ---------- 20MB 文件：8MB + 8MB + 4MB，chunkSize 8MiB ----------
const SIZE = 20 * MiB;
const CHUNK = 8 * MiB;
const content = crypto.randomBytes(SIZE);
const parts = [];
for (let i = 0; i < SIZE; i += CHUNK) parts.push(content.slice(i, Math.min(i + CHUNK, SIZE)));
check('setup. 切片为 3 片（8/8/4 MiB）', parts.length === 3 && parts[0].length === 8 * MiB && parts[1].length === 8 * MiB && parts[2].length === 4 * MiB,
  `sizes=${parts.map((p) => p.length).join('/')}`);

async function putPart(cookie, uploadId, index, buf) {
  return req('PUT', BASE, `/api/uploads/${uploadId}/part/${index}`, {
    cookie, raw: { buffer: buf, contentType: 'application/octet-stream' },
  });
}

// ====================================================================
// 1) init 会话
// ====================================================================
const init1 = await req('POST', BASE, '/api/uploads/init', {
  cookie: aliceJar,
  json: { parentPath: `${ALICE}/inbox`, name: 'concurrent.bin', sizeBytes: SIZE, chunkSize: CHUNK, overwrite: '1' },
});
const sid1 = init1.json?.uploadId;
check('init. 201 返回 uploadId/totalChunks=3',
  init1.status === 201 && !!sid1 && init1.json.totalChunks === 3,
  `status=${init1.status} sid=${sid1} total=${init1.json?.totalChunks}`);

// ====================================================================
// 2) 三片并发 PUT（Promise.all），断言全 200
// ====================================================================
const putResults = await Promise.all([0, 1, 2].map((i) => putPart(aliceJar, sid1, i, parts[i])));
const putAll200 = putResults.every((r) => r.status === 200);
check('并发. 三片同时 PUT 全部 200', putAll200,
  `statuses=${putResults.map((r) => r.status).join(',')} body=${JSON.stringify(putResults.map((r) => r.json?.receivedCount))}`);

// ====================================================================
// 3) 详情 received 必须是 [0,1,2]（不丢片）
// ====================================================================
const det1 = await req('GET', BASE, `/api/uploads/${sid1}`, { cookie: aliceJar });
const gotReceived = det1.json?.item?.received;
check('并发. 详情 received=[0,1,2] 无丢片',
  det1.status === 200 && JSON.stringify(gotReceived) === JSON.stringify([0, 1, 2]),
  `status=${det1.status} received=${JSON.stringify(gotReceived)} missing=${JSON.stringify(det1.json?.item?.missing)}`);

// ====================================================================
// 4) complete 201 + 下载 sha256 一致
// ====================================================================
const complete1 = await req('POST', BASE, `/api/uploads/${sid1}/complete`, { cookie: aliceJar, json: { mime: 'application/octet-stream' } });
check('complete. 并发上传后 complete 201',
  complete1.status === 201 && complete1.json?.item?.type === 'file' && complete1.json?.item?.sizeBytes === SIZE,
  `status=${complete1.status} item=${JSON.stringify(complete1.json?.item)}`);

const dl = await req('GET', BASE, `/api/files/download?path=${encodeURIComponent(`${ALICE}/inbox/concurrent.bin`)}`, { cookie: aliceJar });
const dlBuf = dl.buf;
check('complete. 下载回来字节数与 sha256 一致',
  dl.status === 200 && dlBuf.length === SIZE && sha256(dlBuf) === sha256(content),
  `status=${dl.status} bytes=${dlBuf.length} expect=${SIZE} shaMatch=${sha256(dlBuf) === sha256(content)}`);

// ====================================================================
// 5) 幂等：对同一 active 会话重复上传同 index（先再造一个会话传两片再重发 0/1）
// ====================================================================
const init2 = await req('POST', BASE, '/api/uploads/init', {
  cookie: aliceJar,
  json: { parentPath: `${ALICE}/inbox`, name: 'concurrent-replay.bin', sizeBytes: SIZE, chunkSize: CHUNK, overwrite: '1' },
});
const sid2 = init2.json?.uploadId;
check('setup. 幂等用例 init 201', init2.status === 201 && !!sid2, `status=${init2.status} sid=${sid2}`);

// 先发 0、1、2 并发一轮
const replayA = await Promise.all([0, 1, 2].map((i) => putPart(aliceJar, sid2, i, parts[i])));
// 再重复上传 0、1（同 index 覆盖）并发一轮
const replayB = await Promise.all([0, 1].map((i) => putPart(aliceJar, sid2, i, parts[i])));
check('幂等. 重复上传同 index 仍 200',
  replayA.every((r) => r.status === 200) && replayB.every((r) => r.status === 200),
  `first=${replayA.map((r) => r.status).join(',')} replay=${replayB.map((r) => r.status).join(',')}`);

const det2 = await req('GET', BASE, `/api/uploads/${sid2}`, { cookie: aliceJar });
check('幂等. 重复上传后 received 去重仍为 [0,1,2]',
  det2.status === 200 && JSON.stringify(det2.json?.item?.received) === JSON.stringify([0, 1, 2]),
  `received=${JSON.stringify(det2.json?.item?.received)}`);

const complete2 = await req('POST', BASE, `/api/uploads/${sid2}/complete`, { cookie: aliceJar, json: {} });
const dl2 = await req('GET', BASE, `/api/files/download?path=${encodeURIComponent(`${ALICE}/inbox/concurrent-replay.bin`)}`, { cookie: aliceJar });
check('幂等. 重发会话 complete 201 且 sha256 一致',
  complete2.status === 201 && dl2.status === 200 && dl2.buf.length === SIZE && sha256(dl2.buf) === sha256(content),
  `complete=${complete2.status} bytes=${dl2.buf.length} shaMatch=${sha256(dl2.buf) === sha256(content)}`);

// ---------- 汇总 ----------
const fail = results.filter((r) => !r.ok);
console.log('\n===== 汇总 =====');
console.log(`PASS=${results.length - fail.length}  FAIL=${fail.length}  总计=${results.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('ALL PASS');
void DB_PATH;
