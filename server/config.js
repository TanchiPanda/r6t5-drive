import path from 'node:path';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function resolveDataDir(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

export const ENV = {
  ROOT,
  PORT: Number(process.env.PORT || 5212),
  DB_PATH: resolveDataDir(process.env.DB_PATH || 'data/r6t5.db'),
  STORAGE_ROOT: resolveDataDir(process.env.STORAGE_ROOT || 'data/volume'),
  PUBLIC_DIR: path.join(ROOT, 'public'),
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  DEV_AUTH: process.env.DEV_AUTH === '1',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  TRASH_RETENTION_DAYS: Number(process.env.TRASH_RETENTION_DAYS || 30),
};

fs.mkdirSync(path.dirname(ENV.DB_PATH), { recursive: true });
fs.mkdirSync(ENV.STORAGE_ROOT, { recursive: true });
fs.mkdirSync(ENV.PUBLIC_DIR, { recursive: true });

export const DEFAULTS = {
  siteName: 'R6T5 Drive',
  publicUrl: '',
  spaceLimitBytes: 10n * 1024n * 1024n * 1024n,
  maxFileSizeBytes: 2n * 1024n * 1024n * 1024n,
  traffic7dLimitBytes: 5n * 1024n * 1024n * 1024n,
};
