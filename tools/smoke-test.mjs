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


// ================= P2：多存储后端 =================
// 用本地假 S3（tools/fake-s3.mjs）覆盖 put/get/list/delete/绑定解析/只读拒绝
{
  // 先把 9c 改小的配额恢复，避免 P2 上传被配额挡住
  const groups = await req('GET', '/api/admin/groups', { cookie: jar.admin });
  const gid = groups.json?.items?.[0]?.id;
  await req('PATCH', `/api/admin/groups/${gid}`, {
    cookie: jar.admin,
    body: { maxFileSizeBytes: 2147483648, spaceLimitBytes: 10737418240, traffic7dLimitBytes: 5368709120 },
  });

  let fake = null;
  try {
    const mod = await import(new URL('./fake-s3.mjs', import.meta.url));
    fake = await mod.startFakeS3({ port: 0 });
  } catch (e) {
    check('P2.0 启动本地假 S3', false, `无法加载 tools/fake-s3.mjs：${e.message}`);
  }

  if (fake) {
    const s3Config = {
      endpoint: `http://127.0.0.1:${fake.port}`,
      region: 'us-east-1',
      bucket: 'p2-bucket',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      prefix: 'p2-prefix',
      pathStyle: 'on',
    };
    // 假 S3：桶需要预先存在（真实 S3 同样要求）
    fake.store['p2-bucket'] = fake.store['p2-bucket'] || {};

    // 10. S3 策略创建 + 密钥脱敏
    const s3 = await req('POST', '/api/admin/storage', {
      cookie: jar.admin,
      body: { name: 'S3 主存储', type: 's3', capacityBytes: 107374182400, readOnly: false, config: s3Config, acknowledgeDisclosure: true },
    });
    const s3Id = s3.json?.item?.id;
    check('10a. 创建 s3 策略 201', s3.status === 201 && !!s3Id, `status=${s3.status} id=${s3Id}`);
    const s3List = await req('GET', '/api/admin/storage', { cookie: jar.admin });
    const s3Item = (s3List.json?.items || []).find((i) => i.id === s3Id);
    check('10b. 密钥脱敏（AK 只留末四位、SK 不出现）',
      s3Item?.configMasked?.accessKeyId === '****MPLE' && !s3List.text.includes(s3Config.secretAccessKey),
      `accessKeyId=${s3Item?.configMasked?.accessKeyId} 明文SK出现=${s3List.text.includes(s3Config.secretAccessKey)}`);

    // 11. 保存前测试连接（validate）
    const val = await req('POST', '/api/admin/storage/validate', { cookie: jar.admin, body: { type: 's3', config: s3Config } });
    check('11. POST /storage/validate 对本地假 S3 ok:true',
      val.status === 200 && val.json?.ok === true, `status=${val.status} ok=${val.json?.ok} msg=${String(val.json?.message).slice(0, 60)}`);

    // 12. GitHub 只读策略
    const gh = await req('POST', '/api/admin/storage', {
      cookie: jar.admin,
      body: { name: 'GitHub 只读', type: 'github', capacityBytes: 1073741824, config: { repo: 'octocat/Hello-World', branch: 'master' }, acknowledgeDisclosure: true },
    });
    const ghId = gh.json?.item?.id;
    check('12. 创建 github 策略 201 且强制只读', gh.status === 201 && gh.json?.item?.readOnly === true,
      `status=${gh.status} readOnly=${gh.json?.item?.readOnly}`);

    // 13. 目录绑定
    const b1 = await req('POST', '/api/admin/bindings', { cookie: jar.admin, body: { strategyId: s3Id, scope: 'site', subPath: 'media' } });
    check('13a. 站点级绑定 media → s3 201', b1.status === 201, `status=${b1.status} code=${b1.json?.error?.code || 'ok'}`);
    const b2 = await req('POST', '/api/admin/bindings', { cookie: jar.admin, body: { strategyId: ghId, scope: 'user', email: 'alice@x.com', subPath: 'archive' } });
    check('13b. 用户级绑定 alice/archive → github 201', b2.status === 201, `status=${b2.status}`);
    const bdup = await req('POST', '/api/admin/bindings', { cookie: jar.admin, body: { strategyId: s3Id, scope: 'site', subPath: 'media' } });
    check('13c. 重复绑定 409', bdup.status === 409, `status=${bdup.status} code=${bdup.json?.error?.code}`);

    // 14. 解析优先级
    const r1 = await req('GET', '/api/admin/bindings/resolve?path=' + encodeURIComponent('alice@x.com/media/a.txt'), { cookie: jar.admin });
    const r2 = await req('GET', '/api/admin/bindings/resolve?path=' + encodeURIComponent('alice@x.com/other/x.txt'), { cookie: jar.admin });
    const r3 = await req('GET', '/api/admin/bindings/resolve?path=' + encodeURIComponent('alice@x.com/archive/x.txt'), { cookie: jar.admin });
    check('14a. media 命中绑定（站点级）', r1.json?.matchedBy === 'binding' && r1.json?.strategy?.type === 's3', `matchedBy=${r1.json?.matchedBy} type=${r1.json?.strategy?.type}`);
    check('14b. 未绑定路径回落本地默认', r2.json?.matchedBy === 'local' || r2.json?.matchedBy === 'group', `matchedBy=${r2.json?.matchedBy} type=${r2.json?.strategy?.type}`);
    check('14c. archive 命中绑定（用户级）', r3.json?.matchedBy === 'binding' && r3.json?.strategy?.type === 'github', `matchedBy=${r3.json?.matchedBy} type=${r3.json?.strategy?.type}`);

    // 15. 通过 API 往 S3 目录上传：走 S3 API 真实落对象
    const login = await req('POST', '/api/auth/dev-login', { body: { email: 'alice@x.com' } });
    jar.user = Object.entries(login.set).map(([k, v]) => `${k}=${v}`).join('; ');
    const payload = new TextEncoder().encode('hello from s3 driver\n');
    let fd = new FormData(); fd.append('file', new Blob([payload], { type: 'text/plain' }), 'hello.txt');
    const up = await req('POST', '/api/files/upload?path=' + encodeURIComponent('alice@x.com/media'), { cookie: jar.user, raw: { body: fd, headers: {} } });
    const s3Key = 'p2-prefix/alice@x.com/media/hello.txt';
    check('15a. 上传到 s3 绑定目录 201', up.status === 201 && up.json?.item?.storageId === s3Id, `status=${up.status} storageId=${up.json?.item?.storageId}`);
    check('15b. 对象真的落在假 S3 里', !!fake.store['p2-bucket'][s3Key], `key=${s3Key} 存在=${!!fake.store['p2-bucket'][s3Key]}`);

    // 16. 列表：本地元数据 + 远端列举合并
    fake.store['p2-bucket']['p2-prefix/alice@x.com/media/remote-only.txt'] = {
      body: Buffer.from('remote only'), size: 11, lastModified: new Date().toISOString(),
    };
    const ls = await req('GET', '/api/files?path=' + encodeURIComponent('alice@x.com/media'), { cookie: jar.user });
    const names = (ls.json?.items || []).map((i) => i.name);
    const remoteItem = (ls.json?.items || []).find((i) => i.name === 'remote-only.txt');
    check('16a. 列表带 strategy（绑定命中 s3）', ls.json?.strategy?.type === 's3' && ls.json?.strategy?.matchedBy === 'binding', `type=${ls.json?.strategy?.type} matchedBy=${ls.json?.strategy?.matchedBy}`);
    check('16b. 远端对象被列举并标记 remote', names.includes('remote-only.txt') && remoteItem?.remote === true, `items=${names.join(',')} remote=${remoteItem?.remote}`);
    check('16c. 本地条目未被远端重复', names.filter((n) => n === 'hello.txt').length === 1, `hello.txt 出现次数=${names.filter((n) => n === 'hello.txt').length}`);

    // 17. 下载（走 S3 GetObject）
    const dl = await req('GET', '/api/files/download?path=' + encodeURIComponent('alice@x.com/media/hello.txt'), { cookie: jar.user });
    check('17. 下载 s3 对象字节一致', dl.status === 200 && dl.text.includes('hello from s3 driver'), `status=${dl.status} bytes=${dl.text.length}`);

    // 18. 只读拒绝：上传 / 建目录 都要 403 strategy_readonly
    fd = new FormData(); fd.append('file', new Blob([payload]), 'nope.txt');
    const roUp = await req('POST', '/api/files/upload?path=' + encodeURIComponent('alice@x.com/archive'), { cookie: jar.user, raw: { body: fd, headers: {} } });
    check('18a. 只读目录上传 403 strategy_readonly', roUp.status === 403 && roUp.json?.error?.code === 'strategy_readonly', `status=${roUp.status} code=${roUp.json?.error?.code}`);
    const roMk = await req('POST', '/api/files/folder', { cookie: jar.user, body: { path: 'alice@x.com/archive', name: 'newdir' } });
    check('18b. 只读目录建文件夹 403 strategy_readonly', roMk.status === 403 && roMk.json?.error?.code === 'strategy_readonly', `status=${roMk.status} code=${roMk.json?.error?.code}`);
    check('18c. 只读提示可直接展示', typeof roUp.json?.error?.message === 'string' && roUp.json.error.message.includes('只读'), `message=${String(roUp.json?.error?.message).slice(0, 40)}`);

    // 19. 跨策略搬运：s3 → 本地卷
    const mv = await req('POST', '/api/files/move', { cookie: jar.user, body: { path: 'alice@x.com/media/hello.txt', targetPath: 'alice@x.com' } });
    check('19a. 跨策略移动 200', mv.status === 200, `status=${mv.status} code=${mv.json?.error?.code || 'ok'}`);
    check('19b. 源对象已从 S3 删除', !fake.store['p2-bucket'][s3Key], `key 存在=${!!fake.store['p2-bucket'][s3Key]}`);
    const rootDl = await req('GET', '/api/files/download?path=' + encodeURIComponent('alice@x.com/hello.txt'), { cookie: jar.user });
    check('19c. 移动后本地卷可读', rootDl.status === 200 && rootDl.text.includes('hello from s3 driver'), `status=${rootDl.status} bytes=${rootDl.text.length}`);

    // 20. 仍被绑定的策略不能删；解绑后可删
    const delBound = await req('DELETE', `/api/admin/storage/${s3Id}`, { cookie: jar.admin });
    check('20a. 删除被绑定的策略 409', delBound.status === 409, `status=${delBound.status} code=${delBound.json?.error?.code}`);

    // 21. 绑定响应里没有明文密钥
    const ball = await req('GET', '/api/admin/bindings', { cookie: jar.admin });
    check('21. 绑定列表不含明文密钥', !ball.text.includes(s3Config.secretAccessKey) && !ball.text.includes('AKIAIOSFODNN7EXAMPLE'), `长度=${ball.text.length}`);

    await fake.close();
  }
}



