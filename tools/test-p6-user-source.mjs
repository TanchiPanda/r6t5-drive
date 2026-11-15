// P6 自测：账号来源可切换 + 本地账号体系 + 管理员用户操作
// 用法（隔离库）：
//   DB_PATH=/tmp/p6/r6t5.db STORAGE_ROOT=/tmp/p6/volume PORT=8091 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   BASE=http://127.0.0.1:8091 node tools/test-p6-user-source.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8091';

const jar = { admin: '', alice: '', bob: '' };

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

async function req(method, path, { body, cookie, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (raw) { opts.body = raw.body; Object.assign(opts.headers, raw.headers); }
  const res = await fetch(BASE + path, opts);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = text; } }
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

// ---- 前置：建一条 volume 策略 + 第二个用户组（volume 模式下上传/配额需要）----
async function ensureBaseSetup() {
  const st = await req('POST', '/api/admin/storage', {
    cookie: jar.admin,
    body: {
      name: '本机数据卷', type: 'volume', region: '本机',
      capacityBytes: 107374182400, readOnly: false,
      config: { rootPath: process.env.STORAGE_ROOT || '/tmp/p6/volume' },
      acknowledgeDisclosure: true,
    },
  });
  if (st.status !== 201 && st.status !== 200) {
    // 可能已存在（重复跑），忽略
  }
  const g = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: { name: '普通用户', spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120 },
  });
  return { strategy: st.json?.item, group: g.json?.item };
}

// ============ 1. admin 登录 → GET /api/admin/user-source 默认 supabase ============
{
  const al = await adminLogin();
  check('1a. 管理员登录 200 并拿到 admin cookie', al.status === 200 && !!jar.admin,
    `status=${al.status} cookie=${jar.admin ? 'yes' : 'no'}`);

  const r = await req('GET', '/api/admin/user-source', { cookie: jar.admin });
  check('1b. 默认 userSource=supabase', r.status === 200 && r.json?.userSource === 'supabase',
    `status=${r.status} source=${r.json?.userSource}`);
  check('1c. 返回 default/storage/counts/switchedAt 字段齐全',
    r.json?.default === 'supabase' &&
    r.json?.storage?.table === 'settings' && r.json?.storage?.key === 'userSource' &&
    typeof r.json?.counts?.total === 'number' && typeof r.json?.counts?.localAccounts === 'number' &&
    r.json?.switchedAt === null,
    `body=${JSON.stringify(r.json)}`);
}

// ============ 2. PUT 切到 volume；setup/status 未配 Supabase 时 next 不再是 supabase ============
{
  const bad = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'volume' },
  });
  check('2a. 缺 confirm → 400 invalid_input (field=confirm)',
    bad.status === 400 && bad.json?.error?.code === 'invalid_input' && bad.json?.error?.details?.field === 'confirm',
    `status=${bad.status} code=${bad.json?.error?.code} field=${bad.json?.error?.details?.field}`);

  const badSrc = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'wechat', confirm: true },
  });
  check('2b. source 非法 → 400 invalid_input (field=source)',
    badSrc.status === 400 && badSrc.json?.error?.code === 'invalid_input' && badSrc.json?.error?.details?.field === 'source',
    `status=${badSrc.status} code=${badSrc.json?.error?.code} field=${badSrc.json?.error?.details?.field}`);

  const sw = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'volume', confirm: true },
  });
  check('2c. 切到 volume 200 ok:true',
    sw.status === 200 && sw.json?.ok === true && sw.json?.switchedFrom === 'supabase' && sw.json?.switchedTo === 'volume',
    `status=${sw.status} body=${JSON.stringify(sw.json)}`);

  const st = await req('GET', '/api/setup/status');
  check('2d. volume 模式 next 不再是 supabase',
    st.status === 200 && st.json?.next !== 'supabase' && st.json?.userSource === 'volume',
    `next=${st.json?.next} userSource=${st.json?.userSource}`);
  check('2e. checks.supabase=true 且 supabaseRequired=false，hint 不含 Supabase',
    st.json?.checks?.supabase === true && st.json?.checks?.supabaseRequired === false &&
    !String(st.json?.hint || '').includes('Supabase'),
    `checks=${JSON.stringify(st.json?.checks)} hint=${st.json?.hint}`);

  await ensureBaseSetup();
}

