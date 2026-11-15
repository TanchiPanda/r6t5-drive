// P7 自测：用户组自助注册 + sudo 用户组 + 空间单位（MB→EB，BigInt 精确换算）。
// 用法（隔离环境，先起服务）：
//   DB_PATH=/tmp/p7a/r6t5.db STORAGE_ROOT=/tmp/p7a/volume PORT=8140 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   DB_PATH=/tmp/p7a/r6t5.db BASE=http://127.0.0.1:8140 node tools/test-p7-signup-sudo-units.mjs
import path from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8140';

const jar = { admin: '', gA: '', gB: '', normal: '' };

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

async function req(method, url, { body, cookie, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
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
  if (ct.includes('json')) { try { json = text ? JSON.parse(text) : null; } catch { json = text; } }
  const setCookieArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setCookieArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json, text, set };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

function cookieStr(set) {
  return Object.entries(set).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { body: { password: process.env.ADMIN_PASSWORD || 'test123' } });
  jar.admin = cookieStr(r.set);
  return r;
}

async function ensureVolumeSource() {
  const cur = await req('GET', '/api/admin/user-source', { cookie: jar.admin });
  if (cur.json?.userSource !== 'volume') {
    await req('PUT', '/api/admin/user-source', { cookie: jar.admin, body: { source: 'volume', confirm: true } });
  }
}

// 直连库（造组 / 直查校验）
const Database = (await import('better-sqlite3')).default;
const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'data/r6t5.db');
const db = new Database(dbPath);

// ============ 0. 前置：管理员登录 + 切 volume ============
{
  const al = await adminLogin();
  check('0a. 管理员登录 200 并拿到 admin cookie', al.status === 200 && !!jar.admin,
    `status=${al.status} cookie=${jar.admin ? 'yes' : 'no'}`);
  await ensureVolumeSource();
  const cfg = await req('GET', '/api/auth/signup-config');
  check('0b. volume 初始无开放组 → available:false reason:closed',
    cfg.status === 200 && cfg.json?.available === false && cfg.json?.source === 'volume' && cfg.json?.reason === 'closed',
    `body=${JSON.stringify(cfg.json)}`);
}

// ============ 1. 自助注册：分配组按 createdAt 最前 ============
let groupA, groupB;
{
  const a = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: { name: 'P7-A组', allowSelfSignup: true, spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120 },
  });
  groupA = a.json?.item;
  check('1a. 建组 A（allowSelfSignup:true）201', a.status === 201 && groupA?.allowSelfSignup === true,
    `status=${a.status} item=${JSON.stringify(groupA)}`);

  const b = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: { name: 'P7-B组', allowSelfSignup: true, spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120 },
  });
  groupB = b.json?.item;
  check('1b. 建组 B（allowSelfSignup:true）201', b.status === 201 && groupB?.allowSelfSignup === true,
    `status=${b.status} item=${JSON.stringify(groupB)}`);

  const cfg = await req('GET', '/api/auth/signup-config');
  check('1c. 有开放组 → available:true reason:ok',
    cfg.json?.available === true && cfg.json?.reason === 'ok' && cfg.json?.minPasswordLength === 8,
    `body=${JSON.stringify(cfg.json)}`);

  const email = 'reg-a@p7.test';
  const su = await req('POST', '/api/auth/signup', { body: { email, password: 'password123', passwordConfirm: 'password123' } });
  check('1d. 注册成功 201 并落 createdAt 最前的组 A',
    su.status === 201 && su.json?.ok === true && su.json?.user?.groupId === groupA.id && su.json?.setup?.next === 'ready',
    `status=${su.status} groupId=${su.json?.user?.groupId} expect=${groupA.id}`);
  jar.gA = cookieStr(su.set);
  const me = await req('GET', '/api/me', { cookie: jar.gA });
  check('1e. 注册后会话有效，/api/me 200', me.status === 200 && me.json?.user?.email === email,
    `status=${me.status} email=${me.json?.user?.email}`);

  // 关掉 A → 新注册应落 B
  await req('PATCH', `/api/admin/groups/${groupA.id}`, { cookie: jar.admin, body: { allowSelfSignup: false } });
  const email2 = 'reg-b@p7.test';
  const su2 = await req('POST', '/api/auth/signup', { body: { email: email2, password: 'password123', passwordConfirm: 'password123' } });
  check('1f. A 关闭后注册落 B', su2.status === 201 && su2.json?.user?.groupId === groupB.id,
    `status=${su2.status} groupId=${su2.json?.user?.groupId} expect=${groupB.id}`);
  jar.gB = cookieStr(su2.set);

  // 两组都关 → 403 signup_closed
  await req('PATCH', `/api/admin/groups/${groupB.id}`, { cookie: jar.admin, body: { allowSelfSignup: false } });
  const su3 = await req('POST', '/api/auth/signup', { body: { email: 'reg-closed@p7.test', password: 'password123', passwordConfirm: 'password123' } });
  check('1g. 两组都关 → 403 signup_closed',
    su3.status === 403 && su3.json?.error?.code === 'signup_closed' && su3.json?.error?.message === '当前未开放自助注册',
    `status=${su3.status} code=${su3.json?.error?.code} message=${su3.json?.error?.message}`);

  const cfg2 = await req('GET', '/api/auth/signup-config');
  check('1h. 两组都关 → available:false reason:closed',
    cfg2.json?.available === false && cfg2.json?.reason === 'closed', `body=${JSON.stringify(cfg2.json)}`);

  // 重新打开 B，供后续 sudo / 上传用
  await req('PATCH', `/api/admin/groups/${groupB.id}`, { cookie: jar.admin, body: { allowSelfSignup: true } });
}

