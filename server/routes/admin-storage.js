import { Router } from 'express';
import * as registry from '../services/storage/registry.js';
import { getDriver, driverCaps } from '../services/storage/driver.js';
import { db, getSetting, setSetting } from '../db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';
import { nowIso } from '../lib/format.js';

const router = Router();

const PUBLIC_FIELDS = [
  { key: 'name', label: '策略名' },
  { key: 'type', label: '存储类型' },
  { key: 'region', label: '位置/区域' },
  { key: 'capacityBytes', label: '容量' },
  { key: 'readOnly', label: '是否只读' },
];

const TYPES = ['volume', 's3', 'github'];

// 各类型的密钥字段（PATCH 时前端回传 `****` 开头占位串视为「不修改」）
const SECRET_KEYS = {
  volume: [],
  s3: ['accessKeyId', 'secretAccessKey'],
  github: ['token'],
};

const TYPE_REGISTRY = {
  volume: {
    type: 'volume',
    label: '本地数据卷',
    status: 'ready',
    capabilities: { read: true, write: true, list: true },
    publicFields: PUBLIC_FIELDS,
    neverPublic: [{ key: 'config.*', label: '密钥 / 端点 / 凭证' }],
    fields: [
      {
        key: 'rootPath', label: '数据目录', type: 'text', required: false, secret: false,
        placeholder: 'data/volume', help: '留空使用默认目录', default: 'data/volume',
      },
    ],
    notice: '创建后，普通用户可在界面上看到策略名、类型、位置、容量与是否只读；密钥类字段只保存在服务端，永不下发。',
    docsHint: 'P1 只实现本地卷读写；S3/GitHub 适配器在 P2 落地。',
  },
  s3: {
    type: 's3',
    label: 'S3 兼容对象存储',
    status: 'ready',
    capabilities: { read: true, write: true, list: true },
    publicFields: PUBLIC_FIELDS,
    neverPublic: [
      { key: 'config.endpoint', label: '服务端点' },
      { key: 'config.accessKeyId', label: 'Access Key ID' },
      { key: 'config.secretAccessKey', label: 'Secret Access Key' },
    ],
    fields: [
      { key: 'endpoint', label: 'Endpoint', type: 'text', required: true, placeholder: 'https://s3.us-east-1.amazonaws.com', help: 'AWS S3 / R2 / MinIO / 七牛 / OSS / COS / OBS / KS3 等 S3 兼容服务' },
      { key: 'region', label: 'Region', type: 'text', required: true, default: 'us-east-1' },
      { key: 'bucket', label: 'Bucket', type: 'text', required: true },
      { key: 'accessKeyId', label: 'Access Key ID', type: 'text', required: true, secret: true },
      { key: 'secretAccessKey', label: 'Secret Access Key', type: 'password', required: true, secret: true },
      { key: 'prefix', label: '对象前缀', type: 'text', required: false, placeholder: 'r6t5-drive' },
      { key: 'pathStyle', label: '访问形态', type: 'select', required: false, default: 'auto',
        options: [{ value: 'auto', label: '自动' }, { value: 'on', label: 'path-style' }, { value: 'off', label: 'virtual-host' }] },
    ],
    notice: '创建后，普通用户只会看到策略名、类型、区域、容量与是否只读；Endpoint、Access Key、Secret Key 仅存服务端，永不下发。',
    docsHint: '使用 AWS SigV4 签名；上传为流式，不整文件读入内存。',
  },
  github: {
    type: 'github',
    label: 'GitHub 仓库（只读）',
    status: 'ready',
    capabilities: { read: true, write: false, list: true },
    publicFields: PUBLIC_FIELDS,
    neverPublic: [{ key: 'config.token', label: '访问令牌' }],
    fields: [
      { key: 'repo', label: '仓库', type: 'text', required: true, placeholder: 'owner/repo' },
      { key: 'branch', label: '分支', type: 'text', required: false, default: 'main' },
      { key: 'rootPath', label: '仓库内根目录', type: 'text', required: false, placeholder: 'drive' },
      { key: 'token', label: '访问令牌', type: 'password', required: false, secret: true,
        help: '公开仓库可留空；私有仓库需要 repo 读权限的 fine-grained token' },
    ],
    notice: '创建后，普通用户只会看到策略名、类型、仓库名与只读标记；访问令牌仅存服务端。',
    docsHint: '列目录走 Contents API，下载走 raw；本策略所有写操作返回 403 strategy_readonly。',
  },
};

