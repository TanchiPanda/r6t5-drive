// P8-A 品牌与外观 · 浏览器 E2E（puppeteer-core + Chromium）
// 前置（隔离库）：
//   DB_PATH=/tmp/p8a/r6t5.db STORAGE_ROOT=/tmp/p8a/volume PORT=8190 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   BASE=http://127.0.0.1:8190 node tools/brand-e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('/opt/runtime/nodejs/node_modules/puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8190';
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

async function req(method, p, { cookie, json, raw } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (raw) { opts.body = raw.body; Object.assign(opts.headers, raw.headers); }
  const res = await fetch(BASE + p, opts);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let body = null;
  if (ct.includes('json')) { try { body = JSON.parse(text); } catch { body = text; } }
  const setCookieArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setCookieArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json: body, set };
}

// ---- 手写最小 PNG 编码器（IHDR + deflateSync IDAT + CRC32），生成真实可解码的 64×64 图案 ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function makePng(w, h, pixelFn) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixelFn(x, y, w, h);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8bit RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
// 圆形徽标：外圈填充色 + 内圈点缀色，圆外透明
function circlePixel(fill, inner) {
  return (x, y, w, h) => {
    const cx = (w - 1) / 2, cy = (h - 1) / 2, r = w / 2 - 2;
    const d = Math.hypot(x - cx, y - cy);
    if (d > r) return [0, 0, 0, 0];
    if (inner && d < r * 0.48) return inner;
    return fill;
  };
}
// 64×64：favicon 主色绿；暗色 LOGO 亮绿配深心；日间 LOGO 深绿配白心
const PNG_FAVICON = makePng(64, 64, circlePixel([74, 158, 110, 255], [215, 243, 226, 255]));
const PNG_LOGO_DARK = makePng(64, 64, circlePixel([85, 180, 124, 255], [14, 21, 18, 255]));
const PNG_LOGO_LIGHT = makePng(64, 64, circlePixel([63, 141, 97, 255], [255, 255, 255, 255]));

const SIDEBAR_HTML = '<p><strong>站点公告</strong> 这是侧边栏自定义信息，<a href="https://example.com">了解更多</a></p>';

const jar = { admin: '' };
let browser;

async function adminLogin() {
  const r = await req('POST', '/api/admin/login', { json: { password: process.env.ADMIN_PASSWORD || 'test123' } });
  jar.admin = Object.entries(r.set).map(([k, v]) => `${k}=${v}`).join('; ');
  return r;
}

async function uploadSlot(slot, buffer, name) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: 'image/png' }), name);
  return req('POST', '/api/admin/branding/upload?slot=' + slot, { cookie: jar.admin, raw: { body: fd, headers: {} } });
}

