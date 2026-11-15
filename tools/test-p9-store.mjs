// P9-C 积分 / 商店 / 兑换码 / 付费分享 后端自测。
// 用法（隔离实例，干净库 + 独立进程）：
//   rm -rf /tmp/p9c && mkdir -p /tmp/p9c/volume
//   DB_PATH=/tmp/p9c/r6t5.db STORAGE_ROOT=/tmp/p9c/volume PORT=8197 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
//   DB_PATH=/tmp/p9c/r6t5.db BASE=http://127.0.0.1:8197 node tools/test-p9-store.mjs
// 纯 HTTP + 直查库造数据 / 断言；退出码：全部 PASS → 0，任一 FAIL → 1。
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE || 'http://127.0.0.1:8197';
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data/r6t5.db');
// 测试需要直查库断言 + 少量造数（如把 groupExpiresAt 改到过去触发 Cron），故以读写模式打开。
const db = new Database(DB_PATH);

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

const jar = { admin: '', alice: '', bob: '', carol: '' };
function jarStr(k) { return Object.entries(jar[k]).map(([a, b]) => `${a}=${b}`).join('; '); }

function dbAll(sql, ...p) { return db.prepare(sql).all(...p); }
function dbGet(sql, ...p) { return db.prepare(sql).get(...p); }

const MB = 1024 * 1024;

// ====================================================================
// 0. 登录
// ====================================================================
{
  const admin = await req('POST', '/api/admin/login', { body: { password: 'test123' } });
  jar.admin = admin.set;
  check('0a. 管理员登录 200', admin.status === 200 && !!jarStr('admin'), `status=${admin.status}`);

  for (const [k, email] of [['alice', 'alice@p9c.test'], ['bob', 'bob@p9c.test'], ['carol', 'carol@p9c.test']]) {
    const r = await req('POST', '/api/auth/dev-login', { body: { email } });
    jar[k] = r.set;
    check(`0b. dev-login ${email} 200`, r.status === 200, `status=${r.status}`);
  }

  // 造一条本机 volume 策略（否则建目录 / 上传报 storage_not_configured）
  const st = await req('GET', '/api/admin/storage', { cookie: jarStr('admin') });
  const vol = (st.json?.items || []).find((s) => s.type === 'volume' && s.enabled);
  if (!vol) {
    const c = await req('POST', '/api/admin/storage', {
      cookie: jarStr('admin'),
      body: { name: '本地卷', type: 'volume', capacityBytes: 107374182400, acknowledgeDisclosure: true, config: {} },
    });
    check('0c. 创建 volume 存储策略 201', c.status === 201, `status=${c.status}`);
  } else {
    check('0c. 复用已有 volume 策略', true, `id=${vol.id}`);
  }
}

// ====================================================================
// 1. 建目标用户组（VIP）
// ====================================================================
let vipGroupId = null;
{
  const r = await req('POST', '/api/admin/groups', {
    cookie: jarStr('admin'),
    body: { name: 'VIP 会员组', spaceLimitBytes: '20480', maxFileSizeBytes: '2048', traffic7dLimitBytes: '5120' },
  });
  vipGroupId = r.json?.item?.id;
  check('1. 创建 VIP 用户组 201', r.status === 201 && !!vipGroupId, `status=${r.status} id=${vipGroupId}`);
}

