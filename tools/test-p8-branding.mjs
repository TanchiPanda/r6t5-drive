// P8-A 品牌与站点外观 · 后端 HTTP 自检（配合已启动的隔离实例）
// 用法：BASE=http://127.0.0.1:8190 node tools/test-p8-branding.mjs
// 前置：DB_PATH=/tmp/p8a/r6t5.db STORAGE_ROOT=/tmp/p8a/volume PORT=8190 DEV_AUTH=1 ADMIN_PASSWORD=test123 node server/index.js
const BASE = process.env.BASE || 'http://127.0.0.1:8190';

const jar = { admin: '' };

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

async function req(method, path, { body, cookie, raw, headers = {}, manual = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (manual) opts.redirect = 'manual';
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
  return { status: res.status, json, text, set, redirect: res.headers.get('location') };
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
}

const PNG_MAGIC = Buffer.from('89504e470d0a1a0a', 'hex');
const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle r="8" fill="#4a9e6e"/></svg>';

function pngBuffer(extra = 64) {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(extra, 0x55)]);
}

async function upload(slot, buffer, filename, cookie) {
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type: 'application/octet-stream' }), filename);
  return req('POST', '/api/admin/branding/upload?slot=' + encodeURIComponent(slot), {
    cookie, raw: { body: fd, headers: {} },
  });
}

