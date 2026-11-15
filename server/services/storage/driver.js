// 存储驱动分发（唯一入口）。协议见 docs/storage-drivers.md
import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../../config.js';
import * as volumeImpl from './volume.js';
import { s3Driver } from './s3.js';
import { githubDriver } from './github.js';
import { ossDriver } from './oss.js';
import { cosDriver } from './cos.js';
import { ks3Driver } from './ks3.js';
import { obsDriver } from './obs.js';
import { qiniuDriver } from './qiniu.js';
import { upyunDriver } from './upyun.js';

const volumeDriver = {
  type: 'volume',
  caps: { read: true, write: true, list: true },
  ensureDir(strategy, logicalDir) {
    volumeImpl.ensureDirFor(strategy, logicalDir);
  },
  writeFromTemp(strategy, logicalPath, tmpFile) {
    volumeImpl.saveUploaded(strategy, logicalPath, tmpFile);
  },
  readStream(strategy, logicalPath) {
    return volumeImpl.openReadStream(strategy, logicalPath);
  },
  remove(strategy, logicalPath) {
    volumeImpl.removePhysical(strategy, logicalPath);
  },
  rename(strategy, fromLogical, toLogical) {
    volumeImpl.renamePhysical(strategy, fromLogical, toLogical);
  },
  // 本地卷的目录内容以 SQLite 元数据为准，驱动层不做额外列举
  list() { return []; },
  test(strategy) {
    let cfg = {};
    try { cfg = strategicParse(strategy.config); } catch { cfg = {}; }
    const root = path.isAbsolute(cfg.rootPath || '') ? cfg.rootPath : path.resolve(process.cwd(), cfg.rootPath || ENV.STORAGE_ROOT);
    try {
      fs.mkdirSync(root, { recursive: true });
      const probe = path.join(root, `.probe-${Date.now()}`);
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { ok: true, message: `可读写：${root}`, details: { root } };
    } catch (e) {
      return { ok: false, message: `不可写：${e.code || e.message}`, details: { root } };
    }
  },
};

function strategicParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

const DRIVERS = {
  volume: volumeDriver,
  s3: s3Driver,
  github: githubDriver,
  oss: ossDriver,
  cos: cosDriver,
  ks3: ks3Driver,
  obs: obsDriver,
  qiniu: qiniuDriver,
  upyun: upyunDriver,
};

export function getDriver(type) {
  const d = DRIVERS[type];
  if (!d) throw Object.assign(new Error(`未知存储类型：${type}`), { code: 'storage_unsupported', status: 400 });
  return d;
}

export function driverCaps(type) {
  const d = DRIVERS[type];
  return d ? { ...d.caps } : { read: false, write: false, list: false };
}

export function isWritable(type) {
  return !!driverCaps(type).write;
}