// ====================================================================
// 2. 商品 CRUD
// ====================================================================
const products = {};
{
  const mk = await req('POST', '/api/admin/store/products', {
    cookie: jarStr('admin'),
    body: {
      name: '100MB 永久容量包', type: 'storage_pack', storageBytes: String(100 * MB),
      durationDays: 0, priceMinor: 0, pointsPrice: 100, allowPoints: 1, sort: 1,
    },
  });
  products.pack100 = mk.json?.item?.id;
  check('2a. 建 storage_pack 100MB/永久 201', mk.status === 201 && !!products.pack100, `status=${mk.status} id=${products.pack100}`);

  const up = await req('POST', '/api/admin/store/products', {
    cookie: jarStr('admin'),
    body: {
      name: 'VIP 会员 30 天', type: 'group_upgrade', groupId: vipGroupId,
      durationDays: 30, priceMinor: 0, pointsPrice: 200, allowPoints: 1, sort: 2,
    },
  });
  products.vip30 = up.json?.item?.id;
  check('2b. 建 group_upgrade 30 天 201', up.status === 201 && !!products.vip30, `status=${up.status} id=${products.vip30}`);

  const sm = await req('POST', '/api/admin/store/products', {
    cookie: jarStr('admin'),
    body: {
      name: '10MB 体验包', type: 'storage_pack', storageBytes: String(10 * MB),
      durationDays: 30, priceMinor: 100, pointsPrice: 50, allowPoints: 1, sort: 3,
    },
  });
  products.pack10 = sm.json?.item?.id;
  check('2c. 建 points 商品（10MB 体验包）201', sm.status === 201 && !!products.pack10, `status=${sm.status}`);

  const off = await req('POST', '/api/admin/store/products', {
    cookie: jarStr('admin'),
    body: { name: '已下架商品', type: 'storage_pack', storageBytes: String(5 * MB), durationDays: 0, priceMinor: 0, pointsPrice: 10, enabled: 1 },
  });
  products.off = off.json?.item?.id;
  await req('DELETE', `/api/admin/store/products/${products.off}`, { cookie: jarStr('admin') });

  const pub = await req('GET', '/api/store/products', { cookie: jarStr('alice') });
  const pubIds = (pub.json?.items || []).map((p) => p.id);
  check('2d. 用户端只见 enabled 商品（3 个，不含下架）',
    pub.status === 200 && pubIds.length === 3 && !pubIds.includes(products.off),
    `count=${pubIds.length} off=${pubIds.includes(products.off)}`);

  const adm = await req('GET', '/api/admin/store/products', { cookie: jarStr('admin') });
  const admIds = (adm.json?.items || []).map((p) => p.id);
  check('2e. 管理端商品列表含下架商品', adm.status === 200 && admIds.includes(products.off), `count=${admIds.length}`);
}

// ====================================================================
// 3. 积分：admin adjust → me.points
// ====================================================================
{
  const adj = await req('POST', '/api/admin/points/adjust', {
    cookie: jarStr('admin'), body: { email: 'alice@p9c.test', delta: 1000, note: '测试充值' },
  });
  check('3a. admin adjust +1000 200', adj.status === 200 && adj.json?.points === 1000, `status=${adj.status} body=${JSON.stringify(adj.json)}`);

  const me = await req('GET', '/api/store/me', { cookie: jarStr('alice') });
  check('3b. GET /api/store/me.points=1000', me.status === 200 && me.json?.points === 1000, `points=${me.json?.points}`);
}

// ====================================================================
// 4. 积分买容量包：扣分 + grant + 配额增加（BigInt）
// ====================================================================
let baseLimit = null;
{
  const me0 = await req('GET', '/api/me', { cookie: jarStr('alice') });
  baseLimit = me0.json?.quota?.spaceLimitBytes;
  check('4a. 购买前配额基线可读', !!baseLimit, `limit=${baseLimit}`);

  const od = await req('POST', '/api/store/orders', { cookie: jarStr('alice'), body: { productId: products.pack100 } });
  check('4b. 建积分待支付单 201 pending', od.status === 201 && od.json?.orderNo, `status=${od.status} orderNo=${od.json?.orderNo}`);
  const orderNo = od.json.orderNo;

  const pay = await req('POST', `/api/store/orders/${orderNo}/pay-points`, { cookie: jarStr('alice') });
  check('4c. pay-points 200 且订单 paid', pay.status === 200 && pay.json?.order?.status === 'paid', `status=${pay.status} order=${pay.json?.order?.status}`);

  const me1 = await req('GET', '/api/store/me', { cookie: jarStr('alice') });
  check('4d. 积分变为 900', me1.json?.points === 900, `points=${me1.json?.points}`);

  const grant = dbGet('SELECT * FROM storage_grants WHERE orderId = ?', pay.json.order.id);
  check('4e. storage_grants 有记录（永久）', !!grant && grant.bytes === String(100 * MB) && grant.expiresAt == null,
    `bytes=${grant?.bytes} expiresAt=${grant?.expiresAt}`);

  const meQ = await req('GET', '/api/me', { cookie: jarStr('alice') });
  const expectLimit = (BigInt(baseLimit) + BigInt(100 * MB)).toString();
  check('4f. /api/me 配额增加 100MB（BigInt 十进制字符串）',
    meQ.json?.quota?.spaceLimitBytes === expectLimit, `limit=${meQ.json?.quota?.spaceLimitBytes} expect=${expectLimit}`);
}

