// P4 真机前端复验：多选计数 / 20MB 分片上传完成 / 下载 sha256 / 批量删除 / pageerror=0。
// 前置：服务已起（默认 8126，DEV_AUTH=1，ADMIN_PASSWORD=test123）。
// 用法：BASE=http://127.0.0.1:8126 node tools/p4ui-verify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('/opt/runtime/nodejs/node_modules/puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8126';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const EMAIL = 'alice@p4.test';
const BIG_NAME = 'ui-big-20mb.bin';
const SMALL = ['ui-a.txt', 'ui-b.txt', 'ui-c.txt'];
const OUT_FILE = process.env.VERIFY_OUT || '/tmp/p4f/verify.out';

const results = [];
function log(line) {
  console.log(line);
  try { fs.appendFileSync(OUT_FILE, line + '\n'); } catch { /* 忽略日志落盘失败 */ }
}
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

function jarOf(setCookieArr) {
  return (setCookieArr || []).map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

async function api(method, url, { cookie, json, raw, form } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (raw) { opts.body = raw.buffer; opts.headers['Content-Type'] = raw.contentType || 'application/octet-stream'; }
  if (form) { opts.body = form; }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  if (ct.includes('json')) { try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); } }
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json: body, buf, headers: res.headers, set };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function main() {
  try { fs.rmSync(OUT_FILE, { force: true }); } catch { /* 忽略 */ }
  // ---------- 登录 + 造 3 个小文件 ----------
  const dl = await api('POST', BASE + '/api/auth/dev-login', { json: { email: EMAIL } });
  if (dl.status !== 200) throw new Error('dev-login 失败 ' + dl.status);
  const cookie = jarOf(dl.set);
  check('前置. dev-login alice 200', dl.status === 200, `status=${dl.status}`);

  // 幂等清理：删除可能残留的大文件/测试文件（404 忽略），避免同名冲突
  for (const name of [BIG_NAME, ...SMALL]) {
    await api('DELETE', BASE + '/api/files?' + new URLSearchParams({ path: `${EMAIL}/${name}` }), { cookie });
  }
  // 中止可能残留的同名活动分片会话，避免续传到半截临时目录
  const sess = await api('GET', BASE + '/api/uploads', { cookie });
  for (const s of (sess.json?.items || [])) {
    if (s.name === BIG_NAME || SMALL.includes(s.name)) {
      await api('DELETE', BASE + '/api/uploads/' + encodeURIComponent(s.uploadId), { cookie });
    }
  }

  for (const name of SMALL) {
    const fd = new FormData();
    fd.append('file', new Blob([`body-of-${name}`], { type: 'text/plain' }), name);
    fd.append('overwrite', '1');
    const up = await api('POST', BASE + '/api/files/upload?' + new URLSearchParams({ path: EMAIL }), { cookie, form: fd });
    check(`前置. 上传小文件 ${name}`, up.status === 201 || up.status === 200, `status=${up.status}`);
  }

  // ---------- 20MB 随机源文件 ----------
  const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p4ui-verify-'));
  const BIG_SIZE = 20 * 1024 * 1024;
  const bigBuf = crypto.randomBytes(BIG_SIZE);
  const bigPath = path.join(WORK, BIG_NAME);
  fs.writeFileSync(bigPath, bigBuf);
  const bigSha = sha256(bigBuf);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => pageErrors.push((e && e.message || String(e)).slice(0, 200)));
  page.on('dialog', d => d.accept()); // 批量删除 confirm 自动确认

  const [name, value] = cookie.split(';')[0].split('=');
  await page.setCookie({ name, value, domain: '127.0.0.1', path: '/', httpOnly: true });

  await page.goto(BASE + '/files?path=' + encodeURIComponent(EMAIL), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row, .file-card, .empty', { timeout: 8000 });

  // ========== 1) 多选 3 项，批量条文案含「3 项」 ==========
  const smallPaths = SMALL.map(n => `${EMAIL}/${n}`);
  await page.evaluate(paths => window.App.selectPaths(paths), smallPaths);
  await page.waitForSelector('#batch-bar:not(.hide)', { timeout: 4000 });
  const batchText = await page.$eval('#batch-count', el => el.textContent.trim());
  check('断言. 多选 3 项后批量条文案含「3 项」', /3 项/.test(batchText), `text="${batchText}"`);

  // 点一次 batch-clear 清空选择（其余 batch-* 处理函数已静态核对全部有定义，
  // zip/compress 的点击链路由既有 p4ui-e2e 覆盖）。
  await page.click('#batch-clear');
  await page.waitForSelector('#batch-bar.hide', { timeout: 3000 });

  // ========== 2) 上传 20MB 文件，队列最终「完成」 ==========
  const inputUpload = await page.$('#file-input');
  await inputUpload.uploadFile(bigPath);
  await page.waitForSelector('.chunk-up', { timeout: 6000 });
  for (let i = 0; i < 30; i += 1) {
    const st = await page.$$eval('.chunk-up', els => els.map(r => r.querySelector('.up-status')?.textContent || ''));
    console.log(`[upload-wait ${i}] status=${JSON.stringify(st)} errors=${pageErrors.length}/${consoleErrors.length} console=${JSON.stringify(consoleErrors.slice(-2))}`);
    if (st.length === 0 || st.every(t => /完成/.test(t))) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.chunk-up')];
    return rows.length === 0 || rows.every(r => /完成/.test(r.querySelector('.up-status')?.textContent || ''));
  }, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 800));
  const remain = await page.$$eval('.chunk-up', els => els.map(r => r.querySelector('.up-status')?.textContent || ''));
  check('断言. 20MB 分片上传队列最终「完成」', remain.every(t => /完成/.test(t)), `remain=${JSON.stringify(remain)} pageErrors=${JSON.stringify(pageErrors)} consoleErrors=${JSON.stringify(consoleErrors)}`);

  // ========== 3) API 下载比对 sha256 ==========
  const dlBig = await api('GET', BASE + '/api/files/download?' + new URLSearchParams({ path: `${EMAIL}/${BIG_NAME}` }), { cookie });
  const dlSha = sha256(dlBig.buf);
  check('断言. 下载回 20MB 文件大小与 sha256 一致',
    dlBig.status === 200 && dlBig.buf.length === BIG_SIZE && dlSha === bigSha,
    `status=${dlBig.status} bytes=${dlBig.buf.length} expect=${BIG_SIZE} shaMatch=${dlSha === bigSha}`);

  // ========== 4) 批量删除一个测试文件，列表消失、无 pageerror ==========
  await page.evaluate(email => window.App.selectPaths([`${email}/ui-c.txt`]), EMAIL);
  await page.waitForSelector('#batch-bar:not(.hide)', { timeout: 3000 });
  await page.click('#batch-delete');
  await new Promise(r => setTimeout(r, 1200));
  // 刷新页面后复核 DOM 列表（避免删除后局部重渲染时序干扰断言）
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row, .file-card, .empty', { timeout: 8000 });
  const afterRows = await page.$$eval('.file-row, .file-card', els => els.map(r => r.getAttribute('data-path')));
  check('断言. 批量删除后 ui-c.txt 从列表消失', !afterRows.includes(`${EMAIL}/ui-c.txt`), `rows=${afterRows.join(',')}`);

  // 服务端复核：ui-c.txt 已软删（列表接口不再返回）
  const list = await api('GET', BASE + '/api/files?path=' + encodeURIComponent(EMAIL), { cookie });
  const listed = (list.json?.items || []).map(i => i.path);
  check('断言. 服务端列表不再包含 ui-c.txt', !listed.includes(`${EMAIL}/ui-c.txt`), `items=${listed.join(',')}`);

  // ========== 5) pageerror / console error 计数必须为 0 ==========
  check('断言. 全程无 pageerror', pageErrors.length === 0, `count=${pageErrors.length} ${pageErrors.join(' | ')}`);
  check('断言. 全程无 console error', consoleErrors.length === 0, `count=${consoleErrors.length} ${consoleErrors.join(' | ')}`);

  await browser.close();

  const fail = results.filter(r => !r.ok);
  log('\n===== 汇总 =====');
  log(`PASS=${results.length - fail.length}  FAIL=${fail.length}  总计=${results.length}`);
  log(`pageerror=${pageErrors.length}  consoleError=${consoleErrors.length}`);
  if (fail.length) { fail.forEach(f => log(` - ${f.name}: ${f.detail}`)); process.exit(1); }
  log('ALL PASS');
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
