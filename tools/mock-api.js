/* R6T5 Drive · 契约假后端（仅用于并行开发时前端自测截图，不参与生产）
   用法：node tools/mock-api.js --root .build/B --port 8091
   任何 GET /api/* 返回契约形状的假数据；POST/PATCH 直接回显 ok。 */

import http from 'http';
import fs from 'fs';
import path from 'path';

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
  { id: 's1', name: '本机数据卷', type: 'volume', region: '本机 data/volume', capacityBytes: 100 * GB, usedBytes: 12.4 * GB, readOnly: false, enabled: true,
    capabilities: { read: true, write: true, list: true },
    configMasked: { rootPath: 'data/volume' }, createdAt: iso(200), fileCount: 118,
    health: { ok: true, checkedAt: iso(1), message: '磁盘可读写，剩余空间充足' },
    publicView: { name: '本机数据卷', type: 'volume', region: '本机 data/volume', capacityBytes: 100 * GB, readOnly: false } },
  { id: 's2', name: '图片与媒体库', type: 's3', region: 'us-east-1 · media-bucket', capacityBytes: 500 * GB, usedBytes: 86.2 * GB, readOnly: false, enabled: true,
    capabilities: { read: true, write: true, list: true },
    configMasked: { endpoint: 'https://s3.us-east-1.amazonaws.com', bucket: 'media-bucket', prefix: 'r6t5-drive', accessKeyId: '****9fQZ' }, createdAt: iso(120), fileCount: 432,
    health: { ok: true, checkedAt: iso(3), message: 'HeadBucket 与前缀列举均正常' },
    publicView: { name: '图片与媒体库', type: 's3', region: 'us-east-1 · media-bucket', capacityBytes: 500 * GB, readOnly: false } },
  { id: 's3', name: '仓库只读镜像', type: 'github', region: 'acme/docs-drive · main', capacityBytes: 20 * GB, usedBytes: 3.7 * GB, readOnly: true, enabled: true,
    capabilities: { read: true, write: false, list: true },
    configMasked: { repo: 'acme/docs-drive', branch: 'main', rootPath: 'drive' }, createdAt: iso(60), fileCount: 87,
    health: { ok: false, checkedAt: iso(26), message: '最近一次 Contents API 拉取超时，稍后重试自检' },
    publicView: { name: '仓库只读镜像', type: 'github', region: 'acme/docs-drive · main', capacityBytes: 20 * GB, readOnly: true } }
];

const bindings = [
  { id: 'b1', strategyId: 's2', strategyName: '图片与媒体库', strategyType: 's3', strategyReadOnly: false, scope: 'site', email: null, subPath: 'media', createdAt: iso(110) },
  { id: 'b2', strategyId: 's3', strategyName: '仓库只读镜像', strategyType: 'github', strategyReadOnly: true, scope: 'user', email: 'alice@example.com', subPath: 'archive/2025', createdAt: iso(55) }
];