// ====================================================================
// 5. 现金单：pending 不发权益 → mark-paid 发放 → refund 回收
// ====================================================================
{
  const before = dbGet('SELECT COUNT(*) AS n FROM storage_grants WHERE orderId IS NOT NULL').n;
  const od = await req('POST', '/api/store/orders', { cookie: jarStr('alice'), body: { productId: products.pack10 } });
  check('5a. 现金单 201 pending', od.status === 201 && od.json?.orderNo, `status=${od.status}`);
  const orderNo = od.json.orderNo;
  const order = dbGet('SELECT * FROM orders WHERE orderNo = ?', orderNo);
  check('5b. 订单状态 pending / channel manual', order.status === 'pending' && order.channel === 'manual', `status=${order.status} channel=${order.channel}`);

  // 未 mark-paid 前权益不发放
  const grantBefore = dbGet('SELECT * FROM storage_grants WHERE orderId = ?', order.id);
  check('5c. mark-paid 前无容量 grant', !grantBefore, `grant=${!!grantBefore}`);
  const meQ0 = await req('GET', '/api/me', { cookie: jarStr('alice') });
  check('5d. mark-paid 前配额未变', meQ0.json?.quota?.spaceLimitBytes === (BigInt(baseLimit) + BigInt(100 * MB)).toString(),
    `limit=${meQ0.json?.quota?.spaceLimitBytes}`);

  const paid = await req('POST', `/api/admin/store/orders/${orderNo}/mark-paid`, { cookie: jarStr('admin') });
  check('5e. mark-paid 200 → paid', paid.status === 200 && paid.json?.order?.status === 'paid', `status=${paid.status} order=${paid.json?.order?.status}`);
  const grantAfter = dbGet('SELECT * FROM storage_grants WHERE orderId = ?', order.id);
  check('5f. mark-paid 后 grant 已发放', !!grantAfter, `grant=${!!grantAfter}`);
  const auditMark = dbGet("SELECT * FROM audit WHERE action = 'order_mark_paid' AND target = ?", orderNo);
  check('5g. 审计 order_mark_paid 已写', !!auditMark, `audit=${!!auditMark}`);

  const refund = await req('POST', `/api/admin/store/orders/${orderNo}/refund`, { cookie: jarStr('admin') });
  check('5h. refund 200 → refunded', refund.status === 200 && refund.json?.order?.status === 'refunded', `status=${refund.status}`);
  const grantRevoked = dbGet('SELECT * FROM storage_grants WHERE orderId = ?', order.id);
  check('5i. 退款后容量 grant 撤销', !grantRevoked, `grant=${!!grantRevoked}`);
  const auditRefund = dbGet("SELECT * FROM audit WHERE action = 'order_refund' AND target = ?", orderNo);
  check('5j. 审计 order_refund 已写', !!auditRefund, `audit=${!!auditRefund}`);
  void before;
}

