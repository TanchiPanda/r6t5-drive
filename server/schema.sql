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
  allow_self_signup   INTEGER NOT NULL DEFAULT 0,
  is_sudo             INTEGER NOT NULL DEFAULT 0,
  createdAt           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  displayName     TEXT NOT NULL DEFAULT '',
  groupId         TEXT,
  disabled        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  passwordHash    TEXT,
  registeredAt    TEXT,
  lastLoginAt     TEXT,
  createdAt       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
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

-- 同一逻辑路径只有在「未删除」状态下才要求唯一：软删留下的 tombstone 不再占用路径
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_path_active ON nodes(path) WHERE deletedAt IS NULL;
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

-- 分片上传会话（P4）
-- received 存已完成分片序号的 JSON 数组，用于断点续传
CREATE TABLE IF NOT EXISTS upload_sessions (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  parentPath  TEXT NOT NULL,
  name        TEXT NOT NULL,
  sizeBytes   INTEGER NOT NULL,
  chunkSize   INTEGER NOT NULL,
  totalChunks INTEGER NOT NULL,
  received    TEXT NOT NULL DEFAULT '[]',
  strategyId  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  expiresAt   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_upload_sessions_email ON upload_sessions(email);

-- 应用密码（P5：WebDAV Basic Auth 用；密码只存 PBKDF2 派生值，明文仅在创建时返回一次）
CREATE TABLE IF NOT EXISTS app_passwords (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT NOT NULL,
  hash       TEXT NOT NULL,
  salt       TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt  TEXT
);

CREATE INDEX IF NOT EXISTS idx_app_passwords_email ON app_passwords(email);
