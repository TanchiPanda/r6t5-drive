import path from 'node:path';
import { ENV } from '../config.js';
import { forbidden, badRequest } from './errors.js';

const EMAIL_RE = /^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/;

/**
 * 规范化逻辑路径，首段必须是本人 email。
 * 拒绝 ..、.、空段、反斜杠、绝对路径、控制字符。
 */
export function normalizeLogicalPath(raw, email) {
  if (raw == null || typeof raw !== 'string' || raw.trim() === '') {
    throw badRequest('invalid_input', '路径不能为空', { field: 'path' });
  }
  let p = raw.trim();
  if (p.startsWith('/')) throw forbidden('路径不能是绝对路径');
  if (/[\\\u0000-\u001f]/.test(p)) throw forbidden('路径包含非法字符');

  const segs = p.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..') throw forbidden('路径包含非法段');
    if (/[\u0000-\u001f]/.test(seg)) throw forbidden('路径包含控制字符');
  }

  const owner = String(email).toLowerCase();
  const first = segs[0].toLowerCase();
  if (first !== owner) throw forbidden('只能访问本人目录');

  segs[0] = owner;
  return segs.join('/');
}

/** 仅取首段 email 并校验格式 */
export function ownerOf(logicalPath) {
  const first = logicalPath.split('/')[0].toLowerCase();
  if (!EMAIL_RE.test(first)) throw forbidden('路径首段必须是邮箱');
  return first;
}

/** 逻辑路径 → 物理路径，并再次校验仍在 STORAGE_ROOT/<email>/ 之内 */
export function physicalPath(logicalPath) {
  const email = ownerOf(logicalPath);
  const rest = logicalPath.split('/').slice(1);
  const base = path.resolve(ENV.STORAGE_ROOT, email);
  const phys = path.resolve(base, ...rest);
  if (phys !== base && !phys.startsWith(base + path.sep)) {
    throw forbidden('物理路径越界');
  }
  return phys;
}

export function parentOf(logicalPath) {
  const segs = logicalPath.split('/');
  segs.pop();
  return segs.join('/');
}

export function basenameOf(logicalPath) {
  return logicalPath.split('/').pop();
}

export function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw badRequest('invalid_input', '名称不能为空', { field: 'name' });
  }
  if (name.length > 200) throw badRequest('invalid_input', '名称过长（≤200 字）', { field: 'name' });
  if (name.includes('/') || name.includes('\\')) throw badRequest('invalid_input', '名称不能包含路径分隔符', { field: 'name' });
  if (name === '.' || name === '..') throw badRequest('invalid_input', '名称非法', { field: 'name' });
  if (/[\u0000-\u001f]/.test(name)) throw badRequest('invalid_input', '名称包含控制字符', { field: 'name' });
  return name;
}

export function joinLogical(parentDir, name) {
  return parentDir ? `${parentDir}/${name}` : name;
}
