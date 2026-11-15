/* R6T5 Drive · 品牌与站点外观配置（P8-A）
 *
 * 配置全部落 settings 表（key 前缀 brand.），可空=回落默认静态资源；
 * 上传的品牌文件落到 data/branding/（目录取 DB_PATH 所在目录，DB_PATH 指向
 * /tmp 时品牌文件随之隔离）；对外 URL 统一走本站相对路径 /branding/<slot>-<hash8>.<ext>。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENV } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { sanitizeSidebarHtml } from '../lib/html-sanitize.js';
import { badRequest } from '../lib/errors.js';

/** 配置 key ↔ slot 映射 */
export const BRAND_SLOTS = {
  logoLight: 'brand.logoLightUrl',
  logoDark: 'brand.logoDarkUrl',
  favicon: 'brand.faviconUrl',
  icon192: 'brand.icon192Url',
  iconLarge: 'brand.iconLargeUrl',
};

export const SIDEBAR_KEY = 'brand.sidebarHtml';

/** 上传资源位允许的扩展名 */
export const UPLOAD_EXTS = ['svg', 'png', 'ico'];

/** 上传大小上限：512KB */
export const UPLOAD_MAX_BYTES = 512 * 1024;

/** 外链 URL 长度上限 */
export const URL_MAX_LEN = 512;

/** 各 slot 未配置时回落的静态资源 */
export const DEFAULT_FALLBACKS = {
  logoLight: '/assets/favicon.svg',
  logoDark: '/assets/icons/favicon.svg',
  favicon: '/assets/favicon.svg',
  icon192: '/assets/icons/favicon.svg',
  iconLarge: '/assets/icons/favicon.svg',
};

/** 品牌文件目录：与 DB_PATH 同根，随实例隔离 */
export const BRANDING_DIR = path.join(path.dirname(ENV.DB_PATH), 'branding');
fs.mkdirSync(BRANDING_DIR, { recursive: true });

function validateBrandUrl(value, field) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if (v.length > URL_MAX_LEN) {
    throw badRequest('invalid_input', `${field} 地址过长（≤${URL_MAX_LEN} 字符）`, { field });
  }
  const ok = /^https?:\/\/[^\s]+$/i.test(v) || (/^\/[^\s]/ && v.startsWith('/') && !v.startsWith('//'));
  if (!ok) {
    throw badRequest('invalid_input', `${field} 必须是 http(s):// 或本站相对路径 / 开头`, { field });
  }
  return v;
}

function readValue(key) {
  const v = getSetting(key, null);
  return v == null || v === '' ? null : v;
}

/** 读取后台视角的品牌配置（含默认回落标记与清洗后的侧边栏 HTML） */
export function readBranding() {
  const fields = {};
  const defaults = {};
  for (const [slot, key] of Object.entries(BRAND_SLOTS)) {
    const v = readValue(key);
    fields[slot] = v;
    defaults[slot] = !v;
  }
  const sidebarHtmlRaw = readValue(SIDEBAR_KEY);
  const sidebarHtmlSanitized = sidebarHtmlRaw ? sanitizeSidebarHtml(sidebarHtmlRaw) : null;
  return {
    logoLightUrl: fields.logoLight,
    logoDarkUrl: fields.logoDark,
    faviconUrl: fields.favicon,
    icon192Url: fields.icon192,
    iconLargeUrl: fields.iconLarge,
    sidebarHtml: sidebarHtmlSanitized,
    sidebarHtmlSanitized,
    defaults,
    updatedAt: getSetting('branding_updated_at', null),
  };
}

/** 读取公开视角（免登录）：URL 原样下发，侧边栏 HTML 仅下发清洗后版本 */
export function readPublicBranding() {
  const siteName = getSetting('siteName', 'R6T5 Drive') || 'R6T5 Drive';
  const sidebar = readValue(SIDEBAR_KEY);
  return {
    siteName,
    logoLightUrl: readValue(BRAND_SLOTS.logoLight),
    logoDarkUrl: readValue(BRAND_SLOTS.logoDark),
    faviconUrl: readValue(BRAND_SLOTS.favicon),
    icon192Url: readValue(BRAND_SLOTS.icon192),
    iconLargeUrl: readValue(BRAND_SLOTS.iconLarge),
    sidebarHtml: sidebar ? sanitizeSidebarHtml(sidebar) : null,
  };
}

/**
 * 批量更新品牌配置。
 * @param {object} patch 支持 logoLightUrl/logoDarkUrl/faviconUrl/icon192Url/iconLargeUrl/sidebarHtml
 * @returns {{ item: object, sidebarHtmlRaw: string|null }}
 */
