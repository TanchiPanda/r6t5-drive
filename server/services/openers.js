// 打开方式关联表：阅读器 ↔ 扩展名绑定。
// 管理员在后台维护条目（内置条目不可删、kind 不可改）；用户打开文件时按扩展名匹配，
// 在「打开方式」弹窗里自选，「始终」按扩展名记在浏览器本地。
//
// kind 渲染类型：
//   内置组件：image | video | audio | text | markdown | epub | pdfjs | native-pdf | zip
//   外部在线：gdocs | m365 | onlyoffice | external（urlTemplate 含 {src} 占位）
import crypto from 'node:crypto';
import { db } from '../db.js';
import { nowIso } from '../lib/format.js';
import { getOnlyOfficeConfig } from './integrations.js';

export const OPENER_KINDS = {
  image: { label: '图片查看器', internal: true, fixed: true },
  video: { label: '视频播放器', internal: true, fixed: true },
  audio: { label: '音频播放器', internal: true, fixed: true },
  text: { label: '文本 / 代码查看器', internal: true, fixed: true },
  markdown: { label: 'Markdown 阅读器', internal: true, fixed: true },
  epub: { label: 'ePub 阅读器', internal: true, fixed: true },
  pdfjs: { label: 'PDF 阅读器（内置 PDF.js）', internal: true, fixed: true },
  'native-pdf': { label: '浏览器内置 PDF', internal: true, fixed: true },
  zip: { label: '压缩包清单', internal: true, fixed: true },
  gdocs: { label: 'Google Docs 在线阅读器', internal: false, fixed: true },
  m365: { label: 'Microsoft Office 在线阅读器', internal: false, fixed: true },
  onlyoffice: { label: 'OnlyOffice 在线预览', internal: false, fixed: true },
  external: { label: '自定义外部阅读器', internal: false, fixed: false, needsTemplate: true },
};

export const PLATFORMS = ['all', 'pc', 'mobile'];

/* 内置种子条目：仅在 openers 表为空时写入；之后管理员可改名称 / 扩展名 / 启用，不可删、不可改 kind */
const SEED_ROWS = [
  { id: 'op-image', kind: 'image', name: '图片查看器', sort: 10,
    extList: 'jpg,jpeg,png,gif,bmp,webp,avif,tiff,svg' },
  { id: 'op-video', kind: 'video', name: '视频播放器', sort: 20,
    extList: 'mp4,webm,mov,mkv,avi,m4v,3gp,flv,wmv' },
  { id: 'op-audio', kind: 'audio', name: '音频播放器', sort: 30,
    extList: 'mp3,ogg,wav,flac,m4a,aac,opus' },
  { id: 'op-text', kind: 'text', name: '文本 / 代码查看器', sort: 40,
    extList: 'txt,log,json,yml,yaml,js,ts,jsx,tsx,py,go,java,c,cpp,h,sh,css,html,csv,xml,ini,conf,sql,rb,php,rs,toml' },
  { id: 'op-markdown', kind: 'markdown', name: 'Markdown 阅读器', sort: 50,
    extList: 'md,markdown' },
  { id: 'op-epub', kind: 'epub', name: 'ePub 阅读器', sort: 60,
    extList: 'epub' },
  { id: 'op-pdfjs', kind: 'pdfjs', name: 'PDF 阅读器（内置 PDF.js）', sort: 70,
    extList: 'pdf' },
  { id: 'op-native-pdf', kind: 'native-pdf', name: '浏览器内置 PDF', sort: 80,
    extList: 'pdf' },
  { id: 'op-zip', kind: 'zip', name: '压缩包清单', sort: 90,
    extList: 'zip' },
  { id: 'op-gdocs', kind: 'gdocs', name: 'Google Docs 在线阅读器', sort: 100,
    extList: 'doc,docx,xls,xlsx,ppt,pptx,pdf,rtf' },
  { id: 'op-m365', kind: 'm365', name: 'Microsoft Office 在线阅读器', sort: 110,
    extList: 'doc,docx,docm,dotm,dotx,xls,xlsb,xlsm,xlsx,ppt,pptx,ppsm,ptm,potm,potx,pps,odt,ods,odp,rtf' },
  { id: 'op-onlyoffice', kind: 'onlyoffice', name: 'OnlyOffice 在线预览', sort: 120,
    extList: 'doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,rtf', enabled: 0 },
];

export function normalizeExtList(input) {
  return String(input || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(',');
}

function rowToShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: (OPENER_KINDS[row.kind] && OPENER_KINDS[row.kind].label) || row.kind,
    extList: row.extList || '',
    exts: (row.extList || '').split(',').filter(Boolean),
    platform: row.platform || 'all',
    urlTemplate: row.urlTemplate || null,
    builtin: !!row.builtin,
    enabled: !!row.enabled,
    sort: row.sort || 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt || null,
  };
}

