import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../config.js';
import * as registry from '../services/storage/registry.js';
import { badRequest, conflict, notFound, notImplemented } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

const PUBLIC_FIELDS = [
  { key: 'name', label: '策略名' },
  { key: 'type', label: '存储类型' },
  { key: 'region', label: '位置/区域' },
  { key: 'capacityBytes', label: '容量' },
  { key: 'readOnly', label: '是否只读' },
];

router.get('/types', (req, res) => {
  res.json({
    items: [
      {
        type: 'volume',
        label: '本地数据卷',
        status: 'ready',
        capabilities: { read: true, write: true },
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
      { type: 's3', label: 'S3 对象存储', status: 'planned', capabilities: { read: false, write: false }, publicFields: PUBLIC_FIELDS, neverPublic: [], fields: [], notice: '', docsHint: 'P2 落地。' },
      { type: 'github', label: 'GitHub 仓库', status: 'planned', capabilities: { read: false, write: false }, publicFields: PUBLIC_FIELDS, neverPublic: [], fields: [], notice: '', docsHint: 'P2 落地。' },
    ],
  });
});

function serialize(s) {
  let config = {};
  try { config = s.config ? JSON.parse(s.config) : {}; } catch { config = {}; }
  const fileCount = registry.fileCountForStrategy(s.id);
  const usedBytes = registry.usedBytesForStrategy(s.id);
  const publicView = {
    name: s.name, type: s.type, region: s.region,
    capacityBytes: Number(s.capacityBytes), readOnly: !!s.readOnly,
  };
  return {
    id: s.id, name: s.name, type: s.type, region: s.region,
    capacityBytes: Number(s.capacityBytes), usedBytes,
    readOnly: !!s.readOnly, enabled: !!s.enabled,
    configMasked: { rootPath: config.rootPath || 'data/volume' },
    createdAt: s.createdAt, fileCount, publicView,
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
    if (registry.PLANNED_TYPES.includes(body.type)) {
      throw notImplemented('该存储适配器在 P2 规划中');
    }
    if (body.type !== 'volume') throw badRequest('invalid_input', '未知存储类型', { field: 'type' });
    if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 64) {
      throw badRequest('invalid_input', '策略名长度需为 1–64 字', { field: 'name' });
    }
    const capacity = Number(body.capacityBytes);
    if (!Number.isFinite(capacity) || capacity <= 0) throw badRequest('invalid_input', '容量必须大于 0', { field: 'capacityBytes' });
    const strategy = registry.createStrategy({
      name: body.name.trim(),
      type: body.type,
      region: body.region || '本机 data/volume',
      capacityBytes: Math.trunc(capacity),
      readOnly: !!body.readOnly,
      config: { rootPath: body.config?.rootPath || 'data/volume' },
    });
    writeAudit({ email: 'admin', action: 'storage_create', target: strategy.name });
    res.status(201).json({ item: serialize(strategy) });
  } catch (e) { next(e); }
});

router.post('/:id/test', (req, res, next) => {
  try {
    const s = registry.getStrategy(req.params.id);
    if (!s) throw notFound('策略不存在');
    let config = {};
    try { config = s.config ? JSON.parse(s.config) : {}; } catch { config = {}; }
    const root = path.isAbsolute(config.rootPath) ? config.rootPath : path.resolve(process.cwd(), config.rootPath || ENV.STORAGE_ROOT);
    let writable = false;
    let message = '';
    try {
      fs.mkdirSync(root, { recursive: true });
      const probe = path.join(root, `.probe-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      writable = true;
    } catch (e) {
      message = `不可写：${e.code || e.message}`;
    }
    res.json({ ok: writable, writable, usedBytes: registry.usedBytesForStrategy(s.id), message });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const s = registry.getStrategy(req.params.id);
    if (!s) throw notFound('策略不存在');
    const body = req.body || {};
    if (body.capacityBytes != null) {
      const capacity = Number(body.capacityBytes);
      if (!Number.isFinite(capacity) || capacity <= 0) throw badRequest('invalid_input', '容量必须大于 0', { field: 'capacityBytes' });
      body.capacityBytes = Math.trunc(capacity);
    }
    const updated = registry.updateStrategy(s.id, body);
    res.json({ item: serialize(updated) });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const s = registry.getStrategy(req.params.id);
    if (!s) throw notFound('策略不存在');
    const fileCount = registry.fileCountForStrategy(s.id);
    if (fileCount > 0) throw conflict('策略下仍有文件，不能删除', { fileCount });
    registry.deleteStrategy(s.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