const storageTypes = [{
  type: 'volume', label: '本地数据卷', status: 'ready', capabilities: { read: true, write: true, list: true },
  publicFields: [
    { key: 'name', label: '策略名' }, { key: 'type', label: '存储类型' }, { key: 'region', label: '位置/区域' },
    { key: 'capacityBytes', label: '容量' }, { key: 'readOnly', label: '是否只读' }
  ],
  neverPublic: [{ key: 'config.*', label: '密钥 / 端点 / 凭证' }],
  fields: [{ key: 'rootPath', label: '数据目录', type: 'text', required: false, secret: false, placeholder: 'data/volume', help: '留空使用默认目录', default: 'data/volume' }],
  notice: '创建后，普通用户可在界面上看到策略名、类型、位置、容量与是否只读；密钥类字段只保存在服务端，永不下发。',
  docsHint: '本地卷读写；文件直接落盘到服务端数据目录。'
}, {
  type: 's3', label: 'S3 兼容对象存储', status: 'ready', capabilities: { read: true, write: true, list: true },
  publicFields: [
    { key: 'name', label: '策略名' }, { key: 'type', label: '存储类型' }, { key: 'region', label: '位置/区域' },
    { key: 'capacityBytes', label: '容量' }, { key: 'readOnly', label: '是否只读' }
  ],
  neverPublic: [
    { key: 'config.endpoint', label: '服务端点' },
    { key: 'config.accessKeyId', label: 'Access Key ID' },
    { key: 'config.secretAccessKey', label: 'Secret Access Key' }
  ],
  fields: [
    { key: 'endpoint', label: 'Endpoint', type: 'text', required: true, placeholder: 'https://s3.us-east-1.amazonaws.com', help: '兼容 S3 协议的对象存储服务端点' },
    { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' },
    { key: 'bucket', label: 'Bucket', type: 'text', required: true, placeholder: 'my-bucket' },
    { key: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true, secret: true },
    { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true, secret: true },
    { key: 'prefix', label: '对象前缀', type: 'text', required: false, placeholder: 'r6t5-drive' },
    { key: 'pathStyle', label: '访问形态', type: 'select', required: false, default: 'auto',
      options: [{ value: 'auto', label: '自动' }, { value: 'on', label: 'path-style' }, { value: 'off', label: 'virtual-host' }] }
  ],
  notice: '创建后，普通用户只会看到策略名、类型、区域、容量与是否只读；Endpoint、Access Key、Secret Key 仅存服务端，永不下发。',
  docsHint: '使用签名请求；上传为流式，不整文件读入内存。'
}, {
  type: 'github', label: 'GitHub 仓库（只读）', status: 'ready', capabilities: { read: true, write: false, list: true },
  publicFields: [
    { key: 'name', label: '策略名' }, { key: 'type', label: '存储类型' }, { key: 'region', label: '仓库' },
    { key: 'readOnly', label: '是否只读' }
  ],
  neverPublic: [{ key: 'config.token', label: '访问令牌' }],
  fields: [
    { key: 'repo', label: '仓库', type: 'text', required: true, placeholder: 'owner/repo' },
    { key: 'branch', label: '分支', type: 'text', required: false, default: 'main' },
    { key: 'rootPath', label: '仓库内根目录', type: 'text', required: false, placeholder: 'drive' },
    { key: 'token', label: '访问令牌', type: 'password', required: false, secret: true,
      help: '公开仓库可留空；私有仓库需要仓库读权限的访问令牌' }
  ],
  notice: '创建后，普通用户只会看到策略名、类型、仓库名与只读标记；访问令牌仅存服务端。',
  docsHint: '列目录走 Contents API，下载走原始文件；本策略所有写操作返回 403 strategy_readonly。'
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
  { name: 'media', path: 'alice@example.com/media', type: 'dir', sizeBytes: 0, itemCount: 3, updatedAt: iso(4), remote: true },
  { name: 'archive', path: 'alice@example.com/archive', type: 'dir', sizeBytes: 0, itemCount: 1, updatedAt: iso(10) },
  { name: '季度报告.pdf', path: 'alice@example.com/季度报告.pdf', type: 'file', sizeBytes: 4.2 * MB, mime: 'application/pdf', updatedAt: iso(2), storageId: 's1' },
  { name: '合照.jpg', path: 'alice@example.com/合照.jpg', type: 'file', sizeBytes: 12.6 * MB, mime: 'image/jpeg', updatedAt: iso(8), storageId: 's1' },
  { name: 'notes.md', path: 'alice@example.com/notes.md', type: 'file', sizeBytes: 18 * 1024, mime: 'text/markdown', updatedAt: iso(26), storageId: 's1' },
  // media 目录：来自 S3 前缀列举（remote），其中一个大小未知
  { name: 'IMG_001.jpg', path: 'alice@example.com/media/IMG_001.jpg', type: 'file', sizeBytes: 3.2 * MB, mime: 'image/jpeg', updatedAt: iso(3), storageId: 's2', remote: true },
  { name: '视频剪辑.mp4', path: 'alice@example.com/media/视频剪辑.mp4', type: 'file', sizeBytes: null, mime: 'video/mp4', updatedAt: iso(9), storageId: 's2', remote: true },
  { name: '素材', path: 'alice@example.com/media/素材', type: 'dir', sizeBytes: 0, itemCount: 4, updatedAt: iso(12), storageId: 's2', remote: true },
  // archive/2025：来自 GitHub Contents 列举（remote，只读策略）
  { name: 'README.md', path: 'alice@example.com/archive/2025/README.md', type: 'file', sizeBytes: 24 * 1024, mime: 'text/markdown', updatedAt: iso(30), storageId: 's3', remote: true, readOnly: true },
  { name: '规范手册.pdf', path: 'alice@example.com/archive/2025/规范手册.pdf', type: 'file', sizeBytes: 18.4 * MB, mime: 'application/pdf', updatedAt: iso(48), storageId: 's3', remote: true, readOnly: true },
  { name: 'docs', path: 'alice@example.com/archive/2025/docs', type: 'dir', sizeBytes: 0, itemCount: 5, updatedAt: iso(40), storageId: 's3', remote: true, readOnly: true }
];

function strategyForPath(p) {
  if (p.indexOf('alice@example.com/archive/2025') === 0) {
    return { strategy: { id: 's3', name: '仓库只读镜像', type: 'github', readOnly: true, region: 'acme/docs-drive · main', matchedBy: 'binding', bindingId: 'b2', bindingPath: 'archive/2025' } };
  }
  if (p.indexOf('alice@example.com/media') === 0) {
    return { strategy: { id: 's2', name: '图片与媒体库', type: 's3', readOnly: false, region: 'us-east-1 · media-bucket', matchedBy: 'binding', bindingId: 'b1', bindingPath: 'media' } };
  }
  return { strategy: { id: 's1', name: '本机数据卷', type: 'volume', readOnly: false, region: '本机 data/volume', matchedBy: 'local', bindingId: null, bindingPath: '' } };
}

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
    const { strategy } = strategyForPath(p);
    return { path: p, parentPath, crumbs, items, strategy, quota };
  },
  '/api/admin/storage/validate': body => {
    const type = body && body.type;
    const config = (body && body.config) || {};
    if (type === 's3' && (!config.endpoint || !config.bucket)) {
      return { ok: false, message: 'Endpoint 与 Bucket 为必填项，未发起上游连接测试。', details: {} };
    }
    if (type === 'github' && !config.repo) {
      return { ok: false, message: '仓库地址为必填项，未发起上游连接测试。', details: {} };
    }
    const msg = type === 's3' ? 'HeadBucket 与前缀列举测试通过，可读写。'
      : type === 'github' ? '仓库与分支可访问；该策略为只读。'
      : '本地目录可读写，剩余空间充足。';
    return { ok: true, message: msg, details: { latencyMs: 128 } };
  },
  '/api/admin/bindings': q => ({ items: bindings }),
  '/api/admin/bindings/resolve': q => {
    const p = q.get('path') || 'alice@example.com';
    const { strategy } = strategyForPath(p);
    const matched = strategy.matchedBy === 'binding'
      ? bindings.find(b => b.id === strategy.bindingId)
      : null;
    return {
      strategy: { id: strategy.id, name: strategy.name, type: strategy.type, readOnly: strategy.readOnly, region: strategy.region },
      matchedBy: strategy.matchedBy,
      bindingId: strategy.bindingId,
      depth: matched ? matched.subPath.split('/').filter(Boolean).length : 0,
      subPath: strategy.bindingPath
    };
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

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { resolve({}); }
    });
  });
}

