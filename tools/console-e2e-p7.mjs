// P7 前端自测：用户组单位/BigInt 回填 + sudo 二次确认 + 自助注册 + sudo 管理登录 + 关于/更新。
// 前置（隔离库，避免污染仓库 data/）：
//   DB_PATH=/tmp/p7ui/r6t5.db STORAGE_ROOT=/tmp/p7ui/volume PORT=8150 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   BASE=http://127.0.0.1:8150 node tools/console-e2e-p7.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('/opt/runtime/nodejs/node_modules/puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8150';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'screenshots', 'console');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
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

async function req(method, p, { cookie, json } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
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

const jar = { admin: '', regular: '', signup: '' };
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'test123';
const SIGNUP_EMAIL = 'p7user@x.com';
const SIGNUP_PW = 'password123';
const REGULAR_EMAIL = 'p7regular@x.com';
const REGULAR_PW = 'regular123';

let browser;
const pageErrors = [];

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { json: { password: ADMIN_PW } });
  jar.admin = cookieStr(r.set);
  return r;
}

/* 每个角色一个独立浏览器上下文，cookie 互不可见 */
async function newRolePage(browser, cookie) {
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  p.on('pageerror', e => pageErrors.push(String(e)));
  if (cookie) await setBrowserCookies(p, cookie);
  return { ctx, p };
}

async function setBrowserCookies(page, cookie) {
  if (!cookie) return;
  const pairs = Object.fromEntries(cookie.split('; ').map(s => {
    const i = s.indexOf('=');
    return [s.slice(0, i), s.slice(i + 1)];
  }));
  await page.setCookie(...Object.entries(pairs).map(([name, value]) => ({
    name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  })));
}

