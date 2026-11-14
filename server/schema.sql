CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS groups (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL UNIQUE,
  spaceLimitBytes     INTEGER NOT NULL,
  maxFileSizeBytes    INTEGER NOT NULL,
  traffic7dLimitBytes INTEGER NOT NULL,
  isDefault           INTEGER NOT NULL DEFAULT 0,
  defaultStrategyId   TEXT,
  createdAt           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT NOT NULL UNIQUE,
  displayName  TEXT NOT NULL DEFAULT '',
  groupId      TEXT,
  disabled     INTEGER NOT NULL DEFAULT 0,
  lastLoginAt  TEXT,
  createdAt    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  parentId   TEXT,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  isDir      INTEGER NOT NULL DEFAULT 0,
  sizeBytes  INTEGER NOT NULL DEFAULT 0,
  mime       TEXT,
  storageId  TEXT,
  deletedAt  TEXT,
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_email ON nodes(email);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parentId);
CREATE INDEX IF NOT EXISTS idx_nodes_deleted ON nodes(email, deletedAt);

CREATE TABLE IF NOT EXISTS traffic (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  kind  TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_traffic_email_kind ON traffic(email, kind, at);

-- 分享表见文件末尾「分享（P3）」段（P1 的占位结构已在 db.migrate() 中重建）

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  email   TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  bytes   INTEGER,
  ip      TEXT,
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit(at);
CREATE INDEX IF NOT EXISTS idx_audit_email ON audit(email);

CREATE TABLE IF NOT EXISTS storage_strategies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  region        TEXT,
  capacityBytes INTEGER NOT NULL,
  usedBytes     INTEGER NOT NULL DEFAULT 0,
  readOnly      INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  config        TEXT,
  createdAt     TEXT NOT NULL
);

-- 目录 → 存储策略绑定（P2）
-- scope='site' 对该站点所有用户生效（subPath 相对用户根）；scope='user' 只对该 email 生效
-- subPath='' 表示用户根目录
CREATE TABLE IF NOT EXISTS storage_bindings (
  id         TEXT PRIMARY KEY,
  strategyId TEXT NOT NULL,
  scope      TEXT NOT NULL,
  email      TEXT,
  subPath    TEXT NOT NULL DEFAULT '',
  createdAt  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bindings_unique ON storage_bindings(scope, COALESCE(email, ''), subPath);
CREATE INDEX IF NOT EXISTS idx_bindings_strategy ON storage_bindings(strategyId);

-- 分享（P3）
-- 分享对象是用户的逻辑路径（文件或目录）；目录分享按只读浏览
-- codeHash/codeSalt 存提取码的 PBKDF2 派生值，明文不落库
CREATE TABLE IF NOT EXISTS shares (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL,
  path          TEXT NOT NULL,
  name          TEXT NOT NULL,
  isDir         INTEGER NOT NULL DEFAULT 0,
  codeHash      TEXT,
  codeSalt      TEXT,
  expiresAt     TEXT,
  maxDownloads  INTEGER,
  downloadCount INTEGER NOT NULL DEFAULT 0,
  allowPreview  INTEGER NOT NULL DEFAULT 1,
  revokedAt     TEXT,
  createdAt     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_email ON shares(email);
CREATE INDEX IF NOT EXISTS idx_shares_token ON shares(token);

-- 分享访问记录（P3，用于次数与审计）
CREATE TABLE IF NOT EXISTS share_hits (
  id      TEXT PRIMARY KEY,
  shareId TEXT NOT NULL,
  email   TEXT,
  ip      TEXT,
  action  TEXT NOT NULL,
  at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_share_hits_share ON share_hits(shareId);
