import { Router } from 'express';
import { db } from '../db.js';
import { writeAudit } from '../services/audit.js';
import { badRequest } from '../lib/errors.js';
import { nowIso } from '../lib/format.js';
import {
  getUserSource, setUserSource, getSwitchedAt, setSwitchedAt,
  SOURCES, DEFAULT_SOURCE, SOURCE_SETTING_KEY,
} from '../services/user-source.js';

const router = Router();

function counts() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const localAccounts = db.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE passwordHash IS NOT NULL AND passwordHash <> ''"
  ).get().n;
  return { total, localAccounts };
}

router.get('/', (req, res) => {
  const userSource = getUserSource();
  res.json({
    userSource,
    default: DEFAULT_SOURCE,
    storage: { table: 'settings', key: SOURCE_SETTING_KEY },
    counts: counts(),
    switchedAt: getSwitchedAt(),
  });
});

router.put('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const source = body.source;
    if (!SOURCES.includes(source)) {
      throw badRequest('invalid_input', `source 只能是 ${SOURCES.join(' / ')}`, { field: 'source' });
    }
    if (body.confirm !== true) {
      throw badRequest('invalid_input', '切换账号来源需要 confirm: true 二次确认', { field: 'confirm' });
    }
    const switchedFrom = getUserSource();
    const switchedTo = source;
    if (switchedFrom !== switchedTo) {
      const changedAt = nowIso();
      const tx = db.transaction(() => {
        setUserSource(switchedTo);
        setSwitchedAt(changedAt);
      });
      tx();
      writeAudit({
        email: 'admin',
        action: 'user_source_switch',
        detail: `${switchedFrom}->${switchedTo}`,
        ip: req.ip || req.socket?.remoteAddress || '',
      });
      res.json({ ok: true, switchedFrom, switchedTo, changedAt });
    } else {
      // 幂等：未发生切换也返回当前状态
      res.json({ ok: true, switchedFrom, switchedTo, changedAt: getSwitchedAt() });
    }
  } catch (e) { next(e); }
});

export default router;