async function main() {
  // ---------- 0. API 前置 ----------
  const al = await adminLogin();
  check('0a. 管理员登录 200 并拿到 admin cookie', al.status === 200 && !!jar.admin,
    `status=${al.status} cookie=${jar.admin ? 'yes' : 'no'}`);

  // 切到数据卷账号体系（注册 / sudo 判定都依赖 volume）
  const src = await req('PUT', '/api/admin/user-source', { cookie: jar.admin, json: { source: 'volume', confirm: true } });
  check('0b. 切换到 volume 账号体系', src.status === 200 && src.json?.switchedTo === 'volume',
    `status=${src.status} source=${src.json?.switchedTo}`);

  // 默认组：1.5 TB、允许自助注册、作为 sudo 组；另建一个普通组给非 sudo 用户
  const groups0 = await req('GET', '/api/admin/groups', { cookie: jar.admin });
  const defaultGroup = (groups0.json?.items || [])[0];
  check('0c. 隔离库存在默认用户组', !!defaultGroup, `groups=${(groups0.json?.items || []).length}`);

  await req('PATCH', '/api/admin/groups/' + encodeURIComponent(defaultGroup.id), {
    cookie: jar.admin,
    json: {
      spaceLimitBytes: '1649267441664', // 1.5 TB
      maxFileSizeBytes: '2147483648',
      traffic7dLimitBytes: '5368709120',
      allowSelfSignup: true,
      isSudo: true,
    },
  });
  // 本地数据卷策略，保证 /files 页面可正常加载
  await req('POST', '/api/admin/storage', {
    cookie: jar.admin,
    json: {
      name: '本机数据卷 P7', type: 'volume', region: '本机',
      capacityBytes: 107374182400, readOnly: false,
      config: { rootPath: process.env.STORAGE_ROOT || '/tmp/p7ui/volume' },
      acknowledgeDisclosure: true,
    },
  });

  const regularGroup = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    json: {
      name: '普通组 P7',
      spaceLimitBytes: '1073741824',
      maxFileSizeBytes: '2147483648',
      traffic7dLimitBytes: '5368709120',
      allowSelfSignup: false,
      isSudo: false,
    },
  });
  check('0d. 创建非 sudo 普通组', regularGroup.status === 201 && regularGroup.json?.item?.isSudo === false,
    `status=${regularGroup.status} sudo=${regularGroup.json?.item?.isSudo}`);
  const regularGroupId = regularGroup.json?.item?.id;

  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  // ---------- 1. 用户组页 ----------
  const adminRole = await newRolePage(browser, jar.admin);
  const page = adminRole.p;

  await page.goto(BASE + '/admin/groups.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#group-cards .group-card', { timeout: 5000 });

  const cardText = await page.$eval('#group-cards', el => el.textContent);
  check('1a. 组卡片空间上限回显 1.5 TB（spaceLimitText）', cardText.includes('1.5 TB'), `text=${cardText.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  check('1b. 组卡片展示「自助注册」「sudo」徽标', cardText.includes('自助注册') && cardText.includes('sudo'),
    `badges=${/自助注册|sudo/g.test(cardText)}`);

  // 打开默认组编辑弹窗
  await page.evaluate((gid) => {
    const card = document.querySelector(`.group-card[data-id="${gid}"]`);
    card.querySelector('[data-act="edit"]').click();
  }, defaultGroup.id);
  await page.waitForSelector('#m-group.open', { timeout: 3000 });

  const unitOptions = await page.$$eval('#g-space-u option', els => els.map(e => e.value));
  check('1c. 单位下拉从小到大含 B…EB（含 EB）',
    ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'].every(u => unitOptions.includes(u)) && unitOptions.includes('EB'),
    `options=${JSON.stringify(unitOptions)}`);

  const spaceValue = await page.$eval('#g-space-v', el => el.value);
  const spaceUnit = await page.$eval('#g-space-u', el => el.value);
  check('1d. 1.5 TB 回填数值 1.5 / 单位 TB（BigInt 拆分）', spaceValue === '1.5' && spaceUnit === 'TB',
    `value=${spaceValue} unit=${spaceUnit}`);

  const previewText = await page.$eval('#g-space-pv', el => el.textContent.trim());
  check('1e. 输入右侧预览字节数与人类可读', /1649267441664/.test(previewText) && /TB/.test(previewText),
    `preview=${previewText}`);

  await page.screenshot({ path: path.join(OUT, 'p7-groups-units.png') });

  // sudo 二次确认：先取消勾选（无需确认），再勾选 → 弹确认；取消则回退
  const sudoBox = await page.$('#g-sudo');
  await page.$eval('#g-sudo', el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); });
  const modalAfterUncheck = await page.$eval('#m-sudo-confirm', el => el.classList.contains('open'));
  check('1f. 取消勾选 sudo 不弹二次确认', modalAfterUncheck === false, `modalOpen=${modalAfterUncheck}`);

  await page.$eval('#g-sudo', el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector('#m-sudo-confirm.open', { timeout: 3000 });
  const confirmText = await page.$eval('#sudo-confirm-text', el => el.textContent.trim());
  check('1g. 勾选 sudo 弹出二次确认（原文案）',
    confirmText === 'sudo 用户组等于把管理面板交给该组成员：他们无需管理员密码即可访问全部管理页与接口。确定开启？',
    `text=${confirmText}`);
  await page.screenshot({ path: path.join(OUT, 'p7-groups-sudo-confirm.png') });

  await page.click('#sudo-cancel');
  await new Promise(r => setTimeout(r, 200));
  const sudoAfterCancel = await page.$eval('#g-sudo', el => el.checked);
  check('1h. 取消确认后 sudo 复选框回退未勾选', sudoAfterCancel === false, `checked=${sudoAfterCancel}`);

  // 再次勾选并确认，保留自助注册勾选，提交表单
  await page.$eval('#g-sudo', el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForSelector('#m-sudo-confirm.open', { timeout: 3000 });
  await page.click('#sudo-confirm');
  const selfBox = await page.$('#g-self-signup');
  if (!(await page.$eval('#g-self-signup', el => el.checked))) {
    await page.$eval('#g-self-signup', el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); });
  }
  await page.click('#group-form button[type="submit"]');
  await page.waitForFunction(async () => {
    const r = await fetch('/api/admin/groups', { credentials: 'same-origin' });
    const d = await r.json();
    const g = (d.items || [])[0];
    return g && g.allowSelfSignup === true && g.isSudo === true;
  }, { timeout: 5000 });

  const groupsAfter = await req('GET', '/api/admin/groups', { cookie: jar.admin });
  const savedGroup = (groupsAfter.json?.items || []).find(g => g.id === defaultGroup.id);
  check('1i. 保存后接口 allowSelfSignup/isSudo 与界面一致',
    savedGroup?.allowSelfSignup === true && savedGroup?.isSudo === true,
    `self=${savedGroup?.allowSelfSignup} sudo=${savedGroup?.isSudo}`);

  // ---------- 2. 注册 ----------
  const userRole = await newRolePage(browser);
  const loginPage = userRole.p;

  await loginPage.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await loginPage.waitForSelector('#signup-link', { timeout: 5000 });
  const signupLinkVisible = await loginPage.$eval('#signup-link', el => !el.classList.contains('hide'));
  const signupHref = await loginPage.$eval('#signup-link', el => el.getAttribute('href'));
  check('2a. signup-config.available=true 时登录页展示「注册」入口', signupLinkVisible && signupHref === '/signup',
    `visible=${signupLinkVisible} href=${signupHref}`);

  await loginPage.goto(BASE + '/signup', { waitUntil: 'networkidle0' });
  await loginPage.waitForSelector('#signup-form', { timeout: 5000 });
  await loginPage.type('#signup-email', SIGNUP_EMAIL);
  await loginPage.type('#signup-password', 'password123');
  await loginPage.type('#signup-confirm', 'otherpass999');
  await loginPage.$eval('#signup-confirm', el => el.dispatchEvent(new Event('input', { bubbles: true })));
  await loginPage.$eval('#signup-confirm', el => el.dispatchEvent(new Event('blur')));
  await new Promise(r => setTimeout(r, 200));
  const signupErr = await loginPage.$eval('#signup-err', el => el.textContent.trim());
  check('2b. 两次密码不一致即时红字提示且不提交', signupErr === '两次输入的密码不一致' && loginPage.url().includes('/signup'),
    `err=${signupErr} url=${loginPage.url()}`);
  await loginPage.screenshot({ path: path.join(OUT, 'p7-signup.png') });

  // 短密码提示
  await loginPage.$eval('#signup-confirm', el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await loginPage.$eval('#signup-password', el => { el.value = '1234567'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  await new Promise(r => setTimeout(r, 150));
  const shortErr = await loginPage.$eval('#signup-err', el => el.textContent.trim());
  check('2c. 密码少于 8 位提示「密码至少 8 位」', shortErr === '密码至少 8 位', `err=${shortErr}`);

  // 正确注册 → 跳转 /files
  await loginPage.$eval('#signup-password', (el, pw) => { el.value = pw; el.dispatchEvent(new Event('input', { bubbles: true })); }, SIGNUP_PW);
  await loginPage.$eval('#signup-confirm', (el, pw) => { el.value = pw; el.dispatchEvent(new Event('input', { bubbles: true })); }, SIGNUP_PW);
  await loginPage.click('#signup-submit');
  await loginPage.waitForFunction(() => location.pathname === '/files', { timeout: 5000 });
  const me = await loginPage.evaluate(async () => {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    return { status: r.status, email: (await r.json()).user?.email };
  });
  check('2d. 注册成功跳转 /files 且 /api/me 200', me.status === 200 && me.email === SIGNUP_EMAIL,
    `status=${me.status} email=${me.email}`);
  const meCookies = await loginPage.cookies();
  jar.signup = meCookies.filter(c => c.name).map(c => `${c.name}=${c.value}`).join('; ');

  // ---------- 3. sudo 管理登录 ----------
  // 普通用户：管理员建号到非 sudo 组
  const created = await req('POST', '/api/admin/users', {
    cookie: jar.admin,
    json: { email: REGULAR_EMAIL, password: REGULAR_PW, displayName: 'P7 普通用户', groupId: regularGroupId },
  });
  check('3a. 管理员创建普通用户（非 sudo 组）', created.status === 201, `status=${created.status}`);
  const regularLogin = await req('POST', '/api/auth/login', { json: { email: REGULAR_EMAIL, password: REGULAR_PW } });
  jar.regular = cookieStr(regularLogin.set);
  const regularSession = await req('GET', '/api/admin/session', { cookie: jar.regular });
  check('3b. 普通账号访问管理会话 403', regularSession.status === 403, `status=${regularSession.status}`);

  const regularRole = await newRolePage(browser, jar.regular);
  const adminLoginPage = regularRole.p;
  await adminLoginPage.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
  await adminLoginPage.waitForSelector('#sudo-form', { timeout: 5000 });
  const sudoFormVisible = await adminLoginPage.$eval('#sudo-form', el => !!el);
  check('3c. 管理端登录页存在「sudo 用户组账号可直接进入」表单', sudoFormVisible, 'sudo-form present');
  await adminLoginPage.screenshot({ path: path.join(OUT, 'p7-admin-sudo-login.png') });

  await adminLoginPage.type('#sudo-email', REGULAR_EMAIL);
  await adminLoginPage.type('#sudo-password', REGULAR_PW);
  await adminLoginPage.click('#sudo-form button[type="submit"]');
  await adminLoginPage.waitForFunction(() => (document.getElementById('sudo-err')?.textContent || '').trim(), { timeout: 4000 });
  const sudoErr = await adminLoginPage.$eval('#sudo-err', el => el.textContent.trim());
  const regularPageUrl = adminLoginPage.url();
  check('3d. 非 sudo 账号提交显示 403 提示原文',
    sudoErr === '该账号不属于 sudo 用户组，请使用管理员密码登录', `err=${sudoErr} url=${regularPageUrl}`);

  // sudo 组成员（注册落到默认 sudo 组）进入后台
  const sudoRole = await newRolePage(browser, jar.signup);
  const sudoPage = sudoRole.p;
  await sudoPage.goto(BASE + '/admin/login.html', { waitUntil: 'networkidle0' });
  await sudoPage.type('#sudo-email', SIGNUP_EMAIL);
  await sudoPage.type('#sudo-password', SIGNUP_PW);
  await sudoPage.click('#sudo-form button[type="submit"]');
  await sudoPage.waitForFunction(() => location.pathname === '/admin/home.html', { timeout: 5000 });
  const sudoSession = await req('GET', '/api/admin/session', { cookie: jar.signup });
  const sudoOverview = await req('GET', '/api/admin/overview', { cookie: jar.signup });
  check('3e. sudo 成员登录进入 /admin/home.html', sudoPage.url().includes('/admin/home.html'), `url=${sudoPage.url()}`);
  check('3f. 管理会话 via=sudo 且概览接口 200',
    sudoSession.status === 200 && sudoSession.json?.admin?.via === 'sudo' && sudoOverview.status === 200,
    `session=${sudoSession.status} via=${sudoSession.json?.admin?.via} overview=${sudoOverview.status}`);

  // ---------- 4. 关于 / 更新 ----------
  const settingsRole = await newRolePage(browser, jar.admin);
  const settingsPage = settingsRole.p;

  const fakeUpdate = {
    checked: true,
    current: { version: '20261115a', builtAt: '2026-11-10T08:00:00.000Z', serverTime: new Date().toISOString() },
    latest: {
      version: '20261115b', issueNumber: 12, commentId: 345,
      commentUrl: 'https://github.com/TanchiPanda/r6t5-drive/issues/12#issuecomment-345',
      publishedAt: '2026-11-15T09:00:00.000Z',
      upgradeCommand: 'docker compose pull && docker compose up -d',
      notes: '修复若干问题，提升稳定性与兼容性。',
    },
    hasUpdate: true,
    cached: false,
  };

  await settingsPage.setRequestInterception(true);
  settingsPage.on('request', req2 => {
    if (req2.url().includes('/api/admin/update-status')) {
      req2.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeUpdate) });
    } else {
      req2.continue();
    }
  });

  await settingsPage.goto(BASE + '/admin/settings.html', { waitUntil: 'networkidle0' });
  await settingsPage.waitForSelector('#update-latest:not(.hide)', { timeout: 5000 });

  const latestVersion = await settingsPage.$eval('#update-latest-version', el => el.textContent.trim());
  const latestCmd = await settingsPage.$eval('#update-latest-command', el => el.textContent.trim());
  const linkHref = await settingsPage.$eval('#update-latest-link', el => el.getAttribute('href'));
  const linkText = await settingsPage.$eval('#update-latest-link', el => el.textContent.trim());
  const notesText = await settingsPage.$eval('#update-latest-notes', el => el.textContent.trim());
  check('4a. 有新版本：展示最新版本号', latestVersion === '20261115b', `version=${latestVersion}`);
  check('4b. 展示升级命令（等宽）与发布说明链接',
    latestCmd === 'docker compose pull && docker compose up -d' && linkText === '查看发布说明' &&
    linkHref.includes('issuecomment-345'),
    `cmd=${latestCmd} link=${linkText} href=${linkHref}`);
  check('4c. 展示发布备注', notesText.includes('修复若干问题'), `notes=${notesText}`);
  await settingsPage.$eval('#update-latest', el => el.scrollIntoView({ block: 'center' }));
  await settingsPage.screenshot({ path: path.join(OUT, 'p7-update.png'), fullPage: true });

  // 复制按钮
  await settingsPage.click('#update-copy-cmd');
  await new Promise(r => setTimeout(r, 300));

  // 拦截成 checked:false（无网络）
  const offlineUpdate = {
    checked: false, reason: 'network',
    current: { version: '20261115a', builtAt: '2026-11-10T08:00:00.000Z', serverTime: new Date().toISOString() },
  };
  settingsPage.off('request');
  await settingsPage.setRequestInterception(true);
  settingsPage.on('request', req2 => {
    if (req2.url().includes('/api/admin/update-status')) {
      req2.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(offlineUpdate) });
    } else {
      req2.continue();
    }
  });
  await settingsPage.click('#update-check-btn');
  await settingsPage.waitForFunction(() => {
    const el = document.querySelector('#update-status');
    return el && el.textContent.includes('暂时无法检查更新');
  }, { timeout: 5000 });
  const offlineText = await settingsPage.$eval('#update-status', el => el.textContent.trim());
  check('4d. checked:false 显示「暂时无法检查更新（无网络）」', offlineText.includes('暂时无法检查更新') && offlineText.includes('无网络'),
    `text=${offlineText}`);

  // ---------- 5. 全程无 pageerror ----------
  check('5. 全程无 pageerror（计数 0）', pageErrors.length === 0, `errors=${pageErrors.length} ${pageErrors.join(' | ')}`);
}

main().catch(e => { console.error('E2E 异常：', e); process.exit(1); })
  .finally(async () => {
    const failed = results.filter(r => !r.ok);
    const pass = results.length - failed.length;
    console.log(`\n汇总：PASS=${pass} FAIL=${failed.length}`);
    if (failed.length) {
      console.log('失败项：');
      for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    }
    if (browser) await browser.close();
    process.exit(failed.length ? 1 : 0);
  });
