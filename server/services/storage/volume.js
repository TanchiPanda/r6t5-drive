import fs from 'node:fs';
import path from 'node:path';
import { ENV } from '../../config.js';
import { physicalPath, ownerOf } from '../../lib/paths.js';
import { forbidden, storageError, notFound } from '../../lib/errors.js';

function rootFor(strategy) {
  const cfg = strategy?.config ? safeParse(strategy.config) : {};
  const root = cfg.rootPath || ENV.STORAGE_ROOT;
  return path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function safePhysical(strategy, logicalPath) {
  const segs = String(logicalPath).split('/');
  // 扁平 Blob 布局：uploads/<索引号>/<文件名>，首段不是邮箱而是保留目录名
  const owner = segs[0] === 'uploads' ? 'uploads' : ownerOf(logicalPath);
  const root = path.resolve(rootFor(strategy));
  const base = path.resolve(root, owner);
  const rest = segs.slice(1);
  const phys = path.resolve(base, ...rest);
  if (phys !== base && !phys.startsWith(base + path.sep)) throw forbidden('物理路径越界');
  return phys;
}

export function ensureDirFor(strategy, logicalDir) {
  const phys = safePhysical(strategy, logicalDir);
  fs.mkdirSync(phys, { recursive: true });
  return phys;
}

export function saveUploaded(strategy, logicalPath, tmpFile) {
  const phys = safePhysical(strategy, logicalPath);
  fs.mkdirSync(path.dirname(phys), { recursive: true });
  try {
    fs.renameSync(tmpFile, phys);
  } catch (e) {
    // 跨设备时 rename 失败，退回复制后删除临时文件
    if (e.code === 'EXDEV') {
      fs.copyFileSync(tmpFile, phys);
      fs.rmSync(tmpFile, { force: true });
    } else {
      throw storageError('写入磁盘失败', { detail: e.code });
    }
  }
  return phys;
}

export function openReadStream(strategy, logicalPath) {
  const phys = safePhysical(strategy, logicalPath);
  if (!fs.existsSync(phys)) throw notFound('文件不存在');
  return fs.createReadStream(phys);
}

export function removePhysical(strategy, logicalPath) {
  const phys = safePhysical(strategy, logicalPath);
  fs.rmSync(phys, { force: true, recursive: true });
}

export function renamePhysical(strategy, oldPath, newPath) {
  const oldPhys = safePhysical(strategy, oldPath);
  const newPhys = safePhysical(strategy, newPath);
  fs.mkdirSync(path.dirname(newPhys), { recursive: true });
  fs.renameSync(oldPhys, newPhys);
}

export function statSize(strategy, logicalPath) {
  const phys = safePhysical(strategy, logicalPath);
  try { return fs.statSync(phys).size; } catch { return 0; }
}
