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

CREATE TABLE IF NOT EXISTS shares (
  id         TEXT PRIMARY KEY,
  nodeId     TEXT,
  token      TEXT NOT NULL UNIQUE,
  password   TEXT,
  expiresAt  TEXT,
  maxDownloads INTEGER,
  downloads  INTEGER NOT NULL DEFAULT 0,
  createdAt  TEXT NOT NULL
);

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