// ============ 3. volume 模式建本地号 → 登录 200 → /api/me 200 ============
const ALICE = 'alice-p6@x.com';
const ALICE_PW = 'secret123';
{
  const created = await req('POST', '/api/admin/users', {
    cookie: jar.admin,
    body: { email: ALICE, password: ALICE_PW, displayName: 'Alice P6' },
  });
  check('3a. 本地建号 201，source=local status=active',
    created.status === 201 && created.json?.item?.source === 'local' &&
    created.json?.item?.status === 'active' && !!created.json?.item?.registeredAt,
    `status=${created.status} item=${JSON.stringify(created.json?.item)}`);

  const login = await req('POST', '/api/auth/login', { body: { email: ALICE, password: ALICE_PW } });
  jar.alice = cookieStr(login.set);
  check('3b. 本地密码正确登录 200', login.status === 200 && login.json?.ok === true,
    `status=${login.status} email=${login.json?.user?.email}`);

  const me = await req('GET', '/api/me', { cookie: jar.alice });
  check('3c. /api/me 200，会话 local', me.status === 200 && me.json?.user?.email === ALICE,
    `status=${me.status} email=${me.json?.user?.email}`);
}

// ============ 4. 密码错误 / 账号不存在 → 对外完全一致（status+code+message 逐字节）============
{
  const badPw = await req('POST', '/api/auth/login', { body: { email: ALICE, password: 'wrong-pass' } });
  const noUser = await req('POST', '/api/auth/login', { body: { email: 'ghost-p6@x.com', password: 'whatever1' } });
  check('4a. 密码错误 401 invalid_credentials',
    badPw.status === 401 && badPw.json?.error?.code === 'invalid_credentials',
    `status=${badPw.status} code=${badPw.json?.error?.code}`);
  check('4b. 不存在邮箱 401 invalid_credentials',
    noUser.status === 401 && noUser.json?.error?.code === 'invalid_credentials',
    `status=${noUser.status} code=${noUser.json?.error?.code}`);
  check('4c. 两者 status / code / message 完全一致（逐字节比对 message）',
    badPw.status === noUser.status &&
    badPw.json?.error?.code === noUser.json?.error?.code &&
    badPw.json?.error?.message === noUser.json?.error?.message &&
    badPw.text === noUser.text,
    `pw.message=${badPw.json?.error?.message} ghost.message=${noUser.json?.error?.message} sameText=${badPw.text === noUser.text}`);
}

// ============ 5. 封禁 → 既有 cookie 立刻 403；重新登录 403 ============
let aliceId = null;
{
  const list = await req('GET', '/api/admin/users', { cookie: jar.admin, q: ALICE });
  aliceId = list.json?.items?.[0]?.id;
  check('5a. 列表项含 status/registeredAt/lastLoginAt/source',
    !!aliceId && list.json.items[0].status === 'active' &&
    !!list.json.items[0].registeredAt && list.json.items[0].source === 'local' &&
    !!list.json.items[0].lastLoginAt,
    `item=${JSON.stringify(list.json?.items?.[0])}`);

  const ban = await req('PATCH', `/api/admin/users/${aliceId}`, {
    cookie: jar.admin, body: { status: 'banned' },
  });
  check('5b. PATCH status=banned 200，disabled 同步为 true',
    ban.status === 200 && ban.json?.item?.status === 'banned' && ban.json?.item?.disabled === true,
    `status=${ban.status} item=${JSON.stringify(ban.json?.item)}`);

  const me = await req('GET', '/api/me', { cookie: jar.alice });
  check('5c. 既有 cookie 立刻 /api/me 403 account_banned',
    me.status === 403 && me.json?.error?.code === 'account_banned',
    `status=${me.status} code=${me.json?.error?.code}`);

  const relogin = await req('POST', '/api/auth/login', { body: { email: ALICE, password: ALICE_PW } });
  check('5d. 封禁后重新登录 403 account_banned',
    relogin.status === 403 && relogin.json?.error?.code === 'account_banned',
    `status=${relogin.status} code=${relogin.json?.error?.code}`);
}

