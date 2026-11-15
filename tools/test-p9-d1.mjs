// P9-D1 验收：存储策略补齐（OSS/COS/KS3/OBS/七牛/又拍）+ OAuth 应用凭据。
// 自举隔离实例（DB_PATH /tmp/p9d1/r6t5.db，PORT 8198，DEV_AUTH=1，ADMIN_PASSWORD=test123），
// 配合 tools/fake-objstore.mjs 在本地校验签名 / 鉴权头构造；真实厂商服务一律未联调。
// 用法：node tools/test-p9-d1.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFakeObjStore } from './fake-objstore.mjs';
import { getDriver } from '../server/services/storage/driver.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.PORT || 8198);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = process.env.DB_PATH || '/tmp/p9d1/r6t5.db';
const STORAGE_ROOT = process.env.STORAGE_ROOT || '/tmp/p9d1/volume';

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

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

async function req(method, url, { cookie, body, headers = {}, raw = false, redirect = 'follow' } = {}) {
  const opts = { method, headers: { ...headers }, redirect };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    if (raw) { opts.body = body; }
    else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  }
  const res = await fetch(BASE + url, opts);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = text; } }
  const setArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json, text, set, location: res.headers.get('location') };
}

function jarOf(set) {
  return Object.entries(set).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ---------- 启动隔离实例 ----------
fs.rmSync(DB_PATH, { force: true });
fs.rmSync(DB_PATH + '-wal', { force: true });
fs.rmSync(DB_PATH + '-shm', { force: true });
fs.mkdirSync(STORAGE_ROOT, { recursive: true });

const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DB_PATH, STORAGE_ROOT, DEV_AUTH: '1', ADMIN_PASSWORD: 'test123' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => process.stdout.write(`[boot] ${d}`));
child.stderr.on('data', (d) => process.stderr.write(`[boot-err] ${d}`));

