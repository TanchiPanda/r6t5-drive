// [开发期临时脚手架，勿作为验收门] 依赖 tools/p4ui-harness.mjs 的反代（会吞 POST 体），
// 当前环境实测不稳；验收请用 tools/p4ui-verify.mjs。保留仅为历史排查参考。
// P4 前端自测：多选 / 分片上传与续传 / 打包下载 / 压缩 / 解压 / 只读禁用。
// 前置：主服务 8110（uploads/files/auth）+ harness 8111（前端静态 + archive）。
// 用法：node tools/p4ui-e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('/opt/runtime/nodejs/node_modules/puppeteer-core');

const BASE = process.env.BASE || 'http://127.0.0.1:8111';
const MAIN = process.env.MAIN || 'http://127.0.0.1:8110';
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'docs', 'screenshots', 'p4');
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/chromium';
const EMAIL = 'alice@p4.test';
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

function jarOf(setCookieArr) {
  return (setCookieArr || []).map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

async function api(method, url, { cookie, json, raw, headers } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (headers) Object.assign(opts.headers, headers);
  if (json !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(json); }
  if (raw) { opts.body = raw.buffer; opts.headers['Content-Type'] = raw.contentType || 'application/octet-stream'; }
  const res = await fetch(url, opts);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  let body = null;
  if (ct.includes('json')) { try { body = JSON.parse(buf.toString('utf8')); } catch { body = buf.toString('utf8'); } }
  const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json: body, buf, headers: res.headers, set };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function login() {
  const dl = await api('POST', MAIN + '/api/auth/dev-login', { json: { email: EMAIL } });
  if (dl.status !== 200) throw new Error('dev-login 失败 ' + dl.status);
  return jarOf(dl.set);
}

// ---------- 造数据：20MB 随机文件（分片）、一个 zip 包 ----------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'p4ui-seed-'));
const BIG_SIZE = 20 * 1024 * 1024;
const bigBuf = crypto.randomBytes(BIG_SIZE);
const bigPath = path.join(WORK, 'big-20mb.bin');
fs.writeFileSync(bigPath, bigBuf);
const bigSha = sha256(bigBuf);

// 构造一个含两个文件的 zip（用后端 ZipWriter 不合适，这里直接用后端 compress 产出；
// 先上传 alpha/beta 已在 docs 下，浏览器内压缩生成 bundle.zip 作为解压源）。

async function seedBase(cookie) {
  // 根目录 + docs 目录 + 两个小文件（幂等：已存在则 409 忽略）
  await api('POST', MAIN + '/api/files/folder', { cookie, json: { path: EMAIL, name: 'docs' } });
  const up = async (dir, name, body, mime) => {
    const fd = new FormData();
    fd.append('file', new Blob([body], { type: mime || 'text/plain' }), name);
    fd.append('overwrite', '1');
    const res = await fetch(MAIN + '/api/files/upload?' + new URLSearchParams({ path: dir }), {
      method: 'POST', headers: { Cookie: cookie }, body: fd,
    });
    return res.status;
  };
  await up(EMAIL + '/docs', 'alpha.txt', 'alpha-body-0001', 'text/plain');
  await up(EMAIL + '/docs', 'beta.txt', 'beta-body-0002', 'text/plain');
  await up(EMAIL, 'note.txt', 'note-hello-p4', 'text/plain');
  // ro 只读目录节点（绑定只读卷，API 建目录被 403，直接落库）
  const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const { db } = await import(path.join(REPO, 'server/db.js'));
  const root = db.prepare('SELECT * FROM nodes WHERE path = ?').get(EMAIL);
  const existsRo = !!db.prepare('SELECT * FROM nodes WHERE path = ?').get(EMAIL + '/ro');
  console.log('[seed] REPO=', REPO, 'root=', root && root.id, 'roExists=', existsRo);
  if (root && !existsRo) {
    const id = 'n_' + crypto.randomBytes(6).toString('hex');
    const now = new Date().toISOString();
    const info = db.prepare('INSERT INTO nodes (id,email,parentId,name,path,isDir,sizeBytes,mime,deletedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)')
      .run(id, EMAIL, root.id, 'ro', EMAIL + '/ro', 1, 0, null, now, now);
    console.log('[seed] ro insert changes=', info.changes, 'id=', id);
  }
}

async function main() {
  const cookie = await login();
  await seedBase(cookie);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--lang=zh-CN'],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error') problems.push('[console] ' + m.text().slice(0, 160)); });
  page.on('pageerror', e => problems.push('[pageerror] ' + e.message.slice(0, 160)));

  // 注入登录 cookie（两个 origin 同域 127.0.0.1，共享 cookie jar）
  const [name, value] = cookie.split(';')[0].split('=');
  await page.setCookie({ name, value, domain: '127.0.0.1', path: '/', httpOnly: true });

  await page.goto(BASE + '/files?path=' + encodeURIComponent(EMAIL), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row, .file-card, .empty', { timeout: 8000 });

  // ========== 1) 多选 3 项 + 批量条 ==========
  const rows = await page.$$eval('.file-row', els => els.map(r => r.getAttribute('data-path')));
  console.log('[seed] root rows:', rows.join(', '));
  check('前置. 根目录至少 3 项可选', rows.length >= 3, `count=${rows.length}`);

  // 勾选前 3 行（直接写状态后重渲染，避免 change 时序/句柄 detach）
  const first3 = await page.$$eval('.file-row', els => els.slice(0, 3).map(r => r.getAttribute('data-path')));
  await page.evaluate(paths => window.App.selectPaths(paths), first3);
  await page.waitForSelector('#batch-bar:not(.hide)', { timeout: 4000 });
  const batchText = await page.$eval('#batch-count', el => el.textContent.trim());
  check('断言. 多选 3 项后批量条显示「3 项 / 总大小」', /3 项/.test(batchText), `text="${batchText}"`);

  await page.screenshot({ path: path.join(OUT, 'files-multiselect.png') });
  await page.screenshot({ path: path.join(OUT, 'files-batch-bar.png') });

  // 全选表头 checkbox 状态
  const headChecked = await page.$eval('#head-select-all', el => el.checked);
  check('断言. 部分选中时表头全选非全勾', headChecked === false, `checked=${headChecked}`);

  // 取消选择
  await page.click('#batch-clear');
  await page.waitForSelector('#batch-bar.hide', { timeout: 3000 });

  // ========== 2) 分片上传 20MB（进行中截图 + 完成后 sha256 比对） ==========
  // 通过 input 注入文件；>16MB 走分片
  const inputUpload = await page.$('#file-input');
  await inputUpload.uploadFile(bigPath);

  // 等待分片队列出现并进入进行中
  await page.waitForSelector('.chunk-up', { timeout: 6000 });
  await new Promise(r => setTimeout(r, 1200));
  const progressText = await page.$eval('.chunk-up .up-status', el => el.textContent.trim()).catch(() => '');
  const barNow = await page.$eval('.chunk-up .bar[role="progressbar"]', el => el.getAttribute('aria-valuenow')).catch(() => null);
  check('断言. 分片上传进度条有 aria-valuenow', barNow !== null, `aria-valuenow=${barNow} status="${progressText}"`);
  check('断言. 分片进度显示「已上传 X / Y 片」', /\d+ \/ \d+ 片/.test(progressText), `status="${progressText}"`);
  await page.screenshot({ path: path.join(OUT, 'files-chunk-upload.png') });

  // 等待完成（20MB / 8MiB = 3 片）
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('.chunk-up')];
    return rows.length === 0 || rows.every(r => /完成/.test(r.querySelector('.up-status')?.textContent || ''));
  }, { timeout: 60000 });
  await new Promise(r => setTimeout(r, 800));

  // 拉回文件比对 sha256
  const dl = await api('GET', MAIN + '/api/files/download?' + new URLSearchParams({ path: EMAIL + '/big-20mb.bin' }), { cookie });
  check('断言. 20MB 分片上传后文件存在且大小一致', dl.status === 200 && dl.buf.length === BIG_SIZE,
    `status=${dl.status} size=${dl.buf.length} expect=${BIG_SIZE}`);
  const dlSha = sha256(dl.buf);
  check('断言. 下载回文件 sha256 与源一致', dlSha === bigSha, `src=${bigSha.slice(0, 12)} dl=${dlSha.slice(0, 12)}`);

  // ========== 3) 打包下载：blob 头 4 字节 PK\x03\x04 ==========
  // 勾选 note.txt + docs 目录
  await page.evaluate((email) => {
    window.App.selectPaths([email + '/note.txt', email + '/docs']);
  }, EMAIL);
  await page.waitForSelector('#batch-bar:not(.hide)', { timeout: 3000 });

  // 拦截下载 blob
  const downloadPromise = page.waitForResponse(r => r.url().includes('/api/files/zip') && r.request().method() === 'POST', { timeout: 30000 });
  await page.click('#batch-zip');
  const zipRes = await downloadPromise;
  const zipBuf = Buffer.from(await zipRes.buffer());
  const magic = zipBuf.slice(0, 4).toString('hex');
  check('断言. 打包下载 blob 头 4 字节为 PK\\x03\\x04', magic === '504b0304', `magic=${magic} bytes=${zipBuf.length}`);
  const disp = zipRes.headers()['content-disposition'] || '';
  check('断言. Content-Disposition 含 filename*=UTF-8', /filename\*=UTF-8''/i.test(disp), `disposition=${disp}`);

  // 预检过大/条目过多提示（构造不存在路径会 404；这里用 plan 接口直接验证 tooLarge 分支不触发即可）
  const plan = await api('POST', BASE + '/api/files/zip/plan', { cookie, json: { paths: [EMAIL + '/note.txt', EMAIL + '/docs'] } });
  check('断言. zip/plan 预检返回条目与总大小', plan.status === 200 && plan.json.entries >= 2,
    `status=${plan.status} entries=${plan.json?.entries} totalBytes=${plan.json?.totalBytes}`);
  await page.screenshot({ path: path.join(OUT, 'files-zip-plan.png') });

  // ========== 4) 在线压缩：多选 docs → 生成 bundle.zip ==========
  // 先清空，再勾选 docs 目录
  await page.evaluate((email) => window.App.selectPaths([email + '/docs']), EMAIL);
  await page.waitForSelector('#batch-bar:not(.hide)', { timeout: 3000 });
  await page.click('#batch-compress');
  await page.waitForSelector('#m-compress.open', { timeout: 3000 });
  await page.$eval('#compress-name', el => { el.value = 'bundle.zip'; });
  await page.click('#compress-ok');
  await page.waitForFunction(() => {
    const t = document.body.textContent || '';
    return /已压缩/.test(t);
  }, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 600));
  const rootItems = await page.$$eval('.file-row', els => els.map(r => r.getAttribute('data-path')));
  check('断言. 压缩后列表出现 bundle.zip', rootItems.includes(EMAIL + '/bundle.zip'), `items=${rootItems.join(',')}`);

  // ========== 5) 解压 bundle.zip 到 extracted 目录 ==========
  // 先建 extracted 目录
  await api('POST', MAIN + '/api/files/folder', { cookie, json: { path: EMAIL, name: 'extracted' } });
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row', { timeout: 8000 });

  const bundleRow = await page.$$eval('.file-row', els => {
    const r = els.find(x => x.getAttribute('data-path') === EMAIL + '/bundle.zip');
    return !!r;
  });
  check('断言. 刷新后 bundle.zip 仍在', bundleRow, '');

  // 点击该行「解压」
  const extractBtn = await page.evaluateHandle((email) => {
    const rows = [...document.querySelectorAll('.file-row')];
    const r = rows.find(x => x.getAttribute('data-path') === email + '/bundle.zip');
    return r ? r.querySelector('[data-op="extract"]') : null;
  }, EMAIL);
  check('断言. zip 行内出现「解压」按钮', !!extractBtn.asElement(), '');
  await extractBtn.asElement().click();
  await page.waitForSelector('#m-extract.open', { timeout: 3000 });
  // 目标目录选 extracted
  await page.$eval('#extract-target-dir', el => { el.value = el.options[el.options.length - 1].value; });
  await page.click('#extract-ok');
  await page.waitForFunction(() => /解压完成/.test(document.body.textContent || ''), { timeout: 20000 });
  await new Promise(r => setTimeout(r, 500));

  const ex = await api('GET', MAIN + '/api/files?path=' + encodeURIComponent(EMAIL + '/extracted'), { cookie });
  const exNames = (ex.json?.items || []).map(i => i.name).sort();
  check('断言. 解压后目录出现原文件名', exNames.includes('alpha.txt') && exNames.includes('beta.txt'), `items=${exNames.join(',')}`);
  await page.screenshot({ path: path.join(OUT, 'files-extract.png') });

  // ========== 6) 只读目录：批量删除按钮 disabled ==========
  await page.goto(BASE + '/files?path=' + encodeURIComponent(EMAIL + '/ro'), { waitUntil: 'networkidle0' });
  await page.waitForSelector('.file-row, .empty', { timeout: 8000 });
  // 只读目录下若有可勾选项，勾选后检查批量删除禁用；若无项，直接检查上传/新建禁用
  const roUploadDisabled = await page.$eval('#upload-btn', el => el.disabled);
  const roMkdirDisabled = await page.$eval('#mkdir-btn', el => el.disabled);
  check('断言. 只读目录上传/新建按钮禁用', roUploadDisabled && roMkdirDisabled, `upload=${roUploadDisabled} mkdir=${roMkdirDisabled}`);

  // ========== 7) 续传：中途 abort 后会话仍在，可续传完成 ==========
  // 回到根目录，直接走 API 造一个未完成会话（init + 传第 0 片），再刷新页面验证续传提示
  const init = await api('POST', MAIN + '/api/uploads/init', {
    cookie, json: { parentPath: EMAIL, name: 'resume.bin', sizeBytes: BIG_SIZE, chunkSize: 8 * 1024 * 1024 },
  });
  check('断言. init 分片会话 201', init.status === 201, `status=${init.status} id=${init.json?.uploadId}`);
  const uid = init.json.uploadId;
  // 只传第 0 片，模拟中途 abort
  const part0 = bigBuf.slice(0, 8 * 1024 * 1024);
  const put0 = await api('PUT', MAIN + `/api/uploads/${uid}/part/0`, { cookie, raw: { buffer: part0, contentType: 'application/octet-stream' } });
  check('断言. 首片 PUT 200', put0.status === 200, `status=${put0.status} received=${put0.json?.receivedCount}`);

  await page.goto(BASE + '/files?path=' + encodeURIComponent(EMAIL), { waitUntil: 'networkidle0' });
  await page.waitForSelector('#resume-banner:not(.hide)', { timeout: 5000 });
  const bannerText = await page.$eval('#resume-banner-text', el => el.textContent.trim());
  check('断言. 重载后出现未完成上传续传提示', /未完成|片/.test(bannerText), `text="${bannerText}"`);
  await page.screenshot({ path: path.join(OUT, 'files-chunk-resume.png') });

  // 会话仍在列表
  const listSess = await api('GET', MAIN + '/api/uploads', { cookie });
  const still = (listSess.json?.items || []).some(s => s.uploadId === uid);
  check('断言. abort 后 GET /api/uploads 仍有会话', still, `sessions=${(listSess.json?.items || []).map(s => s.name).join(',')}`);

  // 续传：通过页面「继续上传」会触发文件选择；这里用 API 补齐缺失片并 complete，验证会话可续传完成
  const detail = await api('GET', MAIN + `/api/uploads/${uid}`, { cookie });
  const missing = detail.json?.item?.missing || [];
  check('断言. 会话详情返回 missing 片列表', missing.length === 2, `missing=${missing.join(',')}`);
  for (const idx of missing) {
    const start = idx * 8 * 1024 * 1024;
    const end = Math.min(start + 8 * 1024 * 1024, BIG_SIZE);
    const part = bigBuf.slice(start, end);
    const pr = await api('PUT', MAIN + `/api/uploads/${uid}/part/${idx}`, { cookie, raw: { buffer: part, contentType: 'application/octet-stream' } });
    if (pr.status !== 200) throw new Error(`续传片 ${idx} 失败 ${pr.status}`);
  }
  const complete = await api('POST', MAIN + `/api/uploads/${uid}/complete`, { cookie, json: {} });
  check('断言. 续传补齐缺失片后 complete 201', complete.status === 201, `status=${complete.status}`);
  const dl2 = await api('GET', MAIN + '/api/files/download?' + new URLSearchParams({ path: EMAIL + '/resume.bin' }), { cookie });
  check('断言. 续传完成文件大小与 sha256 一致', dl2.status === 200 && dl2.buf.length === BIG_SIZE && sha256(dl2.buf) === bigSha,
    `size=${dl2.buf.length}`);

  // 清理测试会话（resume.bin 保留在列表中以便截图？这里删掉避免污染）
  await api('DELETE', MAIN + `/api/uploads/${uid}`, { cookie });

  if (problems.length) console.log('\n[browser problems]', problems);

  await browser.close();

  const fail = results.filter(r => !r.ok);
  console.log('\n===== 汇总 =====');
  console.log(`PASS=${results.length - fail.length}  FAIL=${fail.length}  总计=${results.length}`);
  if (fail.length) { fail.forEach(f => console.log(` - ${f.name}: ${f.detail}`)); process.exit(1); }
  console.log('ALL PASS');
}

main().catch(e => { console.error('[fatal]', e); process.exit(1); });
