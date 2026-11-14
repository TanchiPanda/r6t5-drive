// P5 可选集成自测：aria2 离线下载 + OnlyOffice 在线编辑。
//
// 两种运行方式：
//   1) 直连已启动的主服务：P5_BASE=http://127.0.0.1:8109 node tools/test-p5-integrations.mjs
//      （主服务需已按当前阶段配好环境变量；本脚本不负责重启外部服务）。
//   2) 自测编排（默认）：脚本自己 spawn 临时 express 子进程，按阶段切换环境变量并重启，
//      覆盖「未配置 / 配置但不可达 / 配置且可用」三态。临时挂载注明「待主服务挂载」。
//
// 覆盖：
//   - 未配置：POST /api/downloads 503 integration_not_configured；GET /api/downloads 200 configured:false；
//     office-config 200 enabled:false；status 两项 configured:false。
//   - 假 aria2 可用：status reachable:true；POST 201；GET 透传；DELETE 触发 remove/removeDownloadResult。
//   - 不可达：status reachable:false；POST 502 upstream_error（不是 200）。
//   - Office：只配 DS 不配 secret → enabled:false；两者都配 → enabled:true、JWT 三段式且签名可验、
//     documentType 映射正确；callback error:1 含「未实现」；office-file HMAC 错 403 / 对 200。
//   - 响应与服务日志中 grep 不到 ARIA2_SECRET / OO_JWT_SECRET 明文。
// 逐条 PASS/FAIL + 汇总，任一失败 exit 1。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SCRIPT = path.join(ROOT, 'tools', 'test-p5-integrations.mjs');
const P5_BASE = (process.env.P5_BASE || '').replace(/\/+$/, '');
const PORT = Number(process.env.P5_PORT || process.env.PORT || 8109);
const BASE = P5_BASE || `http://127.0.0.1:${PORT}`;
const EMAIL = process.env.TEST_EMAIL || 'p5alice@p5.test';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'test123';
const ARIA2_SECRET = 'testsecret';
const OO_SECRET = 'jwtsecret-p5';
const DEAD_PORT = 59999;

const results = [];
const allBodies = []; // 收集所有响应文本，用于 secret 泄露扫描
const serverLogs = [];

function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

// ---------- HTTP 辅助 ----------

function cookiesFrom(headers) {
  const arr = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
  return arr.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

async function req(method, p, { body, cookie, headers = {}, raw = false } = {}) {
  const url = p.startsWith('http') ? p : `${BASE}${p}`;
  const opts = { method, headers: { Cookie: cookie || '', ...headers } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  allBodies.push(text);
  const ct = r.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = null; } }
  return { status: r.status, ok: r.ok, headers: r.headers, buf, text, json, setCookie: cookiesFrom(r.headers) };
}

async function devLogin() {
  const r = await req('POST', '/api/auth/dev-login', { body: { email: EMAIL } });
  return { status: r.status, jar: r.setCookie, json: r.json };
}

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  return { status: r.status, jar: r.setCookie };
}

async function ensureVolumeStrategy(adminJar) {
  const list = await req('GET', '/api/admin/storage', { cookie: adminJar });
  const vol = list.json?.items?.find((s) => s.type === 'volume' && s.enabled);
  if (vol) return vol;
  const created = await req('POST', '/api/admin/storage', {
    cookie: adminJar,
    body: {
      type: 'volume', name: 'P5 自测本地卷', region: '本机', capacityBytes: 107374182400,
      acknowledgeDisclosure: true, config: { rootPath: process.env.STORAGE_ROOT || '/tmp/p5i/volume' },
    },
  });
  return created.json?.item;
}

async function uploadFixture(jar, name, bytes, mime) {
  const parent = `${EMAIL}/office`;
  const fd = new FormData();
  fd.append('overwrite', '1');
  fd.append('file', new File([bytes], name, { type: mime }));
  const r = await fetch(`${BASE}/api/files/upload?path=${encodeURIComponent(parent)}`, {
    method: 'POST', headers: { Cookie: jar }, body: fd,
  });
  const ct = r.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(Buffer.from(await r.arrayBuffer()).toString('utf8')); } catch { json = null; } }
  allBodies.push(JSON.stringify(json || {}));
  return json?.item?.path || `${parent}/${name}`;
}

// ---------- 子进程临时 express（主服务尚未挂载时使用） ----------