// ============ 6. 解封 → 登录恢复 200 ============
{
  const unban = await req('PATCH', `/api/admin/users/${aliceId}`, {
    cookie: jar.admin, body: { status: 'active' },
  });
  check('6a. 解封 200 status=active',
    unban.status === 200 && unban.json?.item?.status === 'active',
    `status=${unban.status} item=${JSON.stringify(unban.json?.item)}`);

  const login = await req('POST', '/api/auth/login', { body: { email: ALICE, password: ALICE_PW } });
  jar.alice = cookieStr(login.set);
  check('6b. 解封后登录恢复 200', login.status === 200, `status=${login.status}`);
}

// ============ 7. 改密：旧密码 401、新密码 200；supabase 模式该接口 409 ============
{
  const NEW_PW = 'newpass456';
  const pw = await req('POST', `/api/admin/users/${aliceId}/password`, {
    cookie: jar.admin, body: { password: NEW_PW },
  });
  check('7a. 管理员改密 200', pw.status === 200 && pw.json?.ok === true,
    `status=${pw.status} body=${JSON.stringify(pw.json)}`);

  const old = await req('POST', '/api/auth/login', { body: { email: ALICE, password: ALICE_PW } });
  check('7b. 旧密码 401 invalid_credentials',
    old.status === 401 && old.json?.error?.code === 'invalid_credentials',
    `status=${old.status} code=${old.json?.error?.code}`);

  const nw = await req('POST', '/api/auth/login', { body: { email: ALICE, password: NEW_PW } });
  jar.alice = cookieStr(nw.set);
  check('7c. 新密码登录 200', nw.status === 200, `status=${nw.status}`);

  // 切回 supabase 模式：本地账号在 Supabase 侧不存在，改密接口应 409 not_supported_in_source
  const sw = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'supabase', confirm: true },
  });
  check('7d. 切回 supabase 200', sw.status === 200 && sw.json?.switchedTo === 'supabase',
    `status=${sw.status} body=${JSON.stringify(sw.json)}`);

  const pwSb = await req('POST', `/api/admin/users/${aliceId}/password`, {
    cookie: jar.admin, body: { password: 'another789' },
  });
  check('7e. supabase 模式（本地账号无 passwordHash 视为外部账号）改密 409 not_supported_in_source',
    pwSb.status === 409 && pwSb.json?.error?.code === 'not_supported_in_source',
    `status=${pwSb.status} code=${pwSb.json?.error?.code} msg=${pwSb.json?.error?.message}`);

  // 切回 volume，继续删号流程
  await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'volume', confirm: true },
  });
}