router.get('/types', (req, res) => {
  res.json({ items: TYPES.map((t) => TYPE_REGISTRY[t]) });
});

function parseConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

function normalizeConfig(type, cfg) {
  cfg = parseConfig(cfg);
  if (type === 'volume') {
    return { rootPath: cfg.rootPath || 'data/volume' };
  }
  if (type === 's3') {
    return {
      endpoint: String(cfg.endpoint || '').trim(),
      region: String(cfg.region || 'us-east-1').trim() || 'us-east-1',
      bucket: String(cfg.bucket || '').trim(),
      accessKeyId: String(cfg.accessKeyId || '').trim(),
      secretAccessKey: String(cfg.secretAccessKey || ''),
      prefix: String(cfg.prefix || '').trim(),
      pathStyle: ['auto', 'on', 'off'].includes(cfg.pathStyle) ? cfg.pathStyle : 'auto',
    };
  }
  // github
  return {
    repo: String(cfg.repo || '').trim(),
    branch: String(cfg.branch || 'main').trim() || 'main',
    rootPath: String(cfg.rootPath || '').trim(),
    token: String(cfg.token || ''),
  };
}

function validateRequired(type, cfg) {
  const required = {
    volume: [],
    s3: ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'],
    github: ['repo'],
  }[type];
  for (const field of required) {
    if (cfg[field] == null || String(cfg[field]).trim() === '') {
      throw badRequest('invalid_input', `缺少必填字段 ${field}`, { field });
    }
  }
}

function defaultRegion(type, cfg) {
  if (type === 's3') return `${cfg.region} · ${cfg.bucket}`;
  if (type === 'github') return `${cfg.repo}@${cfg.branch}`;
  return '本机 data/volume';
}

function maskSecret(v) {
  if (!v) return null;
  const s = String(v);
  return `****${s.slice(-4)}`;
}

function maskConfig(type, cfg) {
  if (type === 'volume') return { rootPath: cfg.rootPath || 'data/volume' };
  if (type === 's3') {
    return {
      endpoint: cfg.endpoint || '',
      bucket: cfg.bucket || '',
      prefix: cfg.prefix || '',
      accessKeyId: cfg.accessKeyId ? maskSecret(cfg.accessKeyId) : null,
    };
  }
  return {
    repo: cfg.repo || '',
    branch: cfg.branch || 'main',
    rootPath: cfg.rootPath || '',
    token: cfg.token ? maskSecret(cfg.token) : null,
  };
}

function readHealth(id) {
  const raw = getSetting(`health:${id}`, null);
  if (!raw) return { ok: null, checkedAt: null, message: null };
  try {
    const h = JSON.parse(raw);
    return {
      ok: h.ok == null ? null : !!h.ok,
      checkedAt: h.checkedAt || null,
      message: h.message || null,
    };
  } catch {
    return { ok: null, checkedAt: null, message: null };
  }
}

function serialize(s) {
  let config = {};
  try { config = s.config ? JSON.parse(s.config) : {}; } catch { config = {}; }
  const fileCount = registry.fileCountForStrategy(s.id);
  const usedBytes = registry.usedBytesForStrategy(s.id);
  const readOnly = !!s.readOnly;
  const publicView = {
    name: s.name, type: s.type, region: s.region,
    capacityBytes: Number(s.capacityBytes), readOnly,
  };
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    region: s.region,
    capacityBytes: Number(s.capacityBytes),
    usedBytes,
    readOnly,
    enabled: !!s.enabled,
    fileCount,
    capabilities: driverCaps(s.type),
    configMasked: maskConfig(s.type, config),
    health: readHealth(s.id),
    createdAt: s.createdAt,
    publicView,
  };
}

router.get('/', (req, res) => {
  res.json({ items: registry.listStrategies().map(serialize) });
});