let child = null;

function stripP5(env) {
  const next = { ...env };
  for (const k of ['ARIA2_RPC', 'ARIA2_SECRET', 'ARIA2_DIR_MAP', 'OO_DS_URL', 'OO_JWT_SECRET', 'OO_INTERNAL_BASE']) {
    delete next[k];
  }
  return next;
}

function spawnServe(envExtra = {}) {
  return new Promise((resolve, reject) => {
    const base = stripP5(process.env);
    const env = {
      ...base,
      DB_PATH: process.env.DB_PATH || '/tmp/p5i/r6t5.db',
      STORAGE_ROOT: process.env.STORAGE_ROOT || '/tmp/p5i/volume',
      PORT: String(PORT),
      DEV_AUTH: '1',
      ADMIN_PASSWORD,
      ...envExtra,
    };
    console.log(`[boot] 重启临时 express 子进程：port=${PORT} env=${Object.keys(envExtra).join(',') || '(无 P5 环境变量)'}（待主服务在 app.js 挂载后此分支可移除）`);
    child = spawn(process.execPath, [SCRIPT, '--serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => serverLogs.push(d.toString('utf8')));
    child.stderr.on('data', (d) => serverLogs.push(d.toString('utf8')));
    child.on('exit', (code) => { if (code !== 0 && code !== null) serverLogs.push(`[child] exit=${code}`); });

    const deadline = Date.now() + 6000;
    const poll = async () => {
      try {
        const r = await fetch(`${BASE}/api/me`);
        if (r.status === 200 || r.status === 401) return resolve();
      } catch { /* 未就绪 */ }
      if (Date.now() > deadline) return reject(new Error('临时 express 启动超时'));
      setTimeout(poll, 150);
    };
    poll();
  });
}

function stopChild() {
  if (child) { try { child.kill('SIGKILL'); } catch {} child = null; }
}

// ---------- 子进程 serve 模式：挂临时 express ----------

async function serve() {
  fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
  fs.mkdirSync(process.env.STORAGE_ROOT, { recursive: true });

  const { migrate, db, getSetting, setSetting } = await import('../server/db.js');
  migrate();
  if (!getSetting('admin_password_hash')) {
    const { hashPassword } = await import('../server/lib/session.js');
    setSetting('admin_password_hash', hashPassword(process.env.ADMIN_PASSWORD || 'test123'));
    setSetting('admin_password_source', 'env');
  }
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
  app.use(express.json({ limit: '2mb' }));

  const authRouter = (await import('../server/routes/auth.js')).default;
  const meRouter = (await import('../server/routes/auth.js')).meRouter;
  const adminAuthRouter = (await import('../server/routes/admin-auth.js')).default;
  const adminStorageRouter = (await import('../server/routes/admin-storage.js')).default;
  const filesRouter = (await import('../server/routes/files.js')).default;
  const requireUser = (await import('../server/middleware/auth.js')).requireUser;
  const requireAdminApi = (await import('../server/middleware/auth.js')).requireAdminApi;

  const downloadsRouter = (await import('../server/routes/downloads.js')).default;
  const officeRouter = (await import('../server/routes/office.js')).default;
  const { officePublicRouter } = await import('../server/routes/office.js');
  const integrationsRouter = (await import('../server/routes/integrations.js')).default;

  app.use('/api/auth', authRouter);
  app.use('/api/me', meRouter);
  app.use('/api/admin', adminAuthRouter);
  const adminApi = express.Router();
  adminApi.use(requireAdminApi);
  adminApi.use('/storage', adminStorageRouter);
  app.use('/api/admin', adminApi);

  // 公开 HMAC 路由必须在 requireUser 之前挂
  app.use('/api/files', officePublicRouter);
  app.use('/api/files', requireUser, officeRouter);
  app.use('/api/files', requireUser, filesRouter);
  app.use('/api/downloads', requireUser, downloadsRouter);
  app.use('/api/integrations', requireUser, integrationsRouter);

  const { errorBody, ApiError } = await import('../server/lib/errors.js');
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) return res.status(err.status).json(errorBody(err));
    if (err?.status && err?.code) return res.status(err.status).json(errorBody(new ApiError(err.status, err.code, err.message, err.details)));
    console.error('[error]', err);
    res.status(500).json(errorBody(new ApiError(500, 'internal_error', '内部错误')));
  });

  await new Promise((resolve) => app.listen(Number(process.env.PORT), '127.0.0.1', resolve));
  console.log(`[serve] 临时 express 已起：http://127.0.0.1:${process.env.PORT}`);
}

