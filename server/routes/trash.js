import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { normalizeLogicalPath, parentOf } from '../lib/paths.js';
import { notFound, conflict, badRequest } from '../lib/errors.js';
import {
  getNodeByPath, descendantsOf, restoreRecursive, deleteNodeRow,
} from '../services/nodes.js';
import * as registry from '../services/storage/registry.js';
import * as volume from '../services/storage/volume.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

function retentionDays() {
  return Number(getSetting('trashRetentionDays', '30'));
}

function expiresAt(deletedAt) {
  if (!deletedAt) return null;
  return new Date(new Date(deletedAt).getTime() + retentionDays() * 86400000).toISOString();
}

router.get('/', (req, res, next) => {
  try {
    const email = req.user.email;
    const rows = db.prepare(
      `SELECT * FROM nodes WHERE email = ? AND deletedAt IS NOT NULL ORDER BY deletedAt DESC LIMIT 500`
    ).all(email);
    const items = rows.map((r) => ({
      path: r.path,
      name: r.name,
      sizeBytes: Number(r.sizeBytes),
      deletedAt: r.deletedAt,
      expiresAt: expiresAt(r.deletedAt),
      type: r.isDir ? 'dir' : 'file',
    }));
    res.json({ items, retentionDays: retentionDays() });
  } catch (e) { next(e); }
});

router.post('/restore', (req, res, next) => {
  try {
    const email = req.user.email;
    const logical = normalizeLogicalPath(String(req.body?.path || ''), email);
    const node = db.prepare('SELECT * FROM nodes WHERE path = ? AND deletedAt IS NOT NULL').get(logical);
    if (!node) throw notFound('回收站中不存在该节点');
    if (getNodeByPath(logical)) throw conflict('同名节点已存在，无法恢复', { path: logical });
    restoreRecursive(logical);
    writeAudit({ email, action: 'restore', target: logical, ip: req.ip || '' });
    res.json({ path: logical });
  } catch (e) { next(e); }
});

router.delete('/', (req, res, next) => {
  try {
    const email = req.user.email;
    const body = req.body || {};
    const logical = normalizeLogicalPath(String(body.path || req.query.path || ''), email);
    const node = db.prepare('SELECT * FROM nodes WHERE path = ? AND deletedAt IS NOT NULL').get(logical);
    if (!node) throw notFound('回收站中不存在该节点');
    const descendants = descendantsOf(logical);
    const strategy = registry.getStrategy(node.storageId) || registry.defaultStrategy();
    const tx = db.transaction(() => {
      for (const n of descendants) {
        if (strategy) {
          try { volume.removePhysical(strategy, n.path); } catch {}
        }
        deleteNodeRow(n.id);
      }
    });
    tx();
    writeAudit({ email, action: 'delete', target: logical, detail: 'permanent', ip: req.ip || '' });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