// ====================================================================
// 6. 会员：买 group_upgrade → 组 + groupExpiresAt；Cron 到期降级
// ====================================================================
{
  const pay = await req('POST', '/api/store/orders', { cookie: jarStr('alice'), body: { productId: products.vip30 } });
  const orderNo = pay.json.orderNo;
  const paid = await req('POST', `/api/store/orders/${orderNo}/pay-points`, { cookie: jarStr('alice') });
  check('6a. 积分买 VIP 30 天 200', paid.status === 200 && paid.json?.order?.status === 'paid', `status=${paid.status}`);

  const me = await req('GET', '/api/store/me', { cookie: jarStr('alice') });
  check('6b. 组切换到 VIP', me.json?.groupId === vipGroupId, `groupId=${me.json?.groupId} expect=${vipGroupId}`);
  const u = dbGet('SELECT groupId, groupExpiresAt FROM users WHERE email = ?', 'alice@p9c.test');
  check('6c. groupExpiresAt 已写入（未来时间）', !!u.groupExpiresAt && Date.parse(u.groupExpiresAt) > Date.now(), `exp=${u.groupExpiresAt}`);

  // 手工把到期时间改成过去，触发 ban Cron
  db.prepare('UPDATE users SET groupExpiresAt = ? WHERE email = ?').run(new Date(Date.now() - 3600_000).toISOString(), 'alice@p9c.test');
  await req('PATCH', '/api/admin/store/settings', { cookie: jarStr('admin'), body: { 'billing.cronBanExpr': '@every 1m' } });
  const run = await req('POST', '/api/admin/store/cron/ban/run', { cookie: jarStr('admin') });
  check('6d. 手动触发 ban Cron 200', run.status === 200 && run.json?.lastOk !== false, `status=${run.status} result=${JSON.stringify(run.json?.lastResult)}`);

  const u2 = dbGet('SELECT groupId, groupExpiresAt FROM users WHERE email = ?', 'alice@p9c.test');
  const def = dbGet('SELECT id FROM groups WHERE isDefault = 1');
  check('6e. 到期后回默认组并清空 groupExpiresAt', u2.groupId === def.id && u2.groupExpiresAt == null,
    `groupId=${u2.groupId} def=${def.id} exp=${u2.groupExpiresAt}`);
  const auditExp = dbGet("SELECT * FROM audit WHERE action = 'group_expired' AND email = ?", 'alice@p9c.test');
  check('6f. 审计 group_expired 已写', !!auditExp, `audit=${!!auditExp}`);
}

// ====================================================================
// 7. 兑换码
// ====================================================================
let batchCodes = [];
{
  const gen = await req('POST', '/api/admin/store/redeem-codes', {
    cookie: jarStr('admin'),
    body: { count: 5, prefix: 'T9C', type: 'points', points: 100, maxUses: 1 },
  });
  batchCodes = gen.json?.codes || [];
  check('7a. 批量生成 5 个码（前缀生效）', gen.status === 201 && batchCodes.length === 5 && batchCodes.every((c) => c.startsWith('T9C')),
    `count=${batchCodes.length} sample=${batchCodes[0]}`);

  const csv = await req('GET', '/api/admin/store/redeem-codes/export.csv', { cookie: jarStr('admin') });
  const rows = csv.text.trim().split(/\r?\n/);
  check('7b. CSV 导出 Content-Type: text/csv 且含 5 行数据',
    csv.headers.get('content-type')?.includes('text/csv') && rows.length === 6,
    `ct=${csv.headers.get('content-type')} rows=${rows.length}`);

  // bob 兑换成功一次
  const r1 = await req('POST', '/api/store/redeem', { cookie: jarStr('bob'), body: { code: batchCodes[0] } });
  check('7c. 兑换成功 200', r1.status === 200 && r1.json?.type === 'points', `status=${r1.status} body=${JSON.stringify(r1.json)}`);
  const meBob = await req('GET', '/api/store/me', { cookie: jarStr('bob') });
  check('7d. bob 积分 +100', meBob.json?.points === 100, `points=${meBob.json?.points}`);

  // 二次兑换 → 409 already_used
  const r2 = await req('POST', '/api/store/redeem', { cookie: jarStr('bob'), body: { code: batchCodes[0] } });
  check('7e. 二次兑换 409 redeem_code_already_used', r2.status === 409 && r2.json?.error?.code === 'redeem_code_already_used',
    `status=${r2.status} code=${r2.json?.error?.code}`);

  // 次数用尽：batchCodes[1] 由 bob 用掉，alice 再用 → exhausted
  await req('POST', '/api/store/redeem', { cookie: jarStr('bob'), body: { code: batchCodes[1] } });
  const r3 = await req('POST', '/api/store/redeem', { cookie: jarStr('alice'), body: { code: batchCodes[1] } });
  check('7f. 次数用尽 400 redeem_code_exhausted', r3.status === 400 && r3.json?.error?.code === 'redeem_code_exhausted',
    `status=${r3.status} code=${r3.json?.error?.code}`);

  // 绑定邮箱不符
  const bound = await req('POST', '/api/admin/store/redeem-codes', {
    cookie: jarStr('admin'), body: { count: 1, prefix: 'BND', type: 'points', points: 10, boundEmail: 'alice@p9c.test' },
  });
  const boundCode = bound.json.codes[0];
  const r4 = await req('POST', '/api/store/redeem', { cookie: jarStr('carol'), body: { code: boundCode } });
  check('7g. 绑定邮箱不符 400 redeem_code_email_mismatch', r4.status === 400 && r4.json?.error?.code === 'redeem_code_email_mismatch',
    `status=${r4.status} code=${r4.json?.error?.code}`);
  const r4b = await req('POST', '/api/store/redeem', { cookie: jarStr('alice'), body: { code: boundCode } });
  check('7h. 绑定邮箱本人兑换成功', r4b.status === 200, `status=${r4b.status}`);

  // 禁用
  const dis = await req('POST', '/api/admin/store/redeem-codes', {
    cookie: jarStr('admin'), body: { count: 1, prefix: 'DIS', type: 'points', points: 10 },
  });
  const disCode = dis.json.codes[0];
  await req('PATCH', `/api/admin/store/redeem-codes/${disCode}`, { cookie: jarStr('admin'), body: {} });
  const r5 = await req('POST', '/api/store/redeem', { cookie: jarStr('carol'), body: { code: disCode } });
  check('7i. 禁用后 400 redeem_code_disabled', r5.status === 400 && r5.json?.error?.code === 'redeem_code_disabled',
    `status=${r5.status} code=${r5.json?.error?.code}`);

  // 过期
  const exp = await req('POST', '/api/admin/store/redeem-codes', {
    cookie: jarStr('admin'),
    body: { count: 1, prefix: 'EXP', type: 'points', points: 10, expiresAt: new Date(Date.now() - 3600_000).toISOString() },
  });
  const expCode = exp.json.codes[0];
  const r6 = await req('POST', '/api/store/redeem', { cookie: jarStr('carol'), body: { code: expCode } });
  check('7j. 过期 400 redeem_code_expired', r6.status === 400 && r6.json?.error?.code === 'redeem_code_expired',
    `status=${r6.status} code=${r6.json?.error?.code}`);

  // 预览接口
  const pv = await req('GET', `/api/store/redeem/${batchCodes[2]}/preview`, { cookie: jarStr('carol') });
  check('7k. preview 返回类型/额度且 available', pv.status === 200 && pv.json?.item?.type === 'points' && pv.json?.item?.available === true,
    `status=${pv.status} body=${JSON.stringify(pv.json?.item)}`);
}