/** 首次启动播种内置条目（表为空才写，已存在的管理员改动不覆盖） */
export function seedOpeners() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM openers').get().n;
  if (count > 0) return;
  const stmt = db.prepare(`
    INSERT INTO openers (id, name, kind, extList, platform, urlTemplate, builtin, enabled, sort, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const now = nowIso();
  for (const row of SEED_ROWS) {
    stmt.run(row.id, row.name, row.kind, row.extList, 'all', null, row.enabled == null ? 1 : row.enabled, row.sort, now);
  }
}

export function listOpeners({ includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM openers ORDER BY sort ASC, rowid ASC'
    : 'SELECT * FROM openers WHERE enabled = 1 ORDER BY sort ASC, rowid ASC';
  return db.prepare(sql).all().map(rowToShape);
}

export function getOpener(id) {
  return rowToShape(db.prepare('SELECT * FROM openers WHERE id = ?').get(id));
}

/** 按扩展名匹配启用条目（平台本期仅 all；onlyoffice 未配置时不参与匹配） */
export function matchOpeners(ext) {
  const e = String(ext || '').toLowerCase();
  if (!e) return [];
  const oo = getOnlyOfficeConfig();
  return listOpeners().filter((row) => {
    if (row.kind === 'onlyoffice' && !(oo.configured && oo.jwtConfigured)) return false;
    return row.exts.includes(e);
  });
}

export function validateOpenerInput(body, { existing } = {}) {
  const errors = {};
  const kind = existing ? existing.kind : String(body.kind || '').trim();
  if (!existing) {
    if (!OPENER_KINDS[kind]) errors.kind = '打开方式类型非法';
  }
  const name = String(body.name || '').trim();
  if (!name || name.length > 40) errors.name = '名称需为 1–40 字';
  const extList = normalizeExtList(body.extList);
  if (!extList) errors.extList = '至少填写一个扩展名';
  const platform = String(body.platform || 'all').trim();
  if (!PLATFORMS.includes(platform)) errors.platform = '平台仅支持 all / pc / mobile';
  let urlTemplate = existing ? existing.urlTemplate : null;
  if (kind === 'external') {
    urlTemplate = String(body.urlTemplate || '').trim();
    if (!urlTemplate || !urlTemplate.includes('{src}')) errors.urlTemplate = '自定义外部阅读器需填写含 {src} 占位的 URL 模板';
  }
  if (Object.keys(errors).length) return { errors };
  return { value: { name, kind, extList, platform, urlTemplate } };
}

export function createOpener(body) {
  const { errors, value } = validateOpenerInput(body);
  if (errors) return { errors };
  const id = 'op-' + crypto.randomBytes(6).toString('base64url');
  const now = nowIso();
  db.prepare(`
    INSERT INTO openers (id, name, kind, extList, platform, urlTemplate, builtin, enabled, sort, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)
  `).run(id, value.name, value.kind, value.extList, value.platform, value.urlTemplate, 999, now);
  return { item: getOpener(id) };
}

export function updateOpener(id, body) {
  const existing = getOpener(id);
  if (!existing) return { notFound: true };
  const { errors, value } = validateOpenerInput(body, { existing });
  if (errors) return { errors };
  const sets = ['name = ?', 'extList = ?', 'platform = ?', 'urlTemplate = ?', 'updatedAt = ?'];
  const args = [value.name, value.extList, value.platform, value.urlTemplate, nowIso()];
  if (body.enabled != null) {
    sets.push('enabled = ?');
    args.push(body.enabled ? 1 : 0);
  }
  if (body.sort != null && Number.isFinite(Number(body.sort))) {
    sets.push('sort = ?');
    args.push(Number(body.sort));
  }
  args.push(id);
  db.prepare(`UPDATE openers SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return { item: getOpener(id) };
}

export function deleteOpener(id) {
  const existing = getOpener(id);
  if (!existing) return { notFound: true };
  if (existing.builtin) return { builtin: true };
  db.prepare('DELETE FROM openers WHERE id = ?').run(id);
  return { ok: true };
}

/** 用户端下发：仅启用条目；onlyoffice 附带可用性标记 */
export function publicOpeners() {
  const oo = getOnlyOfficeConfig();
  return listOpeners().map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    kindLabel: row.kindLabel,
    exts: row.exts,
    platform: row.platform,
    urlTemplate: row.urlTemplate,
    available: row.kind !== 'onlyoffice' || (oo.configured && oo.jwtConfigured),
  }));
}
