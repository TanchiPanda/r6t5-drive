import { Router } from 'express';
import { db } from '../db.js';
import { quotaForUser } from '../services/quota.js';

const router = Router();

function classify(mime) {
  if (!mime) return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (/^(application\/(pdf|msword|vnd\.|octet-stream|json|xml|zip)|text\/|text)/.test(mime) ||
      mime.includes('document') || mime.includes('sheet') || mime.includes('presentation')) {
    return 'document';
  }
  return 'other';
}

router.get('/', (req, res) => {
  const email = req.user.email;
  const rows = db.prepare(
    `SELECT * FROM nodes WHERE email = ? AND deletedAt IS NULL AND isDir = 0 ORDER BY updatedAt DESC LIMIT 200`
  ).all(email);

  const byType = { image: 0, document: 0, other: 0 };
  for (const r of rows) byType[classify(r.mime)] += Number(r.sizeBytes);

  const recentUploads = rows.slice(0, 10).map((r) => ({
    path: r.path, sizeBytes: Number(r.sizeBytes), at: r.updatedAt,
  }));

  res.json({
    user: req.publicUser,
    quota: quotaForUser(req.user),
    byType,
    recentUploads,
    shareCount: 0,
  });
});

export default router;