export function updateBranding(patch) {
  const fieldKeyMap = {
    logoLightUrl: BRAND_SLOTS.logoLight,
    logoDarkUrl: BRAND_SLOTS.logoDark,
    faviconUrl: BRAND_SLOTS.favicon,
    icon192Url: BRAND_SLOTS.icon192,
    iconLargeUrl: BRAND_SLOTS.iconLarge,
  };
  for (const [field, key] of Object.entries(fieldKeyMap)) {
    if (patch[field] === undefined) continue;
    const v = patch[field] === null || patch[field] === '' ? null : validateBrandUrl(patch[field], field);
    setSetting(key, v);
  }
  let sidebarHtmlRaw = null;
  if (patch.sidebarHtml !== undefined) {
    sidebarHtmlRaw = patch.sidebarHtml == null ? '' : String(patch.sidebarHtml);
    const cleaned = sanitizeSidebarHtml(sidebarHtmlRaw);
    setSetting(SIDEBAR_KEY, cleaned || null);
  }
  setSetting('branding_updated_at', new Date().toISOString());
  const item = readBranding();
  return { item, sidebarHtmlRaw: sidebarHtmlRaw === '' ? null : sidebarHtmlRaw };
}

/** 清空某个资源位（回落默认） */
export function clearSlot(slot) {
  const key = BRAND_SLOTS[slot];
  if (!key) throw badRequest('invalid_input', `未知资源位：${slot}`, { slot });
  setSetting(key, null);
  setSetting('branding_updated_at', new Date().toISOString());
  return readBranding();
}

/* ---------------- 上传：文件头（magic）校验 ---------------- */

function extFromName(name) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 校验缓冲区与扩展名是否一致；返回规范扩展名，非法抛 400 */
export function detectImageType(buffer, originalName) {
  const ext = extFromName(originalName);
  if (!UPLOAD_EXTS.includes(ext)) {
    throw badRequest('invalid_input', '仅支持 svg / png / ico 格式', { ext });
  }
  const head = buffer.subarray(0, Math.min(8, buffer.length));
  const hex = [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ');

  if (ext === 'png') {
    const magic = [0x89, 0x50, 0x4e, 0x47];
    const ok = magic.every((b, i) => head[i] === b);
    if (!ok) throw badRequest('invalid_input', '文件头与 PNG 不一致（伪造文件）', { head: hex });
    return 'png';
  }
  if (ext === 'ico') {
    const magic = [0x00, 0x00, 0x01, 0x00];
    const ok = magic.every((b, i) => head[i] === b);
    if (!ok) throw badRequest('invalid_input', '文件头与 ICO 不一致（伪造文件）', { head: hex });
    return 'ico';
  }
  // svg：必须能解析出 <svg，且不能是伪装成 svg 的 HTML 文档
  const text = buffer.toString('utf8').slice(0, 4096);
  if (!/<svg\b/i.test(text)) {
    throw badRequest('invalid_input', 'SVG 内容缺少 <svg> 根标签（伪造文件）', {});
  }
  if (/<!doctype\s+html|<html\b/i.test(text)) {
    throw badRequest('invalid_input', 'SVG 内容为 HTML 文档（伪造文件）', {});
  }
  return 'svg';
}

/**
 * 保存上传的品牌文件。
 * @returns {{ url: string, slot: string }}
 */
export function saveUploadedFile(slot, buffer, originalName) {
  if (!BRAND_SLOTS[slot]) throw badRequest('invalid_input', `未知资源位：${slot}`, { slot });
  if (!buffer || !buffer.length) throw badRequest('invalid_input', '空文件', {});
  if (buffer.length > UPLOAD_MAX_BYTES) {
    const e = badRequest('payload_too_large', '品牌资源大小不能超过 512KB', { bytes: buffer.length });
    e.status = 413;
    throw e;
  }
  const ext = detectImageType(buffer, originalName);
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 8);
  const fileName = `${slot}-${hash}.${ext}`;
  fs.writeFileSync(path.join(BRANDING_DIR, fileName), buffer);
  const url = `/branding/${fileName}`;
  setSetting(BRAND_SLOTS[slot], url);
  setSetting('branding_updated_at', new Date().toISOString());
  return { ok: true, url, slot };
}

/** 安全解析 /branding/:name，禁止路径穿越；返回绝对路径或 null */
export function resolveBrandingFile(name) {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return null;
  const abs = path.join(BRANDING_DIR, name);
  if (!abs.startsWith(BRANDING_DIR + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}