// ============ 2. 注册参数校验 / 重复邮箱文案 ============
{
  // 两次密码不一致
  const mismatch = await req('POST', '/api/auth/signup', { body: { email: 'mm@p7.test', password: 'password123', passwordConfirm: 'other456' } });
  check('2a. 两次密码不一致 → 400 invalid_input field=passwordConfirm',
    mismatch.status === 400 && mismatch.json?.error?.code === 'invalid_input' &&
    mismatch.json?.error?.details?.field === 'passwordConfirm' && mismatch.json?.error?.message === '两次输入的密码不一致',
    `status=${mismatch.status} code=${mismatch.json?.error?.code} field=${mismatch.json?.error?.details?.field} msg=${mismatch.json?.error?.message}`);

  // 密码 7 位
  const short = await req('POST', '/api/auth/signup', { body: { email: 'short@p7.test', password: '1234567', passwordConfirm: '1234567' } });
  check('2b. 密码 7 位 → 400 invalid_input field=password',
    short.status === 400 && short.json?.error?.code === 'invalid_input' && short.json?.error?.details?.field === 'password' &&
    short.json?.error?.message === '密码至少 8 位',
    `status=${short.status} field=${short.json?.error?.details?.field} msg=${short.json?.error?.message}`);

  // 重复邮箱（reg-b@p7.test 已在 1f 注册）→ 400 invalid_signup，文案逐字一致，不含 duplicate/exists。
  // 此用例在限流段之前跑：此时桶内仍有令牌，避免被 429 抢先。
  const dup = await req('POST', '/api/auth/signup', { body: { email: 'reg-b@p7.test', password: 'password123', passwordConfirm: 'password123' } });
  const msg = dup.json?.error?.message || '';
  check('2c. 重复邮箱 → 400 invalid_signup，message=「注册信息无效」且不泄露存在性',
    dup.status === 400 && dup.json?.error?.code === 'invalid_signup' && msg === '注册信息无效' &&
    !/duplicate|exists|已存在|已注册/i.test(msg),
    `status=${dup.status} code=${dup.json?.error?.code} msg=${msg}`);
  check('2d. 错误码 invalid_signup 已在 errors 定义',
    dup.json?.error?.code === 'invalid_signup', `code=${dup.json?.error?.code}`);
}

