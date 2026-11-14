// R6T5 Drive 后端自检脚本（配合已启动的服务使用）
// 用法：BASE=http://127.0.0.1:8090 node tools/smoke-test.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:8090';

const jar = { admin: '', user: '', bob: '' };

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

async function req(method, path, { body, cookie, raw, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (cookie) opts.headers.Cookie = cookie;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (raw) { opts.body = raw.body; Object.assign(opts.headers, raw.headers); }
  const res = await fetch(BASE + path, opts);
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  let json = null;
  if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = text; } }
  const setCookieArr = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const set = {};
  for (const c of setCookieArr) Object.assign(set, parseCookies(c));
  return { status: res.status, json, text, set };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

// 1. 全新 DB setup.status → supabase
{
  const r = await req('GET', '/api/setup/status');
  check('1. setup.status 初始 next=supabase', r.json?.next === 'supabase',
    `status=${r.status} next=${r.json?.next} hint=${r.json?.hint}`);
}

// 2. 管理员登录：错密码 401，对密码 200
{
  const bad = await req('POST', '/api/admin/login', { body: { password: 'wrong-pass' } });
  check('2a. 错密码 401 invalid_admin_password', bad.status === 401 && bad.json?.error?.code === 'invalid_admin_password',
    `status=${bad.status} code=${bad.json?.error?.code}`);
  const ok = await req('POST', '/api/admin/login', { body: { password: 'test123' } });
  jar.admin = Object.entries(ok.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('2b. 对密码 200 并拿到 admin cookie', ok.status === 200 && !!jar.admin,
    `status=${ok.status} cookie=${jar.admin ? 'yes' : 'no'}`);
}

// 3. 错误 Supabase 配置 → 400 不落盘
{
  const r = await req('POST', '/api/admin/supabase', {
    cookie: jar.admin,
    body: { url: 'https://nope.supabase.co', anonKey: 'x', serviceKey: 'y' },
  });
  check('3a. 坏配置 400 supabase_unreachable', r.status === 400 && r.json?.error?.code === 'supabase_unreachable',
    `status=${r.status} code=${r.json?.error?.code} reason=${r.json?.error?.details?.reason}`);
  const g = await req('GET', '/api/admin/supabase', { cookie: jar.admin });
  check('3b. 旧配置保持 configured:false（无脏数据）', g.json?.configured === false,
    `status=${g.status} configured=${g.json?.configured}`);
}

// 4. 状态机推进：先在 DB 直接标记 supabase 已自检通过（自测绕过真实实例），再建策略/组/站点
{
  // 直接写 SQLite 模拟已通过自检（仅自测用途）
  const Database = (await import('better-sqlite3')).default;
  const path = await import('node:path');
  const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), 'data/r6t5.db');
  const db = new Database(dbPath);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('supabase_url','https://fake.supabase.co')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('supabase_anon_key','fake-anon')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('supabase_service_key','fake-service')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('supabase_last_check','{"ok":true,"at":"${now}","latencyMs":1}')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.prepare(`INSERT INTO settings (key,value) VALUES ('supabase_checked_at','${now}')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run();
  db.close();

  // 先建一条 volume 策略（storage 检查）
  const st = await req('POST', '/api/admin/storage', {
    cookie: jar.admin,
    body: { name: '本机数据卷', type: 'volume', region: '本机 data/volume', capacityBytes: 107374182400, readOnly: false, config: { rootPath: 'data/volume' }, acknowledgeDisclosure: true },
  });
  check('5a. 带 acknowledgeDisclosure 创建策略 201', st.status === 201, `status=${st.status} id=${st.json?.item?.id}`);

  // 再建第二个组（含默认组共 2 个）
  const g1 = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: { name: '普通用户', spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120 },
  });
  check('4a. 创建第二个用户组 201', g1.status === 201, `status=${g1.status} id=${g1.json?.item?.id}`);

  let s = await req('GET', '/api/setup/status');
  check('4b. 组达标后 next=site', s.json?.next === 'site', `status=${s.status} next=${s.json?.next}`);

  const defaultGroup = await req('GET', '/api/admin/groups', { cookie: jar.admin });
  const gid = defaultGroup.json?.items?.[0]?.id;
  const patch = await req('PATCH', '/api/admin/settings', {
    cookie: jar.admin,
    body: { siteName: '我的网盘', publicUrl: 'https://drive.example.com', defaultGroupId: gid },
  });
  check('4c. 补全站点信息 200', patch.status === 200, `status=${patch.status}`);
  s = await req('GET', '/api/setup/status');
  check('4d. 全部就绪 next=ready', s.json?.next === 'ready', `status=${s.status} next=${s.json?.next}`);

  // 5b. 未勾选披露 → 400 not_acknowledged
  const na = await req('POST', '/api/admin/storage', {
    cookie: jar.admin,
    body: { name: '未披露策略', type: 'volume', capacityBytes: 107374182400 },
  });
  check('5b. 未 acknowledge 400 not_acknowledged', na.status === 400 && na.json?.error?.code === 'not_acknowledged',
    `status=${na.status} code=${na.json?.error?.code}`);
}

// 6. 用户端完整流程
{
  const dl = await req('POST', '/api/auth/dev-login', { body: { email: 'alice@x.com' } });
  jar.user = Object.entries(dl.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('6a. dev-login 200', dl.status === 200, `status=${dl.status} email=${dl.json?.user?.email}`);

  const mkdir = await req('POST', '/api/files/folder', { cookie: jar.user, body: { path: 'alice@x.com', name: 'inbox' } });
  check('6b. 建目录 inbox 201', mkdir.status === 201, `status=${mkdir.status} path=${mkdir.json?.path}`);

  // 造 5MB 文件
  const chunk = new Uint8Array(5 * 1024 * 1024);
  const file = new Blob([chunk], { type: 'application/octet-stream' });
  const fd = new FormData();
  fd.append('file', file, 'hello.bin');
  const up = await req('POST', '/api/files/upload?path=alice@x.com/inbox', { cookie: jar.user, raw: { body: fd, headers: {} } });
  check('6c. 上传 5MB 201', up.status === 201, `status=${up.status} size=${up.json?.item?.sizeBytes}`);

  const list = await req('GET', '/api/files?path=alice@x.com/inbox', { cookie: jar.user });
  const found = list.json?.items?.some((i) => i.name === 'hello.bin');
  check('6d. 列表能看到文件', list.status === 200 && found, `status=${list.status} items=${list.json?.items?.length}`);

  const dl2 = await req('GET', '/api/files/download?path=alice@x.com/inbox/hello.bin', { cookie: jar.user });
  check('6e. 下载拿到字节', dl2.status === 200 && dl2.text.length === 5 * 1024 * 1024,
    `status=${dl2.status} bytes=${dl2.text.length}`);

  const rn = await req('POST', '/api/files/rename', { cookie: jar.user, body: { path: 'alice@x.com/inbox/hello.bin', newName: 'renamed.bin' } });
  check('6f. 重命名 200', rn.status === 200, `status=${rn.status} path=${rn.json?.item?.path}`);

  const mv = await req('POST', '/api/files/move', { cookie: jar.user, body: { path: 'alice@x.com/inbox/renamed.bin', targetPath: 'alice@x.com' } });
  check('6g. 移动到根目录 200', mv.status === 200, `status=${mv.status} path=${mv.json?.item?.path}`);

  const del = await req('DELETE', '/api/files?path=alice@x.com/renamed.bin', { cookie: jar.user });
  check('6h. 软删 200', del.status === 200 && del.json?.trashed >= 1, `status=${del.status} trashed=${del.json?.trashed}`);

  const trash = await req('GET', '/api/trash', { cookie: jar.user });
  const inTrash = trash.json?.items?.some((i) => i.path === 'alice@x.com/renamed.bin');
  check('6i. 回收站可见', trash.status === 200 && inTrash, `status=${trash.status} items=${trash.json?.items?.length}`);

  const restore = await req('POST', '/api/trash/restore', { cookie: jar.user, body: { path: 'alice@x.com/renamed.bin' } });
  check('6j. 恢复 200', restore.status === 200, `status=${restore.status} path=${restore.json?.path}`);
}

// 7. 越权
{
  const bob = await req('POST', '/api/auth/dev-login', { body: { email: 'bob@x.com' } });
  jar.bob = Object.entries(bob.set).map(([k, v]) => `${k}=${v}`).join('; ');
  const cross = await req('GET', '/api/files?path=alice@x.com/inbox', { cookie: jar.bob });
  check('7a. bob 读 alice 目录 403', cross.status === 403, `status=${cross.status} code=${cross.json?.error?.code}`);

  const ov = await req('GET', '/api/admin/overview', { cookie: jar.bob });
  check('7b. 普通用户访问管理概览 403', ov.status === 403, `status=${ov.status} code=${ov.json?.error?.code}`);

  const page = await req('GET', '/admin/home.html', { cookie: jar.bob });
  check('7c. 普通用户访问 /admin/home.html 403 HTML', page.status === 403 && page.text.includes('管理员'),
    `status=${page.status} html=${page.text.length > 0}`);
}

// 8. 路径穿越
{
  const t = await req('GET', '/api/files?path=alice@x.com/../bob@x.com', { cookie: jar.user });
  check('8. 路径穿越被拒（403/400）', [400, 403].includes(t.status), `status=${t.status} code=${t.json?.error?.code}`);
}

// 9. 三种配额错误
{
  const groups = await req('GET', '/api/admin/groups', { cookie: jar.admin });
  const gid = groups.json?.items?.[0]?.id;
  const chunk = new Uint8Array(1024);

  // 9a 单文件上限
  await req('PATCH', `/api/admin/groups/${gid}`, { cookie: jar.admin, body: { maxFileSizeBytes: 512, spaceLimitBytes: 10737418240, traffic7dLimitBytes: 5368709120 } });
  let fd = new FormData(); fd.append('file', new Blob([chunk]), 'q.bin');
  let r = await req('POST', '/api/files/upload?path=alice@x.com', { cookie: jar.user, raw: { body: fd, headers: {} } });
  check('9a. 单文件超限 413 quota_file', r.status === 413 && r.json?.error?.code === 'quota_file',
    `status=${r.status} code=${r.json?.error?.code}`);

  // 9b 空间上限
  await req('PATCH', `/api/admin/groups/${gid}`, { cookie: jar.admin, body: { maxFileSizeBytes: 2147483648, spaceLimitBytes: 1024, traffic7dLimitBytes: 5368709120 } });
  fd = new FormData(); fd.append('file', new Blob([chunk]), 'q.bin');
  r = await req('POST', '/api/files/upload?path=alice@x.com', { cookie: jar.user, raw: { body: fd, headers: {} } });
  check('9b. 空间不足 409 quota_space', r.status === 409 && r.json?.error?.code === 'quota_space',
    `status=${r.status} code=${r.json?.error?.code}`);

  // 9c 流量上限
  await req('PATCH', `/api/admin/groups/${gid}`, { cookie: jar.admin, body: { maxFileSizeBytes: 2147483648, spaceLimitBytes: 10737418240, traffic7dLimitBytes: 1 } });
  fd = new FormData(); fd.append('file', new Blob([chunk]), 'q.bin');
  r = await req('POST', '/api/files/upload?path=alice@x.com', { cookie: jar.user, raw: { body: fd, headers: {} } });
  check('9c. 7 天流量耗尽 429 quota_traffic', r.status === 429 && r.json?.error?.code === 'quota_traffic',
    `status=${r.status} code=${r.json?.error?.code}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
