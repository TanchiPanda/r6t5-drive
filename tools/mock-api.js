/* R6T5 Drive · 契约假后端（仅用于并行开发时前端自测截图，不参与生产）
   用法：node tools/mock-api.js --root .build/B --port 8091
   任何 GET /api/* 返回契约形状的假数据；POST/PATCH 直接回显 ok。 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', '.build/B/public'));
const PORT = Number(arg('port', 8091));

const MB = 1024 * 1024, GB = 1024 * MB;
const now = Date.now();
const iso = h => new Date(now - h * 3600e3).toISOString();

const quota = {
  spaceLimitBytes: 10 * GB, usedBytes: 3.4 * GB, spaceRemainingBytes: 6.6 * GB,
  maxFileSizeBytes: 2 * GB, traffic7dLimitBytes: 5 * GB,
  traffic7dUsedBytes: 1.2 * GB, traffic7dRemainingBytes: 3.8 * GB
};
const publicUser = { id: 'u1', email: 'alice@example.com', displayName: 'Alice', groupId: 'g1', groupName: '标准用户', isAdmin: false, disabled: false };

const groups = [
  { id: 'g1', name: '标准用户', spaceLimitBytes: 10 * GB, maxFileSizeBytes: 2 * GB, traffic7dLimitBytes: 5 * GB, isDefault: true, userCount: 8, createdAt: iso(720) },
  { id: 'g2', name: '进阶用户', spaceLimitBytes: 30 * GB, maxFileSizeBytes: 5 * GB, traffic7dLimitBytes: 20 * GB, isDefault: false, userCount: 3, createdAt: iso(300) },
  { id: 'g3', name: '只读访客', spaceLimitBytes: 1 * GB, maxFileSizeBytes: 100 * MB, traffic7dLimitBytes: 512 * MB, isDefault: false, userCount: 0, createdAt: iso(100) }
];

const users = Array.from({ length: 12 }, (_, i) => ({
  id: 'u' + (i + 1),
  email: ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'ken', 'laura'][i] + '@example.com',
  displayName: '',
  groupId: ['g1', 'g2', 'g1', 'g1', 'g2', 'g1', 'g3', 'g1', 'g2', 'g1', 'g1', 'g1'][i],
  groupName: { g1: '标准用户', g2: '进阶用户', g3: '只读访客' }[['g1', 'g2', 'g1', 'g1', 'g2', 'g1', 'g3', 'g1', 'g2', 'g1', 'g1', 'g1'][i]],
  disabled: i === 9, createdAt: iso(400 + i * 12), lastLoginAt: iso(i * 3 + 1),
  usedBytes: (i + 1) * 240 * MB, fileCount: i + 3
}));

const strategies = [
  { id: 's1', name: '本机数据卷', type: 'volume', region: '本机 data/volume', capacityBytes: 100 * GB, usedBytes: 12.4 * GB, readOnly: false, enabled: true, configMasked: { rootPath: 'data/volume' }, createdAt: iso(200), fileCount: 118, publicView: { name: '本机数据卷', type: 'volume', region: '本机 data/volume', capacityBytes: 100 * GB, readOnly: false } },
  { id: 's2', name: '归档只读卷', type: 'volume', region: '本机 data/archive', capacityBytes: 40 * GB, usedBytes: 9.1 * GB, readOnly: true, enabled: true, configMasked: { rootPath: 'data/archive' }, createdAt: iso(90), fileCount: 22, publicView: { name: '归档只读卷', type: 'volume', region: '本机 data/archive', capacityBytes: 40 * GB, readOnly: true } }
];

const storageTypes = [{
  type: 'volume', label: '本地数据卷', status: 'ready', capabilities: { read: true, write: true },
  publicFields: [
    { key: 'name', label: '策略名' }, { key: 'type', label: '存储类型' }, { key: 'region', label: '位置/区域' },
    { key: 'capacityBytes', label: '容量' }, { key: 'readOnly', label: '是否只读' }
  ],
  neverPublic: [{ key: 'config.*', label: '密钥 / 端点 / 凭证' }],
  fields: [{ key: 'rootPath', label: '数据目录', type: 'text', required: false, secret: false, placeholder: 'data/volume', help: '留空使用默认目录', default: 'data/volume' }],
  notice: '创建后，普通用户可在界面上看到策略名、类型、位置、容量与是否只读；密钥类字段只保存在服务端，永不下发。',
  docsHint: 'P1 只实现本地卷读写；S3/GitHub 适配器在 P2 落地。'
}, {
  type: 's3', label: 'S3 兼容对象存储', status: 'planned', capabilities: { read: true, write: true },
  publicFields: [{ key: 'name', label: '策略名' }, { key: 'type', label: '存储类型' }, { key: 'region', label: '区域' }, { key: 'capacityBytes', label: '容量' }],
  neverPublic: [{ key: 'config.accessKey', label: 'Access Key' }, { key: 'config.secretKey', label: 'Secret Key' }, { key: 'config.endpoint', label: '端点' }],
  fields: [{ key: 'endpoint', label: 'Endpoint', type: 'text', required: true, secret: false }, { key: 'accessKey', label: 'Access Key', type: 'text', required: true, secret: true }, { key: 'secretKey', label: 'Secret Key', type: 'password', required: true, secret: true }],
  notice: '创建后仅展示策略名、类型、区域与容量；Access Key / Secret Key / 端点只保存在服务端。',
  docsHint: 'P2 提供七牛 / OSS / COS / OBS / KS3 / 又拍 / OneDrive 适配器。'
}, {
  type: 'github', label: 'GitHub 仓库（只读）', status: 'planned', capabilities: { read: true, write: false },
  publicFields: [{ key: 'name', label: '策略名' }, { key: 'type', label: '存储类型' }, { key: 'region', label: '仓库' }, { key: 'readOnly', label: '是否只读' }],
  neverPublic: [{ key: 'config.token', label: '访问令牌' }],
  fields: [{ key: 'repo', label: '仓库', type: 'text', required: true, secret: false, placeholder: 'owner/repo' }, { key: 'token', label: '访问令牌', type: 'password', required: true, secret: true }],
  notice: '创建后仅展示策略名、类型、仓库名与只读标记；访问令牌只保存在服务端。',
  docsHint: 'P2 以只读方式挂载仓库内容。'
}];

let seq = 200;
const audit = Array.from({ length: 26 }, (_, i) => ({
  id: seq - i, at: iso(i * 2), email: users[i % users.length].email,
  action: ['upload', 'login', 'download', 'delete', 'rename', 'admin_login', 'settings_update', 'storage_create'][i % 8],
  target: users[i % users.length].email + '/inbox/file-' + (i + 1) + '.bin',
  bytes: (i + 1) * 1024 * 37, ip: '203.0.113.' + (20 + i), detail: ''
}));

const files = [
  { name: '设计稿', path: 'alice@example.com/设计稿', type: 'dir', sizeBytes: 0, itemCount: 6, updatedAt: iso(5) },
  { name: '季度报告.pdf', path: 'alice@example.com/季度报告.pdf', type: 'file', sizeBytes: 4.2 * MB, mime: 'application/pdf', updatedAt: iso(2), storageId: 's1' },
  { name: '合照.jpg', path: 'alice@example.com/合照.jpg', type: 'file', sizeBytes: 12.6 * MB, mime: 'image/jpeg', updatedAt: iso(8), storageId: 's1' },
  { name: 'notes.md', path: 'alice@example.com/notes.md', type: 'file', sizeBytes: 18 * 1024, mime: 'text/markdown', updatedAt: iso(26), storageId: 's1' },
  { name: 'archive-2025.zip', path: 'alice@example.com/archive-2025.zip', type: 'file', sizeBytes: 890 * MB, mime: 'application/zip', updatedAt: iso(60), storageId: 's2' }
];

const seriesDays = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(now - (13 - i) * 86400e3);
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
});

function overview() {
  return {
    users: { total: users.length, active7d: 5, disabled: 1, pendingUploads: 0 },
    traffic: { up7dBytes: 1.2 * GB, down7dBytes: 3.4 * GB, upTodayBytes: 210 * MB },
    storage: {
      usedBytes: 21.5 * GB, capacityBytes: 140 * GB, fileCount: 140, trashCount: 3,
      byStrategy: strategies.map(s => ({ id: s.id, name: s.name, type: s.type, usedBytes: s.usedBytes, capacityBytes: s.capacityBytes }))
    },
    groups: groups.map(g => ({ id: g.id, name: g.name, userCount: g.userCount, spaceLimitBytes: g.spaceLimitBytes })),
    recent: audit.slice(0, 8).map(a => ({ id: a.id, at: a.at, email: a.email, action: a.action, target: a.target, bytes: a.bytes })),
    series: {
      days: seriesDays,
      uploads: [3, 5, 2, 8, 6, 11, 4, 7, 9, 5, 3, 6, 12, 4],
      trafficBytes: [120, 340, 210, 890, 640, 1200, 480, 760, 980, 520, 300, 680, 1400, 420].map(v => v * MB)
    }
  };
}

const settings = {
  siteName: 'R6T5 Drive', publicUrl: '', defaultGroupId: 'g1', allowSignup: false,
  trashRetentionDays: 30, themeDefault: 'dark', maxUploadMb: 2048, updatedAt: iso(20),
  defaults: { siteName: false, publicUrl: true, defaultGroupId: false }
};

function setupStatus() {
  return {
    ready: true, next: 'ready', hint: '配置完成，可以使用邮箱登录', link: '/admin/login', linkLabel: '进入管理后台',
    checks: { supabase: true, storage: true, groups: true, site: true },
    site: { name: settings.siteName, publicUrl: settings.publicUrl, defaultGroupId: settings.defaultGroupId, isDefaultSite: !settings.defaults.publicUrl },
    counts: { users: users.length, groups: groups.length, strategies: strategies.length }
  };
}

const API = {
  '/api/setup/status': () => setupStatus(),
  '/api/admin/setup/status': () => setupStatus(),
  '/api/me': () => ({ user: publicUser, quota, trash: { count: 3, bytes: 42 * MB } }),
  '/api/admin/session': () => ({ ok: true, admin: { passwordSource: 'env', loginAt: iso(1) } }),
  '/api/admin/overview': () => overview(),
  '/api/admin/groups': () => ({ items: groups }),
  '/api/admin/users': () => ({ total: users.length, page: 1, pageSize: 20, items: users }),
  '/api/admin/storage': () => ({ items: strategies }),
  '/api/admin/storage/types': () => ({ items: storageTypes }),
  '/api/admin/supabase': () => ({ configured: true, url: 'https://demo.supabase.co', anonKeyMasked: 'eyJhbG…9fQ', serviceKeyMasked: 'eyJhbG…7cA', updatedAt: iso(48), lastCheck: { ok: true, at: iso(2), latencyMs: 143 } }),
  '/api/admin/settings': () => settings,
  '/api/admin/audit': () => ({ total: audit.length, page: 1, pageSize: 30, items: audit }),
  '/api/admin/trash': () => ({
    items: [
      { id: 'n1', path: 'alice@example.com/old.txt', email: 'alice@example.com', name: 'old.txt', sizeBytes: 1024, deletedAt: iso(6), expiresAt: iso(-660) },
      { id: 'n2', path: 'bob@example.com/draft.docx', email: 'bob@example.com', name: 'draft.docx', sizeBytes: 320 * 1024, deletedAt: iso(30), expiresAt: iso(-690) }
    ], retentionDays: 30
  }),
  '/api/files': q => {
    const p = q.get('path') || 'alice@example.com';
    const items = files.filter(f => f.path.split('/').slice(0, -1).join('/') === p);
    const crumbs = p.split('/').map((seg, i, arr) => ({ label: seg, path: arr.slice(0, i + 1).join('/') }));
    const parentPath = p.split('/').length > 1 ? p.split('/').slice(0, -1).join('/') : null;
    return { path: p, parentPath, crumbs, items, quota };
  },
  '/api/files/search': q => ({ items: files.filter(f => f.name.includes(q.get('q') || '')).map(f => Object.assign({}, f, { highlight: (q.get('q') || '') })), total: 3 }),
  '/api/trash': () => ({
    items: [
      { path: 'alice@example.com/old.txt', name: 'old.txt', sizeBytes: 1024, deletedAt: iso(6), expiresAt: iso(-660), type: 'file' },
      { path: 'alice@example.com/tmp', name: 'tmp', sizeBytes: 0, deletedAt: iso(20), expiresAt: iso(-640), type: 'dir' }
    ], retentionDays: 30
  }),
  '/api/account': () => ({
    user: publicUser, quota,
    byType: { image: 12.6 * MB, document: 4.2 * MB, other: 890 * MB },
    recentUploads: [{ path: 'alice@example.com/季度报告.pdf', sizeBytes: 4.2 * MB, at: iso(2) }, { path: 'alice@example.com/合照.jpg', sizeBytes: 12.6 * MB, at: iso(8) }],
    shareCount: 0
  }),
  '/api/shares': () => ({ items: [], available: false }),
  '/api/share/demo': () => ({ available: false })
};

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function send(res, code, body, type) {
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  if (p.startsWith('/api/')) {
    const hit = API[p] || API[p.replace(/\/$/, '')];
    if (req.method === 'POST') return send(res, 200, JSON.stringify({ ok: true }));
    if (hit) return send(res, 200, JSON.stringify(hit(u.searchParams)));
    // 前缀兜底，供未列举路径（如 /api/share/xxx）不炸
    const pref = Object.keys(API).find(k => p.startsWith(k.split('?')[0]));
    if (pref) return send(res, 200, JSON.stringify(API[pref](u.searchParams)));
    return send(res, 404, JSON.stringify({ error: { code: 'not_found', message: 'mock 未实现该路径：' + p } }));
  }
  let rel = p === '/' ? '/index.html' : p;
  if (rel === '/login') rel = '/login.html';
  if (rel === '/files') rel = '/files.html';
  if (rel === '/account') rel = '/account.html';
  if (rel.startsWith('/admin') && (rel === '/admin' || rel === '/admin/')) rel = '/admin/home.html';
  if (rel.startsWith('/share/')) rel = '/share.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, '<pre>mock 404: ' + rel + '</pre>', 'text/html; charset=utf-8');
  }
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, () => console.log('mock-api root=' + ROOT + ' http://127.0.0.1:' + PORT));
