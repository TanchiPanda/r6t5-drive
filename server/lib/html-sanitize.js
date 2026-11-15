/* R6T5 Drive · 侧边栏自定义 HTML 白名单清洗（P8-A 品牌与站点外观）
 *
 * 设计原则：白名单制。不在白名单内的标签一律剔除（保留其内部文本）；
 * 危险标签（script/iframe/object/embed/style）连同其内容整体移除；
 * 所有 on* 事件属性、style 属性一律剔除；外链域名受白名单约束。
 * 前后端各实现一份等价规则（前端见 public/assets/api.js 的 R6T5.sanitizeSidebarHtml）。
 */

/** 允许保留的标签（小写） */
export const ALLOWED_TAGS = new Set([
  'p', 'br', 'strong', 'em', 'a', 'span', 'img', 'h3', 'h4', 'ul', 'li',
]);

/** 允许整体移除内容的危险标签 */
const DANGEROUS_BLOCK_TAGS = ['script', 'iframe', 'object', 'embed', 'style', 'form', 'link', 'meta'];

/** img 外链允许的域名后缀（精确命中或以 '.' 连接的子域） */
export const ALLOWED_IMG_HOST_SUFFIXES = [
  'raw.githubusercontent.com',
  'githubusercontent.com',
  'doubaocdn.com',
];

/** 每个标签允许保留的属性 */
const TAG_ALLOWED_ATTRS = {
  a: ['href'],
  img: ['src', 'alt'],
};

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function hostOf(url) {
  try {
    const u = new URL(url, 'http://localhost');
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** a[href]：仅允许 http(s):// */
export function isAllowedHref(url) {
  const v = decodeEntities(url || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(v);
}

/** img[src]：允许 http(s) 白名单域名，或本站根相对路径 `/...`；一律拒绝 data:/javascript:/blob: 与协议相对 `//` */
export function isAllowedImgSrc(src) {
  const v = decodeEntities(src || '').trim();
  if (!v) return false;
  if (/^(javascript|data|blob|vbscript):/i.test(v)) return false;
  if (v.startsWith('//')) return false;
  if (v.startsWith('/')) return true;
  if (!/^https?:\/\//i.test(v)) return false;
  const host = hostOf(v);
  if (!host) return false;
  return ALLOWED_IMG_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

function parseAttrs(raw) {
  const attrs = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>"']*))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (!m[1]) continue;
    let val = m[3] != null ? m[3] : '';
    if (val.startsWith('"') || val.startsWith("'")) val = val.slice(1, -1);
    attrs.push({ name: m[1].toLowerCase(), value: val });
  }
  return attrs;
}

function cleanAttrs(tagName, attrs) {
  const allowed = TAG_ALLOWED_ATTRS[tagName] || [];
  const out = [];
  for (const attr of attrs) {
    const name = attr.name;
    // 剔除所有事件属性与 style 属性
    if (name.startsWith('on') || name === 'style') continue;
    if (!allowed.includes(name)) continue;
    if (name === 'href') {
      if (!isAllowedHref(attr.value)) continue;
      out.push({ name, value: decodeEntities(attr.value) });
      continue;
    }
    if (name === 'src') {
      if (!isAllowedImgSrc(attr.value)) continue;
      out.push({ name, value: decodeEntities(attr.value) });
      continue;
    }
    if (name === 'alt') {
      out.push({ name, value: attr.value });
    }
  }
  return out;
}

function renderAttrs(attrs) {
  if (!attrs.length) return '';
  return ' ' + attrs
    .map((a) => `${a.name}="${String(a.value).replace(/"/g, '&quot;')}"`)
    .join(' ');
}

/**
 * 清洗侧边栏 HTML。返回安全的 HTML 字符串。
 * @param {string} html
 * @returns {string}
 */
export function sanitizeSidebarHtml(html) {
  let src = String(html == null ? '' : html);

  // 1. 危险标签连同内容整体移除（大小写不敏感，兼容嵌套/换行）
  for (const tag of DANGEROUS_BLOCK_TAGS) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?(?:</${tag}\\s*>|/>)`, 'gi');
    src = src.replace(re, '');
    // 残留的孤立闭合标签
    src = src.replace(new RegExp(`</${tag}\\s*>`, 'gi'), '');
  }

  // 2. 逐标签处理
  const tagRe = /<\/?[a-zA-Z0-9][^>]*>/g;
  let last = 0;
  let out = '';
  let m;
  const dropped = {}; // 被剔除开标签的计数，用于抑制配套闭合标签
  while ((m = tagRe.exec(src)) !== null) {
    out += src.slice(last, m.index);
    last = tagRe.lastIndex;
    const raw = m[0];
    const tagMatch = /^<(\/?)([a-zA-Z0-9]+)([\s\S]*?)(\/?)>$/.exec(raw);
    if (!tagMatch) continue;
    const [, closing, nameRaw, attrRaw, selfClose] = tagMatch;
    const name = nameRaw.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) continue; // 非白名单标签：剔除标签本身，保留文本
    if (closing) {
      if (dropped[name] > 0) { dropped[name] -= 1; continue; } // 开标签已被剔除，抑制孤儿闭合标签
      out += `</${name}>`;
      continue;
    }
    const attrs = cleanAttrs(name, parseAttrs(attrRaw));
    // img 无合法 src / a 无合法 href：剔除标签本身，保留内部文本
    if (name === 'img' && !attrs.some((a) => a.name === 'src')) { dropped.img = (dropped.img || 0) + 1; continue; }
    if (name === 'a' && !attrs.some((a) => a.name === 'href')) { dropped.a = (dropped.a || 0) + 1; continue; }
    const self = selfClose === '/' || name === 'br' ? '/' : '';
    out += `<${name}${renderAttrs(attrs)}${self ? ' /' : ''}>`;
  }
  out += src.slice(last);
  return out;
}

/** 判断原始 HTML 经过清洗后是否未发生任何移除/改写（供测试与前端提示使用） */
export function isSafeSidebarHtml(html) {
  return sanitizeSidebarHtml(html) === String(html == null ? '' : html);
}