router.post('/', (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.acknowledgeDisclosure !== true) {
      throw badRequest('not_acknowledged', '创建存储策略前需确认公开字段披露', { publicFields: PUBLIC_FIELDS });
    }
    const type = body.type;
    if (!TYPES.includes(type)) throw badRequest('invalid_input', '未知存储类型', { field: 'type' });
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 64) {
      throw badRequest('invalid_input', '策略名长度需为 1–64 字', { field: 'name' });
    }
    const capacity = Number(body.capacityBytes);
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw badRequest('invalid_input', '容量必须大于 0', { field: 'capacityBytes' });
    }
    const config = normalizeConfig(type, body.config);
    validateRequired(type, config);

    const readOnly = type === 'github' ? true : !!body.readOnly;
    const region = (typeof body.region === 'string' && body.region.trim()) ? body.region.trim() : defaultRegion(type, config);

    const strategy = registry.createStrategy({
      name: body.name.trim(),
      type,
      region,
      capacityBytes: Math.trunc(capacity),
      readOnly,
      config,
    });
    writeAudit({ email: 'admin', action: 'storage_create', target: strategy.name });
    res.status(201).json({ item: serialize(strategy) });
  } catch (e) { next(e); }
});

// 未保存先测：用临时 strategy 对象调驱动 test()，失败也返回 200 + ok:false
router.post('/validate', async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = body.type;
    if (!TYPES.includes(type)) throw badRequest('invalid_input', '未知存储类型', { field: 'type' });
    const config = normalizeConfig(type, body.config);
    const temp = { id: null, type, config: JSON.stringify(config) };
    let result;
    try {
      result = await getDriver(type).test(temp);
      if (!result) result = { ok: false, message: '驱动未返回结果' };
    } catch (e) {
      result = { ok: false, message: e.message || String(e) };
    }
    res.json({ ok: !!result.ok, message: result.message || '', details: result.details || {} });
  } catch (e) { next(e); }
});

router.post('/:id/test', async (req, res, next) => {
  try {
    const s = registry.getStrategy(req.params.id);
    if (!s) throw notFound('策略不存在');
    let result;
    try {
      result = await getDriver(s.type).test(s);
      if (!result) result = { ok: false, message: '驱动未返回结果' };
    } catch (e) {
      result = { ok: false, message: e.message || String(e) };
    }
    const ok = !!result.ok;
    const health = { ok, checkedAt: nowIso(), message: result.message || '' };
    setSetting(`health:${s.id}`, JSON.stringify(health));
    const writable = !!driverCaps(s.type).write && !s.readOnly;
    res.json({ ok, writable, message: result.message || '', details: result.details || {} });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const s = registry.getStrategy(req.params.id);
    if (!s) throw notFound('策略不存在');
    const body = req.body || {};

    if (body.capacityBytes != null) {
      const capacity = Number(body.capacityBytes);
      if (!Number.isFinite(capacity) || capacity <= 0) {
        throw badRequest('invalid_input', '容量必须大于 0', { field: 'capacityBytes' });
      }
      body.capacityBytes = Math.trunc(capacity);
    }

    const fields = {};
    for (const k of ['name', 'region', 'capacityBytes', 'readOnly', 'enabled']) {
      if (body[k] != null) fields[k] = body[k];
    }
    if (s.type === 'github') fields.readOnly = true;

    if (body.config != null && typeof body.config === 'object') {
      let oldConfig = {};
      try { oldConfig = s.config ? JSON.parse(s.config) : {}; } catch { oldConfig = {}; }
      const merged = { ...oldConfig };
      const secretKeys = SECRET_KEYS[s.type] || [];
      for (const [key, v] of Object.entries(body.config)) {
        // 密钥字段回传 `****` 开头占位串 → 视为不修改，保留原值
        // 空串也视为「不修改」，避免前端未回填就把旧密钥抹成空
        if (secretKeys.includes(key) && (v == null || (typeof v === 'string' && (v === '' || v.startsWith('****'))))) continue;
        merged[key] = v;
      }
      fields.config = merged;
    }

    const updated = registry.updateStrategy(s.id, fields);
    res.json({ item: serialize(updated) });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const s = registry.getStrategy(req.params.id);
    if (!s) throw notFound('策略不存在');
    const fileCount = registry.fileCountForStrategy(s.id);
    if (fileCount > 0) throw conflict('策略下仍有文件，不能删除', { fileCount });
    const bound = db.prepare('SELECT COUNT(*) AS n FROM storage_bindings WHERE strategyId = ?').get(s.id).n;
    if (bound > 0) throw conflict('该策略仍被目录绑定引用，请先解除目录绑定', { bindingCount: bound });
    registry.deleteStrategy(s.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