// ============ 3. 同 IP 令牌桶：容量 5，每分钟补 1 个；超限 429 rate_limited ============
{
  // 容量 5：前 5 次消耗完令牌后，第 6 次应命中 429。前面用例已消耗若干令牌，
  // 这里连发直到出现 429，断言「超限请求返回 429 rate_limited 且文案正确」。
  const resultsSeq = [];
  let limitedHit = null;
  for (let i = 0; i < 10; i += 1) {
    const r = await req('POST', '/api/auth/signup', { body: { email: `rate-${i}@p7.test`, password: 'password123', passwordConfirm: 'password123' } });
    const code = r.json?.error?.code;
    resultsSeq.push({ status: r.status, code });
    if (code === 'rate_limited' && !limitedHit) limitedHit = r;
    if (limitedHit) break;
  }
  check('3. 令牌桶超限 → 429 rate_limited',
    !!limitedHit && limitedHit.status === 429 && limitedHit.json?.error?.code === 'rate_limited',
    `seq=${JSON.stringify(resultsSeq)}`);
  check('3b. 限流文案「注册尝试过多，请稍后再试」',
    limitedHit?.json?.error?.message === '注册尝试过多，请稍后再试', `msg=${limitedHit?.json?.error?.message}`);
}

// 令牌桶每分钟补 1 个；后续用例不再走注册接口（sudo 走 /api/auth/login，不计入注册桶）。

// ============ 4. sudo 用户组 ============
{
  // 把组 B 设为 sudo；B 组用户 reg-b@p7.test 已登录（jar.gB）
  const patchSudo = await req('PATCH', `/api/admin/groups/${groupB.id}`, { cookie: jar.admin, body: { isSudo: true } });
  check('4a. 组 B 设 isSudo:true 200，返回 item.isSudo=true',
    patchSudo.status === 200 && patchSudo.json?.item?.isSudo === true,
    `status=${patchSudo.status} item=${JSON.stringify(patchSudo.json?.item)}`);

  // 重新用邮箱+密码登录拿 user cookie（模拟前端 sudo 表单调 /api/auth/login）
  const loginB = await req('POST', '/api/auth/login', { body: { email: 'reg-b@p7.test', password: 'password123' } });
  jar.gB = cookieStr(loginB.set);
  check('4b. B 组用户密码登录 200', loginB.status === 200 && loginB.json?.ok === true,
    `status=${loginB.status}`);

  const ov = await req('GET', '/api/admin/overview', { cookie: jar.gB });
  check('4c. sudo 用户访问 /api/admin/overview 200', ov.status === 200, `status=${ov.status}`);

  const sess = await req('GET', '/api/admin/session', { cookie: jar.gB });
  check('4d. /api/admin/session 返回 via:sudo + email/groupId/groupName',
    sess.status === 200 && sess.json?.admin?.via === 'sudo' &&
    sess.json?.admin?.email === 'reg-b@p7.test' && sess.json?.admin?.groupId === groupB.id &&
    !!sess.json?.admin?.groupName,
    `body=${JSON.stringify(sess.json)}`);

  // 把 B 的 isSudo 改回 0 → 同一 cookie 下一个请求即 403
  await req('PATCH', `/api/admin/groups/${groupB.id}`, { cookie: jar.admin, body: { isSudo: false } });
  const ov2 = await req('GET', '/api/admin/overview', { cookie: jar.gB });
  check('4e. 移出 sudo 组后同一 cookie → 403', ov2.status === 403, `status=${ov2.status} code=${ov2.json?.error?.code}`);
  const sess2 = await req('GET', '/api/admin/session', { cookie: jar.gB });
  check('4f. 移出 sudo 后 /api/admin/session 403（普通登录用户）', sess2.status === 403, `status=${sess2.status} code=${sess2.json?.error?.code}`);

  // 普通组用户（A 组 reg-a@p7.test）登录后访问管理接口仍 403
  const loginA = await req('POST', '/api/auth/login', { body: { email: 'reg-a@p7.test', password: 'password123' } });
  jar.normal = cookieStr(loginA.set);
  const ov3 = await req('GET', '/api/admin/overview', { cookie: jar.normal });
  check('4g. 普通组用户访问 /api/admin/overview 403', ov3.status === 403 && ov3.json?.error?.code === 'forbidden',
    `status=${ov3.status} code=${ov3.json?.error?.code}`);

  // 审计：sudo 进入写 admin_login，detail=sudo:<email>
  const audit = await req('GET', '/api/admin/audit?action=admin_login&pageSize=50', { cookie: jar.admin });
  const sudoAudit = (audit.json?.items || []).some((i) => i.detail === 'sudo:reg-b@p7.test');
  check('4h. 审计含 admin_login detail=sudo:reg-b@p7.test', sudoAudit,
    `items=${(audit.json?.items || []).map((i) => `${i.action}:${i.detail}`).join(',')}`);
}

