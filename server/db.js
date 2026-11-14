import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ENV } from './config.js';

const db = new Database(ENV.DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  const sql = fs.readFileSync(path.join(ENV.ROOT, 'server', 'schema.sql'), 'utf8');
  // P3：P1 的 shares 占位表结构不同且从未写入过数据，检测到旧结构就先重建
  const hasShares = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shares'").get();
  if (hasShares) {
    const cols = db.prepare('PRAGMA table_info(shares)').all().map((c) => c.name);
    if (!cols.includes('email')) db.exec('DROP TABLE shares');
  }
  db.exec(sql);
  // 老库补列（幂等）：P2 起用户组可指定默认存储策略
  const groupCols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
  if (!groupCols.includes('defaultStrategyId')) {
    db.exec('ALTER TABLE groups ADD COLUMN defaultStrategyId TEXT');
  }
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? null : String(value));
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export { db };