// ================= 回归：软删后同名重建（nodes.path 部分唯一索引） =================
{
  const payload = new TextEncoder().encode('tombstone test');
  let fd = new FormData(); fd.append('file', new Blob([payload]), 'reborn.txt');
  const up1 = await req('POST', '/api/files/upload?path=' + encodeURIComponent('alice@x.com'), { cookie: jar.user, raw: { body: fd, headers: {} } });
  check('22a. 首次上传 reborn.txt 201', up1.status === 201, `status=${up1.status}`);
  const del = await req('DELETE', '/api/files?path=' + encodeURIComponent('alice@x.com/reborn.txt'), { cookie: jar.user });
  check('22b. 软删成功', del.status === 200 && del.json?.trashed >= 1, `status=${del.status} trashed=${del.json?.trashed}`);
  fd = new FormData(); fd.append('file', new Blob([payload]), 'reborn.txt');
  const up2 = await req('POST', '/api/files/upload?path=' + encodeURIComponent('alice@x.com'), { cookie: jar.user, raw: { body: fd, headers: {} } });
  check('22c. 软删后同名重建 201（不再是 500 UNIQUE）', up2.status === 201, `status=${up2.status} code=${up2.json?.error?.code}`);
}

// ================= P6：账号来源切换 + 本地账号体系（独立段落，收尾切回 supabase） =================
// 注意：本段必须放在文件最后——前面用例默认依赖 supabase 未配置时 next='supabase'。
// 段落末尾把 userSource 切回 supabase，保证脚本可重复跑、不影响既有断言。
{
  const P6_EMAIL = 'p6smoke@x.com';
  const P6_PW = 'p6pass123';

  // 56a. 切到 volume；setup/status 跳过 supabase 检查
  const sw = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'volume', confirm: true },
  });
  check('56a1. 切到 volume 200 ok:true', sw.status === 200 && sw.json?.ok === true && sw.json?.switchedTo === 'volume',
    `status=${sw.status} body=${JSON.stringify(sw.json)}`);
  const stAfter = await req('GET', '/api/setup/status');
  check('56a2. volume 模式 next 不再是 supabase，userSource=volume',
    stAfter.status === 200 && stAfter.json?.next !== 'supabase' && stAfter.json?.userSource === 'volume',
    `next=${stAfter.json?.next} userSource=${stAfter.json?.userSource}`);

  // 56b. 建本地账号 → 本地登录 200 → /api/me 200
  const created = await req('POST', '/api/admin/users', {
    cookie: jar.admin,
    body: { email: P6_EMAIL, password: P6_PW, displayName: 'P6 Smoke' },
  });
  const p6Id = created.json?.item?.id;
  check('56b1. volume 本地建号 201，source=local status=active',
    created.status === 201 && created.json?.item?.source === 'local' && created.json?.item?.status === 'active',
    `status=${created.status} item=${JSON.stringify(created.json?.item)}`);
  const p6Login = await req('POST', '/api/auth/login', { body: { email: P6_EMAIL, password: P6_PW } });
  jar.p6 = Object.entries(p6Login.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('56b2. 本地密码正确登录 200', p6Login.status === 200 && p6Login.json?.ok === true,
    `status=${p6Login.status} email=${p6Login.json?.user?.email}`);
  const p6Me = await req('GET', '/api/me', { cookie: jar.p6 });
  check('56b3. /api/me 200', p6Me.status === 200 && p6Me.json?.user?.email === P6_EMAIL,
    `status=${p6Me.status} email=${p6Me.json?.user?.email}`);

  // 56c. 密码错误 / 不存在邮箱 → 同一状态码、同一 code、同一文案（逐字节）
  const badPw = await req('POST', '/api/auth/login', { body: { email: P6_EMAIL, password: 'wrong-pass' } });
  const ghost = await req('POST', '/api/auth/login', { body: { email: 'p6-ghost@x.com', password: 'whatever1' } });
  check('56c1. 密码错误 401 invalid_credentials',
    badPw.status === 401 && badPw.json?.error?.code === 'invalid_credentials',
    `status=${badPw.status} code=${badPw.json?.error?.code}`);
  check('56c2. 不存在邮箱与密码错误 status/code/message 完全一致',
    ghost.status === badPw.status && ghost.json?.error?.code === badPw.json?.error?.code &&
    ghost.json?.error?.message === badPw.json?.error?.message && ghost.text === badPw.text,
    `pw=${badPw.json?.error?.message} ghost=${ghost.json?.error?.message} sameText=${ghost.text === badPw.text}`);

  // 56d. 封禁 → 旧 cookie 立刻 403；再登录 403
  const ban = await req('PATCH', `/api/admin/users/${p6Id}`, { cookie: jar.admin, body: { status: 'banned' } });
  check('56d1. PATCH status=banned 200，disabled 同步',
    ban.status === 200 && ban.json?.item?.status === 'banned' && ban.json?.item?.disabled === true,
    `status=${ban.status} item=${JSON.stringify(ban.json?.item)}`);
  const meBanned = await req('GET', '/api/me', { cookie: jar.p6 });
  check('56d2. 封禁后旧 cookie /api/me 403 account_banned',
    meBanned.status === 403 && meBanned.json?.error?.code === 'account_banned',
    `status=${meBanned.status} code=${meBanned.json?.error?.code}`);
  const reloginBanned = await req('POST', '/api/auth/login', { body: { email: P6_EMAIL, password: P6_PW } });
  check('56d3. 封禁后重新登录 403 account_banned',
    reloginBanned.status === 403 && reloginBanned.json?.error?.code === 'account_banned',
    `status=${reloginBanned.status} code=${reloginBanned.json?.error?.code}`);

  // 56e. 解封 → 登录恢复 200
  const unban = await req('PATCH', `/api/admin/users/${p6Id}`, { cookie: jar.admin, body: { status: 'active' } });
  check('56e1. 解封 200 status=active', unban.status === 200 && unban.json?.item?.status === 'active',
    `status=${unban.status} item=${JSON.stringify(unban.json?.item)}`);
  const reloginOk = await req('POST', '/api/auth/login', { body: { email: P6_EMAIL, password: P6_PW } });
  jar.p6 = Object.entries(reloginOk.set).map(([k, v]) => `${k}=${v}`).join('; ');
  check('56e2. 解封后登录恢复 200', reloginOk.status === 200, `status=${reloginOk.status}`);

  // 56f. 列表项 registeredAt / lastLoginAt 均为非空时间字符串（抽屉所需字段）
  const list = await req('GET', `/api/admin/users?q=${encodeURIComponent(P6_EMAIL)}`, { cookie: jar.admin });
  const p6Item = list.json?.items?.[0];
  check('56f. 列表项 registeredAt / lastLoginAt 非空时间字符串',
    !!p6Item && typeof p6Item.registeredAt === 'string' && p6Item.registeredAt !== '' &&
    typeof p6Item.lastLoginAt === 'string' && p6Item.lastLoginAt !== '' && p6Item.status === 'active',
    `registeredAt=${p6Item?.registeredAt} lastLoginAt=${p6Item?.lastLoginAt}`);

  // 56g. deleteFiles=0 删号 → 既有 cookie /api/me 401/403（不 500）
  const del = await req('DELETE', `/api/admin/users/${p6Id}?deleteFiles=0`, { cookie: jar.admin });
  check('56g1. deleteFiles=0 删号 200', del.status === 200 && del.json?.ok === true,
    `status=${del.status} body=${JSON.stringify(del.json)}`);
  const meDeleted = await req('GET', '/api/me', { cookie: jar.p6 });
  check('56g2. 删号后既有 cookie /api/me 401/403（不 500）',
    [401, 403].includes(meDeleted.status), `status=${meDeleted.status} code=${meDeleted.json?.error?.code}`);

  // 56h. 收尾切回 supabase，断言来源复位（保证脚本可重复跑、不影响前面用例）
  const swBack = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'supabase', confirm: true },
  });
  check('56h1. 切回 supabase 200', swBack.status === 200 && swBack.json?.switchedTo === 'supabase',
    `status=${swBack.status} body=${JSON.stringify(swBack.json)}`);
  const srcBack = await req('GET', '/api/admin/user-source', { cookie: jar.admin });
  check('56h2. GET /api/admin/user-source 回到 supabase',
    srcBack.status === 200 && srcBack.json?.userSource === 'supabase',
    `status=${srcBack.status} userSource=${srcBack.json?.userSource}`);
}