// ============ 5. 单位换算（对象写法 {value, unit} + 旧字节写法）============
{
  const mk = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: { name: 'P7-单位组', spaceLimit: { value: '1.5', unit: 'TB' }, maxFileSize: { value: '1', unit: 'EB' }, traffic7dLimit: { value: '200', unit: 'MB' } },
  });
  const item = mk.json?.item;
  check('5a. 1.5 TB → spaceLimitBytes=1649267441664 且 spaceLimitText 含 TB',
    mk.status === 201 && item?.spaceLimitBytes === '1649267441664' && /TB/.test(item?.spaceLimitText || ''),
    `bytes=${item?.spaceLimitBytes} text=${item?.spaceLimitText}`);
  check('5b. 1 EB → maxFileSizeBytes=1152921504606846976',
    item?.maxFileSizeBytes === '1152921504606846976' && /EB/.test(item?.maxFileSizeText || ''),
    `bytes=${item?.maxFileSizeBytes} text=${item?.maxFileSizeText}`);
  check('5c. 200 MB → traffic7dLimitBytes=209715200',
    item?.traffic7dLimitBytes === '209715200' && /MB/.test(item?.traffic7dLimitText || ''),
    `bytes=${item?.traffic7dLimitBytes} text=${item?.traffic7dLimitText}`);

  // 0.5 MB → 524288
  const p05 = await req('PATCH', `/api/admin/groups/${item.id}`, { cookie: jar.admin, body: { maxFileSize: { value: '0.5', unit: 'MB' } } });
  check('5d. 0.5 MB → 524288', p05.json?.item?.maxFileSizeBytes === '524288',
    `bytes=${p05.json?.item?.maxFileSizeBytes} text=${p05.json?.item?.maxFileSizeText}`);

  // 16 EB（=2^64）超 SQLite 上限 → 400 invalid_input，details.max 存在
  const over = await req('PATCH', `/api/admin/groups/${item.id}`, { cookie: jar.admin, body: { spaceLimit: { value: '16', unit: 'EB' } } });
  check('5e. 16 EB 超上限 → 400 invalid_input 且 details.max 存在',
    over.status === 400 && over.json?.error?.code === 'invalid_input' && !!over.json?.error?.details?.max,
    `status=${over.status} details=${JSON.stringify(over.json?.error?.details)}`);

  // 旧字节字符串写法兼容
  const legacy = await req('PATCH', `/api/admin/groups/${item.id}`, { cookie: jar.admin, body: { spaceLimitBytes: '10737418240', maxFileSizeBytes: '2147483648', traffic7dLimitBytes: '5368709120' } });
  check('5f. 旧字节字符串写法兼容（10GiB/2GiB/5GiB）',
    legacy.status === 200 && legacy.json?.item?.spaceLimitBytes === '10737418240' &&
    legacy.json?.item?.maxFileSizeBytes === '2147483648' && legacy.json?.item?.traffic7dLimitBytes === '5368709120',
    `item=${JSON.stringify(legacy.json?.item)}`);
}