async function main() {
  // ---------- 1. API 前置：登录 + 上传一套品牌资源 ----------
  const al = await adminLogin();
  check('1a. 管理员登录 200', al.status === 200 && !!jar.admin, `status=${al.status}`);

  const light = await uploadSlot('logoLight', PNG_LOGO_LIGHT, 'logo-light.png');
  const dark = await uploadSlot('logoDark', PNG_LOGO_DARK, 'logo-dark.png');
  const fav = await uploadSlot('favicon', PNG_FAVICON, 'favicon.png');
  check('1b. 日间/暗色 LOGO 与 favicon 上传 201',
    light.status === 201 && dark.status === 201 && fav.status === 201,
    `light=${light.status} dark=${dark.status} fav=${fav.status}`);

  const patch = await req('PATCH', '/api/admin/branding', {
    cookie: jar.admin,
    json: { sidebarHtml: SIDEBAR_HTML },
  });
  check('1c. 保存侧边栏 HTML 200', patch.status === 200 && !!patch.json?.item?.sidebarHtml,
    `status=${patch.status} cleaned=${patch.json?.item?.sidebarHtml}`);

  const cfg = {
    logoLight: light.json.url, logoDark: dark.json.url, favicon: fav.json.url,
    sidebar: patch.json.item.sidebarHtml,
  };

  // ---------- 2. 启动浏览器 ----------
  browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1360, height: 900 });

  let pageErrors = 0;
  page.on('pageerror', () => { pageErrors += 1; });

  const adminCookies = Object.fromEntries(jar.admin.split('; ').map(s => s.split('=')));
  await page.setCookie(...Object.entries(adminCookies).map(([name, value]) => ({
    name, value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax',
  })));

  // ---------- 3. 设置页：品牌卡片 ----------
  await page.goto(BASE + '/admin/settings.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('#brand-slots .brand-slot', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 300));

  const slotCount = await page.$$eval('#brand-slots .brand-slot', els => els.length);
  check('3a. 设置页品牌卡片渲染 5 个资源位', slotCount === 5, `slots=${slotCount}`);
  const hasPreviewBtn = await page.$('#b-preview-btn') !== null;
  const hasSaveBtn = await page.$('#b-save-btn') !== null;
  check('3b. 含侧边栏 HTML 预览与保存按钮', hasPreviewBtn && hasSaveBtn,
    `preview=${hasPreviewBtn} save=${hasSaveBtn}`);

  const card = await page.$('.brand-card');
  await card.screenshot({ path: path.join(OUT, 'A-brand-settings.png') });

  // ---------- 4. 管理端边栏：新 LOGO + 自定义 HTML ----------
  await page.goto(BASE + '/admin/home.html', { waitUntil: 'networkidle0' });
  await page.waitForSelector('[data-brand-logo]', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 300));

  const darkMeta = await page.$eval('[data-brand-logo]', el => ({ src: el.getAttribute('src'), w: el.naturalWidth, h: el.naturalHeight }));
  check('4a. 管理端边栏暗色主题显示暗色 LOGO 且图片解码成功',
    darkMeta.src === cfg.logoDark && darkMeta.w > 0 && darkMeta.h > 0,
    `src=${darkMeta.src} natural=${darkMeta.w}x${darkMeta.h} expect=${cfg.logoDark}`);

  const sideIframe = await page.$('[data-brand-sidehtml] iframe');
  check('4b. 边栏底部自定义 HTML 以 iframe 渲染', !!sideIframe, 'iframe=' + (!!sideIframe));
  if (sideIframe) {
    const srcdoc = await sideIframe.evaluate(f => f.getAttribute('srcdoc') || '');
    check('4c. iframe srcdoc 含清洗后的公告内容且注入暗色主题色板',
      srcdoc.includes('站点公告') && srcdoc.includes('<strong>') &&
      srcdoc.includes('#151f1b') && srcdoc.includes('content="dark"'),
      `srcdoc=${srcdoc.slice(0, 100)}`);
  }

  const iconHref = await page.$eval('link[rel="icon"]', el => el.getAttribute('href'));
  check('4d. favicon link 指向 /branding/favicon', (iconHref || '').endsWith('/branding/favicon'), `href=${iconHref}`);

  const manifestHref = await page.$eval('link[rel="manifest"]', el => el.getAttribute('href'));
  const manifestRes = await fetch(BASE + manifestHref);
  check('4e. manifest link 存在且 200', !!manifestHref && manifestRes.status === 200,
    `href=${manifestHref} status=${manifestRes.status}`);

  await page.screenshot({ path: path.join(OUT, 'A-brand-sidebar.png') });

  // ---------- 5. 主题切换：LOGO 在明暗之间切换 ----------
  const themeBtn = await page.$('#theme-btn');
  await themeBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const lightMeta = await page.$eval('[data-brand-logo]', el => ({ src: el.getAttribute('src'), w: el.naturalWidth, h: el.naturalHeight }));
  check('5a. 切到浅色后 LOGO 切换为日间 LOGO 且解码成功',
    lightMeta.src === cfg.logoLight && lightMeta.w > 0 && lightMeta.h > 0,
    `src=${lightMeta.src} natural=${lightMeta.w}x${lightMeta.h} expect=${cfg.logoLight}`);
  const lightFrame = await page.$('[data-brand-sidehtml] iframe');
  const lightDoc = lightFrame ? await lightFrame.evaluate(f => f.getAttribute('srcdoc') || '') : '';
  check('5c. 切浅色后 iframe srcdoc 重绘为浅色主题色板',
    lightDoc.includes('#ffffff') && lightDoc.includes('content="light"'),
    `srcdoc=${lightDoc.slice(0, 100)}`);
  await themeBtn.click();
  await new Promise(r => setTimeout(r, 300));
  const backDark = await page.$eval('[data-brand-logo]', el => el.getAttribute('src'));
  check('5b. 切回暗色后 LOGO 切换回暗色 LOGO', backDark === cfg.logoDark, `src=${backDark}`);
  const darkFrame = await page.$('[data-brand-sidehtml] iframe');
  const darkDoc = darkFrame ? await darkFrame.evaluate(f => f.getAttribute('srcdoc') || '') : '';
  check('5d. 切回暗色后 iframe srcdoc 重绘回暗色主题色板',
    darkDoc.includes('#151f1b') && darkDoc.includes('content="dark"'),
    `srcdoc=${darkDoc.slice(0, 100)}`);

  // ---------- 6. 登录页：新 LOGO ----------
  const loginPage = await browser.newPage();
  await loginPage.setViewport({ width: 1100, height: 800 });
  await loginPage.goto(BASE + '/login', { waitUntil: 'networkidle0' });
  await loginPage.waitForSelector('[data-brand-logo]', { timeout: 5000 });
  await new Promise(r => setTimeout(r, 300));
  const loginMeta = await loginPage.$eval('[data-brand-logo]', el => ({ src: el.getAttribute('src'), w: el.naturalWidth, h: el.naturalHeight }));
  const loginName = await loginPage.$eval('[data-brand-name]', el => el.textContent.trim());
  check('6a. 登录页显示暗色 LOGO 且解码成功',
    loginMeta.src === cfg.logoDark && loginMeta.w > 0 && loginMeta.h > 0,
    `src=${loginMeta.src} natural=${loginMeta.w}x${loginMeta.h}`);
  check('6b. 登录页站点名已注入', !!loginName, `name=${loginName}`);
  await loginPage.screenshot({ path: path.join(OUT, 'A-brand-login.png') });

  check('7. 全程 pageerror 计数 0', pageErrors === 0, `pageerrors=${pageErrors}`);
}

main().catch(e => {
  console.error('脚本异常：', e);
  process.exit(1);
}).then(() => {
  if (browser) browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
});