// ================= P7：自助注册 / sudo / 空间单位 / 版本发布（独立段落，收尾切回 supabase） =================
// 与 56 段同套路：开头切 volume、结尾切回 supabase，保证脚本可重复跑；
// 独立 jar.p7 / jar.p7sudo 与随机后缀邮箱，避免与 56 段及既有用例冲突。
{
  const jarOf = (set) => Object.entries(set).map(([k, v]) => `${k}=${v}`).join('; ');
  const suffix = Date.now().toString(36);
  const P7_EMAIL = `p7smoke+${suffix}@x.com`;
  const P7_PW = 'p7pass123';

  // 57a. 切到 volume
  const sw = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'volume', confirm: true },
  });
  check('57a1. 切到 volume 200 ok:true', sw.status === 200 && sw.json?.ok === true && sw.json?.switchedTo === 'volume',
    `status=${sw.status} body=${JSON.stringify(sw.json)}`);

  // 57b. 建一个 allowSelfSignup:true 的组
  const grp = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: {
      name: `P7 Smoke ${suffix}`, allowSelfSignup: true,
      spaceLimitBytes: 10737418240, maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120,
    },
  });
  const p7Group = grp.json?.item;
  check('57b1. 建组 allowSelfSignup:true 201', grp.status === 201 && p7Group?.allowSelfSignup === true,
    `status=${grp.status} item=${JSON.stringify(p7Group)}`);

  // 57c. signup-config：开放注册
  const cfg = await req('GET', '/api/auth/signup-config');
  check('57c. signup-config available:true source:volume reason:ok',
    cfg.status === 200 && cfg.json?.available === true && cfg.json?.source === 'volume' && cfg.json?.reason === 'ok',
    `body=${JSON.stringify(cfg.json)}`);

  // 57d. 注册成功 201 → /api/me 200
  const su = await req('POST', '/api/auth/signup', {
    body: { email: P7_EMAIL, password: P7_PW, passwordConfirm: P7_PW },
  });
  jar.p7 = jarOf(su.set);
  check('57d1. 注册成功 201 ok:true', su.status === 201 && su.json?.ok === true,
    `status=${su.status} code=${su.json?.error?.code} msg=${su.json?.error?.message}`);
  const me = await req('GET', '/api/me', { cookie: jar.p7 });
  check('57d2. 注册后 /api/me 200', me.status === 200 && me.json?.user?.email === P7_EMAIL,
    `status=${me.status} email=${me.json?.user?.email}`);

  // 57e. 两次密码不一致 → 400，details.field=passwordConfirm
  const mismatch = await req('POST', '/api/auth/signup', {
    body: { email: `p7mm+${suffix}@x.com`, password: P7_PW, passwordConfirm: 'other456' },
  });
  check('57e. 两次密码不一致 400 invalid_input field=passwordConfirm',
    mismatch.status === 400 && mismatch.json?.error?.code === 'invalid_input' &&
    mismatch.json?.error?.details?.field === 'passwordConfirm',
    `status=${mismatch.status} code=${mismatch.json?.error?.code} field=${mismatch.json?.error?.details?.field} msg=${mismatch.json?.error?.message}`);

  // 57f. 重复邮箱 → 400 invalid_signup，message 逐字等于「注册信息无效」
  const dup = await req('POST', '/api/auth/signup', {
    body: { email: P7_EMAIL, password: P7_PW, passwordConfirm: P7_PW },
  });
  const dupMsg = dup.json?.error?.message || '';
  check('57f. 重复邮箱 400 invalid_signup message=「注册信息无效」',
    dup.status === 400 && dup.json?.error?.code === 'invalid_signup' && dupMsg === '注册信息无效',
    `status=${dup.status} code=${dup.json?.error?.code} msg=${dupMsg}`);

  // 57g. 关掉该组再注册 → 403 signup_closed
  await req('PATCH', `/api/admin/groups/${p7Group.id}`, { cookie: jar.admin, body: { allowSelfSignup: false } });
  const closed = await req('POST', '/api/auth/signup', {
    body: { email: `p7closed+${suffix}@x.com`, password: P7_PW, passwordConfirm: P7_PW },
  });
  check('57g. 组关闭后注册 403 signup_closed',
    closed.status === 403 && closed.json?.error?.code === 'signup_closed',
    `status=${closed.status} code=${closed.json?.error?.code} msg=${closed.json?.error?.message}`);

  // 57h. sudo：组设 isSudo:true → 成员登录 → /api/admin/overview 200、session via:sudo
  await req('PATCH', `/api/admin/groups/${p7Group.id}`, { cookie: jar.admin, body: { isSudo: true } });
  const sudoLogin = await req('POST', '/api/auth/login', { body: { email: P7_EMAIL, password: P7_PW } });
  jar.p7sudo = jarOf(sudoLogin.set);
  check('57h0. sudo 成员密码登录 200', sudoLogin.status === 200 && sudoLogin.json?.ok === true,
    `status=${sudoLogin.status} email=${sudoLogin.json?.user?.email}`);
  const ov = await req('GET', '/api/admin/overview', { cookie: jar.p7sudo });
  check('57h1. sudo 用户 /api/admin/overview 200', ov.status === 200,
    `status=${ov.status} code=${ov.json?.error?.code}`);
  const sess = await req('GET', '/api/admin/session', { cookie: jar.p7sudo });
  check('57h2. /api/admin/session 返回 via:sudo',
    sess.status === 200 && sess.json?.admin?.via === 'sudo' && sess.json?.admin?.email === P7_EMAIL,
    `body=${JSON.stringify(sess.json)}`);

  // 57i. 改回 isSudo:false → 同一 cookie 立即 403；重新登录的普通用户也 403
  await req('PATCH', `/api/admin/groups/${p7Group.id}`, { cookie: jar.admin, body: { isSudo: false } });
  const ov2 = await req('GET', '/api/admin/overview', { cookie: jar.p7sudo });
  check('57i1. 移出 sudo 后同一 cookie 立即 403', ov2.status === 403,
    `status=${ov2.status} code=${ov2.json?.error?.code}`);
  const relog = await req('POST', '/api/auth/login', { body: { email: P7_EMAIL, password: P7_PW } });
  const jarP7Normal = jarOf(relog.set);
  const ov3 = await req('GET', '/api/admin/overview', { cookie: jarP7Normal });
  check('57i2. 普通组用户登录后 /api/admin/overview 403 forbidden',
    ov3.status === 403 && ov3.json?.error?.code === 'forbidden',
    `status=${ov3.status} code=${ov3.json?.error?.code}`);

  // 57j. 单位：spaceLimit {1.5, TB} → 十进制字符串 + text 含 TB
  const unit = await req('POST', '/api/admin/groups', {
    cookie: jar.admin,
    body: {
      name: `P7 Unit ${suffix}`,
      spaceLimit: { value: '1.5', unit: 'TB' },
      maxFileSizeBytes: 2147483648, traffic7dLimitBytes: 5368709120,
    },
  });
  const unitItem = unit.json?.item;
  check('57j1. 1.5 TB → spaceLimitBytes=1649267441664 且 spaceLimitText 含 TB',
    unit.status === 201 && unitItem?.spaceLimitBytes === '1649267441664' && /TB/.test(unitItem?.spaceLimitText || ''),
    `bytes=${unitItem?.spaceLimitBytes} text=${unitItem?.spaceLimitText}`);

  // 57k. 16 EB（=2^64）超 SQLite 上限 → 400 invalid_input，details.max 存在
  const over = await req('PATCH', `/api/admin/groups/${unitItem?.id}`, {
    cookie: jar.admin, body: { maxFileSize: { value: '16', unit: 'EB' } },
  });
  check('57k. 16 EB 超上限 400 invalid_input 且 details.max 存在',
    over.status === 400 && over.json?.error?.code === 'invalid_input' && !!over.json?.error?.details?.max,
    `status=${over.status} code=${over.json?.error?.code} details=${JSON.stringify(over.json?.error?.details)}`);

  // 57l. 版本发布检查：200 且非 5xx；current.version 非空字符串；checked:true 时再断言 latest/hasUpdate
  const upd = await req('GET', '/api/admin/update-status', { cookie: jar.admin });
  const updChecked = upd.json?.checked;
  const updReason = upd.json?.reason;
  const updVersion = upd.json?.current?.version;
  let updOk = upd.status === 200 && upd.status < 500 && typeof updVersion === 'string' && updVersion !== '';
  if (updChecked === true) {
    updOk = updOk && typeof upd.json?.hasUpdate === 'boolean' && !!upd.json?.latest?.upgradeCommand;
  }
  check('57l. update-status 200 非 5xx，current.version 非空字符串', updOk,
    `checked=${updChecked} reason=${updReason} version=${updVersion} hasUpdate=${upd.json?.hasUpdate} upgradeCommand=${upd.json?.latest?.upgradeCommand || ''}`);

  // 57m. 收尾切回 supabase，断言来源复位（保证脚本可重复跑）
  const swBack = await req('PUT', '/api/admin/user-source', {
    cookie: jar.admin, body: { source: 'supabase', confirm: true },
  });
  check('57m1. 切回 supabase 200', swBack.status === 200 && swBack.json?.switchedTo === 'supabase',
    `status=${swBack.status} body=${JSON.stringify(swBack.json)}`);
  const srcBack = await req('GET', '/api/admin/user-source', { cookie: jar.admin });
  check('57m2. GET /api/admin/user-source 回到 supabase',
    srcBack.status === 200 && srcBack.json?.userSource === 'supabase',
    `status=${srcBack.status} userSource=${srcBack.json?.userSource}`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