// ====================================================================
// 8. 付费分享
// ====================================================================
let shareToken = null;
{
  // alice 造目录 + 文件
  await req('POST', '/api/files/folder', { cookie: jarStr('alice'), body: { path: 'alice@p9c.test', name: 'paid' } });
  const content = Buffer.from('hello-p9c-paid-' + 'y'.repeat(100));
  const fd = new FormData();
  fd.append('file', new Blob([content]), 'secret.txt');
  fd.append('overwrite', '1');
  await req('POST', '/api/files/upload?path=alice@p9c.test/paid', { cookie: jarStr('alice'), raw: { body: fd, headers: {} } });

  const create = await req('POST', '/api/shares', {
    cookie: jarStr('alice'),
    body: { path: 'alice@p9c.test/paid/secret.txt', paidDownload: 1, pricePoints: 50, allowPreview: true },
  });
  shareToken = create.json?.item?.token;
  check('8a. 创建付费分享 201', create.status === 201 && !!shareToken, `status=${create.status} token=${shareToken}`);

  // bob（未购买）访问 pay-info
  const info = await req('GET', `/api/shares/${shareToken}/pay-info`, { cookie: jarStr('bob') });
  check('8b. pay-info：requiresPayment / self / alreadyPurchased',
    info.status === 200 && info.json?.requiresPayment === true && info.json?.self === false && info.json?.alreadyPurchased === false,
    `body=${JSON.stringify(info.json)}`);

  // 未购买下载 → 402
  const dl = await req('GET', `/api/share/${shareToken}/download`, { cookie: jarStr('bob') });
  check('8c. 未购买下载 402 share_not_paid', dl.status === 402 && dl.json?.error?.code === 'share_not_paid',
    `status=${dl.status} code=${dl.json?.error?.code}`);

  // 积分不足 → 400 insufficient_points（bob 当前 100，够 50；先扣到 0 不行，直接新建 carol 测不足）
  const poor = await req('POST', '/api/shares/:token/buy-points'.replace(':token', shareToken), { cookie: jarStr('carol') });
  check('8d. 积分不足 400 insufficient_points', poor.status === 400 && poor.json?.error?.code === 'insufficient_points',
    `status=${poor.status} code=${poor.json?.error?.code} details=${JSON.stringify(poor.json?.error?.details)}`);

  // 给 bob 加分后购买；bob 现有 100，够 50
  const buy = await req('POST', `/api/shares/${shareToken}/buy-points`, { cookie: jarStr('bob') });
  check('8e. bob 积分购买分享成功', buy.status === 200 && buy.json?.commission != null, `status=${buy.status} body=${JSON.stringify(buy.json)}`);

  const commission = dbGet(
    "SELECT * FROM points_ledger WHERE email = ? AND source = 'commission' AND refId = ? ORDER BY id DESC LIMIT 1",
    'alice@p9c.test', shareToken,
  );
  // 默认 commissionPercent=10 → floor(50*10/100)=5
  check('8f. 分享者收到 commission=floor(50*10/100)=5', !!commission && Number(commission.delta) === 5,
    `delta=${commission?.delta}`);

  const dl2 = await req('GET', `/api/share/${shareToken}/download`, { cookie: jarStr('bob') });
  check('8g. 购买后 bob 下载 200', dl2.status === 200, `status=${dl2.status}`);

  // 自己买自己 → 400
  const self = await req('POST', `/api/shares/${shareToken}/buy-points`, { cookie: jarStr('alice') });
  check('8h. 自己买自己 400 self_purchase_forbidden', self.status === 400 && self.json?.error?.code === 'self_purchase_forbidden',
    `status=${self.status} code=${self.json?.error?.code}`);

  // 匿名现金下单
  const anon = await req('POST', `/api/shares/${shareToken}/orders`, { body: { email: '' } });
  check('8i. 匿名现金下单 201 返回 orderNo/recoverToken',
    anon.status === 201 && !!anon.json?.orderNo && !!anon.json?.recoverToken,
    `status=${anon.status} body=${JSON.stringify(anon.json)}`);
  const anonOrder = anon.json;

  const q1 = await req('GET', `/api/orders/${anonOrder.orderNo}?recover=${anonOrder.recoverToken}`);
  check('8j. 正确 recover 可查订单 200', q1.status === 200 && q1.json?.orderNo === anonOrder.orderNo, `status=${q1.status}`);
  const q2 = await req('GET', `/api/orders/${anonOrder.orderNo}?recover=wrong-token`);
  check('8k. 错误 recover 404 order_not_found', q2.status === 404 && q2.json?.error?.code === 'order_not_found',
    `status=${q2.status} code=${q2.json?.error?.code}`);
}