async function waitBoot() {
  for (let i = 0; i < 50; i += 1) {
    try {
      const r = await fetch(BASE + '/api/setup/status');
      if (r.status === 200) return true;
    } catch { /* 尚未监听 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r6t5-p9d1-'));

// 厂商配置（endpoint 指向本地假服务；密钥为假值，假服务不做密码学真值校验）
function vendorConfigs(fake) {
  const ep = `http://127.0.0.1:${fake.port}`;
  return {
    oss: { endpoint: ep, region: 'oss-cn-hangzhou', bucket: 'b-oss', accessKeyId: 'AKOSS00000000000000', secretAccessKey: 'secret-oss-p9d1', prefix: 'p9' },
    cos: { endpoint: ep, region: 'ap-guangzhou', bucket: 'b-cos', appid: '1234567890', accessKeyId: 'AKCOS00000000000000', secretAccessKey: 'secret-cos-p9d1', prefix: 'p9' },
    ks3: { endpoint: ep, region: 'ks3-cn-beijing', bucket: 'b-ks3', accessKeyId: 'AKKS30000000000000', secretAccessKey: 'secret-ks3-p9d1', prefix: 'p9' },
    obs: { endpoint: ep, region: 'cn-north-4', bucket: 'b-obs', accessKeyId: 'AKOBS00000000000000', secretAccessKey: 'secret-obs-p9d1', prefix: 'p9' },
    qiniu: { endpoint: ep, bucket: 'b-qn', accessKey: 'AKQN00000000000000', secretKey: 'secret-qn-p9d1', prefix: 'p9' },
    upyun: { endpoint: ep, bucket: 'b-up', operator: 'p9d1-op', password: 'secret-up-p9d1', prefix: 'p9' },
  };
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

try {
  const booted = await waitBoot();
  check('0. 隔离实例启动', booted, `BASE=${BASE}`);

  const fake = await startFakeObjStore({ port: 0 });
  const cfgs = vendorConfigs(fake);

  // ================= A. 六家适配器签名 / 鉴权头在假服务上被接受 =================
  for (const [type, cfg] of Object.entries(cfgs)) {
    const driver = getDriver(type);
    const strategy = { id: `st-${type}`, type, config: JSON.stringify(cfg) };
    const relPath = `alice@p9d1.test/inbox/hello-${type}.txt`;
    const body = Buffer.from(`hello ${type} p9-d1 内容\n`.repeat(3), 'utf8');
    const tmpFile = path.join(tmpDir, `${type}.txt`);
    fs.writeFileSync(tmpFile, body);

    // PUT
    let putOk = true, putErr = '';
    try { await driver.writeFromTemp(strategy, relPath, tmpFile, { size: body.length, mime: 'text/plain' }); }
    catch (e) { putOk = false; putErr = `${e.code || ''} ${e.message}`; }

    if (type === 'qiniu' || type === 'upyun') {
      check(`A.${type} 上传显式 upload_not_supported`, !putOk && putErr.includes('upload_not_supported'), `err=${putErr}`);
      // 不支持列举：显式 driver_not_supported
      let listErr = '';
      try { await driver.list(strategy, 'alice@p9d1.test/inbox'); } catch (e) { listErr = e.code || ''; }
      check(`A.${type} list 显式 driver_not_supported`, listErr === 'driver_not_supported', `code=${listErr}`);
      continue;
    }

    check(`A.${type} PUT 被假服务接受`, putOk, `err=${putErr}`);

    // GET 全量
    const stream = await driver.readStream(strategy, relPath);
    const back = await streamToBuffer(stream);
    check(`A.${type} GET 字节一致`, back.equals(body), `bytes=${back.length}/${body.length}`);

    // Range GET
    const rStream = await driver.readStream(strategy, relPath, { range: 'bytes=0-5' });
    const rBack = await streamToBuffer(rStream);
    const expected = body.slice(0, 6);
    check(`A.${type} Range GET 206 切片一致`, rBack.equals(expected) && (rStream.meta?.status === 206),
      `bytes=${rBack.length}/${expected.length} status=${rStream.meta?.status}`);

    // HEAD / stat
    const stat = await driver.stat(strategy, relPath);
    check(`A.${type} HEAD/stat 返回大小`, stat.sizeBytes === body.length, `size=${stat.sizeBytes}`);

    // DELETE
    await driver.remove(strategy, relPath);
    let gone = false;
    try { await driver.readStream(strategy, relPath); } catch (e) { gone = e.status === 404 || e.code === 'not_found'; }
    check(`A.${type} DELETE 后 404`, gone, `404=${gone}`);

    // 假服务记录：该厂商所有请求均无 violation
    const vendorReqs = fake.requests.filter((r) => r.vendor === type);
    const violations = vendorReqs.filter((r) => r.violation);
    check(`A.${type} 假服务无签名校验违规`, vendorReqs.length >= 4 && violations.length === 0,
      `requests=${vendorReqs.length} violations=${violations.length} ${violations.map((v) => v.violation).join(';')}`);
  }

  // ================= B. 管理端：保存策略缺字段 → 400 =================
  const adminLogin = await req('POST', '/api/admin/login', { body: { password: 'test123' } });
  const adminJar = jarOf(adminLogin.set);
  check('B.0 管理员登录拿到会话', adminLogin.status === 200 && !!adminJar, `status=${adminLogin.status}`);

  const missing = await req('POST', '/api/admin/storage', {
    cookie: adminJar,
    body: { name: 'OSS 缺字段', type: 'oss', capacityBytes: 107374182400, acknowledgeDisclosure: true,
      config: { endpoint: `http://127.0.0.1:${fake.port}`, bucket: 'b-oss' } },
  });
  check('B.1 OSS 缺 region/密钥 → 400 invalid_input 并指出字段',
    missing.status === 400 && missing.json?.error?.code === 'invalid_input' &&
    ['region', 'accessKeyId', 'secretAccessKey'].includes(missing.json?.error?.details?.field),
    `status=${missing.status} code=${missing.json?.error?.code} field=${missing.json?.error?.details?.field}`);

  // ================= C. OAuth 应用 / 授权码 / 令牌 =================
  // C.1 建应用（两个 redirect_uri）
  const create = await req('POST', '/api/admin/oauth-clients', {
    cookie: adminJar,
    body: {
      name: '桌面客户端', description: 'R6T5 桌面端接入', scopes: ['read'],
      redirectUris: ['http://127.0.0.1:8198/callback', 'http://localhost:3000/callback'],
    },
  });
  const client = create.json?.item;
  const clientSecret = create.json?.clientSecret;
  check('C.1 创建 OAuth 应用 201，明文 secret 一次性返回',
    create.status === 201 && !!client?.clientId && !!clientSecret,
    `status=${create.status} clientId=${client?.clientId} secret=${clientSecret ? 'yes' : 'no'}`);

  // 列表 / 详情不含明文 secret
  const listClients = await req('GET', '/api/admin/oauth-clients', { cookie: adminJar });
  const detail = await req('GET', `/api/admin/oauth-clients/${client.id}`, { cookie: adminJar });
  check('C.2 管理端列表/详情不回显明文 secret',
    listClients.status === 200 && detail.status === 200 &&
    !listClients.text.includes(clientSecret) && !detail.text.includes(clientSecret) &&
    listClients.json.items[0].secretSet === true,
    `明文出现=${listClients.text.includes(clientSecret)} secretSet=${listClients.json.items?.[0]?.secretSet}`);

  // C.2 用户登录
  const userLogin = await req('POST', '/api/auth/dev-login', { body: { email: 'alice@p9d1.test' } });
  const userJar = jarOf(userLogin.set);
  check('C.3 用户 dev-login 200', userLogin.status === 200 && !!userJar, `status=${userLogin.status}`);

  // C.3 未登录 authorize → 302 登录页
  const anon = await req('GET', `/api/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8198/callback')}&response_type=code`, { redirect: 'manual' });
  check('C.4 未登录 authorize → 302 回登录页', anon.status === 302 && /^\/login/.test(anon.location || ''),
    `status=${anon.status} location=${anon.location}`);

  // C.4 redirect_uri 不匹配 → 400
  const badUri = await req('GET', `/api/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&redirect_uri=${encodeURIComponent('http://evil.example.com/cb')}&response_type=code`, { cookie: userJar, redirect: 'manual' });
  check('C.5 redirect_uri 未登记 → 400', badUri.status === 400 && badUri.json?.error?.code === 'invalid_redirect_uri',
    `status=${badUri.status} code=${badUri.json?.error?.code}`);

  // C.5 登录态确认页（不带 confirm）→ 200 HTML 含应用名
  const page = await req('GET', `/api/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8198/callback')}&response_type=code&state=xyz123`, { cookie: userJar });
  check('C.6 登录态授权确认页 200 含应用名', page.status === 200 && page.text.includes('桌面客户端'),
    `status=${page.status} html=${page.text.length}`);

  // C.6 确认签发 code（第一轮，POST body 认证换 token）
  const authz = await req('GET', `/api/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8198/callback')}&response_type=code&state=xyz123&confirm=1`, { cookie: userJar, redirect: 'manual' });
  check('C.7 确认后 302 回 redirect_uri 带 code/state', authz.status === 302 && /code=/.test(authz.location || '') && /state=xyz123/.test(authz.location || ''),
    `status=${authz.status} location=${authz.location}`);
  const code1 = new URL(authz.location, BASE).searchParams.get('code');

  // 第一轮：client_secret_post 认证
  const tokenPost = await req('POST', '/api/oauth/token', {
    body: {
      grant_type: 'authorization_code', code: code1, redirect_uri: 'http://127.0.0.1:8198/callback',
      client_id: client.clientId, client_secret: clientSecret,
    },
  });
  check('C.8 authorization_code + post 认证换 token 200',
    tokenPost.status === 200 && !!tokenPost.json?.access_token && !!tokenPost.json?.refresh_token && tokenPost.json.token_type === 'Bearer',
    `status=${tokenPost.status} code=${tokenPost.json?.error?.code} at=${tokenPost.json?.access_token ? 'yes' : 'no'}`);
  const access1 = tokenPost.json.access_token;
  const refresh1 = tokenPost.json.refresh_token;

  // C.7 第二轮授权码，Basic 认证换 token
  const authz2 = await req('GET', `/api/oauth/authorize?client_id=${encodeURIComponent(client.clientId)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:8198/callback')}&response_type=code&confirm=1`, { cookie: userJar, redirect: 'manual' });
  const code2 = new URL(authz2.location, BASE).searchParams.get('code');
  const basic = Buffer.from(`${client.clientId}:${clientSecret}`).toString('base64');
  const tokenBasic = await req('POST', '/api/oauth/token', {
    headers: { Authorization: `Basic ${basic}` },
    body: { grant_type: 'authorization_code', code: code2, redirect_uri: 'http://127.0.0.1:8198/callback' },
  });
  check('C.9 authorization_code + Basic 认证换 token 200',
    tokenBasic.status === 200 && !!tokenBasic.json?.access_token,
    `status=${tokenBasic.status} code=${tokenBasic.json?.error?.code}`);
  const access2 = tokenBasic.json.access_token;
  const refresh2 = tokenBasic.json.refresh_token;

  // C.8 Bearer 访问 /api/oauth/me 与 /api/me
  const meOauth = await req('GET', '/api/oauth/me', { headers: { Authorization: `Bearer ${access1}` } });
  check('C.10 Bearer /api/oauth/me 200 返回邮箱与 scope',
    meOauth.status === 200 && meOauth.json?.email === 'alice@p9d1.test' && meOauth.json.scopes.includes('read'),
    `status=${meOauth.status} body=${JSON.stringify(meOauth.json)}`);
  const meCookie = await req('GET', '/api/me', { headers: { Authorization: `Bearer ${access2}` } });
  check('C.11 Bearer /api/me 200（不挂文件权限模型）',
    meCookie.status === 200 && meCookie.json?.user?.email === 'alice@p9d1.test' && meCookie.json.via === 'oauth',
    `status=${meCookie.status} body=${JSON.stringify(meCookie.json)}`);

  // 无 Bearer / 错 Bearer → 401
  const noAuth = await req('GET', '/api/oauth/me');
  const badAuth = await req('GET', '/api/oauth/me', { headers: { Authorization: 'Bearer not-a-token' } });
  check('C.12 缺失/错误 Bearer → 401 bearer_invalid',
    noAuth.status === 401 && badAuth.status === 401 && badAuth.json?.error?.code === 'bearer_invalid',
    `noAuth=${noAuth.status} bad=${badAuth.status} code=${badAuth.json?.error?.code}`);

  // C.9 刷新令牌轮换
  const refreshed = await req('POST', '/api/oauth/token', {
    headers: { Authorization: `Basic ${basic}` },
    body: { grant_type: 'refresh_token', refresh_token: refresh1 },
  });
  check('C.13 refresh_token 轮换签发新对 200',
    refreshed.status === 200 && !!refreshed.json?.access_token && refreshed.json.access_token !== access1,
    `status=${refreshed.status} newAt=${refreshed.json?.access_token ? 'yes' : 'no'}`);

  // C.10 撤销 access2 → 再访问 401
  const rev = await req('POST', '/api/oauth/revoke', { body: { access_token: access2 } });
  check('C.14 revoke 200', rev.status === 200 && rev.json?.ok === true, `status=${rev.status}`);
  const afterRevoke = await req('GET', '/api/oauth/me', { headers: { Authorization: `Bearer ${access2}` } });
  check('C.15 撤销后 Bearer 401 bearer_invalid',
    afterRevoke.status === 401 && afterRevoke.json?.error?.code === 'bearer_invalid',
    `status=${afterRevoke.status} code=${afterRevoke.json?.error?.code}`);

  // C.11 管理端令牌列表（仅元信息，无哈希）
  const tokens = await req('GET', `/api/admin/oauth-clients/${client.id}/tokens`, { cookie: adminJar });
  const tokenRows = tokens.json?.items || [];
  check('C.16 管理端令牌列表仅元信息、无哈希字段',
    tokens.status === 200 && tokenRows.length > 0 && tokenRows.every((t) => !('accessHash' in t) && !('refreshHash' in t)),
    `status=${tokens.status} rows=${tokenRows.length} fields=${Object.keys(tokenRows[0] || {}).join(',')}`);

  // 清理第二轮 refresh（避免残留干扰）
  await req('POST', '/api/oauth/revoke', { body: { refresh_token: refresh2 } });
} catch (e) {
  check('测试流程未抛异常', false, `${e?.stack || e}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  try { await fake.close(); } catch { /* 已关闭 */ }
  child.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
