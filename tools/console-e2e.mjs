// 管理端控制台前端自测：概览账号来源开关、用户抽屉、封禁/解封、删号双选项、登录页文案。
// 前置（隔离库，避免污染仓库 data/）：
//   DB_PATH=/tmp/con/ui.db STORAGE_ROOT=/tmp/con/volume PORT=8095 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   BASE=http://127.0.0.1:8095 node tools/console-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('/opt/runtime/nodejs/node_modules/puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8095';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'screenshots', 'console');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const STORAGE_ROOT = process.env.STORAGE_ROOT || '/tmp/con/volume';
fs.mkdirSync(OUT, { recursive: true });

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
function cookieStr(set) {
  return Object.entries(set).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, p, { cookie, json, raw } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  if (raw) { opts.body = raw.body; Object.assign(opts.headers, raw.headers); }
  const res = await fetch(BASE + p, opts);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let body = null;
  if (ct.includes('json')) { try { body = JSON.parse(text); } catch { body = text; } }
  const setArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json: body, text, set };
}

const jar = { admin: '', alice: '', bob: '', carol: '' };
const ALICE = 'alice-con@x.com';
const ALICE_PW = 'secret123';
const BOB = 'bob-con@x.com';
const BOB_PW = 'bobpass123';
const CAROL = 'carol-con@x.com';
const CAROL_PW = 'carolpass123';

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { json: { password: process.env.ADMIN_PASSWORD || 'test123' } });
  jar.admin = cookieStr(r.set);
  return r;
}

async function ensureBaseSetup() {
  await req('POST', '/api/admin/storage', {
    cookie: jar.admin,
    json: {
      name: '本机数据卷', type: 'volume', region: '本机',
      capacityBytes: 107374182400, readOnly: false,
      config: { rootPath: STORAGE_ROOT }, acknowledgeDisclosure: true,
    },
  });
  await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    json: { name: '普通用户', spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120 },
  });
}

async function completeSiteSetup() {
  const g = await req('GET', '/api/admin/groups', { cookie: jar.admin });
  const gid = g.json?.items?.[0]?.id || null;
  await req('PATCH', '/api/admin/settings', {
    cookie: jar.admin,
    json: {
      siteName: 'R6T5 Drive 测试站', publicUrl: 'http://127.0.0.1:8095', defaultGroupId: gid,
      allowSignup: false, trashRetentionDays: 30, themeDefault: 'dark',
    },
  });
}

async function uploadFile(cookie, email, name, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/plain' }), name);
  return req('POST', '/api/files/upload?path=' + encodeURIComponent(email), { cookie, raw: { body: fd, headers: {} } });
}

