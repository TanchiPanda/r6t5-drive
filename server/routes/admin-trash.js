import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { isoPlusDays } from '../lib/format.js';

const router = Router();

function expiresAt(deletedAt) {
  if (!deletedAt) return null;
  const days = Number(getSetting('trashRetentionDays', '30'));
  return new Date(new Date(deletedAt).getTime() + days * 86400000).toISOString();
}

router.get('/', (req, res) => {
  const retentionDays = Number(getSetting('trashRetentionDays', '30'));
  const rows = db.prepare(
    `SELECT id, path, email, name, sizeBytes, deletedAt, isDir FROM nodes
     WHERE deletedAt IS NOT NULL ORDER BY deletedAt DESC LIMIT 500`
  ).all();
  const items = rows.map((r) => ({
    id: r.id,
    path: r.path,
    email: r.email,
    name: r.name,
    sizeBytes: Number(r.sizeBytes),
    deletedAt: r.deletedAt,
    expiresAt: expiresAt(r.deletedAt),
    type: r.isDir ? 'dir' : 'file',
  }));
  res.json({ items, retentionDays });
});

export default router;
