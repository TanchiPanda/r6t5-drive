import { Router } from 'express';
import { db } from '../db.js';
import { trafficInWindow, trafficToday, uploadSeries } from '../services/traffic.js';
import * as registry from '../services/storage/registry.js';

const router = Router();

router.get('/', (req, res) => {
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

  const users = {
    total: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    active7d: db.prepare('SELECT COUNT(*) AS n FROM users WHERE lastLoginAt >= ?').get(sevenDaysAgo).n,
    disabled: db.prepare('SELECT COUNT(*) AS n FROM users WHERE disabled = 1').get().n,
    pendingUploads: 0,
  };

  const traffic = {
    up7dBytes: trafficInWindow('upload'),
    down7dBytes: trafficInWindow('download'),
    upTodayBytes: trafficToday('upload'),
  };

  const strategies = registry.listStrategies();
  const storage = {
    usedBytes: strategies.reduce((s, x) => s + registry.usedBytesForStrategy(x.id), 0),
    capacityBytes: strategies.reduce((s, x) => s + Number(x.capacityBytes), 0),
    fileCount: db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE deletedAt IS NULL AND isDir = 0").get().n,
    trashCount: db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE deletedAt IS NOT NULL').get().n,
    byStrategy: strategies.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      usedBytes: registry.usedBytesForStrategy(s.id),
      capacityBytes: Number(s.capacityBytes),
    })),
  };

  const groupRows = db.prepare('SELECT * FROM groups ORDER BY createdAt ASC').all();
  const groups = groupRows.map((g) => ({
    id: g.id,
    name: g.name,
    userCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE groupId = ?').get(g.id).n,
    spaceLimitBytes: Number(g.spaceLimitBytes),
  }));

  const recentRows = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 10').all();
  const recent = recentRows.map((r) => ({
    id: r.id, at: r.at, email: r.email, action: r.action, target: r.target, bytes: r.bytes,
  }));

  res.json({
    users,
    traffic,
    storage,
    groups,
    recent,
    series: uploadSeries(14),
  });
});

export default router;