let browser;
async function main() {
  // ---------- 1. API 前置：管理员登录 + 基础策略/用户组 ----------
  const al = await adminLogin();
  check('1a. 管理员登录 200 并拿到 admin cookie', al.status === 200 && !!jar.admin,
    `status=${al.status} cookie=${jar.admin ? 'yes' : 'no'}`);
  await ensureBaseSetup();

  const src0 = await req('GET', '/api/admin/user-source', { cookie: jar.admin });
  check('1b. 初始 userSource=supabase（隔离库默认）', src0.status === 200 && src0.json?.userSource === 'supabase',
    `status=${src0.status} source=${src0.json?.userSource}`);

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900 });

  const adminCookies = Object.fromEntries(jar.admin.split('; ').map(s => s.split('=')));
  await page.setCookie(...Object.entries(adminCookies).map(([name, value]) => ({
    name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  })));

  // ---------- 2. 概览页：开关初始态 / tooltip / 二次确认 / 切换 ----------
  await page.goto(BASE + '/admin/home.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#usource-switch', { timeout: 5000 });

  const switchChecked = await page.$eval('#usource-switch', el => el.checked);
  check('2a. 开关初始状态与 GET /api/admin/user-source 一致',
    switchChecked === (src0.json.userSource === 'volume'),
    `switch=${switchChecked} source=${src0.json.userSource}`);

  const stateText = await page.$eval('#usource-state', el => el.textContent.trim());
  check('2b. 状态小字显示 Supabase 账号', stateText === '当前：Supabase 账号', `text=${stateText}`);

  // 打开 tooltip（hover 与点击都能显示；这里点击展开并截图）
  await page.click('#usource-info-btn');
  await page.waitForSelector('#usource-tip.show', { timeout: 3000 });
  await new Promise(r => setTimeout(r, 250));
  const tipText = await page.$eval('#usource-tip', el => el.textContent.trim());
  check('2c. tooltip 文案固定为数据卷安全提示',
    tipText === '将账户数据直接放在数据卷中，请注意数据安全', `text=${tipText}`);
  await page.screenshot({ path: path.join(OUT, 'console-source-toggle.png') });

  // 拨动开关 → 二次确认弹窗（input 视觉隐藏，直接派发 change）
  await page.$eval('#usource-switch', el => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('#m-usource.open', { timeout: 3000 });
  const modalText = await page.$eval('#m-usource', el => el.textContent);
  check('2d. 确认弹窗含固定说明原文（不改写）',
    modalText.includes('不迁移既有账号，仅切换认证来源；本地账号密码哈希存于 data/ 卷，请自行做好卷的备份与权限'),
    'warning text present');

  // 先验证取消路径：关闭弹窗后开关回到原位
  await page.click('#m-usource [data-close]');
  await new Promise(r => setTimeout(r, 300));
  const afterCancel = await page.$eval('#usource-switch', el => el.checked);
  check('2e. 取消后开关回到原位（supabase）', afterCancel === false, `checked=${afterCancel}`);

  // 再次拨动并确认
  await page.$eval('#usource-switch', el => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForSelector('#m-usource.open', { timeout: 3000 });
  await page.click('#usource-confirm');
  await page.waitForFunction(async () => {
    const r = await fetch('/api/admin/user-source', { credentials: 'same-origin' });
    const d = await r.json();
    return d.userSource === 'volume';
  }, { timeout: 5000 });

  const src1 = await req('GET', '/api/admin/user-source', { cookie: jar.admin });
  check('2f. 确认后 userSource 变为 volume', src1.status === 200 && src1.json?.userSource === 'volume',
    `source=${src1.json?.userSource} switchedAt=${src1.json?.switchedAt}`);

  await page.waitForSelector('#setup-note', { timeout: 3000 });
  await new Promise(r => setTimeout(r, 300));
  const noteText = await page.$eval('#setup-note', el => el.textContent);
  check('2g. setup-note 刷新后不含 Supabase 文案', !noteText.includes('Supabase'), `note=${noteText.trim()}`);

  // ---------- 3. 造数据：本地账号 alice/bob/carol，均登录过并各传一个文件 ----------
  for (const [email, pw, name] of [[ALICE, ALICE_PW, 'Alice Con'], [BOB, BOB_PW, 'Bob Con'], [CAROL, CAROL_PW, 'Carol Con']]) {
    const created = await req('POST', '/api/admin/users', { cookie: jar.admin, json: { email, password: pw, displayName: name } });
    check(`3. 建号 ${email} 201`, created.status === 201 && created.json?.item?.source === 'local',
      `status=${created.status} item=${JSON.stringify(created.json?.item || null)}`);
    const login = await req('POST', '/api/auth/login', { json: { email, password: pw } });
    jar[email === ALICE ? 'alice' : email === BOB ? 'bob' : 'carol'] = cookieStr(login.set);
    check(`3. 登录 ${email} 200`, login.status === 200, `status=${login.status}`);
    await uploadFile(jar[email === ALICE ? 'alice' : email === BOB ? 'bob' : 'carol'], email, email.split('@')[0] + '.txt', 'console e2e file\n');
  }

  // ---------- 4. 用户页：表格列 / 抽屉字段 / 文件夹链接 ----------
  await page.goto(BASE + '/admin/users.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#user-rows tr.user-row', { timeout: 5000 });

  const headers = await page.$$eval('thead th', ths => ths.map(t => t.textContent.trim()));
  check('4a. 表头含「注册时间」「最近登录」「状态」「来源」',
    headers.includes('注册时间') && headers.includes('最近登录') && headers.includes('状态') && headers.includes('来源'),
    `headers=${JSON.stringify(headers)}`);

  const aliceRow = await page.evaluate((email) => {
    const tr = Array.from(document.querySelectorAll('#user-rows tr.user-row'))
      .find(r => r.textContent.includes(email));
    if (!tr) return null;
    const cells = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
    return { cells, id: tr.dataset.id };
  }, ALICE);
  check('4b. 已登录用户的注册时间/最近登录显示为时间而非「无记录」',
    !!aliceRow && aliceRow.cells[4] !== '无记录' && aliceRow.cells[5] !== '无记录' &&
    /\d{4}-\d{2}-\d{2}/.test(aliceRow.cells[4]) && /\d{4}-\d{2}-\d{2}/.test(aliceRow.cells[5]),
    `cells=${JSON.stringify(aliceRow?.cells)}`);

  // 点击行打开抽屉
  await page.evaluate((email) => {
    const tr = Array.from(document.querySelectorAll('#user-rows tr.user-row'))
      .find(r => r.textContent.includes(email));
    tr.click();
  }, ALICE);
  await page.waitForSelector('#user-drawer.open', { timeout: 3000 });
  await new Promise(r => setTimeout(r, 300));

  const drawerText = await page.$eval('#drawer-body', el => el.textContent);
  check('4c. 抽屉展示邮箱/显示名/用户组/最后登录/注册时间/状态/来源',
    drawerText.includes(ALICE) && drawerText.includes('Alice Con') &&
    drawerText.includes('未分组') && drawerText.includes('最后登录时间') &&
    drawerText.includes('注册成功时间') && drawerText.includes('正常') && drawerText.includes('本地账号'),
    `drawer=${drawerText.replace(/\s+/g, ' ').trim()}`);

  const folderHref = await page.$eval('#drawer-body a[href*="path="]', el => el.getAttribute('href'));
  check('4d. 打开用户文件夹链接含 path= 且指向该邮箱',
    !!folderHref && folderHref.includes('path=') && decodeURIComponent(folderHref).includes(ALICE),
    `href=${folderHref}`);

  await page.screenshot({ path: path.join(OUT, 'console-users-drawer.png') });

  // ---------- 5. 封禁：旧 cookie 403 account_banned，列表状态变「已封禁」 ----------
  await page.click('#drawer-ban');
  await page.waitForFunction(async () => {
    const r = await fetch('/api/admin/users?q=' + encodeURIComponent('alice-con@x.com'), { credentials: 'same-origin' });
    const d = await r.json();
    return d.items?.[0]?.status === 'banned';
  }, { timeout: 5000 });

  const meBanned = await req('GET', '/api/me', { cookie: jar.alice });
  check('5a. 封禁后旧 cookie 请求 /api/me 403 account_banned',
    meBanned.status === 403 && meBanned.json?.error?.code === 'account_banned',
    `status=${meBanned.status} code=${meBanned.json?.error?.code}`);

  const listAfterBan = await req('GET', '/api/admin/users', { cookie: jar.admin, json: undefined });
  const aliceAfterBan = (listAfterBan.json?.items || []).find(u => u.email === ALICE);
  check('5b. 列表中状态变为「已封禁」', aliceAfterBan?.status === 'banned',
    `status=${aliceAfterBan?.status}`);

  // 抽屉内按钮文案随状态刷新
  const banBtnText = await page.$eval('#drawer-ban', el => el.textContent.trim());
  check('5c. 封禁后抽屉按钮变为「解封」', banBtnText === '解封', `text=${banBtnText}`);

  // ---------- 6. 解封：恢复 active，登录恢复 200 ----------
  await page.click('#drawer-ban');
  await page.waitForFunction(async () => {
    const r = await fetch('/api/admin/users?q=' + encodeURIComponent('alice-con@x.com'), { credentials: 'same-origin' });
    const d = await r.json();
    return d.items?.[0]?.status === 'active';
  }, { timeout: 5000 });
  const meActive = await req('GET', '/api/me', { cookie: jar.alice });
  check('6a. 解封后旧 cookie /api/me 恢复 200', meActive.status === 200, `status=${meActive.status}`);
  const relog = await req('POST', '/api/auth/login', { json: { email: ALICE, password: ALICE_PW } });
  jar.alice = cookieStr(relog.set);
  check('6b. 解封后重新登录 200', relog.status === 200, `status=${relog.status}`);

  // ---------- 7. 删号弹窗：两个选项可见 + 红字警告 ----------
  await page.click('#drawer-delete');
  await page.waitForSelector('#m-user-delete.open', { timeout: 3000 });
  const delOptions = await page.$$eval('input[name="del-files"]', els => els.map(e => ({ value: e.value, checked: e.checked })));
  check('7a. 删号弹窗提供两个明确选项（保留文件 / 连文件删除）',
    delOptions.length === 2 && delOptions.some(o => o.value === '0') && delOptions.some(o => o.value === '1'),
    `options=${JSON.stringify(delOptions)}`);
  const warnHidden0 = await page.$eval('#del-files-warn', el => el.classList.contains('hide'));
  check('7b. 选「仅删账号」时红字警告隐藏', warnHidden0, 'warn hidden');
  await page.click('input[name="del-files"][value="1"]');
  await new Promise(r => setTimeout(r, 200));
  await page.screenshot({ path: path.join(OUT, 'console-user-delete.png') });
  const warnVisible1 = await page.$eval('#del-files-warn', el => !el.classList.contains('hide'));
  const warnText = await page.$eval('#del-files-warn', el => el.textContent.trim());
  check('7c. 选「删账号并删文件」时显示红字不可恢复警告',
    warnVisible1 && warnText === '将同时删除该邮箱下全部文件与回收站内容，不可恢复', `warn=${warnText}`);

  // 切回「仅删账号」执行删除
  await page.click('input[name="del-files"][value="0"]');
  await page.click('#del-confirm');
  await page.waitForFunction(async () => {
    const r = await fetch('/api/admin/users?q=' + encodeURIComponent('alice-con@x.com'), { credentials: 'same-origin' });
    const d = await r.json();
    return d.items?.length === 0;
  }, { timeout: 5000 });

  const aliceGone = (await req('GET', '/api/admin/users', { cookie: jar.admin, json: undefined })).json?.items
    .some(u => u.email === ALICE);
  check('7d. 仅删账号后该用户从列表消失', !aliceGone, `stillPresent=${aliceGone}`);

  // 保留的文件：物理目录仍在；bob 的文件不受影响
  const aliceFileKept = fs.existsSync(path.join(STORAGE_ROOT, ALICE, 'alice-con.txt'));
  const bobDl = await req('GET', '/api/files/download?path=' + encodeURIComponent(`${BOB}/bob-con.txt`), { cookie: jar.bob });
  check('7e. 仅删账号后 alice 文件仍保留在卷中，bob 文件仍可下载',
    aliceFileKept && bobDl.status === 200 && bobDl.text.includes('console e2e file'),
    `aliceFileKept=${aliceFileKept} bobDownload=${bobDl.status}`);

  // ---------- 8. 删账号并删文件：carol 文件 404 ----------
  const carolRow = await page.evaluate((email) => {
    const tr = Array.from(document.querySelectorAll('#user-rows tr.user-row'))
      .find(r => r.textContent.includes(email));
    if (tr) tr.click();
    return !!tr;
  }, CAROL);
  check('8a. 抽屉可打开 carol 详情', carolRow, `found=${carolRow}`);
  await page.waitForSelector('#user-drawer.open', { timeout: 3000 });
  await page.click('#drawer-delete');
  await page.waitForSelector('#m-user-delete.open', { timeout: 3000 });
  await page.click('input[name="del-files"][value="1"]');
  await page.click('#del-confirm');
  await page.waitForFunction(async () => {
    const r = await fetch('/api/admin/users?q=' + encodeURIComponent('carol-con@x.com'), { credentials: 'same-origin' });
    const d = await r.json();
    return d.items?.length === 0;
  }, { timeout: 5000 });

  const carolDl = await req('GET', '/api/files/download?path=' + encodeURIComponent(`${CAROL}/carol-con.txt`), { cookie: jar.bob });
  const carolFileGone = !fs.existsSync(path.join(STORAGE_ROOT, CAROL, 'carol-con.txt'));
  // 跨用户访问先命中权限边界（403）；核心证据是物理文件已清除
  check('8b. 删账号并删文件后其文件不可下载且物理目录清除',
    [403, 404].includes(carolDl.status) && carolFileGone,
    `download=${carolDl.status} fileGone=${carolFileGone}`);

  // ---------- 9. 登录页文案：volume 模式不含 Supabase；切回 supabase 恢复 ----------
  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#setup-note-body', { timeout: 3000 });
  const volumeNote = await page.$eval('#setup-note-body', el => el.textContent.trim());
  check('9a. volume 模式登录页提示含「数据卷」且不含「Supabase」',
    volumeNote.includes('数据卷') && !volumeNote.includes('Supabase'), `note=${volumeNote}`);
  await page.screenshot({ path: path.join(OUT, 'console-login-volume.png') });

  // 登录失败文案：先让站点就绪以启用登录表单；错误密码 → 「邮箱或密码错误」
  await completeSiteSetup();
  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#login-form', { timeout: 3000 });
  await page.evaluate((email) => {
    document.getElementById('email').value = email;
    document.getElementById('password').value = 'wrong-pass';
    document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
  }, ALICE);
  await new Promise(r => setTimeout(r, 600));
  const errText = await page.$eval('#login-err', el => el.textContent.trim());
  check('9b. invalid_credentials 显示「邮箱或密码错误」，不含「账号不存在」',
    errText === '邮箱或密码错误' && !errText.includes('账号不存在'), `err=${errText}`);

  // 切回 supabase 模式，文案恢复
  const swBack = await req('PUT', '/api/admin/user-source', { cookie: jar.admin, json: { source: 'supabase', confirm: true } });
  check('9c. 切回 supabase 200', swBack.status === 200 && swBack.json?.switchedTo === 'supabase',
    `status=${swBack.status} body=${JSON.stringify(swBack.json)}`);
  await page.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#setup-note-body', { timeout: 3000 });
  const sbNote = await page.$eval('#setup-note-body', el => el.textContent.trim());
  check('9d. supabase 模式文案恢复原状（含 Supabase 配置提示）', sbNote.includes('Supabase'), `note=${sbNote}`);
}

main().catch(e => { console.error('E2E 异常：', e); process.exit(1); })
  .finally(async () => {
    const failed = results.filter(r => !r.ok);
    console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
    if (failed.length) {
      console.log('失败项：');
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    }
    if (browser) await browser.close();
    process.exit(failed.length ? 1 : 0);
  });
