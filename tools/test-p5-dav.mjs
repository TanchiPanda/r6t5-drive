// P5 WebDAV + 应用密码 自测。
// 用法：
//   1) 服务已起（8107）：BASE=http://127.0.0.1:8107 node tools/test-p5-dav.mjs
//   2) 若 /api/account/app-passwords 或 /dav 尚未在 server/app.js 挂载（404），
//      本脚本会自建一个临时 express 实例把两个 router 挂上，端口 8107，
//      此时报告里标注「待挂载」。
// 退出码：全部 PASS → 0；任一 FAIL → 1。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8107';
const PORT = Number(process.env.PORT || 8107);
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

function basic(email, password) {
  if (password == null) return undefined;
  return 'Basic ' + Buffer.from(`${email}:${password}`).toString('base64');
}

async function req(method, url, { body, cookie, auth, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  const binary = raw?.isBinary ? raw.body : body;
  // FormData 必须由 fetch 自动生成 multipart boundary；先清掉可能继承的 JSON Content-Type
  if (binary instanceof FormData) delete opts.headers['Content-Type'];
  if (cookie) opts.headers.Cookie = cookie;
  if (auth) opts.headers.Authorization = auth;
  if (binary !== undefined) {
    if (binary instanceof FormData) {
      opts.body = binary; // 浏览器/Node 自动带 multipart boundary，不手动设 Content-Type
    } else if (raw?.isBinary) {
      opts.headers['Content-Type'] = headers['Content-Type'] || 'application/octet-stream';
      opts.body = binary instanceof Uint8Array ? binary : new Uint8Array(binary);
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(binary);
    }
  }
  const res = await fetch(BASE + url, opts);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { json = null; } }
  const setCookieArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setCookieArr) Object.assign(set, parseCookies(c));
  return {
    status: res.status, json, text: buf.toString('utf8'), bytes: buf, set,
    headers: res.headers,
  };
}

// ---------- 探测主服务挂载状态 ----------
let mainUp = false;
let mounted = false;
try {
  const probe = await req('GET', '/api/me');
  mainUp = probe.status === 200 || probe.status === 401;
  const probeDav = await req('OPTIONS', '/dav');
  mounted = probeDav.status === 200 && /DAV/i.test(probeDav.headers.get('dav') || '');
  console.log(`[mount] 主服务=${mainUp}  /dav mounted=${mounted}  probeDav=${probeDav.status}`);
} catch (e) {
  console.log(`[mount] 探测主服务失败：${e.message}`);
  mainUp = false;
}