// ============ 8. 删号：deleteFiles=0 后 /api/me 401/403；deleteFiles=1 清节点与物理目录，他人文件不受影响 ============
const BOB = 'bob-p6@x.com';
{
  // 再造一个 bob，上传一个文件，验证删 alice 不影响 bob
  await req('POST', '/api/admin/users', {
    cookie: jar.admin, body: { email: BOB, password: 'bobpass123', displayName: 'Bob P6' },
  });
  const bobLogin = await req('POST', '/api/auth/login', { body: { email: BOB, password: 'bobpass123' } });
  jar.bob = cookieStr(bobLogin.set);

  // alice 上传一个文件
  const payload = new TextEncoder().encode('alice p6 file\n');
  let fd = new FormData(); fd.append('file', new Blob([payload], { type: 'text/plain' }), 'alice.txt');
  const upA = await req('POST', '/api/files/upload?path=' + encodeURIComponent(ALICE), {
    cookie: jar.alice, raw: { body: fd, headers: {} },
  });
  check('8a. alice 上传文件 201', upA.status === 201, `status=${upA.status} size=${upA.json?.item?.sizeBytes}`);

  // bob 上传一个文件
  fd = new FormData(); fd.append('file', new Blob([payload], { type: 'text/plain' }), 'bob.txt');
  const upB = await req('POST', '/api/files/upload?path=' + encodeURIComponent(BOB), {
    cookie: jar.bob, raw: { body: fd, headers: {} },
  });
  check('8b. bob 上传文件 201', upB.status === 201, `status=${upB.status} size=${upB.json?.item?.sizeBytes}`);

  // 8c. deleteFiles=0 仅删账号，保留文件节点
  const del0 = await req('DELETE', `/api/admin/users/${aliceId}?deleteFiles=0`, { cookie: jar.admin });
  check('8c1. deleteFiles=0 删号 200，detail files:kept',
    del0.status === 200 && del0.json?.ok === true && del0.json?.deletedFiles?.nodes === 0,
    `status=${del0.status} body=${JSON.stringify(del0.json)}`);
  check('8c2. 删号后既有 cookie /api/me 401/403（不 500）',
    [401, 403].includes((await req('GET', '/api/me', { cookie: jar.alice })).status),
    `status=${(await req('GET', '/api/me', { cookie: jar.alice })).status}`);

  // alice 的文件节点仍在（deleteFiles=0 保留）；重建 alice 再测 deleteFiles=1
  const recreate = await req('POST', '/api/admin/users', {
    cookie: jar.admin, body: { email: ALICE, password: 'rebuilt123', displayName: 'Alice Rebuilt' },
  });
  aliceId = recreate.json?.item?.id;
  const relog = await req('POST', '/api/auth/login', { body: { email: ALICE, password: 'rebuilt123' } });
  jar.alice = cookieStr(relog.set);

  // 再补一个 alice 文件，确保有可删物理对象
  fd = new FormData(); fd.append('file', new Blob([payload], { type: 'text/plain' }), 'alice2.txt');
  await req('POST', '/api/files/upload?path=' + encodeURIComponent(ALICE), {
    cookie: jar.alice, raw: { body: fd, headers: {} },
  });

  const del1 = await req('DELETE', `/api/admin/users/${aliceId}?deleteFiles=1`, { cookie: jar.admin });
  check('8d1. deleteFiles=1 删号 200，返回 deletedFiles.nodes/bytes',
    del1.status === 200 && del1.json?.ok === true &&
    Number(del1.json?.deletedFiles?.nodes) >= 1 && Number(del1.json?.deletedFiles?.bytes) >= 0,
    `status=${del1.status} body=${JSON.stringify(del1.json)}`);

  const meAfter = await req('GET', '/api/me', { cookie: jar.alice });
  check('8d2. 删号后既有 cookie /api/me 401/403（不 500）',
    [401, 403].includes(meAfter.status), `status=${meAfter.status} code=${meAfter.json?.error?.code}`);

  const bobDl = await req('GET', '/api/files/download?path=' + encodeURIComponent(`${BOB}/bob.txt`), { cookie: jar.bob });
  check('8e. bob 的文件仍可下载，未受 alice 删号影响',
    bobDl.status === 200 && bobDl.text.includes('alice p6 file'),
    `status=${bobDl.status} bytes=${bobDl.text.length}`);
}

// ============ 9. 列表项字段（含登录后 lastLoginAt 非空）============
{
  const list = await req('GET', '/api/admin/users', { cookie: jar.admin, q: BOB });
  const item = list.json?.items?.[0];
  check('9. 列表项含 status/registeredAt/lastLoginAt/source，有登录时 lastLoginAt 非空',
    !!item && item.status === 'active' && !!item.registeredAt &&
    !!item.lastLoginAt && item.source === 'local',
    `item=${JSON.stringify(item)}`);
}

// ============ 10. 审计表原始动作名可检索 ============
{
  const actions = ['user_source_switch', 'user_create', 'user_ban', 'user_unban', 'user_password', 'user_delete'];
  for (const action of actions) {
    const r = await req('GET', `/api/admin/audit?action=${action}&pageSize=50`, { cookie: jar.admin });
    const hit = (r.json?.items || []).some((i) => i.action === action);
    check(`10. 审计动作 ${action} 可命中`, r.status === 200 && hit,
      `status=${r.status} total=${r.json?.total} actions=${(r.json?.items || []).map((i) => i.action).join(',')}`);
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
