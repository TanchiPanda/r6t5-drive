/* R6T5 Drive · 前端公共库（用户端与管理端共用）
   约定：所有请求走 cookie 会话，禁止把 token 放进 localStorage。 */
(function (global) {
  'use strict';

  const R6T5 = {
    /* ---------- 请求 ---------- */
    async request(path, options = {}) {
      const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options);
      if (opts.body && !(opts.body instanceof FormData)) {
        opts.headers['Content-Type'] = opts.headers['Content-Type'] || 'application/json';
        if (typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
      }
      let res;
      try {
        res = await fetch(path, opts);
      } catch (e) {
        throw new ApiError('network_error', '无法连接服务端，请检查网络或服务状态', 0);
      }
      const ct = res.headers.get('content-type') || '';
      let data = null;
      if (ct.includes('application/json')) {
        try { data = await res.json(); } catch (_) { data = null; }
      }
      if (!res.ok) {
        const err = (data && data.error) || {};
        throw new ApiError(err.code || 'http_' + res.status, err.message || '请求失败（' + res.status + '）', res.status, err.details);
      }
      return data;
    },
    get(p, q) { return R6T5.request(p + (q ? '?' + R6T5.qs(q) : '')); },
    post(p, body) { return R6T5.request(p, { method: 'POST', body: body || {} }); },
    patch(p, body) { return R6T5.request(p, { method: 'PATCH', body: body || {} }); },
    del(p, q) { return R6T5.request(p + (q ? '?' + R6T5.qs(q) : ''), { method: 'DELETE' }); },

    /* ---------- 工具 ---------- */
    qs(obj) {
      const sp = new URLSearchParams();
      Object.keys(obj).forEach(k => { if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') sp.set(k, obj[k]); });
      return sp.toString();
    },
    fmtBytes(n) {
      if (n === null || n === undefined || isNaN(n)) return '—';
      if (n === 0) return '0 B';
      const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let i = 0, v = Number(n);
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return (v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + u[i];
    },
    fmtTime(t) {
      if (!t) return '—';
      const d = new Date(typeof t === 'number' ? t : t);
      if (isNaN(d)) return '—';
      const p = x => String(x).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    fmtAgo(t) {
      if (!t) return '—';
      const d = new Date(t).getTime();
      if (isNaN(d)) return '—';
      const s = Math.floor((Date.now() - d) / 1000);
      if (s < 60) return '刚刚';
      if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
      if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
      if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
      return R6T5.fmtTime(t);
    },
    esc(s) {
      return String(s === null || s === undefined ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },
    svgIcon(name) {
      return '<svg class="fic-svg" aria-hidden="true"><use href="/assets/icons/sprite.svg#i-' + name + '"></use></svg>';
    },
    /* 从路径取文件名 / 父目录（路径一律用 / 分隔） */
    basename(p) { return String(p || '').replace(/\/+$/, '').split('/').pop(); },
    dirname(p) { const a = String(p || '').replace(/\/+$/, '').split('/'); a.pop(); return a.join('/'); },
    join(...parts) { return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/'); },

    /* ---------- 轻提示 ---------- */
    toast(msg, type) {
      let box = document.querySelector('.toasts');
      if (!box) { box = document.createElement('div'); box.className = 'toasts'; document.body.appendChild(box); }
      const el = document.createElement('div');
      el.className = 'toast ' + (type || '');
      const iconName = type === 'danger' || type === 'warn' ? 'alert' : type === 'ok' ? 'check' : 'info';
      el.innerHTML = '<span class="ico">' + R6T5.svgIcon(iconName) + '</span><span>' + R6T5.esc(msg) + '</span>';
      box.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, type === 'danger' ? 5200 : 2800);
    },
    toastError(e) { R6T5.toast((e && e.message) || '操作失败', 'danger'); },

    /* ---------- 主题 ---------- */
    theme: {
      key: 'r6t5.theme',
      get() { return localStorage.getItem(R6T5.theme.key) || 'light'; },
      set(v) {
        document.documentElement.setAttribute('data-theme', v === 'light' ? 'light' : 'dark');
        localStorage.setItem(R6T5.theme.key, v);
        document.dispatchEvent(new CustomEvent('r6t5:theme', { detail: { theme: v } }));
      },
      toggle() { R6T5.theme.set(R6T5.theme.get() === 'light' ? 'dark' : 'light'); },
      init() { document.documentElement.setAttribute('data-theme', R6T5.theme.get() === 'light' ? 'light' : 'dark'); }
    },

    /* ---------- 弹窗 ---------- */
    modal: {
      open(sel) { const m = document.querySelector(sel); if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; } },
      close(sel) { const m = document.querySelector(sel); if (m) { m.classList.remove('open'); document.body.style.overflow = ''; } },
      /* 点击遮罩关闭 + ESC 关闭；只做一次绑定 */
      bind(sel) {
        const m = document.querySelector(sel);
        if (!m || m.dataset.bound) return;
        m.dataset.bound = '1';
        m.addEventListener('click', e => { if (e.target === m) R6T5.modal.close(sel); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && m.classList.contains('open')) R6T5.modal.close(sel); });
      }
    },

    /* ---------- 顶部主题按钮 ---------- */
    mountThemeBtn(node) {
      if (!node) return;
      const themeIcon = name => '<svg class="fic-svg" aria-hidden="true"><use href="/assets/icons/sprite.svg#i-' + name + '"></use></svg>';
      const paint = () => { node.innerHTML = themeIcon(R6T5.theme.get() === 'light' ? 'sun' : 'moon'); node.title = '切换明暗主题'; };
      node.addEventListener('click', () => { R6T5.theme.toggle(); paint(); });
      paint();
    },

    /* ---------- 页面初始化（主题 + 顶栏按钮 + 品牌外观） ---------- */
    boot() {
      R6T5.theme.init();
      const btn = document.getElementById('theme-btn');
      if (btn) R6T5.mountThemeBtn(btn);
      const t = document.querySelectorAll('[data-theme-sync]');
      t.forEach(() => {});
      // 主题切换后按新主题重选 LOGO
      document.addEventListener('r6t5:theme', () => R6T5.brand.apply());
      R6T5.brand.load();
    }
  };

  /* ================= 品牌外观（P8-A） =================
     规则与后端 server/lib/html-sanitize.js 保持一致，前端再洗一遍作为双保险。 */
  const BRAND_ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'a', 'span', 'img', 'h3', 'h4', 'ul', 'li'];
  const BRAND_DANGEROUS = ['script', 'iframe', 'object', 'embed', 'style', 'form', 'link', 'meta'];
  const BRAND_IMG_SUFFIXES = ['raw.githubusercontent.com', 'githubusercontent.com', 'doubaocdn.com'];
  const BRAND_TAG_ATTRS = { a: ['href'], img: ['src', 'alt'] };

  function brandDecode(s) {
    return String(s == null ? '' : s)
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  }
  function brandHost(url) {
    try { return new URL(url, 'http://localhost').hostname.toLowerCase(); } catch { return null; }
  }
  function brandHrefOk(v) { return /^https?:\/\/[^\s]+$/i.test(brandDecode(v || '').trim()); }
  function brandImgSrcOk(src) {
    const v = brandDecode(src || '').trim();
    if (!v || /^(javascript|data|blob|vbscript):/i.test(v) || v.startsWith('//')) return false;
    if (v.startsWith('/')) return true;
    if (!/^https?:\/\//i.test(v)) return false;
    const host = brandHost(v);
    return !!host && BRAND_IMG_SUFFIXES.some(s => host === s || host.endsWith('.' + s));
  }
  function brandParseAttrs(raw) {
    const attrs = [];
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s>"']*))?/g;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (!m[1]) continue;
      let val = m[3] != null ? m[3] : '';
      if (val.charAt(0) === '"' || val.charAt(0) === "'") val = val.slice(1, -1);
      attrs.push({ name: m[1].toLowerCase(), value: val });
    }
    return attrs;
  }
  function brandCleanAttrs(tag, attrs) {
    const allowed = BRAND_TAG_ATTRS[tag] || [];
    const out = [];
    for (const a of attrs) {
      if (a.name.indexOf('on') === 0 || a.name === 'style') continue;
      if (allowed.indexOf(a.name) < 0) continue;
      if (a.name === 'href') { if (brandHrefOk(a.value)) out.push({ name: a.name, value: brandDecode(a.value) }); }
      else if (a.name === 'src') { if (brandImgSrcOk(a.value)) out.push({ name: a.name, value: brandDecode(a.value) }); }
      else if (a.name === 'alt') out.push({ name: a.name, value: a.value });
    }
    return out;
  }
  function brandRenderAttrs(attrs) {
    if (!attrs.length) return '';
    return ' ' + attrs.map(a => a.name + '="' + String(a.value).replace(/"/g, '&quot;') + '"').join(' ');
  }

  R6T5.sanitizeSidebarHtml = function (html) {
    let src = String(html == null ? '' : html);
    for (const tag of BRAND_DANGEROUS) {
      src = src.replace(new RegExp('<' + tag + '\\b[\\s\\S]*?(?:</' + tag + '\\s*>|/>)', 'gi'), '');
      src = src.replace(new RegExp('</' + tag + '\\s*>', 'gi'), '');
    }
    const tagRe = /<\/?[a-zA-Z0-9][^>]*>/g;
    let last = 0, out = '', m;
    const dropped = {};
    while ((m = tagRe.exec(src)) !== null) {
      out += src.slice(last, m.index);
      last = tagRe.lastIndex;
      const tm = /^<(\/?)([a-zA-Z0-9]+)([\s\S]*?)(\/?)>$/.exec(m[0]);
      if (!tm) continue;
      const closing = tm[1], name = tm[2].toLowerCase(), attrRaw = tm[3], selfClose = tm[4];
      if (BRAND_ALLOWED_TAGS.indexOf(name) < 0) continue;
      if (closing) {
        if (dropped[name] > 0) { dropped[name] -= 1; continue; }
        out += '</' + name + '>'; continue;
      }
      const attrs = brandCleanAttrs(name, brandParseAttrs(attrRaw));
      if (name === 'img' && !attrs.some(a => a.name === 'src')) { dropped.img = (dropped.img || 0) + 1; continue; }
      if (name === 'a' && !attrs.some(a => a.name === 'href')) { dropped.a = (dropped.a || 0) + 1; continue; }
      const self = selfClose === '/' || name === 'br' ? '/' : '';
      out += '<' + name + brandRenderAttrs(attrs) + (self ? ' /' : '') + '>';
    }
    out += src.slice(last);
    return out;
  };

  R6T5.brand = {
    defaults: {
      logoLight: '/assets/favicon.svg',
      logoDark: '/assets/icons/favicon.svg',
      favicon: '/assets/favicon.svg',
      icon192: '/assets/icons/favicon.svg',
      iconLarge: '/assets/icons/favicon.svg',
    },
    data: null,
    async load() {
      try { R6T5.brand.data = await R6T5.get('/api/branding') || null; }
      catch (_) { R6T5.brand.data = null; }
      R6T5.brand.apply();
    },
    cfg() { return R6T5.brand.data || {}; },
    logoFor(theme) {
      const d = R6T5.brand.cfg();
      return theme === 'light'
        ? (d.logoLightUrl || R6T5.brand.defaults.logoLight)
        : (d.logoDarkUrl || R6T5.brand.defaults.logoDark);
    },
    apply() {
      const d = R6T5.brand.cfg();
      const theme = R6T5.theme.get();
      const logo = R6T5.brand.logoFor(theme);
      document.querySelectorAll('[data-brand-logo]').forEach(el => { el.src = logo; });
      const icon = d.faviconUrl || R6T5.brand.defaults.favicon;
      document.querySelectorAll('[data-brand-icon]').forEach(el => { el.src = icon; });
      // <link rel=icon> 统一走 /branding/favicon 短链（302 到当前配置或默认资源）
      const linkIcon = document.querySelector('link[rel="icon"]');
      if (linkIcon) linkIcon.href = '/branding/favicon';
      const name = d.siteName || 'R6T5 Drive';
      document.querySelectorAll('[data-brand-name]').forEach(el => { el.textContent = name; });
      R6T5.brand.renderSideHtml(d.sidebarHtml);
    },
    /* 与 tokens.css 两套主题一一对应的色板（iframe srcdoc 隔离，读不到父页面变量，需内联注入） */
    sidePalette(theme) {
      return theme === 'light'
        ? { scheme: 'light', panel: '#ffffff', fg: '#1d2734', fgDim: '#3d4c5e', muted: '#5f7083', info: '#2466d6', line: 'rgba(19,35,54,.09)' }
        : { scheme: 'dark', panel: '#1d232b', fg: '#e9eef3', fgDim: '#c4cfda', muted: '#97a6b5', info: '#5f9df2', line: 'rgba(255,255,255,.08)' };
    },
    sideHtmlDoc(clean, theme) {
      const P = R6T5.brand.sidePalette(theme || R6T5.theme.get());
      return '<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="' + P.scheme + '"><style>' +
        ':root{color-scheme:' + P.scheme + '}' +
        'body{margin:0;padding:8px 10px;font:12px/1.5 Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:' + P.fgDim + ';background:' + P.panel + '}' +
        'a{color:' + P.info + ';text-decoration:none}strong,b{color:' + P.fg + '}' +
        'img{max-width:100%;height:auto}p{margin:0 0 6px}ul{margin:0;padding-left:18px}' +
        '</style></head><body>' + clean + '</body></html>';
    },
    /* 按内容高度贴合（60–160px），超出 160px 在 iframe 内部滚动 */
    fitFrame(iframe, maxH) {
      const max = maxH || 160;
      try {
        const doc = iframe.contentDocument;
        if (!doc || !doc.body) return;
        const h = doc.body.scrollHeight;
        iframe.style.height = Math.max(60, Math.min(max, h + 16)) + 'px';
      } catch (_) { iframe.style.height = '120px'; }
    },
    renderSideHtml(html) {
      const box = document.querySelector('[data-brand-sidehtml]');
      if (!box) return;
      const clean = html ? R6T5.sanitizeSidebarHtml(html) : '';
      box.innerHTML = '';
      if (!clean) return;
      const iframe = document.createElement('iframe');
      iframe.className = 'brand-sidehtml-frame';
      iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
      iframe.setAttribute('title', '站点自定义信息');
      iframe.srcdoc = R6T5.brand.sideHtmlDoc(clean, R6T5.theme.get());
      iframe.addEventListener('load', () => R6T5.brand.fitFrame(iframe, 160));
      box.appendChild(iframe);
    }
  };

  class ApiError extends Error {
    constructor(code, message, status, details) {
      super(message); this.name = 'ApiError'; this.code = code; this.status = status; this.details = details || null;
    }
  }
  R6T5.ApiError = ApiError;
  global.R6T5 = R6T5;
  R6T5.boot();
})(window);
