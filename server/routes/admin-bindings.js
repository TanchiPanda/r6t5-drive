import { Router } from 'express';
import { db } from '../db.js';
import {
  listBindings, createBinding, updateBinding, deleteBinding, resolveStorage,
} from '../services/bindings.js';
import { notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

function serializeRow(b) {
  return {
    id: b.id,
    strategyId: b.strategyId,
    strategyName: b.strategyName || null,
    strategyType: b.strategyType || null,
    strategyReadOnly: !!b.strategyReadOnly,
    scope: b.scope,
    email: b.email || null,
    subPath: b.subPath || '',
    createdAt: b.createdAt,
  };
}

function findJoined(id) {
  const row = listBindings().find((b) => b.id === id);
  return row ? serializeRow(row) : null;
}

router.get('/', (req, res) => {
  res.json({ items: listBindings().map(serializeRow) });
});

router.post('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const row = createBinding({
      strategyId: body.strategyId,
      scope: body.scope,
      email: body.email,
      subPath: body.subPath,
    });
    const item = findJoined(row.id);
    writeAudit({ email: 'admin', action: 'storage_create', target: `binding:${item.subPath || '/'}${item.email ? ` (${item.email})` : ''}` });
    res.status(201).json({ item });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    updateBinding(req.params.id, {
      strategyId: body.strategyId,
      scope: body.scope,
      email: body.email,
      subPath: body.subPath,
    });
    const item = findJoined(req.params.id);
    if (!item) throw notFound('绑定不存在');
    writeAudit({ email: 'admin', action: 'settings_update', target: `binding:${item.id}` });
    res.json({ item });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    deleteBinding(req.params.id);
    writeAudit({ email: 'admin', action: 'settings_update', target: `binding:${req.params.id}` });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/resolve', (req, res, next) => {
  try {
    const path = String(req.query.path || '').trim();
    if (!path) throw notFound('路径不能为空');
    const segments = path.split('/').filter(Boolean);
    const email = (segments[0] || '').toLowerCase();
    if (!email) throw notFound('路径缺少邮箱首段');

    const userRow = db.prepare('SELECT groupId FROM users WHERE email = ?').get(email);
    const user = { groupId: userRow ? userRow.groupId : null };

    const resolved = resolveStorage({ email, logicalPath: path, user });
    if (!resolved) throw notFound('未解析到可用的存储策略');

    const { strategy, matchedBy, bindingId, depth } = resolved;
    let subPath;
    if (bindingId) {
      const b = db.prepare('SELECT subPath FROM storage_bindings WHERE id = ?').get(bindingId);
      subPath = b ? b.subPath || '' : undefined;
    }
    res.json({
      strategy: {
        id: strategy.id,
        name: strategy.name,
        type: strategy.type,
        readOnly: !!strategy.readOnly,
        region: strategy.region,
      },
      matchedBy,
      bindingId: bindingId || undefined,
      depth: depth == null ? undefined : depth,
      subPath,
    });
  } catch (e) { next(e); }
});

export default router;