// 若主服务未挂载 /dav 或未启动，自建临时 express 挂两个 router
let tempServer = null;
let selfMounted = false;
if (!mounted) {
  console.log('[mount] 主服务尚未挂载 /dav（或服务未起），启动临时 express 挂载两个 router …');
  process.env.PORT = String(PORT);
  process.env.DB_PATH = process.env.DB_PATH || '/tmp/p5a/r6t5.db';
  process.env.STORAGE_ROOT = process.env.STORAGE_ROOT || '/tmp/p5a/volume';
  process.env.DEV_AUTH = '1';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';
  fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
  fs.mkdirSync(process.env.STORAGE_ROOT, { recursive: true });

  const { migrate, db, getSetting, setSetting } = await import('../server/db.js');
  migrate();
  // 播种管理员密码（对齐 index.js bootstrapAdmin；临时实例直接走环境变量）
  if (!getSetting('admin_password_hash')) {
    const { hashPassword } = await import('../server/lib/session.js');
    setSetting('admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD || 'test123'));
    setSetting('admin_password_source', 'env');
  }
  // 播种默认用户组（对齐 index.js 首启行为）
  if (db.prepare('SELECT COUNT(*) AS n FROM groups').get().n === 0) {
    const { DEFAULTS } = await import('../server/config.js');
    const { genId, nowIso } = await import('../server/lib/format.js');
    db.prepare(
      `INSERT INTO groups (id, name, spaceLimitBytes, maxFileSizeBytes, traffic7dLimitBytes, isDefault, createdAt)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    ).run(genId('g'), '标准用户', Number(DEFAULTS.spaceLimitBytes), Number(DEFAULTS.maxFileSizeBytes), Number(DEFAULTS.traffic7dLimitBytes), nowIso());
  }

  const express = (await import('express')).default;
  const app = express();
  // 注意：不在全局挂 express.json，避免把 WebDAV PUT 的二进制流当 JSON 吞掉；
  // 各 JSON 接口在各自路由内按需解析（与主 app.js 一致：/dav 必须先于 JSON 解析挂载）。
  const jsonBody = express.json({ limit: '2mb' });

  // 复用主服务已有的 auth / admin 路由，便于造数据
  const authRouter = (await import('../server/routes/auth.js')).default;
  const meRouter = (await import('../server/routes/auth.js')).meRouter;
  const adminAuthRouter = (await import('../server/routes/admin-auth.js')).default;
  const adminStorageRouter = (await import('../server/routes/admin-storage.js')).default;
  const adminBindingsRouter = (await import('../server/routes/admin-bindings.js')).default;
  const adminGroupsRouter = (await import('../server/routes/admin-groups.js')).default;
  const filesRouter = (await import('../server/routes/files.js')).default;
  const requireUser = (await import('../server/middleware/auth.js')).requireUser;

  app.use('/api/auth', jsonBody, authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/admin', jsonBody, adminAuthRouter);

  const adminApi = express.Router();
  const requireAdminApi = (await import('../server/middleware/auth.js')).requireAdminApi;
  adminApi.use(requireAdminApi);
  adminApi.use('/storage', jsonBody, adminStorageRouter);
  adminApi.use('/bindings', jsonBody, adminBindingsRouter);
  adminApi.use('/groups', jsonBody, adminGroupsRouter);
  app.use('/api/admin', adminApi);

  app.use('/api/files', requireUser, jsonBody, filesRouter);

  // 本任务新增：应用密码管理（会话守卫由挂载方套）
  const appPwRouter = (await import('../server/routes/apppasswords.js')).default;
  app.use('/api/account/app-passwords', requireUser, jsonBody, appPwRouter);

  // 本任务新增：WebDAV（不套 requireUser，仅 Basic Auth）
  const davRouter = (await import('../server/routes/dav.js')).default;
  app.use('/dav', davRouter);

  // 错误处理（对齐主 app.js）
  const { errorBody, ApiError } = await import('../server/lib/errors.js');
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json(errorBody(err));
    if (err?.status && err?.code) return res.status(err.status).json(errorBody(new ApiError(err.status, err.code, err.message, err.details)));
    console.error('[error]', err);
    res.status(500).json(errorBody(new ApiError(500, 'internal_error', '内部错误')));
  });

  await new Promise((resolve) => { tempServer = app.listen(PORT, '127.0.0.1', resolve); });
  selfMounted = true;
  console.log(`[mount] 临时 express 已起：http://127.0.0.1:${PORT}（待主服务挂载后此分支可移除）`);
}

const EMAIL = 'alice@p5.test';

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { body: { password: process.env.ADMIN_PASSWORD || 'test123' } });
  const jar = Object.entries(r.set).map(([k, v]) => `${k}=${v}`).join('; ');
  return { status: r.status, jar };
}

async function ensureVolumeStrategy(adminJar) {
  // 列出已有 volume 策略；没有就建一条（site 默认由站点默认兜底）
  const list = await req('GET', '/api/admin/storage', { cookie: adminJar });
  const vol = list.json?.items?.find((s) => s.type === 'volume' && s.enabled);
  if (vol) return vol;
  const created = await req('POST', '/api/admin/storage', {
    cookie: adminJar,
    body: {
      type: 'volume', name: '本地卷', region: '本机', capacityBytes: 107374182400,
      acknowledgeDisclosure: true, config: { rootPath: process.env.STORAGE_ROOT || 'data/volume' },
    },
  });
  return created.json?.item;
}

async function devLogin() {
  const r = await req('POST', '/api/auth/dev-login', { body: { email: EMAIL } });
  const jar = Object.entries(r.set).map(([k, v]) => `${k}=${v}`).join('; ');
  return { status: r.status, jar, json: r.json };
}

// ================= 主流程 =================
let adminJar = '';
let userJar = '';
let appPw = '';
let appPwId = '';

try {
  // 1) admin 登录 + 建 volume 策略 + 绑站点根
  const admin = await adminLogin();
  adminJar = admin.jar;
  check('admin. 登录 200', admin.status === 200, `status=${admin.status}`);

  const vol = await ensureVolumeStrategy(adminJar);
  check('admin. volume 策略就绪', !!vol?.id, `strategy=${vol?.id} type=${vol?.type}`);

  // 站点根绑定 volume（幂等：已存在则 409 视为命中）
  const bind = await req('POST', '/api/admin/bindings', {
    cookie: adminJar,
    body: { strategyId: vol.id, scope: 'site', subPath: '' },
  });
  check('admin. 站点根绑定 volume（已存在则 409 幂等）', bind.status === 201 || bind.status === 409, `status=${bind.status}`);

  // 2) dev-login alice，建目录 inbox + 上传 note.txt
  const alice = await devLogin();
  userJar = alice.jar;
  check('user. dev-login alice 200', alice.status === 200, `status=${alice.status} email=${alice.json?.user?.email}`);

  const mk = await req('POST', '/api/files/folder', { cookie: userJar, body: { path: EMAIL, name: 'inbox' } });
  check('user. 建目录 inbox 201（已存在则 409 幂等）', mk.status === 201 || mk.status === 409, `status=${mk.status} body=${mk.text.slice(0, 120)}`);

  const noteContent = 'hello-p5-dav-' + crypto.randomBytes(6).toString('hex');
  const fd = new FormData();
  fd.append('file', new File([noteContent], 'note.txt', { type: 'text/plain' }));
  fd.append('overwrite', '1');
  const upRes = await fetch(BASE + `/api/files/upload?path=${encodeURIComponent(`${EMAIL}/inbox`)}`, { method: 'POST', headers: { Cookie: userJar }, body: fd });
  const upText = await upRes.text();
  const up = { status: upRes.status, text: upText, headers: upRes.headers, json: null };
  try { up.json = JSON.parse(upText); } catch {}
  check('user. 上传 note.txt 201', up.status === 201, `status=${up.status} body=${up.text.slice(0, 120)} size=${up.json?.item?.sizeBytes}`);

  // ================= 应用密码 =================
  const create = await req('POST', '/api/account/app-passwords', { cookie: userJar, body: { name: 'dav-laptop' } });
  appPw = create.json?.password;
  appPwId = create.json?.item?.id;
  check('APP. 创建应用密码 201', create.status === 201 && !!appPw && !!appPwId,
    `status=${create.status} id=${appPwId} pwPattern=${/^r6t5-[a-z0-9]{6}-[a-z0-9]{6}-[a-z0-9]{6}$/.test(appPw || '')}`);

  const list1 = await req('GET', '/api/account/app-passwords', { cookie: userJar });
  const listText = list1.text;
  const leaked = list1.json?.items?.some((i) => 'password' in i || 'hash' in i || 'salt' in i);
  check('APP. GET 列表不含 password/hash/salt', list1.status === 200 && !leaked && !listText.includes(appPw || ''),
    `status=${list1.status} keys=${list1.json?.items?.[0] ? Object.keys(list1.json.items[0]).join(',') : '-'}`);

  // ================= 鉴权 =================
  const optNoCred = await req('OPTIONS', '/dav');
  check('DAV. 无凭据 OPTIONS 401 且带 WWW-Authenticate',
    optNoCred.status === 401 && /^Basic\s+realm="r6t5-drive"/i.test(optNoCred.headers.get('www-authenticate') || ''),
    `status=${optNoCred.status} wwW=${optNoCred.headers.get('www-authenticate')}`);

  const optBad = await req('OPTIONS', '/dav', { auth: basic(EMAIL, 'wrong-password-0000') });
  check('DAV. 错密码 401', optBad.status === 401, `status=${optBad.status}`);

  const opt = await req('OPTIONS', '/dav', { auth: basic(EMAIL, appPw) });
  check('DAV. OPTIONS /dav 200 DAV:1 Allow 含 PROPFIND/PUT/MOVE',
    opt.status === 200 && opt.headers.get('dav') === '1' &&
    /PROPFIND/.test(opt.headers.get('allow') || '') && /PUT/.test(opt.headers.get('allow') || '') && /MOVE/.test(opt.headers.get('allow') || ''),
    `status=${opt.status} DAV=${opt.headers.get('dav')} Allow=${opt.headers.get('allow')} MS=${opt.headers.get('ms-author-via')}`);

  const optSub = await req('OPTIONS', '/dav/inbox', { auth: basic(EMAIL, appPw) });
  check('DAV. OPTIONS /dav/<path> 200', optSub.status === 200, `status=${optSub.status}`);

  // ================= PROPFIND =================
  const pf0 = await req('PROPFIND', '/dav', { auth: basic(EMAIL, appPw), headers: { Depth: '0' } });
  check('DAV. PROPFIND /dav Depth 0 → 207 且为目录',
    pf0.status === 207 && pf0.text.includes('<D:collection/>') && pf0.headers.get('content-type')?.includes('xml'),
    `status=${pf0.status} ct=${pf0.headers.get('content-type')} depth=${pf0.headers.get('depth')}`);

  const pf1 = await req('PROPFIND', '/dav', { auth: basic(EMAIL, appPw), headers: { Depth: '1' } });
  check('DAV. PROPFIND /dav Depth 1 含 inbox',
    pf1.status === 207 && pf1.text.includes('/dav/inbox'),
    `status=${pf1.status} hrefs=${(pf1.text.match(/<D:href>[^<]+<\/D:href>/g) || []).join(' ')}`);
  // Email 只允许出现在 displayname 之外的 href 里；href 不得含 email 段
  const hrefsRoot = (pf1.text.match(/<D:href>([^<]+)<\/D:href>/g) || []).join(' ');
  check('DAV. PROPFIND XML href 不暴露 Email 段', !hrefsRoot.includes(EMAIL), `hrefs=${hrefsRoot}`);

  // Depth 1 只列直接子级；note.txt 在 inbox 下，再对 inbox 做一次 Depth 1
  const pfInbox = await req('PROPFIND', '/dav/inbox', { auth: basic(EMAIL, appPw), headers: { Depth: '1' } });
  check('DAV. PROPFIND /dav/inbox Depth 1 含 note.txt',
    pfInbox.status === 207 && pfInbox.text.includes('/dav/inbox/note.txt'),
    `status=${pfInbox.status} hrefs=${(pfInbox.text.match(/<D:href>[^<]+<\/D:href>/g) || []).join(' ')}`);

  const pfMiss = await req('PROPFIND', '/dav/no-such-dir', { auth: basic(EMAIL, appPw), headers: { Depth: '1' } });
  check('DAV. PROPFIND 不存在路径 404', pfMiss.status === 404, `status=${pfMiss.status}`);

  // ================= GET / HEAD =================
  const get = await req('GET', '/dav/inbox/note.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. GET note.txt 200 内容一致', get.status === 200 && get.text === noteContent,
    `status=${get.status} bytes=${get.bytes.length} expect=${Buffer.byteLength(noteContent)}`);

  const head = await req('HEAD', '/dav/inbox/note.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. HEAD 无 body 有 Content-Length',
    head.status === 200 && head.bytes.length === 0 && Number(head.headers.get('content-length')) === Buffer.byteLength(noteContent),
    `status=${head.status} len=${head.headers.get('content-length')} body=${head.bytes.length}`);

  const getMiss = await req('GET', '/dav/no-such-file.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. GET 不存在 404', getMiss.status === 404, `status=${getMiss.status}`);

  // ================= PUT =================
  const bigBody = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MB
  const putBig = await req('PUT', '/dav/inbox/up.txt', {
    auth: basic(EMAIL, appPw), raw: { body: bigBody, isBinary: true },
    headers: { 'Content-Type': 'text/plain' },
  });
  check('DAV. PUT 2MB 到 inbox/up.txt 201/204',
    [201, 204].includes(putBig.status), `status=${putBig.status}`);

  const listAfter = await req('GET', `/api/files?path=${encodeURIComponent(`${EMAIL}/inbox`)}`, { cookie: userJar });
  const upSeen = listAfter.json?.items?.some((i) => i.name === 'up.txt' && Number(i.sizeBytes) === bigBody.length);
  check('DAV. PUT 后用户文件列表可见 up.txt(2MB)', !!upSeen, `items=${(listAfter.json?.items || []).map((i) => `${i.name}:${i.sizeBytes}`).join(',')}`);

  const putNoParent = await req('PUT', '/dav/missing-dir/x.txt', {
    auth: basic(EMAIL, appPw), raw: { body: Buffer.from('x'), isBinary: true },
  });
  check('DAV. PUT 到不存在父目录 409 conflict',
    putNoParent.status === 409, `status=${putNoParent.status}`);

  // ================= MKCOL =================
  const mkcol = await req('MKCOL', '/dav/newdir', { auth: basic(EMAIL, appPw) });
  check('DAV. MKCOL /dav/newdir 201', mkcol.status === 201, `status=${mkcol.status}`);
  const mkcolAgain = await req('MKCOL', '/dav/newdir', { auth: basic(EMAIL, appPw) });
  check('DAV. MKCOL 重复 405', mkcolAgain.status === 405, `status=${mkcolAgain.status}`);
  const mkcolNoParent = await req('MKCOL', '/dav/ghost/a', { auth: basic(EMAIL, appPw) });
  check('DAV. MKCOL 父目录不存在 409', mkcolNoParent.status === 409, `status=${mkcolNoParent.status}`);

  // ================= MOVE（绝对 URL Destination） =================
  const destAbs = `${BASE}/dav/newdir/up.txt`;
  const move = await req('MOVE', '/dav/inbox/up.txt', {
    auth: basic(EMAIL, appPw),
    headers: { Destination: destAbs, Overwrite: 'T' },
  });
  check('DAV. MOVE（绝对 URL Destination）201/204',
    [201, 204].includes(move.status), `status=${move.status} dest=${destAbs}`);
  const oldGone = await req('GET', '/dav/inbox/up.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. MOVE 后旧路径 404', oldGone.status === 404, `status=${oldGone.status}`);
  const movedBack = await req('GET', '/dav/newdir/up.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. MOVE 后新路径可读 200', movedBack.status === 200 && movedBack.bytes.length === bigBody.length,
    `status=${movedBack.status} bytes=${movedBack.bytes.length}`);

  // MOVE Overwrite=F 且目标存在 → 412
  await req('PUT', '/dav/newdir/up.txt', { auth: basic(EMAIL, appPw), raw: { body: Buffer.from('second'), isBinary: true } });
  const moveNoOverwrite = await req('MOVE', '/dav/inbox/note.txt', {
    auth: basic(EMAIL, appPw), headers: { Destination: `${BASE}/dav/newdir/up.txt`, Overwrite: 'F' },
  });
  check('DAV. MOVE Overwrite=F 且目标存在 412', moveNoOverwrite.status === 412, `status=${moveNoOverwrite.status}`);

  // ================= DELETE =================
  const del = await req('DELETE', '/dav/newdir/up.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. DELETE 文件 204', del.status === 204, `status=${del.status}`);
  const delGet = await req('GET', '/dav/newdir/up.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. DELETE 后再 GET 404', delGet.status === 404, `status=${delGet.status}`);
  const delMiss = await req('DELETE', '/dav/no-such.txt', { auth: basic(EMAIL, appPw) });
  check('DAV. DELETE 不存在 404', delMiss.status === 404, `status=${delMiss.status}`);

  // ================= 只读策略（github 绑定 archive） =================
  // 建一个 github 类型策略（只读驱动），再 user 级绑定 archive 子路径
  const gh = await req('POST', '/api/admin/storage', {
    cookie: adminJar,
    body: {
      type: 'github', name: '只读归档', region: 'repo', capacityBytes: 107374182400,
      acknowledgeDisclosure: true, config: { repo: 'tanchipanda/r6t5-drive', branch: 'main', rootPath: 'drive' },
    },
  });
  const ghStrategy = gh.json?.item;
  check('admin. github(只读) 策略就绪', !!ghStrategy?.id && ghStrategy.readOnly === true,
    `status=${gh.status} id=${ghStrategy?.id} readOnly=${ghStrategy?.readOnly}`);

  if (ghStrategy?.id) {
    const bindGh = await req('POST', '/api/admin/bindings', {
      cookie: adminJar,
      body: { strategyId: ghStrategy.id, scope: 'user', email: EMAIL, subPath: 'archive' },
    });
    check('admin. 绑定 archive → 只读策略（已存在则 409 幂等）',
      bindGh.status === 201 || bindGh.status === 409, `status=${bindGh.status}`);

    const putRo = await req('PUT', '/dav/archive/x.txt', {
      auth: basic(EMAIL, appPw), raw: { body: Buffer.from('ro'), isBinary: true },
    });
    check('DAV. 只读策略下 PUT 403 strategy_readonly',
      putRo.status === 403 && /strategy_readonly/.test(putRo.text),
      `status=${putRo.status} body=${putRo.text.slice(0, 80)}`);
  } else {
    check('DAV. 只读策略下 PUT 403 strategy_readonly', false, 'github 策略未建成，跳过');
  }

  // ================= 越界路径 =================
  // 说明：Node fetch 在发出请求前会把 ../ 与 %2e%2e 规范化掉，服务端收到的已是 /evil.txt；
  // 这里断言越界尝试不会在用户根外落盘（400/403/404 均可接受，禁止 2xx 落盘）。
  // 服务端在 dav 路由中间件对解码后含 .. 段的请求返回 403，由 normalizeLogicalPath 二次兜底。
  const evilPhys = path.join(process.env.STORAGE_ROOT || 'data/volume', 'evil.txt');
  const esc = await req('PUT', '/dav/%2e%2e/evil.txt', {
    auth: basic(EMAIL, appPw), raw: { body: Buffer.from('evil'), isBinary: true },
  });
  check('DAV. 越界 %2e%2e/evil.txt 不落盘（400/403/404，禁止 2xx）',
    ![200, 201, 204].includes(esc.status) && !fs.existsSync(evilPhys),
    `status=${esc.status} evilExists=${fs.existsSync(evilPhys)}`);
  const escRaw = await req('PUT', '/dav/../evil.txt', {
    auth: basic(EMAIL, appPw), raw: { body: Buffer.from('evil'), isBinary: true },
  });
  check('DAV. 越界 ../evil.txt 不落盘（400/403/404，禁止 2xx）',
    ![200, 201, 204].includes(escRaw.status) && !fs.existsSync(evilPhys),
    `status=${escRaw.status} evilExists=${fs.existsSync(evilPhys)}`);

  // ================= 未支持方法 405（撤销密码前，先带有效凭据测） =================
  const postDav = await req('POST', '/dav', { auth: basic(EMAIL, appPw) });
  check('DAV. POST /dav → 405 且 Allow 正确',
    postDav.status === 405 && /PROPFIND/.test(postDav.headers.get('allow') || '') && /PUT/.test(postDav.headers.get('allow') || ''),
    `status=${postDav.status} Allow=${postDav.headers.get('allow')}`);

  const proppatch = await req('PROPPATCH', '/dav', { auth: basic(EMAIL, appPw) });
  check('DAV. PROPPATCH → 405', proppatch.status === 405, `status=${proppatch.status}`);

  // ================= 撤销应用密码 =================
  const revoke = await req('DELETE', `/api/account/app-passwords/${appPwId}`, { cookie: userJar });
  check('APP. DELETE 撤销应用密码 ok=true', revoke.status === 200 && revoke.json?.ok === true, `status=${revoke.status}`);
  const afterRevoke = await req('PROPFIND', '/dav', { auth: basic(EMAIL, appPw), headers: { Depth: '0' } });
  check('APP. 撤销后再访问 401', afterRevoke.status === 401, `status=${afterRevoke.status}`);
} catch (e) {
  console.error('[fatal]', e);
  results.push({ name: 'fatal', ok: false, detail: e.stack || e.message });
}

// ---------- 汇总 ----------
const fail = results.filter((r) => !r.ok);
console.log('\n===== 汇总 =====');
console.log(`PASS=${results.length - fail.length}  FAIL=${fail.length}  总计=${results.length}`);
if (selfMounted) console.log('[mount] 说明：本次由自测脚本自建临时 express 挂载，主服务 app.js 仍需正式挂载（待挂载）。');
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('ALL PASS');

if (tempServer) tempServer.close();