// ============ 6. 上传拦截用同一换算：单文件上限 1 MB ============
{
  // 先确保有一条 volume 策略（直连库兜底造一条，避免依赖 P2 策略）
  const stratExists = db.prepare("SELECT id FROM storage_strategies WHERE type='volume'").get();
  if (!stratExists) {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO storage_strategies (id,name,type,region,capacityBytes,usedBytes,readOnly,enabled,config,createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('st-p7', 'P7本地数据卷', 'volume', '本机', 107374182400, 0, 0, 1, JSON.stringify({ rootPath: process.env.STORAGE_ROOT || '/tmp/p7a/volume' }), now);
  }

  // 把普通组 A 的单文件上限设成 1 MB
  await req('PATCH', `/api/admin/groups/${groupA.id}`, {
    cookie: jar.admin,
    body: { maxFileSize: { value: '1', unit: 'MB' }, spaceLimit: { value: '10', unit: 'GB' }, traffic7dLimit: { value: '10', unit: 'GB' } },
  });

  // P8-B：未配 SMTP 时自助注册落 pending_review，上传/分享会被 email_unconfirmed 守卫拦截。
  // 本用例只测配额换算，直接在隔离库把该测试用户置 active（仅测试脚本适配，服务端守卫未放宽）。
  db.prepare("UPDATE users SET status = 'active', disabled = 0 WHERE email = ?").run('reg-a@p7.test');

  // 2MB 文件 → 超限
  const bigChunk = new Uint8Array(2 * 1024 * 1024);
  const fd1 = new FormData(); fd1.append('file', new Blob([bigChunk]), 'big.bin');
  const upBig = await req('POST', '/api/files/upload?path=reg-a@p7.test', { cookie: jar.normal, raw: { body: fd1, headers: {} } });
  check('6a. 单文件上限 1MB，上传 2MB → 413 quota_file',
    upBig.status === 413 && upBig.json?.error?.code === 'quota_file',
    `status=${upBig.status} code=${upBig.json?.error?.code}`);

  // 0.9MB 文件 → 201
  const smallChunk = new Uint8Array(Math.floor(0.9 * 1024 * 1024));
  const fd2 = new FormData(); fd2.append('file', new Blob([smallChunk]), 'small.bin');
  const upSmall = await req('POST', '/api/files/upload?path=reg-a@p7.test', { cookie: jar.normal, raw: { body: fd2, headers: {} } });
  check('6b. 上传 0.9MB → 201', upSmall.status === 201, `status=${upSmall.status} size=${upSmall.json?.item?.sizeBytes}`);
}

// ============ 7. 老库兼容：旧表结构迁移后组行仍在、新列默认 0、上限语义不变 ============
{
  const fs = await import('node:fs');
  const OldDb = (await import('better-sqlite3')).default;
  const oldPath = '/tmp/p7a/legacy-test.db';
  fs.rmSync(oldPath, { force: true });
  const oldDb = new OldDb(oldPath);
  // 构造只有旧列的 groups 表（无 allow_self_signup / is_sudo），写入旧纯字节整数上限
  oldDb.exec(`
    CREATE TABLE groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      spaceLimitBytes INTEGER NOT NULL, maxFileSizeBytes INTEGER NOT NULL,
      traffic7dLimitBytes INTEGER NOT NULL, isDefault INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, displayName TEXT NOT NULL DEFAULT '', groupId TEXT, disabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', passwordHash TEXT, registeredAt TEXT, lastLoginAt TEXT, createdAt TEXT NOT NULL);
  `);
  oldDb.prepare('INSERT INTO groups (id,name,spaceLimitBytes,maxFileSizeBytes,traffic7dLimitBytes,isDefault,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run('g-old', '老库标准组', 10737418240, 2147483648, 5368709120, 1, new Date().toISOString());
  oldDb.close();

  // 用服务端 db 模块跑 migrate：db.js 在模块加载时按 ENV.DB_PATH 建库，
  // 因此先把 DB_PATH 指向老库，再以独立 URL 副本 import（避免复用已缓存的单例）。
  process.env.DB_PATH = oldPath;
  const modUrl = new URL('../server/db.js', import.meta.url).href + `?t=${Date.now()}`;
  const mod = await import(modUrl);
  mod.migrate();
  const row = mod.db.prepare('SELECT * FROM groups WHERE id = ?').get('g-old');
  check('7a. 老库迁移后组行仍在', !!row, `row=${JSON.stringify(row)}`);
  check('7b. 两新列默认 0（allow_self_signup=0, is_sudo=0）',
    row.allow_self_signup === 0 && row.is_sudo === 0,
    `allow_self_signup=${row.allow_self_signup} is_sudo=${row.is_sudo}`);
  check('7c. 旧上限语义不变（10GiB/2GiB/5GiB）',
    Number(row.spaceLimitBytes) === 10737418240 && Number(row.maxFileSizeBytes) === 2147483648 && Number(row.traffic7dLimitBytes) === 5368709120,
    `space=${row.spaceLimitBytes} file=${row.maxFileSizeBytes} traffic=${row.traffic7dLimitBytes}`);
  mod.db.close();
  process.env.DB_PATH = dbPath;
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
