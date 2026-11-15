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
  // P4：老库 nodes.path 是内联 UNIQUE（软删 tombstone 会占住路径，同名重建直接 500）
  // 检测到该自动索引就重建表，改成「仅未删除行唯一」的部分唯一索引
  const idxList = db.prepare('PRAGMA index_list(nodes)').all();
  // 逐个检查自动索引：TEXT 主键也会生成 sqlite_autoindex_nodes_1，只有作用在 path 上的才是老 UNIQUE
  let inlineUniquePath = false;
  for (const i of idxList) {
    if (i.unique !== 1 || !String(i.name).startsWith('sqlite_autoindex_nodes')) continue;
    const cols = db.prepare(`PRAGMA index_info(${JSON.stringify(i.name).replace(/"/g, "'")})`).all().map((c) => c.name);
    if (cols.length === 1 && cols[0] === 'path') inlineUniquePath = true;
  }
  if (inlineUniquePath) {
    {
      db.exec(`
        CREATE TABLE nodes_rebuild (
          id         TEXT PRIMARY KEY,
          email      TEXT NOT NULL,
          parentId   TEXT,
          name       TEXT NOT NULL,
          path       TEXT NOT NULL,
          isDir      INTEGER NOT NULL DEFAULT 0,
          sizeBytes  INTEGER NOT NULL DEFAULT 0,
          mime       TEXT,
          storageId  TEXT,
          deletedAt  TEXT,
          createdAt  TEXT NOT NULL,
          updatedAt  TEXT NOT NULL
        );
        INSERT INTO nodes_rebuild SELECT id, email, parentId, name, path, isDir, sizeBytes, mime, storageId, deletedAt, createdAt, updatedAt FROM nodes;
        DROP TABLE nodes;
        ALTER TABLE nodes_rebuild RENAME TO nodes;
      `);
    }
  }
  db.exec(sql);
  // 老库补列（幂等）：P2 起用户组可指定默认存储策略
  const groupCols = db.prepare('PRAGMA table_info(groups)').all().map((c) => c.name);
  if (!groupCols.includes('defaultStrategyId')) {
    db.exec('ALTER TABLE groups ADD COLUMN defaultStrategyId TEXT');
  }

  // P6：本地账号体系。users 表加列（老库自动迁移，数据不丢）：
  //  - passwordHash TEXT：scrypt 派生值，有值即本地账号；空 = Supabase 账号
  //  - status TEXT NOT NULL DEFAULT 'active'：active | banned，与 disabled 同步
  //  - registeredAt TEXT：注册/创建时间，老行用 createdAt 回填
  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('passwordHash')) {
    db.exec('ALTER TABLE users ADD COLUMN passwordHash TEXT');
  }
  if (!userCols.includes('status')) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    // 老库：按现有 disabled 回填 status（disabled=1 ⇔ banned）
    db.prepare("UPDATE users SET status = CASE WHEN disabled = 1 THEN 'banned' ELSE 'active' END").run();
  } else {
    // 已存在 status 的库：保证两列一致（以 status 为准同步 disabled）
    db.prepare('UPDATE users SET disabled = CASE WHEN status = ? THEN 1 ELSE 0 END').run('banned');
  }
  if (!userCols.includes('registeredAt')) {
    db.exec('ALTER TABLE users ADD COLUMN registeredAt TEXT');
    db.prepare('UPDATE users SET registeredAt = createdAt WHERE registeredAt IS NULL').run();
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