function errBody(code, message, status) {
  return { code, message };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  if (p.startsWith('/api/')) {
    const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};

    // P2-3 保存前测试连接
    if (p === '/api/admin/storage/validate' && req.method === 'POST') {
      return send(res, 200, JSON.stringify(API['/api/admin/storage/validate'](body)));
    }

    // P2-4 目录绑定：/resolve 优先于 /:id
    if (p === '/api/admin/bindings/resolve' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(API['/api/admin/bindings/resolve'](u.searchParams)));
    }
    const bindMatch = p.match(/^\/api\/admin\/bindings\/([^/]+)$/);
    if (p === '/api/admin/bindings' || bindMatch) {
      if (req.method === 'GET') return send(res, 200, JSON.stringify({ items: bindings }));
      if (req.method === 'POST') {
        const dup = bindings.some(b => (b.scope === (body.scope || 'site')) &&
          ((b.email || '') === (body.email || '')) && (b.subPath || '') === (body.subPath || ''));
        if (dup) return send(res, 409, JSON.stringify({ error: errBody('conflict', '该生效范围与目录已存在绑定，请勿重复添加') }));
        const strategy = strategies.find(s => s.id === body.strategyId);
        const item = {
          id: 'b' + (bindings.length + 1) + '-' + Math.random().toString(36).slice(2, 6),
          strategyId: body.strategyId,
          strategyName: strategy ? strategy.name : '未知策略',
          strategyType: strategy ? strategy.type : 'volume',
          strategyReadOnly: strategy ? !!strategy.readOnly : false,
          scope: body.scope === 'user' ? 'user' : 'site',
          email: body.scope === 'user' ? (body.email || '') : null,
          subPath: body.subPath || '',
          createdAt: new Date().toISOString()
        };
        bindings.push(item);
        return send(res, 201, JSON.stringify({ item }));
      }
      if (bindMatch && req.method === 'PATCH') {
        const item = bindings.find(b => b.id === decodeURIComponent(bindMatch[1]));
        if (!item) return send(res, 404, JSON.stringify({ error: errBody('not_found', '绑定不存在') }));
        Object.assign(item, body.strategyId ? { strategyId: body.strategyId } : {},
          body.scope ? { scope: body.scope } : {},
          body.email !== undefined ? { email: body.scope === 'user' ? body.email : null } : {},
          body.subPath !== undefined ? { subPath: body.subPath } : {});
        const st = strategies.find(s => s.id === item.strategyId);
        if (st) { item.strategyName = st.name; item.strategyType = st.type; item.strategyReadOnly = !!st.readOnly; }
        return send(res, 200, JSON.stringify({ item }));
      }
      if (bindMatch && req.method === 'DELETE') {
        const i = bindings.findIndex(b => b.id === decodeURIComponent(bindMatch[1]));
        if (i < 0) return send(res, 404, JSON.stringify({ error: errBody('not_found', '绑定不存在') }));
        bindings.splice(i, 1);
        return send(res, 200, JSON.stringify({ ok: true }));
      }
      return send(res, 405, JSON.stringify({ error: errBody('invalid_input', '不支持的方法：' + req.method) }));
    }

    const testMatch = p.match(/^\/api\/admin\/storage\/([^/]+)\/test$/);
    if (testMatch && req.method === 'POST') {
      const st = strategies.find(s => s.id === decodeURIComponent(testMatch[1]));
      const ok = st ? !(st.health && st.health.ok === false) : false;
      return send(res, 200, JSON.stringify({ ok, writable: st ? !st.readOnly : false, message: st ? (st.health && st.health.message) : '策略不存在' }));
    }

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