// ---------- JWT 校验辅助 ----------

function verifyJwtLocal(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
}

// ================= 编排主流程 =================

async function main() {
  if (process.argv.includes('--serve')) return serve();

  console.log(`== P5 集成自测 · base=${BASE} ${P5_BASE ? '(外部主服务，不重启)' : '(脚本编排临时子进程)' } ==\n`);

  // 准备假 aria2（可用分支）
  const { startFakeAria2 } = await import('./fake-aria2.mjs');
  const fake = await startFakeAria2({ port: 0, secret: ARIA2_SECRET });
  console.log(`[setup] fake-aria2 已起：http://127.0.0.1:${fake.port}/jsonrpc\n`);

  let jar = '';
  let adminJar = '';
  const files = {};

  // 阶段 A：未配置
  if (!P5_BASE) {
    fs.rmSync('/tmp/p5i', { recursive: true, force: true });
    await spawnServe({});
  }
  {
    const login = await devLogin();
    jar = login.jar;
    check('A0. dev-login 建立会话', login.status === 200 && !!jar, `status=${login.status}`);
    const admin = await adminLogin();
    adminJar = admin.jar;
    await ensureVolumeStrategy(adminJar);

    // 上传 Office 预览用 fixture（DB 跨重启保留）
    files.docx = await uploadFixture(jar, 'demo.docx', Buffer.from('fake docx bytes'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    files.xlsx = await uploadFixture(jar, 'demo.xlsx', Buffer.from('fake xlsx bytes'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    files.pptx = await uploadFixture(jar, 'demo.pptx', Buffer.from('fake pptx bytes'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    files.txt = await uploadFixture(jar, 'note.txt', Buffer.from('hello office', 'utf8'), 'text/plain');
    files.xyz = await uploadFixture(jar, 'data.xyz', Buffer.from('binary'), 'application/octet-stream');
    console.log(`[setup] fixtures: ${JSON.stringify(files)}`);
  }

  // ---- A. 未配置 ----
  console.log('\n-- 阶段 A：未配置（无 ARIA2_RPC / OO_DS_URL）--');
  {
    const post = await req('POST', '/api/downloads', { cookie: jar, body: { url: 'https://example.com/a.zip' } });
    const code = post.json?.error?.code || '';
    const msg = post.json?.error?.message || '';
    check('A1. POST /api/downloads 未配置 → 503 integration_not_configured 且 message 含 ARIA2_RPC',
      post.status === 503 && code === 'integration_not_configured' && /ARIA2_RPC/.test(msg),
      `status=${post.status} code=${code} msg=${msg}`);

    const list = await req('GET', '/api/downloads', { cookie: jar });
    check('A2. GET /api/downloads 未配置 → 200 configured:false 且 items 为空',
      list.status === 200 && list.json?.configured === false && Array.isArray(list.json?.items) && list.json.items.length === 0,
      `status=${list.status} body=${list.text}`);

    const oc = await req('GET', `/api/files/office-config?path=${encodeURIComponent(files.docx)}`, { cookie: jar });
    check('A3. office-config 未配置 → 200 enabled:false 且 reason 非空',
      oc.status === 200 && oc.json?.enabled === false && !!oc.json?.reason,
      `status=${oc.status} body=${oc.text}`);

    const st = await req('GET', '/api/integrations/status', { cookie: jar });
    check('A4. status 两项均 configured:false',
      st.status === 200 && st.json?.aria2?.configured === false && st.json?.onlyoffice?.configured === false,
      `status=${st.status} body=${st.text}`);
  }

  // ---- B. 配置假 aria2（可用）----
  console.log('\n-- 阶段 B：配置假 aria2（可达）--');
  if (!P5_BASE) { stopChild(); await spawnServe({ ARIA2_RPC: `http://127.0.0.1:${fake.port}/jsonrpc`, ARIA2_SECRET }); const l = await devLogin(); jar = l.jar; }
  {
    const st = await req('GET', '/api/integrations/status', { cookie: jar });
    check('B1. status aria2 reachable:true 且 version 有值',
      st.status === 200 && st.json?.aria2?.configured === true && st.json?.aria2?.reachable === true && !!st.json?.aria2?.version,
      `body=${st.text}`);

    const post = await req('POST', '/api/downloads', { cookie: jar, body: { url: 'https://example.com/archive.zip', dir: `${EMAIL}/office` } });
    const gid = post.json?.task?.gid || post.json?.task?.id;
    check('B2. POST /api/downloads → 201 且 gid 来自假服务',
      post.status === 201 && !!gid && fake.tasks.has(gid),
      `status=${post.status} gid=${gid} body=${post.text}`);

    const one = await req('GET', `/api/downloads/${gid}`, { cookie: jar });
    check('B3. GET /api/downloads/:gid 透传 aria2 状态',
      one.status === 200 && one.json?.task?.gid === gid && !!one.json?.task?.status && Array.isArray(one.json?.task?.files),
      `status=${one.status} body=${one.text}`);

    const badProto = await req('POST', '/api/downloads', { cookie: jar, body: { url: 'magnet:?xt=urn:btih:abc' } });
    check('B3b. 非 http/https/ftp 协议 → 400 invalid_input',
      badProto.status === 400 && badProto.json?.error?.code === 'invalid_input',
      `status=${badProto.status} code=${badProto.json?.error?.code}`);

    const list = await req('GET', '/api/downloads', { cookie: jar });
    check('B4. GET /api/downloads 列表含该任务',
      list.status === 200 && list.json?.configured === true && list.json?.items.some((i) => i.gid === gid),
      `items=${list.json?.items?.length}`);

    const del = await req('DELETE', `/api/downloads/${gid}`, { cookie: jar });
    const calls = fake.calls.map((c) => c.method);
    check('B5. DELETE 触发 aria2.remove 与 removeDownloadResult',
      del.status === 200 && del.json?.ok === true && calls.includes('aria2.remove') && calls.includes('aria2.removeDownloadResult'),
      `status=${del.status} calls=${calls.join(',')}`);

    const missing = await req('GET', `/api/downloads/${gid}`, { cookie: jar });
    check('B6. 已删除任务再查 → 404 not_found',
      missing.status === 404 && missing.json?.error?.code === 'not_found',
      `status=${missing.status} body=${missing.text}`);
  }

  // ---- C. 配置但不可达 ----
  console.log('\n-- 阶段 C：aria2 地址不可达 --');
  if (!P5_BASE) { stopChild(); await spawnServe({ ARIA2_RPC: `http://127.0.0.1:${DEAD_PORT}/jsonrpc`, ARIA2_SECRET }); const l = await devLogin(); jar = l.jar; }
  {
    const st = await req('GET', '/api/integrations/status', { cookie: jar });
    check('C1. status reachable:false（不 500、不假装 true）',
      st.status === 200 && st.json?.aria2?.configured === true && st.json?.aria2?.reachable === false,
      `body=${st.text}`);

    const post = await req('POST', '/api/downloads', { cookie: jar, body: { url: 'https://example.com/x.zip' } });
    const code = post.json?.error?.code || '';
    check('C2. POST 不可达 → 502 upstream_error（不是 200）',
      post.status === 502 && code === 'upstream_error',
      `status=${post.status} code=${code} msg=${post.json?.error?.message || ''}`);
  }

  // ---- D1. Office：只配 DS 不配 secret ----
  console.log('\n-- 阶段 D1：OnlyOffice 仅配 OO_DS_URL，未配 JWT secret --');
  if (!P5_BASE) { stopChild(); await spawnServe({ OO_DS_URL: 'http://127.0.0.1:8080' }); const l = await devLogin(); jar = l.jar; }
  {
    const oc = await req('GET', `/api/files/office-config?path=${encodeURIComponent(files.docx)}`, { cookie: jar });
    check('D1. 缺 OO_JWT_SECRET → enabled:false 且 reason 提示安全未启用',
      oc.status === 200 && oc.json?.enabled === false && /JWT_SECRET/.test(oc.json?.reason || ''),
      `body=${oc.text}`);
  }

  // ---- D2. Office：两者都配 ----
  console.log('\n-- 阶段 D2：OO_DS_URL + OO_JWT_SECRET 均配置 --');
  if (!P5_BASE) { stopChild(); await spawnServe({ OO_DS_URL: 'http://127.0.0.1:8080', OO_JWT_SECRET: OO_SECRET }); const l = await devLogin(); jar = l.jar; }
  {
    const expect = { [files.docx]: 'word', [files.xlsx]: 'cell', [files.pptx]: 'slide' };
    for (const [path, type] of Object.entries(expect)) {
      const oc = await req('GET', `/api/files/office-config?path=${encodeURIComponent(path)}`, { cookie: jar });
      const dt = oc.json?.config?.documentType;
      check(`D2. ${path.split('/').pop()} → documentType=${type}`,
        oc.status === 200 && oc.json?.enabled === true && dt === type,
        `status=${oc.status} documentType=${dt}`);
    }

    const oc = await req('GET', `/api/files/office-config?path=${encodeURIComponent(files.docx)}`, { cookie: jar });
    const token = oc.json?.config?.token;
    const jwtParts = String(token || '').split('.');
    const payload = verifyJwtLocal(token, OO_SECRET);
    check('D3. config.token 为三段式 JWT 且能用 OO_JWT_SECRET 验签通过，含 document/editorConfig',
      oc.status === 200 && jwtParts.length === 3 && !!payload && !!payload.document && !!payload.editorConfig,
      `parts=${jwtParts.length} hasDoc=${!!payload?.document} hasEditor=${!!payload?.editorConfig}`);

    check('D4. editorConfig.mode=view（只读预览）',
      oc.json?.config?.editorConfig?.mode === 'view' && oc.json?.config?.document?.permissions?.edit === false,
      `mode=${oc.json?.config?.editorConfig?.mode} edit=${oc.json?.config?.document?.permissions?.edit}`);

    // 回源文件：正确 HMAC
    const fileUrl = oc.json?.config?.document?.url;
    check('D5. document.url 为内部 office-file 地址', !!fileUrl && /\/api\/files\/office-file\?/.test(fileUrl || ''), `url=${fileUrl}`);
    if (fileUrl) {
      const okFile = await fetch(fileUrl);
      const okBuf = Buffer.from(await okFile.arrayBuffer());
      check('D6. office-file HMAC 正确 → 200 拿到字节',
        okFile.status === 200 && okBuf.length > 0,
        `status=${okFile.status} bytes=${okBuf.length}`);

      const badUrl = fileUrl.replace(/t=[^&]+/, 't=bad-signature');
      const badFile = await fetch(badUrl);
      check('D7. office-file HMAC 错误 → 403', badFile.status === 403, `status=${badFile.status}`);
    }

    // 回调：如实拒绝
    const cbUrl = oc.json?.config?.editorConfig?.callbackUrl;
    const cb = await fetch(cbUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 2 }) });
    const cbJson = await cb.json().catch(() => null);
    check('D8. office-callback 返回 error:1 且 message 含「未实现」',
      cb.status === 200 && cbJson?.error === 1 && /未实现/.test(cbJson?.message || ''),
      `status=${cb.status} body=${JSON.stringify(cbJson)}`);

    const unknown = await req('GET', `/api/files/office-config?path=${encodeURIComponent(files.xyz)}`, { cookie: jar });
    check('D8b. 未知后缀 → enabled:false 且 reason 说明不支持',
      unknown.status === 200 && unknown.json?.enabled === false && !!unknown.json?.reason,
      `body=${unknown.text}`);

    const st = await req('GET', '/api/integrations/status', { cookie: jar });
    check('D9. status onlyoffice configured/jwtConfigured 均 true',
      st.json?.onlyoffice?.configured === true && st.json?.onlyoffice?.jwtConfigured === true,
      `body=${st.text}`);
  }

  // ---- secret 泄露扫描 ----
  console.log('\n-- 阶段 E：secret 泄露扫描 --');
  const blob = [...allBodies, ...serverLogs].join('\n');
  const leakAria = blob.includes(ARIA2_SECRET);
  const leakOo = blob.includes(OO_SECRET);
  check('E1. 响应与日志不含 ARIA2_SECRET 明文', !leakAria, leakAria ? '命中 ARIA2_SECRET！' : '未命中');
  check('E2. 响应与日志不含 OO_JWT_SECRET 明文', !leakOo, leakOo ? '命中 OO_JWT_SECRET！' : '未命中');

  // 收尾
  await fake.close();
  stopChild();

  const failed = results.filter((x) => !x.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('自测流程异常：', e?.stack || e);
  stopChild();
  process.exit(1);
});