// ====================================================================
// 9. 未实现支付渠道占位 → 501，且不产生 paid 订单
// ====================================================================
{
  const { getProvider } = await import('../server/services/payment/index.js');
  let threw = false;
  try { await getProvider('stripe').createOrder({ order: {} }); }
  catch (e) { threw = e.status === 501 && e.code === 'payment_not_configured'; }
  check('9a. stripe createOrder 501 payment_not_configured', threw, `threw=${threw}`);

  let threwCb = false;
  try { getProvider('stripe').verifyCallback({ req: {} }); }
  catch (e) { threwCb = e.status === 501 && e.code === 'payment_not_configured'; }
  check('9b. stripe verifyCallback 501', threwCb, `threw=${threwCb}`);

  const stripePaid = dbGet("SELECT COUNT(*) AS n FROM orders WHERE provider = 'stripe' AND status = 'paid'").n;
  check('9c. 没有任何 stripe 订单被置 paid', stripePaid === 0, `stripe paid=${stripePaid}`);
}

// ====================================================================
// 汇总
// ====================================================================
const failed = results.filter((r) => !r.ok);
console.log(`\n==== P9-C 汇总：${results.length - failed.length}/${results.length} PASS ====`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL | ${f.name} | ${f.detail}`);
  process.exit(1);
}
process.exit(0);