async function main() {
  // ---------- 1. 初始公开配置：全部 null，manifest 200 ----------
  {
    const r = await req('GET', '/api/branding');
    const b = r.json || {};
    check('1a. 未登录 GET /api/branding 200 且各资源位为 null',
      r.status === 200 && b.logoLightUrl === null && b.logoDarkUrl === null &&
      b.faviconUrl === null && b.icon192Url === null && b.iconLargeUrl === null &&
      b.sidebarHtml === null && !!b.siteName,
      `status=${r.status} body=${JSON.stringify(b)}`);

    const m = await req('GET', '/manifest.webmanifest');
    const mj = m.json || {};
    check('1b. manifest 200，含 name 与两个 icon（192/512）',
      m.status === 200 && !!mj.name && Array.isArray(mj.icons) && mj.icons.length === 2 &&
      mj.icons.some(i => i.sizes === '192x192') && mj.icons.some(i => i.sizes === '512x512'),
      `status=${m.status} icons=${JSON.stringify(mj.icons)}`);
  }

  // ---------- 2. 管理员登录 ----------
  {
    const ok = await req('POST', '/api/admin/login', { body: { password: process.env.ADMIN_PASSWORD || 'test123' } });
    jar.admin = Object.entries(ok.set).map(([k, v]) => `${k}=${v}`).join('; ');
    check('2. 管理员登录 200 并拿到 cookie', ok.status === 200 && !!jar.admin, `status=${ok.status}`);
  }

  // 清掉可能残留的资源位，保证矩阵从干净状态开始
  for (const slot of ['logoLight', 'logoDark', 'favicon', 'icon192', 'iconLarge']) {
    await req('DELETE', '/api/admin/branding/' + slot, { cookie: jar.admin });
  }
  await req('PATCH', '/api/admin/branding', { cookie: jar.admin, body: { sidebarHtml: '' } });

  // ---------- 3. 上传矩阵 ----------
  {
    const png = await upload('favicon', pngBuffer(64), 'logo.png', jar.admin);
    check('3a. 合法 PNG 上传 201 并返回 /branding/...',
      png.status === 201 && png.json?.ok === true && /^\/branding\/favicon-[\da-f]{8}\.png$/.test(png.json?.url || ''),
      `status=${png.status} body=${JSON.stringify(png.json)}`);

    const fake = await upload('logoDark', Buffer.from('<html><body>not an image</body></html>'), 'fake.png', jar.admin);
    check('3b. 扩展名 .png 但内容是 HTML → 400 invalid_input',
      fake.status === 400 && fake.json?.error?.code === 'invalid_input',
      `status=${fake.status} code=${fake.json?.error?.code}`);

    const big = await upload('icon192', Buffer.concat([pngBuffer(0), Buffer.alloc(600 * 1024, 0x55)]), 'big.png', jar.admin);
    check('3c. 600KB 文件 → 413 payload_too_large',
      big.status === 413 && big.json?.error?.code === 'payload_too_large',
      `status=${big.status} code=${big.json?.error?.code}`);

    const svg = await upload('iconLarge', Buffer.from(SVG_OK), 'mark.svg', jar.admin);
    check('3d. 合法 SVG 上传 201',
      svg.status === 201 && svg.json?.ok === true && /^\/branding\/iconLarge-[\da-f]{8}\.svg$/.test(svg.json?.url || ''),
      `status=${svg.status} body=${JSON.stringify(svg.json)}`);

    // 静态文件可访问且无路径穿越
    if (png.json?.url) {
      const file = await req('GET', png.json.url);
      check('3e. 上传文件经 /branding/:name 200 访问', file.status === 200, `status=${file.status} url=${png.json.url}`);
    }
    const trav = await req('GET', '/branding/..%2fdb.js');
    check('3f. 路径穿越被拒绝 404', trav.status === 404, `status=${trav.status}`);
  }

  // ---------- 4. PATCH 配置 + DELETE 回落 ----------
  {
    const patch = await req('PATCH', '/api/admin/branding', {
      cookie: jar.admin,
      body: { logoLightUrl: 'https://example.com/light.png', logoDarkUrl: '/assets/icons/favicon.svg' },
    });
    check('4a. PATCH logoLight/logoDark 200 并回读',
      patch.status === 200 && patch.json?.item?.logoLightUrl === 'https://example.com/light.png' &&
      patch.json?.item?.logoDarkUrl === '/assets/icons/favicon.svg',
      `status=${patch.status} body=${JSON.stringify(patch.json?.item)}`);

    const pub = await req('GET', '/api/branding');
    check('4b. 公开接口能读到已配置的 logoLight/logoDark',
      pub.json?.logoLightUrl === 'https://example.com/light.png' && pub.json?.logoDarkUrl === '/assets/icons/favicon.svg',
      `body=${JSON.stringify(pub.json)}`);

    const del = await req('DELETE', '/api/admin/branding/logoLight', { cookie: jar.admin });
    check('4c. DELETE logoLight 200', del.status === 200 && del.json?.ok === true, `status=${del.status}`);
    const pub2 = await req('GET', '/api/branding');
    check('4d. 删除后 logoLight 回落 null', pub2.json?.logoLightUrl === null, `body=${JSON.stringify(pub2.json)}`);

    // 非法 URL 拒绝
    const bad = await req('PATCH', '/api/admin/branding', { cookie: jar.admin, body: { faviconUrl: 'javascript:alert(1)' } });
    check('4e. 非法协议 URL → 400 invalid_input', bad.status === 400 && bad.json?.error?.code === 'invalid_input',
      `status=${bad.status} code=${bad.json?.error?.code}`);
    const long = await req('PATCH', '/api/admin/branding', { cookie: jar.admin, body: { faviconUrl: 'https://x.com/' + 'a'.repeat(512) } });
    check('4f. 超长 URL（>512）→ 400', long.status === 400, `status=${long.status}`);
  }

  // ---------- 5. 侧边栏 HTML 清洗矩阵 ----------
  const matrix = [
    {
      name: '5a. 安全标签与 https 链接保留',
      input: '<p><strong>hi</strong> <a href="https://example.com/x">link</a></p>',
      expect: { contains: ['<strong>', '<a href="https://example.com/x">'], banned: [] },
    },
    {
      name: '5b. script 标签连同内容移除',
      input: '<script>alert(1)</script><p>ok</p>',
      expect: { banned: ['<script>', 'alert(1)'], contains: ['<p>ok</p>'] },
    },
    {
      name: '5c. data: 图片被剔除',
      input: '<img src="data:image/png;base64,AAA">',
      expect: { banned: ['data:', '<img'] },
    },
    {
      name: '5d. javascript: 链接被剔除（含孤儿闭合标签）',
      input: '<a href="javascript:alert(1)">x</a>',
      expect: { banned: ['javascript:', '<a', '</a>'] },
    },
    {
      name: '5e. on* 事件属性被剔除',
      input: '<p onclick="evil()">t</p><img src="/assets/favicon.svg" onerror="x()">',
      expect: { banned: ['onclick', 'onerror'] },
    },
    {
      name: '5f. iframe 移除，em 保留',
      input: '<iframe src="https://x"></iframe><em>e</em>',
      expect: { banned: ['<iframe>'], contains: ['<em>e</em>'] },
    },
    {
      name: '5g. http:// 链接保留',
      input: '<a href="http://example.com">http ok</a>',
      expect: { contains: ['<a href="http://example.com">'] },
    },
    {
      name: '5h. 白名单域名图片保留',
      input: '<img src="https://raw.githubusercontent.com/a/b/c.png" alt="r">',
      expect: { contains: ['<img src="https://raw.githubusercontent.com/a/b/c.png"'] },
    },
    {
      name: '5i. style 属性中的 url( 被剔除',
      input: '<p style="background:url(/x.png)">t</p>',
      expect: { banned: ['style=', 'url('] },
    },
    {
      name: '5j. 非白名单域名图片被剔除',
      input: '<img src="https://evil.com/x.png">',
      expect: { banned: ['evil.com', '<img'] },
    },
  ];
  for (const c of matrix) {
    const r = await req('PATCH', '/api/admin/branding', { cookie: jar.admin, body: { sidebarHtml: c.input } });
    const cleaned = r.json?.item?.sidebarHtml || '';
    const raw = r.json?.sidebarHtmlRaw;
    const bannedHit = (c.expect.banned || []).filter(b => cleaned.includes(b));
    const missing = (c.expect.contains || []).filter(x => !cleaned.includes(x));
    check(c.name, r.status === 200 && bannedHit.length === 0 && missing.length === 0 && raw === c.input,
      `cleaned=${JSON.stringify(cleaned)} bannedHit=${bannedHit.join(',')} missing=${missing.join(',')}`);
  }

  // ---------- 6. 鉴权 ----------
  {
    const pub = await req('GET', '/api/branding');
    check('6a. 未登录访问 /api/branding 200（登录页需要）', pub.status === 200, `status=${pub.status}`);
    const admin = await req('GET', '/api/admin/branding');
    check('6b. 未登录访问 /api/admin/branding 401', admin.status === 401 && admin.json?.error?.code === 'unauthorized',
      `status=${admin.status} code=${admin.json?.error?.code}`);
  }

  // ---------- 7. 短链回落 ----------
  {
    await req('DELETE', '/api/admin/branding/favicon', { cookie: jar.admin });
    await req('DELETE', '/api/admin/branding/logoLight', { cookie: jar.admin });
    await req('DELETE', '/api/admin/branding/logoDark', { cookie: jar.admin });
    const f = await req('GET', '/branding/favicon', { manual: true });
    const ll = await req('GET', '/branding/logo-light', { manual: true });
    const ld = await req('GET', '/branding/logo-dark', { manual: true });
    check('7a. /branding/favicon 无配置 302 到默认 favicon.svg', f.status === 302 && f.redirect?.endsWith('/assets/favicon.svg'),
      `status=${f.status} ->${f.redirect}`);
    check('7b. /branding/logo-light 无配置 302 到默认 favicon.svg', ll.status === 302 && ll.redirect?.endsWith('/assets/favicon.svg'),
      `status=${ll.status} ->${ll.redirect}`);
    check('7c. /branding/logo-dark 无配置 302 到默认 icons/favicon.svg', ld.status === 302 && ld.redirect?.endsWith('/assets/icons/favicon.svg'),
      `status=${ld.status} ->${ld.redirect}`);
  }
}

main().catch(e => {
  console.error('脚本异常：', e);
  process.exit(1);
}).then(() => {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
});
