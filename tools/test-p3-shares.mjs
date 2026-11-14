// P3 分享功能自测。
// 用法：
//   1) 服务已起：BASE=http://127.0.0.1:8103 DB_PATH=/tmp/p3a/r6t5.db node tools/test-p3-shares.mjs
//   2) 若 /api/share 尚未挂载（404 not_found / 500），自动降级为 service 层单元级验证（临时 sqlite）。
// 退出码：全部 PASS → 0；任一 FAIL → 1。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BASE = process.env.BASE || 'http://127.0.0.1:8103';
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

async function req(method, url, { body, cookie, raw } = {}) {
  const opts = { method, headers: {} };
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
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = text; } }
  const setCookieArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setCookieArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json, text, set, headers: res.headers };
}

// ---------- 探测挂载状态 ----------
let mounted = false;
try {
  const probe = await req('GET', '/api/share/__probe_none__');
  mounted = probe.status === 404 && probe.json?.error?.code === 'share_not_found';
  console.log(`[mount] /api/share 探测 status=${probe.status} code=${probe.json?.error?.code} → mounted=${mounted}`);
} catch (e) {
  console.log(`[mount] 探测失败：${e.message} → 视为未挂载`);
  mounted = false;
}

// ====================================================================
//  HTTP 层流程（仅在已挂载时执行）
// ====================================================================
async function runHttpSuite() {
  // dev-login alice
  const dl = await req('POST', '/api/auth/dev-login', { body: { email: 'alice@p3.test' } });
  const jar = Object.entries(dl.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('HTTP. dev-login alice 200', dl.status === 200, `status=${dl.status} email=${dl.json?.user?.email}`);

  // 造目录 + 文件（本地卷）；重复跑时目录/文件已存在，409 视为幂等命中
  const mk = await req('POST', '/api/files/folder', { cookie: jar, body: { path: 'alice@p3.test', name: 'inbox' } });
  check('HTTP. 建目录 inbox 201（已存在则 409 幂等）',
    mk.status === 201 || mk.status === 409, `status=${mk.status} path=${mk.json?.path}`);

  const content = Buffer.from('hello-p3-share-' + 'x'.repeat(100));
  const fd = new FormData();
  fd.append('file', new Blob([content]), 'note.txt');
  fd.append('overwrite', '1');
  const up = await req('POST', '/api/files/upload?path=alice@p3.test/inbox', { cookie: jar, raw: { body: fd, headers: {} } });
  check('HTTP. 上传 note.txt 201', up.status === 201, `status=${up.status} size=${up.json?.item?.sizeBytes}`);

  // 1) 创建：带提取码
  const createCode = await req('POST', '/api/shares', {
    cookie: jar,
    body: { path: 'alice@p3.test/inbox/note.txt', expiresIn: '1d', code: 'abcd1234', maxDownloads: 2, allowPreview: true },
  });
  const tokenCode = createCode.json?.item?.token;
  check('HTTP. 创建带码分享 201', createCode.status === 201 && !!tokenCode,
    `status=${createCode.status} token=${tokenCode} hasCode=${createCode.json?.item?.hasCode}`);
  check('HTTP. 响应不含提取码明文', createCode.status === 201 && !createCode.text.includes('abcd1234'),
    `明文出现=${createCode.text.includes('abcd1234')}`);

  // 2) 公开 meta：locked=true
  const meta = await req('GET', `/api/share/${tokenCode}`);
  check('HTTP. meta 200 locked=true', meta.status === 200 && meta.json?.locked === true,
    `status=${meta.status} locked=${meta.json?.locked} hasCode=${meta.json?.share?.hasCode}`);

  // 3) 未解锁下载 → 401 share_code_required
  const dlLocked = await req('GET', `/api/share/${tokenCode}/download`);
  check('HTTP. 未解锁下载 401 share_code_required',
    dlLocked.status === 401 && dlLocked.json?.error?.code === 'share_code_required',
    `status=${dlLocked.status} code=${dlLocked.json?.error?.code}`);

  // 4) 错码 → 403 share_code_invalid
  const bad = await req('POST', `/api/share/${tokenCode}/unlock`, { body: { code: 'wrong00' } });
  check('HTTP. 错码 403 share_code_invalid',
    bad.status === 403 && bad.json?.error?.code === 'share_code_invalid',
    `status=${bad.status} code=${bad.json?.error?.code}`);

  // 5) 正确解锁 → 200 + cookie
  const good = await req('POST', `/api/share/${tokenCode}/unlock`, { body: { code: 'abcd1234' } });
  const shareCookie = Object.entries(good.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('HTTP. 正确解锁 200 unlocked', good.status === 200 && good.json?.unlocked === true && !!shareCookie,
    `status=${good.status} unlocked=${good.json?.unlocked} cookie=${shareCookie ? 'yes' : 'no'}`);

  // 6) 下载 200 字节一致
  const d1 = await req('GET', `/api/share/${tokenCode}/download`, { cookie: shareCookie });
  check('HTTP. 解锁后下载 200 字节一致',
    d1.status === 200 && d1.text === content.toString('utf8'),
    `status=${d1.status} bytes=${d1.text.length} expect=${content.length}`);

  // 7) downloadCount 递增；maxDownloads=2，第二次成功，第三次 410
  const meta2 = await req('GET', `/api/share/${tokenCode}`, { cookie: shareCookie });
  check('HTTP. 下载后 downloadCount=1', meta2.json?.share?.downloadCount === 1,
    `downloadCount=${meta2.json?.share?.downloadCount} remaining=${meta2.json?.share?.remaining}`);

  const d2 = await req('GET', `/api/share/${tokenCode}/download`, { cookie: shareCookie });
  check('HTTP. 第二次下载 200（额度=2）', d2.status === 200, `status=${d2.status}`);

  const d3 = await req('GET', `/api/share/${tokenCode}/download`, { cookie: shareCookie });
  check('HTTP. 超次后 410 share_exceeded',
    d3.status === 410 && d3.json?.error?.code === 'share_exceeded',
    `status=${d3.status} code=${d3.json?.error?.code}`);

  // 8) 无码永久分享
  const perm = await req('POST', '/api/shares', {
    cookie: jar, body: { path: 'alice@p3.test/inbox/note.txt', expiresIn: 'permanent', allowPreview: false },
  });
  const tokenPerm = perm.json?.item?.token;
  check('HTTP. 创建永久无码分享 201 expiresAt=null',
    perm.status === 201 && perm.json?.item?.expiresAt === null && perm.json?.item?.hasCode === false,
    `status=${perm.status} expiresAt=${perm.json?.item?.expiresAt} hasCode=${perm.json?.item?.hasCode}`);

  const metaPerm = await req('GET', `/api/share/${tokenPerm}`);
  check('HTTP. 永久分享 locked=false status=active',
    metaPerm.status === 200 && metaPerm.json?.locked === false && metaPerm.json?.share?.status === 'active',
    `status=${metaPerm.status} locked=${metaPerm.json?.locked} status=${metaPerm.json?.share?.status}`);

  // 9) 过期分享（传已过去的 ISO）
  const past = new Date(Date.now() - 3600_000).toISOString();
  const exp = await req('POST', '/api/shares', {
    cookie: jar, body: { path: 'alice@p3.test/inbox/note.txt', expiresIn: past },
  });
  const tokenExp = exp.json?.item?.token;
  const metaExp = await req('GET', `/api/share/${tokenExp}`);
  check('HTTP. 过期分享访问 410 share_expired',
    metaExp.status === 410 && metaExp.json?.error?.code === 'share_expired',
    `status=${metaExp.status} code=${metaExp.json?.error?.code}`);
  const dlExp = await req('GET', `/api/share/${tokenExp}/download`);
  check('HTTP. 过期下载 410 share_expired',
    dlExp.status === 410 && dlExp.json?.error?.code === 'share_expired',
    `status=${dlExp.status} code=${dlExp.json?.error?.code}`);

  // 10) 撤销后 410
  const del = await req('DELETE', `/api/shares/${exp.json?.item?.id}`, { cookie: jar });
  check('HTTP. 用户撤销 200', del.status === 200 && del.json?.ok === true, `status=${del.status}`);
  const metaRev = await req('GET', `/api/share/${tokenExp}`);
  check('HTTP. 撤销后访问 410 share_revoked',
    metaRev.status === 410 && metaRev.json?.error?.code === 'share_revoked',
    `status=${metaRev.status} code=${metaRev.json?.error?.code}`);
  const dlRev = await req('GET', `/api/share/${tokenExp}/download`);
  check('HTTP. 撤销下载 410 share_revoked',
    dlRev.status === 410 && dlRev.json?.error?.code === 'share_revoked',
    `status=${dlRev.status} code=${dlRev.json?.error?.code}`);

  // 11) 目录分享 list + 越界 403
  const dir = await req('POST', '/api/shares', {
    cookie: jar, body: { path: 'alice@p3.test/inbox', expiresIn: '7d' },
  });
  const tokenDir = dir.json?.item?.token;
  check('HTTP. 创建目录分享 201 isDir=true', dir.status === 201 && dir.json?.item?.isDir === true,
    `status=${dir.status} isDir=${dir.json?.item?.isDir}`);
  const list = await req('GET', `/api/share/${tokenDir}/list`);
  check('HTTP. 目录 list 200 含 note.txt',
    list.status === 200 && list.json?.items?.some((i) => i.name === 'note.txt'),
    `status=${list.status} items=${list.json?.items?.map((i) => i.name).join(',')}`);
  const escape = await req('GET', `/api/share/${tokenDir}/list?path=alice@p3.test`);
  check('HTTP. 越界路径 403 forbidden',
    escape.status === 403 && escape.json?.error?.code === 'forbidden',
    `status=${escape.status} code=${escape.json?.error?.code}`);

  // 12) 管理端列表 + 管理端撤销
  const adminLogin = await req('POST', '/api/admin/login', { body: { password: process.env.ADMIN_PASSWORD || 'test123' } });
  const adminJar = Object.entries(adminLogin.set).map(([k, v]) => `${k}=${v}`).join('; ');
  const adminList = await req('GET', '/api/admin/shares', { cookie: adminJar });
  const inAdmin = (adminList.json?.items || []).some((i) => i.token === tokenDir);
  check('HTTP. 管理端列表能看到目录分享', adminList.status === 200 && inAdmin,
    `status=${adminList.status} total=${adminList.json?.total} has=${inAdmin}`);
  const adminRev = await req('DELETE', `/api/admin/shares/${dir.json?.item?.id}`, { cookie: adminJar });
  check('HTTP. 管理端撤销 200', adminRev.status === 200 && adminRev.json?.ok === true, `status=${adminRev.status}`);
  const afterRev = await req('GET', `/api/share/${tokenDir}`);
  check('HTTP. 管理端撤销后 410 share_revoked',
    afterRev.status === 410 && afterRev.json?.error?.code === 'share_revoked',
    `status=${afterRev.status} code=${afterRev.json?.error?.code}`);

  // 13) 响应里 grep 不到提取码明文
  const allTexts = JSON.stringify({ meta, metaPerm, list, adminList });
  check('HTTP. 汇总响应不含提取码明文 abcd1234', !allTexts.includes('abcd1234'),
    `明文出现=${allTexts.includes('abcd1234')}`);
}

// ====================================================================
//  Service 层单元验证（临时 sqlite，不依赖 app.js 挂载）
// ====================================================================
async function runServiceSuite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-unit-'));
  process.env.DB_PATH = path.join(tmp, 'unit.db');
  process.env.STORAGE_ROOT = path.join(tmp, 'vol');
  process.env.DEV_AUTH = '1';
  fs.mkdirSync(process.env.STORAGE_ROOT, { recursive: true });

  const { migrate, db } = await import('../server/db.js');
  migrate();

  // 播种组 + volume 策略 + 用户 + 根目录 + 文件
  const { upsertUser, ensureRootNode: _ } = await import('../server/services/nodes.js');
  // ensureRootNode 在 files 路由里，service/nodes 没有；直接插根节点
  const { genId, nowIso } = await import('../server/lib/format.js');
  const email = 'alice@unit.test';
  upsertUser({ id: genId('u'), email });
  db.prepare('INSERT INTO storage_strategies (id,name,type,region,capacityBytes,usedBytes,readOnly,enabled,config,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(genId('s'), '本地卷', 'volume', '本机', 107374182400, 0, 0, 1, JSON.stringify({}), nowIso());

  // 根目录
  db.prepare('INSERT INTO nodes (id,email,parentId,name,path,isDir,sizeBytes,mime,deletedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)')
    .run(genId('n'), email, null, email, email, 1, 0, null, nowIso(), nowIso());
  const root = db.prepare('SELECT * FROM nodes WHERE path = ?').get(email);

  const fileContent = 'unit-share-body-12345';
  const relDir = 'inbox';
  const dirPath = `${email}/${relDir}`;
  db.prepare('INSERT INTO nodes (id,email,parentId,name,path,isDir,sizeBytes,mime,deletedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)')
    .run(genId('n'), email, root.id, relDir, dirPath, 1, 0, null, nowIso(), nowIso());
  const dirNode = db.prepare('SELECT * FROM nodes WHERE path = ?').get(dirPath);

  const fileName = 'note.txt';
  const filePath = `${dirPath}/${fileName}`;
  const phys = path.join(process.env.STORAGE_ROOT, email, relDir, fileName);
  fs.mkdirSync(path.dirname(phys), { recursive: true });
  fs.writeFileSync(phys, fileContent, 'utf8');
  db.prepare('INSERT INTO nodes (id,email,parentId,name,path,isDir,sizeBytes,mime,deletedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,NULL,?,?)')
    .run(genId('n'), email, dirNode.id, fileName, filePath, 0, Buffer.byteLength(fileContent), 'text/plain', nowIso(), nowIso());

  const shares = await import('../server/services/shares.js');

  const user = { email, groupId: null };

  // 创建：无码永久
  const sPerm = shares.createShare(user, { path: filePath, expiresIn: 'permanent', allowPreview: true });
  check('UNIT. 创建永久无码分享', sPerm.hasCode === false && sPerm.expiresAt === null && sPerm.status === 'active',
    `hasCode=${sPerm.hasCode} expiresAt=${sPerm.expiresAt} status=${sPerm.status} url=${sPerm.url}`);
  check('UNIT. 序列化不含 codeHash/codeSalt 明文', !('codeHash' in sPerm) && !('codeSalt' in sPerm),
    `keys=${Object.keys(sPerm).join(',')}`);

  // 创建：带码 1d
  const sCode = shares.createShare(user, { path: filePath, expiresIn: '1d', code: 'wxyz99', maxDownloads: 3 });
  check('UNIT. 创建带码 1d 分享 hasCode=true', sCode.hasCode === true && sCode.maxDownloads === 3,
    `hasCode=${sCode.hasCode} maxDownloads=${sCode.maxDownloads} expiresAt=${sCode.expiresAt}`);

  // 创建：30d
  const s30 = shares.createShare(user, { path: filePath, expiresIn: '30d' });
  const days30 = (Date.parse(s30.expiresAt) - Date.now()) / 86400000;
  check('UNIT. expiresIn=30d 约 30 天后过期', days30 > 29 && days30 < 31, `days=${days30.toFixed(2)}`);

  // 创建：自定义 ISO（过去）
  const past = new Date(Date.now() - 600_000).toISOString();
  const sExp = shares.createShare(user, { path: filePath, expiresIn: past });
  check('UNIT. 自定义过去 ISO → status=expired', sExp.status === 'expired', `status=${sExp.status} expiresAt=${sExp.expiresAt}`);

  // 列表：自己的，倒序
  const mine = shares.listMyShares(email);
  check('UNIT. 列表只含自己且倒序', mine.length >= 3 && mine[0].createdAt >= mine[mine.length - 1].createdAt,
    `count=${mine.length}`);

  // 详情：不属于自己 → 404
  let notOwned = false;
  try { shares.getMyShare(sPerm.id, 'stranger@unit.test'); } catch (e) { notOwned = e.code === 'share_not_found'; }
  check('UNIT. 他人访问详情 404 share_not_found', notOwned, `notOwned=${notOwned}`);

  // 公开 meta：带码 locked=true
  const rowCode = shares.loadActiveShare(sCode.token);
  const metaCode = shares.publicMeta(rowCode);
  check('UNIT. 带码 meta remaining=3', metaCode.remaining === 3 && metaCode.hasCode === true,
    `remaining=${metaCode.remaining} hasCode=${metaCode.hasCode}`);

  // 解锁：错码
  let badCode = false;
  try { shares.unlockShare(rowCode, 'nope1', '127.0.0.1'); } catch (e) { badCode = e.code === 'share_code_invalid'; }
  check('UNIT. 错码 share_code_invalid', badCode, `badCode=${badCode}`);

  // 5 次错误后锁定：新建一条带码分享专门压限流
  const lockShare = shares.createShare(user, { path: filePath, code: 'lockcode1' });
  const lockRow = db.prepare('SELECT * FROM shares WHERE token=?').get(lockShare.token);
  let lockoutHit = false;
  for (let i = 0; i < 6; i += 1) {
    let threw = false;
    try { shares.unlockShare(lockRow, 'badcode', '10.0.0.9'); } catch (e) { threw = e.code === 'share_code_invalid'; }
    if (i === 5 && threw) lockoutHit = true;
  }
  check('UNIT. 连续错 5 次后第 6 次仍 403（限流）', lockoutHit, `lockoutHit=${lockoutHit}`);

  // 解锁：正确
  const un = shares.unlockShare(rowCode, 'wxyz99', '127.0.0.1');
  check('UNIT. 正确解锁 unlocked=true', un.ok === true && un.unlocked === true, `unlocked=${un.unlocked}`);
  const cookie = shares.unlockCookie(rowCode);
  check('UNIT. 解锁 cookie 名前缀 r6t5_share_', cookie.startsWith(`r6t5_share_${rowCode.token.slice(0, 8)}=`),
    `cookie=${cookie.split(';')[0]}`);

  // 目录分享 list
  const sDir = shares.createShare(user, { path: dirPath, expiresIn: '7d' });
  const rowDir = db.prepare('SELECT * FROM shares WHERE token=?').get(sDir.token);
  const listing = await shares.listShareDir(rowDir, undefined);
  check('UNIT. 目录 list 含 note.txt', listing.items.some((i) => i.name === 'note.txt'),
    `items=${listing.items.map((i) => i.name).join(',')}`);

  // 越界路径
  let escaped = false;
  let escapeErr = null;
  try { await shares.listShareDir(rowDir, email); }
  catch (e) { escapeErr = e; escaped = e.code === 'forbidden'; }
  check('UNIT. 越界路径 403 forbidden', escaped, `escaped=${escaped} err=${escapeErr?.status}/${escapeErr?.code}/${escapeErr?.message}`);

  // 下载记账：recordDownloadHit
  shares.recordDownloadHit(rowCode, { email, ip: '127.0.0.1', bytes: Buffer.byteLength(fileContent) });
  const after = db.prepare('SELECT downloadCount FROM shares WHERE id=?').get(rowCode.id);
  check('UNIT. 下载后 downloadCount=1', Number(after.downloadCount) === 1, `downloadCount=${after.downloadCount}`);
  const hit = db.prepare('SELECT * FROM share_hits WHERE shareId=?').get(rowCode.id);
  check('UNIT. 写了 share_hits 记录', !!hit && hit.action === 'download', `hit=${!!hit}`);

  // 超次：maxDownloads=3，已 1 次；再记 2 次后第 4 次 loadActive 应 410
  shares.recordDownloadHit(rowCode, { email, ip: '127.0.0.1', bytes: 10 });
  shares.recordDownloadHit(rowCode, { email, ip: '127.0.0.1', bytes: 10 });
  let exceeded = false;
  try { shares.loadActiveShare(sCode.token); } catch (e) { exceeded = e.code === 'share_exceeded'; }
  check('UNIT. 超次后 share_exceeded', exceeded, `exceeded=${exceeded}`);

  // 撤销
  shares.revokeMyShare(sPerm.id, email);
  let revoked = false;
  try { shares.loadActiveShare(sPerm.token); } catch (e) { revoked = e.code === 'share_revoked'; }
  check('UNIT. 撤销后 share_revoked', revoked, `revoked=${revoked}`);
  // 幂等再删
  const again = shares.revokeMyShare(sPerm.id, email);
  check('UNIT. 重复撤销幂等 ok=true', again.ok === true, `again=${JSON.stringify(again)}`);

  // 管理端列表
  const admin = shares.adminListShares({});
  check('UNIT. 管理端列表含全部分享', admin.total >= 4, `total=${admin.total}`);
  const adminRev = shares.adminRevokeShare(sDir.id, 'admin');
  check('UNIT. 管理端撤销 ok=true', adminRev.ok === true, `ok=${adminRev.ok}`);

  // 审计：share_create / share_revoke 都落库
  const aud = db.prepare("SELECT action, COUNT(*) AS n FROM audit WHERE action IN ('share_create','share_revoke') GROUP BY action").all();
  const createAudit = aud.find((a) => a.action === 'share_create');
  const revokeAudit = aud.find((a) => a.action === 'share_revoke');
  check('UNIT. 审计含 share_create / share_revoke', !!createAudit && !!revokeAudit,
    `create=${createAudit?.n} revoke=${revokeAudit?.n}`);

  // 响应整体不含提取码明文
  const dump = JSON.stringify({ mine, admin });
  check('UNIT. 序列化响应不含提取码明文 wxyz99', !dump.includes('wxyz99'), `明文出现=${dump.includes('wxyz99')}`);

  db.close();
}

// ---------- 主流程 ----------
try {
  if (mounted) {
    await runHttpSuite();
  } else {
    console.log('[mount] /api/share 未挂载，跳过 HTTP 流程，进入 service 层单元验证。');
  }
  await runServiceSuite();
} catch (e) {
  console.error('[fatal]', e);
  results.push({ name: 'fatal', ok: false, detail: e.message });
}

const fail = results.filter((r) => !r.ok);
console.log('\n===== 汇总 =====');
console.log(`PASS=${results.length - fail.length}  FAIL=${fail.length}  总计=${results.length}`);
if (fail.length) {
  console.log('失败项：');
  for (const f of fail) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log('ALL PASS');
