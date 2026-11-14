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
      const ico = type === 'danger' ? '⚠' : type === 'warn' ? '!' : type === 'ok' ? '✓' : 'i';
      el.innerHTML = '<span class="ico">' + ico + '</span><span>' + R6T5.esc(msg) + '</span>';
      box.appendChild(el);
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s'; setTimeout(() => el.remove(), 260); }, type === 'danger' ? 5200 : 2800);
    },
    toastError(e) { R6T5.toast((e && e.message) || '操作失败', 'danger'); },

    /* ---------- 主题 ---------- */
    theme: {
      key: 'r6t5.theme',
      get() { return localStorage.getItem(R6T5.theme.key) || 'dark'; },
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
      const paint = () => { node.textContent = R6T5.theme.get() === 'light' ? '☀' : '☾'; node.title = '切换明暗主题'; };
      node.addEventListener('click', () => { R6T5.theme.toggle(); paint(); });
      paint();
    },

    /* ---------- 页面初始化（主题 + 顶栏按钮） ---------- */
    boot() {
      R6T5.theme.init();
      const btn = document.getElementById('theme-btn');
      if (btn) R6T5.mountThemeBtn(btn);
      const t = document.querySelectorAll('[data-theme-sync]');
      t.forEach(() => {});
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
