// P8-B 自测：注册策略 / SMTP 发信 / 邮箱确认状态机 / 验证码 / 第三方登录占位。
// 前置（隔离库）：
//   DB_PATH=/tmp/p8/r6t5.db STORAGE_ROOT=/tmp/p8/volume PORT=8195 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   BASE=http://127.0.0.1:8195 node tools/test-p8-security.mjs
// 脚本会自行拉起 tools/fake-smtp.mjs（SMTP 2525 / HTTP 2526）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const BASE = process.env.BASE || 'http://127.0.0.1:8195';
const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'data/r6t5.db');
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test123';
const SUFFIX = Date.now().toString(36);

// ---- 拉起假 SMTP ----
const fakeSmtp = spawn(process.execPath, [path.join(process.cwd(), 'tools', 'fake-smtp.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
fakeSmtp.stdout.on('data', (d) => process.stdout.write(`[fake-smtp] ${d}`));
fakeSmtp.stderr.on('data', (d) => process.stderr.write(`[fake-smtp] ${d}`));

const db = new Database(DB_PATH);

const jar = { admin: '' };
const results = [];
let skips = 0;

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

async function req(method, p, { body, cookie, raw } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (raw) { opts.body = raw.body; Object.assign(opts.headers, raw.headers); }
  const res = await fetch(BASE + p, opts);
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

function check(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

function skip(name, reason) {
  skips += 1;
  results.push({ name, ok: true, skipped: true });
  console.log(`SKIP | ${name} | ${reason}`);
}

function cookieStr(set) {
  return Object.entries(set).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { body: { password: ADMIN_PW } });
  jar.admin = cookieStr(r.set);
  return r;
}

function dbUser(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

async function signup(email, extra = {}) {
  return req('POST', '/api/auth/signup', {
    body: { email, password: 'password123', passwordConfirm: 'password123', ...extra },
  });
}

async function fakeMessages() {
  const res = await fetch('http://127.0.0.1:2526/messages');
  return res.json();
}

// 正文可能是 base64 / multipart 编码，解码后再匹配链接
function decodedBody(msg) {
  if (msg?.decoded) return msg.decoded;
  const body = msg?.body || '';
  try { return Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8'); }
  catch { return body; }
}

// ============ 前置：管理员登录 + 开放注册组 ============
await adminLogin();
check('0a. 管理员登录 200', !!jar.admin, `cookie=${jar.admin ? 'yes' : 'no'}`);

const sw = await req('PUT', '/api/admin/user-source', { cookie: jar.admin, body: { source: 'volume', confirm: true } });
check('0a2. 切到 volume 来源', sw.status === 200 && sw.json?.switchedTo === 'volume', `status=${sw.status} body=${JSON.stringify(sw.json)}`);

const grp = await req('POST', '/api/admin/groups', {
  cookie: jar.admin,
  body: { name: `P8 Smoke ${SUFFIX}`, allowSelfSignup: true, spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120 },
});
check('0b. 建开放注册组 201', grp.status === 201, `status=${grp.status}`);

const strat = await req('POST', '/api/admin/storage', {
  cookie: jar.admin,
  body: {
    name: 'P8 本机数据卷', type: 'volume', region: '本机',
    capacityBytes: 107374182400, readOnly: false,
    config: { rootPath: process.env.STORAGE_ROOT || '/tmp/p8/volume' },
    acknowledgeDisclosure: true,
  },
});
check('0c. 建 volume 存储策略', strat.status === 201 || strat.status === 200, `status=${strat.status}`);

// ============ 1. 域白/黑名单 + 子地址 ============
{
  await req('PATCH', '/api/admin/security', {
    cookie: jar.admin,
    body: { signup: { allowDomains: 'example.com,*.corp.test', denyDomains: 'blocked.example.com', forbidSubAddress: true } },
  });

  const ok1 = await signup(`a-${SUFFIX}@example.com`);
  check('1a. 白名单精确域 example.com 允许', ok1.status === 201, `status=${ok1.status} code=${ok1.json?.error?.code}`);

  const ok2 = await signup(`b-${SUFFIX}@sub.corp.test`);
  check('1b. 通配 *.corp.test 子域允许', ok2.status === 201, `status=${ok2.status} code=${ok2.json?.error?.code}`);

  const bad1 = await signup(`c-${SUFFIX}@other.com`);
  check('1c. 非白名单域 400 signup_domain_not_allowed',
    bad1.status === 400 && bad1.json?.error?.code === 'signup_domain_not_allowed',
    `status=${bad1.status} code=${bad1.json?.error?.code}`);

  const bad2 = await signup(`d-${SUFFIX}@blocked.example.com`);
  check('1d. 黑名单优先拦截 400 signup_domain_blocked',
    bad2.status === 400 && bad2.json?.error?.code === 'signup_domain_blocked',
    `status=${bad2.status} code=${bad2.json?.error?.code}`);

  const bad3 = await signup(`x+y-${SUFFIX}@example.com`);
  check('1e. 子地址 + 400 signup_subaddress_forbidden',
    bad3.status === 400 && bad3.json?.error?.code === 'signup_subaddress_forbidden',
    `status=${bad3.status} code=${bad3.json?.error?.code}`);
}

// ============ 2. 未配 SMTP：pending_review，受限上传/分享 ============
{
  // 清空 SMTP 配置
  await req('PATCH', '/api/admin/mail', { cookie: jar.admin, body: { host: '', fromEmail: '', replyTo: '' } });
  const email = `review-${SUFFIX}@example.com`;
  const su = await signup(email);
  const pending = su.status === 201 && su.json?.status === 'pending_review' && su.json?.confirmEmail?.configured === false;
  check('2a. 未配 SMTP 注册 201 pending_review / configured=false', pending,
    `status=${su.status} userStatus=${su.json?.status} configured=${su.json?.confirmEmail?.configured}`);
  const userJar = cookieStr(su.set);

  if (pending) {
    const up = await req('POST', '/api/files/upload?path=' + encodeURIComponent(email), {
      cookie: userJar,
      raw: { body: (() => { const fd = new FormData(); fd.append('file', new Blob(['x']), 'x.txt'); return fd; })(), headers: {} },
    });
    check('2b. pending_review 上传 403 email_unconfirmed',
      up.status === 403 && up.json?.error?.code === 'email_unconfirmed' && up.json?.error?.details?.status === 'pending_review',
      `status=${up.status} code=${up.json?.error?.code} details=${JSON.stringify(up.json?.error?.details)}`);

    const share = await req('POST', '/api/shares', { cookie: userJar, body: { path: `${email}/`, name: 't' } });
    check('2c. pending_review 建分享 403 email_unconfirmed',
      share.status === 403 && share.json?.error?.code === 'email_unconfirmed',
      `status=${share.status} code=${share.json?.error?.code}`);

    const dl = await req('GET', '/api/files/download?path=' + encodeURIComponent(`${email}/x.txt`), { cookie: userJar });
    check('2d. pending_review 下载不被 403 拦截', dl.status !== 403, `status=${dl.status}`);
  } else {
    skip('2b/2c/2d. 受限访问断言', `注册未进入 pending_review（status=${su.status}），跳过上传/分享/下载断言`);
  }
}

// ============ 3. 配 SMTP（假服务器）：pending_email → 确认 → active ============
{
  await req('PATCH', '/api/admin/mail', {
    cookie: jar.admin,
    body: { host: '127.0.0.1', port: 2525, secure: false, fromEmail: 'noreply@example.com', fromName: 'P8 Test', replyTo: 'support@example.com' },
  });

  const email = `mail-${SUFFIX}@example.com`;
  const su = await signup(email);
  check('3a. 配 SMTP 注册 201 pending_email',
    su.status === 201 && su.json?.status === 'pending_email',
    `status=${su.status} userStatus=${su.json?.status} sent=${su.json?.confirmEmail?.sent}`);
  const userJar = cookieStr(su.set);

  const msgs = await fakeMessages();
  check('3b. 假 SMTP 收到确认邮件', msgs.count >= 1, `count=${msgs.count}`);

  const decoded = msgs.messages.map((m) => decodedBody(m));
  const linkIdx = decoded.findIndex((b) => /confirm\?token=([A-Za-z0-9_-]+)/.test(b));
  const linkMatch = linkIdx >= 0
    ? decoded[linkIdx].match(/confirm\?token=([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*)/)
    : null;
  if (linkMatch) linkMatch[1] = linkMatch[1].replace(/\s+/g, '');
  check('3c. 邮件正文含 /confirm?token=', !!linkMatch, `matched=${linkIdx >= 0}`);

  if (linkMatch) {
    const token = linkMatch[1];
    const confirm = await req('GET', `/api/auth/confirm?token=${encodeURIComponent(token)}`);
    const u = dbUser(email);
    check('3d. 确认页返回 HTML 且用户变 active',
      confirm.status === 200 && confirm.text.includes('邮箱已确认') && u?.status === 'active',
      `status=${confirm.status} dbStatus=${u?.status}`);

    const fd = new FormData(); fd.append('file', new Blob(['hello']), 'hello.txt');
    const up = await req('POST', '/api/files/upload?path=' + encodeURIComponent(email), {
      cookie: userJar, raw: { body: fd, headers: {} },
    });
    check('3e. active 后上传 201', up.status === 201, `status=${up.status} code=${up.json?.error?.code} details=${JSON.stringify(up.json?.error?.details)} msg=${up.json?.error?.message}`);

    // 二次使用同一令牌
    const again = await req('GET', `/api/auth/confirm?token=${encodeURIComponent(token)}`);
    const u2 = dbUser(email);
    check('3f. 令牌二次使用显示失效且不再置 active',
      again.text.includes('链接已失效') && u2?.status === 'active',
      `status=${again.status} dbStatus=${u2?.status}`);

    // 篡改 expiresAt 为过去
    db.prepare('UPDATE email_tokens SET expiresAt = ? WHERE token = ?').run(new Date(Date.now() - 3600_000).toISOString(), token);
    const expired = await req('GET', `/api/auth/confirm?token=${encodeURIComponent(token)}`);
    check('3g. 过期令牌显示失效且页面含联系邮箱 replyTo',
      expired.text.includes('链接已失效') && expired.text.includes('support@example.com'),
      `hasContact=${expired.text.includes('support@example.com')}`);
  } else {
    skip('3d–3g. 确认链路断言', '未从假 SMTP 邮件中解析到 token，跳过');
  }
}

// ============ 4. 发信测试 / 不可达 502 / 密码不明文回显 ============
{
  const test = await req('POST', '/api/admin/mail/test', { cookie: jar.admin, body: { to: 'support@example.com' } });
  check('4a. 测试发信 200', test.status === 200 && test.json?.ok === true, `status=${test.status} code=${test.json?.code}`);

  await req('PATCH', '/api/admin/mail', { cookie: jar.admin, body: { host: '127.0.0.1', port: 25999 } });
  const unreachable = await req('POST', '/api/admin/mail/test', { cookie: jar.admin, body: { to: 'support@example.com' } });
  check('4b. 不可达 SMTP 502 且带 smtpCode',
    unreachable.status === 502 && unreachable.json?.error?.code === 'upstream_error' && !!unreachable.json?.error?.details?.smtpCode,
    `status=${unreachable.status} code=${unreachable.json?.error?.code} details=${JSON.stringify(unreachable.json?.error?.details)}`);

  const secretPw = `p8uniquePwd42${SUFFIX}`;
  await req('PATCH', '/api/admin/mail', { cookie: jar.admin, body: { password: secretPw } });
  const snap = await req('GET', '/api/admin/mail', { cookie: jar.admin });
  const leaked = snap.text.includes(secretPw);
  check('4c. GET /admin/mail 不下发密码明文', !leaked && snap.json?.passwordSet === true && !!snap.json?.passwordMasked,
    `leaked=${leaked} passwordSet=${snap.json?.passwordSet} masked=${snap.json?.passwordMasked}`);
}

// ============ 5. 验证码配置与验票 ============
{
  const sec = await req('GET', '/api/admin/security', { cookie: jar.admin });
  const turnstile = sec.json?.captcha?.providers?.turnstile;
  check('5a. 未配 secret 时 turnstile.disabledReason 非空',
    !!turnstile && !!turnstile.disabledReason, `reason=${turnstile?.disabledReason}`);

  await req('PATCH', '/api/admin/security', {
    cookie: jar.admin,
    body: { captcha: { provider: 'turnstile', secretKey: 'fake-secret-p8', onSignup: true, onLogin: false, onRecover: false } },
  });
  const capFail = await signup(`cap-${SUFFIX}@example.com`);
  check('5b. onSignup 启用且不带 token 注册 400 captcha_failed',
    capFail.status === 400 && capFail.json?.error?.code === 'captcha_failed',
    `status=${capFail.status} code=${capFail.json?.error?.code}`);

  const pub = await req('GET', '/api/auth/security-config');
  const bodyText = JSON.stringify(pub.json || {});
  check('5c. security-config 不下发 secret',
    pub.status === 200 && !bodyText.includes('secretKey') && !bodyText.includes('fake-secret-p8'),
    `body=${bodyText}`);

  // 关闭 onSignup，避免影响后续用例（隔离库下非必需）
  await req('PATCH', '/api/admin/security', { cookie: jar.admin, body: { captcha: { onSignup: false } } });
}

// ============ 6. 管理员手动确认 ============
{
  const email = `review-${SUFFIX}@example.com`;
  const u = dbUser(email);
  if (!u) {
    skip('6. 管理员手动确认', '场景 2 的 pending_review 用户不存在');
  } else {
    const confirm = await req('POST', `/api/admin/users/${u.id}/confirm`, { cookie: jar.admin });
    const after = dbUser(email);
    check('6a. 管理员确认后 status=active',
      confirm.status === 200 && after?.status === 'active',
      `status=${confirm.status} dbStatus=${after?.status}`);
    const audit = await req('GET', '/api/admin/audit?action=email_confirm&pageSize=50', { cookie: jar.admin });
    const manual = (audit.json?.items || []).some((i) => i.email === email && i.detail === 'manual');
    check('6b. 审计含 email_confirm detail=manual', manual, `items=${(audit.json?.items || []).map((i) => `${i.action}:${i.detail}`).join(',')}`);
  }
}

// ============ 7. 第三方登录未配置 ============
{
  const list = await req('GET', '/api/auth/oauth/providers');
  check('7a. 未配置 provider 时列表为空', list.status === 200 && Array.isArray(list.json?.providers) && list.json.providers.length === 0,
    `body=${JSON.stringify(list.json)}`);
  const start = await req('GET', '/api/auth/oauth/qq/start');
  check('7b. 未配置 provider 启动 503 integration_not_configured',
    start.status === 503 && start.json?.error?.code === 'integration_not_configured',
    `status=${start.status} code=${start.json?.error?.code}`);
}

// ============ 汇总 ============
const failed = results.filter((r) => !r.ok && !r.skipped);
console.log(`\n==== P8-B 汇总：PASS=${results.length - failed.length - skips} FAIL=${failed.length} SKIP=${skips} 总计=${results.length} ====`);

fakeSmtp.kill();
process.exit(failed.length ? 1 : 0);
