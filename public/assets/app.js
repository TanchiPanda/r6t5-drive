/* R6T5 Drive · 用户端交互（login / files / account / share）
   纯原生 JS，无第三方库；请求与公共工具复用 /assets/api.js 的 R6T5。 */
(function (global) {
  'use strict';

  /* ================= 通用：401 守卫与请求包装 ================= */

  function redirectLogin() {
    var next = location.pathname + location.search;
    location.href = '/login?next=' + encodeURIComponent(next);
  }

  async function guardedGet(p, q) {
    try { return await R6T5.get(p, q); }
    catch (e) { if (e && e.status === 401) redirectLogin(); throw e; }
  }
  async function guardedPost(p, b) {
    try { return await R6T5.post(p, b); }
    catch (e) { if (e && e.status === 401) redirectLogin(); throw e; }
  }
  async function guardedDel(p, q) {
    try { return await R6T5.del(p, q); }
    catch (e) { if (e && e.status === 401) redirectLogin(); throw e; }
  }
  async function guardedDelBody(p, body) {
    try { return await R6T5.request(p, { method: 'DELETE', body: body || {} }); }
    catch (e) { if (e && e.status === 401) redirectLogin(); throw e; }
  }

  function loginNext() {
    var n = new URLSearchParams(location.search).get('next');
    return n && n.indexOf('/') === 0 && n.indexOf('//') !== 0 ? n : '/files';
  }

  function bindLogout() {
    var btn = document.getElementById('logout-btn');
    var link = document.getElementById('logout-link');
    async function doLogout() {
      try { await R6T5.post('/api/auth/logout', {}); } catch (_) { /* 忽略，本地跳转 */ }
      location.href = '/login';
    }
    if (btn) btn.addEventListener('click', doLogout);
    if (link) link.addEventListener('click', function (e) { e.preventDefault(); doLogout(); });
  }

  /* ================= 图标（Unicode，纯 CSS） ================= */

  function iconFor(item) {
    if (item.type === 'dir') return '▣';
    var mime = item.mime || '';
    if (mime.indexOf('image/') === 0) return '▧';
    if (mime.indexOf('pdf') >= 0) return '▤';
    if (mime.indexOf('text/') === 0 || mime.indexOf('markdown') >= 0) return '✎';
    if (mime.indexOf('zip') >= 0 || mime.indexOf('compressed') >= 0) return '▥';
    return '▤';
  }

  /* 搜索关键字高亮：先转义再包 <mark> */
  function hlName(name, q) {
    var safe = R6T5.esc(name);
    if (!q) return safe;
    var safeQ = R6T5.esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return safe.replace(new RegExp('(' + safeQ + ')', 'ig'), '<mark>$1</mark>'); }
    catch (_) { return safe; }
  }

  /* ================= 通用：在线预览组件（文件页 / 公开分享页复用） ================= */

  var PREVIEW_KIND_LABEL = { image: '图片', video: '视频', pdf: 'PDF', text: '文本', markdown: 'Markdown' };

  /* 按扩展名粗判类型（公开分享页没有 meta 接口时使用；文件页以 meta 为准） */
  function kindByName(name) {
    var ext = String(name || '').split('.').pop().toLowerCase();
    if (ext === 'svg') return 'svg';
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].indexOf(ext) >= 0) return 'image';
    if (['mp4', 'webm', 'ogg', 'mov', 'mkv'].indexOf(ext) >= 0) return 'video';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'md' || ext === 'markdown') return 'markdown';
    if (['txt', 'js', 'ts', 'json', 'csv', 'xml', 'html', 'css', 'yml', 'yaml', 'sh', 'py', 'java', 'c', 'cpp', 'go', 'rs', 'toml', 'ini', 'log', 'sql'].indexOf(ext) >= 0) return 'text';
    return 'unsupported';
  }

  /* EXIF 方向 → CSS 旋转角度（服务端不重编码，前端仅做旋转纠正） */
  function rotateForOrientation(o) {
    switch (Number(o)) {
      case 3: return 180;
      case 6: return 90;
      case 8: return 270;
      case 5: return 270;
      case 7: return 90;
      default: return 0;
    }
  }

  function previewErrText(e) {
    switch (e && e.code) {
      case 'preview_unsupported': return '该文件类型暂不支持在线预览，请下载查看';
      case 'svg_blocked': return 'SVG 含可执行脚本，出于安全考虑不支持在线预览，请下载查看';
      case 'preview_too_large': return '文件过大，无法在线预览，请下载查看';
      case 'share_code_required': return '该分享需要输入提取码后才能预览';
      case 'forbidden': return (e && e.message) || '无权限预览该文件';
      case 'storage_not_configured': return '站点还没有可用的存储策略';
      default: return (e && e.message) || '预览失败，请稍后重试';
    }
  }

  var Preview = {
    mask: null, body: null, title: null, objectUrl: null, bound: false,

    ensure() {
      this.mask = document.getElementById('m-preview') || document.getElementById('m-share-preview');
      if (!this.mask) {
        this.mask = document.createElement('div');
        this.mask.className = 'modal-mask';
        this.mask.id = 'm-preview';
        this.mask.innerHTML =
          '<div class="modal modal-wide"><div class="modal-head"><h3 id="pv-title">预览</h3>' +
          '<div class="spacer"></div><button class="btn icon ghost" id="pv-close" type="button">✕</button></div>' +
          '<div class="modal-body" id="pv-body"></div></div>';
        document.body.appendChild(this.mask);
      }
      this.title = this.mask.querySelector('#pv-title, #sp-title');
      this.body = this.mask.querySelector('#pv-body, #sp-body');
      if (!this.bound) {
        this.bound = true;
        var closeBtn = this.mask.querySelector('#pv-close, #sp-close');
        if (closeBtn) closeBtn.addEventListener('click', () => this.close());
        this.mask.addEventListener('click', e => { if (e.target === this.mask) this.close(); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.mask.classList.contains('open')) this.close(); });
      }
    },

    open(opts) {
      this.ensure();
      this.revokeObjectUrl();
      this.title.textContent = opts.title || '预览';
      this.body.innerHTML = '<div class="skel" style="height:180px"></div>';
      this.mask.classList.add('open');
      document.body.style.overflow = 'hidden';
      this.render(opts.url, opts.kind, opts.name);
    },

    close() {
      if (!this.mask) return;
      this.mask.classList.remove('open');
      document.body.style.overflow = '';
      this.revokeObjectUrl();
      if (this.body) this.body.innerHTML = '';
    },

    revokeObjectUrl() {
      if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    },

    async render(url, kind, name) {
      var body = this.body;
      try {
        if (kind === 'image') await this.renderImage(url, body);
        else if (kind === 'video') this.renderVideo(url, body);
        else if (kind === 'pdf') this.renderPdf(url, body);
        else if (kind === 'markdown') await this.renderMarkdown(url, body);
        else if (kind === 'text') await this.renderText(url, body);
        else this.renderUnsupported(body, name);
      } catch (e) {
        body.innerHTML = '<div class="note danger"><span class="ico">⚠</span><div>' +
          R6T5.esc(previewErrText(e)) + '</div></div>';
      }
    },

    async handleRes(res) {
      if (!res.ok) {
        var data = null;
        try { data = await res.json(); } catch (_) { data = null; }
        var err = (data && data.error) || {};
        throw new R6T5.ApiError(err.code || 'http_' + res.status, err.message || '预览请求失败（' + res.status + '）', res.status);
      }
      return res;
    },

    async renderImage(url, body) {
      var res = await this.handleRes(await fetch(url, { credentials: 'same-origin' }));
      var orient = res.headers.get('X-Image-Orientation');
      var blob = await res.blob();
      this.objectUrl = URL.createObjectURL(blob);
      var rot = rotateForOrientation(orient);
      body.innerHTML = '<div class="pv-media pv-image"><img src="' + this.objectUrl + '"' +
        (rot ? ' style="transform:rotate(' + rot + 'deg)"' : '') + ' alt="' + R6T5.esc(name || '图片') + '"></div>';
    },

    renderVideo(url, body) {
      body.innerHTML = '<div class="pv-media pv-video">' +
        '<video controls preload="metadata" src="' + url + '"></video></div>';
    },

    renderPdf(url, body) {
      body.innerHTML = '<div class="pv-media pv-pdf"><iframe src="' + url + '" title="PDF 预览"></iframe></div>';
    },

    async renderText(url, body) {
      var res = await this.handleRes(await fetch(url, { credentials: 'same-origin' }));
      var data = await res.json();
      var lang = data.language ? '<span class="badge info mt2">' + R6T5.esc(data.language) + '</span>' : '';
      body.innerHTML = '<div class="pv-text-head">' + lang +
        (data.sizeBytes != null ? '<span class="faint small"> · ' + R6T5.fmtBytes(data.sizeBytes) + '</span>' : '') + '</div>' +
        '<pre class="preview-code"><code></code></pre>';
      body.querySelector('code').textContent = data.content || '';
    },

    async renderMarkdown(url, body) {
      var res = await this.handleRes(await fetch(url, { credentials: 'same-origin' }));
      var data = await res.json();
      // html 由后端净化后返回，直接插入，不再做二次处理
      body.innerHTML = '<div class="md-body">' + (data.html || '') + '</div>';
    },

    renderUnsupported(body, name) {
      body.innerHTML = '<div class="empty"><div class="ico">▤</div><h3>暂不支持在线预览</h3>' +
        '<p>该文件类型出于安全考虑不提供在线预览，请下载后查看。</p></div>';
    }
  };

  /* ================= 登录页 ================= */

  async function initLogin() {
    var params = new URLSearchParams(location.search);
    var status;
    try {
      status = await R6T5.get('/api/setup/status');
    } catch (e) {
      status = { ready: false, next: 'supabase', hint: '服务端状态获取失败，请稍后重试', link: '/admin/login', linkLabel: '进入管理后台' };
    }
    /* 前端自测开关：?mock=setup-supabase 模拟未接通账号中心；生产无参时不受影响 */
    if (params.get('mock') === 'setup-supabase') {
      status = {
        ready: false, next: 'supabase',
        hint: '请管理员凭管理密码进入设置页配置 Supabase',
        link: '/admin/login', linkLabel: '进入管理后台',
        checks: { supabase: false, storage: false, groups: false, site: false }
      };
    }
    renderSetup(status);
    bindLoginForm(status);
  }

  function renderSetup(s) {
    var note = document.getElementById('setup-note');
    var noteBody = document.getElementById('setup-note-body');
    var linkBtn = document.getElementById('setup-link');
    var ready = s.ready === true || s.next === 'ready';
    note.className = 'note ' + (ready ? 'ok' : 'warn');
    if (s.userSource === 'volume') {
      // 数据卷模式：提示条不出现 Supabase 字样；即便 next 异常回落到 supabase 也按 volume 文案渲染
      noteBody.textContent = '当前由数据卷管理账号，请使用管理员分配的邮箱与密码登录';
    } else {
      noteBody.textContent = s.hint || (ready ? '配置完成，可以使用邮箱登录' : '站点尚未配置完成');
    }
    if (!linkBtn) return;
    if (ready) {
      linkBtn.classList.add('hide');
    } else if (s.link) {
      linkBtn.href = s.link;
      linkBtn.textContent = s.linkLabel || '进入管理后台';
      linkBtn.classList.remove('hide');
    } else {
      linkBtn.classList.add('hide');
    }
  }

  function bindLoginForm(status) {
    var form = document.getElementById('login-form');
    var btn = document.getElementById('login-submit');
    var email = document.getElementById('email');
    var pass = document.getElementById('password');
    var errBox = document.getElementById('login-err');
    var adminEntry = document.getElementById('setup-link');
    var notReady = !(status.ready === true || status.next === 'ready');

    if (notReady) {
      btn.disabled = true;
      email.disabled = true;
      pass.disabled = true;
      btn.textContent = '站点尚未就绪';
      if (status.next === 'supabase' && status.link && status.userSource !== 'volume') {
        adminEntry.href = status.link;
        adminEntry.textContent = status.linkLabel || '进入管理后台';
        adminEntry.classList.remove('hide');
      }
    }

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (btn.disabled) return;
      errBox.textContent = '';
      btn.disabled = true;
      var old = btn.textContent;
      btn.textContent = '登录中…';
      try {
        await R6T5.post('/api/auth/login', { email: email.value.trim(), password: pass.value });
        location.href = loginNext();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = old;
        var msg;
        switch (err.code) {
          case 'invalid_credentials': msg = '邮箱或密码错误'; break;
          case 'account_banned': msg = (err && err.message) || '账号已被封禁，请联系管理员'; break;
          case 'supabase_not_configured': msg = '站点尚未接通账号中心，请联系管理员'; break;
          case 'rate_limited': msg = '尝试过于频繁，请稍后再试'; break;
          default: msg = (err && err.message) || '登录失败';
        }
        errBox.textContent = msg;
      }
    });
  }

  /* ================= 文件页 ================= */

  var Files = {
    email: '',
    me: null,
    quota: null,
    state: {
      path: '',
      crumbs: [],
      items: [],
      strategy: null,
      view: localStorage.getItem('r6t5.view') || 'list',
      searching: false,
      q: ''
    },
    /* 多选：path 集合；lastChecked 用于 Shift 区间选择 */
    selected: new Set(),
    lastCheckedPath: null,
    /* 进行中的分片上传任务，便于卸载/取消 */
    chunkJobs: [],
    highlightedPath: null
  };

  var CHUNK_THRESHOLD = 16 * 1024 * 1024; // 超过 16 MB 走分片上传
  var DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB，可被后端返回值对齐
  var CHUNK_CONCURRENCY = 3;
  var CHUNK_MAX_RETRY = 3;
  var CHUNK_RETRY_BASE_MS = 1000;

  var STRATEGY_TYPE_LABEL = { volume: '本地卷', s3: 'S3', github: 'GitHub' };
  var MATCH_LABEL = { binding: '目录绑定', group: '用户组默认', local: '本地默认' };

  function strategyTypeText(t) { return STRATEGY_TYPE_LABEL[t] || t || '—'; }
  function strategyReadOnly() { return !!(Files.state.strategy && Files.state.strategy.readOnly === true); }
  function readOnlyTip() {
    var st = Files.state.strategy;
    var t = st ? strategyTypeText(st.type) : '';
    return '该目录为只读策略（' + t + '），不能写入';
  }

  async function initFiles() {
    bindLogout();
    var pv = new URLSearchParams(location.search).get('view');
    if (pv === 'grid' || pv === 'list') Files.state.view = pv;
    var me;
    try { me = await R6T5.get('/api/me'); }
    catch (e) { if (e.status === 401) redirectLogin(); throw e; }
    Files.me = me;
    Files.email = me.user.email;
    Files.quota = me.quota;
    document.getElementById('whoami').textContent = me.user.email;
    renderQuota();
    var initPath = new URLSearchParams(location.search).get('path') || Files.email;
    await loadDir(initPath);
    bindFilesToolbar();
    bindFileModals();
    bindArchiveModals();
    bindTrashDrawer();
    bindMySharesDrawer();
    wireResumeInput();
  }

  /* ---------- 目录加载 ---------- */

  async function loadDir(path) {
    Files.state.path = path || Files.email;
    Files.state.searching = false;
    Files.state.q = '';
    var searchInput = document.getElementById('search-input');
    searchInput.value = '';
    document.getElementById('search-clear').classList.add('hide');
    Files.selected.clear();
    Files.lastCheckedPath = null;
    var res = await guardedGet('/api/files', { path: Files.state.path });
    Files.state.crumbs = res.crumbs || [];
    Files.state.items = res.items || [];
    Files.state.strategy = res.strategy || null;
    if (res.quota) { Files.quota = res.quota; renderQuota(); }
    renderCrumbs();
    renderStrategyBadge();
    applyReadOnly();
    renderItems();
    refreshResumeBanner();
  }

  function renderStrategyBadge() {
    var box = document.getElementById('strategy-badge');
    if (!box) return;
    var st = Files.state.strategy;
    if (!st || !st.name) { box.innerHTML = ''; return; }
    var matched = MATCH_LABEL[st.matchedBy] || st.matchedBy || '—';
    var tip = '策略：' + st.name + ' · ' + strategyTypeText(st.type) + ' · 命中方式：' + matched +
      (st.bindingPath ? ' · 子目录 ' + st.bindingPath : '');
    box.innerHTML =
      '<span class="badge" title="' + R6T5.esc(tip) + '">' +
      '<span class="dot-s"></span>' + R6T5.esc(st.name) +
      '<span class="muted">·</span>' + R6T5.esc(strategyTypeText(st.type)) +
      (st.readOnly ? '<span class="badge warn">只读</span>' : '') +
      '</span>';
  }

  function applyReadOnly() {
    var ro = strategyReadOnly();
    var upload = document.getElementById('upload-btn');
    var mkdir = document.getElementById('mkdir-btn');
    var tip = readOnlyTip();
    [upload, mkdir].forEach(function (btn) {
      if (!btn) return;
      btn.disabled = ro;
      btn.title = ro ? tip : '';
    });
    /* 只读目录：隐藏/禁用多选与批量操作 */
    var allChecks = document.querySelectorAll('.row-check-input, #head-select-all');
    allChecks.forEach(function (c) { c.disabled = ro; });
    renderBatchBar();
  }

  function renderCrumbs() {
    var box = document.getElementById('crumbs');
    box.innerHTML = '';
    Files.state.crumbs.forEach(function (c, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '/';
        box.appendChild(sep);
      }
      var a = document.createElement('button');
      a.type = 'button';
      a.className = 'crumb' + (i === Files.state.crumbs.length - 1 ? ' current' : '');
      a.textContent = c.label;
      if (i < Files.state.crumbs.length - 1) {
        a.addEventListener('click', function () { loadDir(c.path); });
      }
      box.appendChild(a);
    });
  }

  /* ---------- 列表 / 网格渲染 ---------- */

  function renderItems() {
    var area = document.getElementById('file-area');
    var items = Files.state.items;
    if (!items.length) {
      area.innerHTML =
        '<div class="empty"><div class="ico">▢</div><h3>' +
        (Files.state.searching ? '没有找到匹配的文件' : '还没有文件') + '</h3>' +
        '<p>' + (Files.state.searching ? '换个关键字试试，或清空搜索回到当前目录' : '拖进来或点上传') + '</p></div>';
      renderBatchBar();
      return;
    }
    var q = Files.state.searching ? Files.state.q : '';
    var ro = strategyReadOnly();
    if (Files.state.view === 'grid') {
      area.className = 'file-grid';
      area.innerHTML = items.map(function (it) {
        var nameHtml = hlName(it.name, q);
        var meta = it.type === 'dir'
          ? (it.itemCount != null ? it.itemCount + ' 项' : '文件夹')
          : (it.sizeBytes == null ? '—' : R6T5.fmtBytes(it.sizeBytes));
        var remote = it.remote ? '<span class="badge acc">云端</span>' : '';
        var sel = Files.selected.has(it.path) ? ' selected' : '';
        var hl = Files.highlightedPath === it.path ? ' hl' : '';
        return '<div class="file-card' + sel + hl + '" data-path="' + R6T5.esc(it.path) + '" data-type="' + it.type + '">' +
          '<label class="row-check" title="选择此项"><input type="checkbox" class="row-check-input" aria-label="选择 ' + R6T5.esc(it.name) + '"' +
          (Files.selected.has(it.path) ? ' checked' : '') + (ro ? ' disabled' : '') + '></label>' +
          '<div class="fic">' + iconFor(it) + '</div>' +
          '<div class="fname" title="' + R6T5.esc(it.name) + '">' + nameHtml + remote + '</div>' +
          '<div class="meta"><span>' + meta + '</span><span>' + R6T5.fmtAgo(it.updatedAt) + '</span></div>' +
          '<div class="ops">' + opsHtml(it) + '</div></div>';
      }).join('');
    } else {
      area.className = 'file-list';
      area.innerHTML =
        '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th class="col-check"><label class="check row-check" title="全选当前目录"><input type="checkbox" id="head-select-all" aria-label="全选当前目录"' +
        (ro ? ' disabled' : '') + '></label></th>' +
        '<th>名称</th><th class="num">大小</th><th>修改时间</th><th></th></tr></thead><tbody>' +
        items.map(function (it) {
          var nameHtml = hlName(it.name, q);
          var size = it.type === 'dir' ? '—' : (it.sizeBytes == null ? '—' : R6T5.fmtBytes(it.sizeBytes));
          var remote = it.remote ? '<span class="badge acc">云端</span>' : '';
          var sel = Files.selected.has(it.path) ? ' selected' : '';
          var hl = Files.highlightedPath === it.path ? ' hl' : '';
          return '<tr class="file-row' + sel + hl + '" data-path="' + R6T5.esc(it.path) + '" data-type="' + it.type + '">' +
            '<td class="col-check"><label class="row-check" title="选择此项"><input type="checkbox" class="row-check-input" aria-label="选择 ' + R6T5.esc(it.name) + '"' +
            (Files.selected.has(it.path) ? ' checked' : '') + (ro ? ' disabled' : '') + '></label></td>' +
            '<td><div class="name"><span class="fic">' + iconFor(it) + '</span>' +
            '<span class="fname" title="' + R6T5.esc(it.name) + '">' + nameHtml + '</span>' + remote + '</div></td>' +
            '<td class="num meta">' + size + '</td>' +
            '<td class="when">' + R6T5.fmtAgo(it.updatedAt) + '</td>' +
            '<td><div class="ops">' + opsHtml(it) + '</div></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    bindItemEvents(area);
    refreshPreviewStates(area);
    renderBatchBar();
  }

  /* 逐文件拉取 meta，决定预览按钮是否可用；不可预览时 title 展示 reason */
  function refreshPreviewStates(area) {
    area.querySelectorAll('.file-row, .file-card').forEach(function (row) {
      var path = row.getAttribute('data-path');
      var item = Files.state.items.find(function (x) { return x.path === path; });
      if (!item || item.type !== 'file') return;
      var btn = row.querySelector('[data-op="preview"]');
      if (!btn) return;
      R6T5.get('/api/files/preview/meta', { path: item.path }).then(function (meta) {
        if (!meta || !meta.previewable) {
          btn.disabled = true;
          btn.title = (meta && meta.reason) || '暂不支持在线预览，请下载查看';
        } else {
          btn.disabled = false;
          btn.title = '预览';
        }
      }).catch(function () {
        btn.disabled = true;
        btn.title = '预览状态获取失败';
      });
    });
  }

  function opsHtml(it) {
    var ops = '';
    if (it.type === 'file') {
      ops += '<button class="btn sm ghost" data-op="preview" title="预览">◈</button>' +
        '<button class="btn sm ghost" data-op="download" title="下载">↓</button>';
      if (isZipFile(it)) {
        var ro = strategyReadOnly();
        var exDis = ro ? ' disabled title="' + R6T5.esc(readOnlyTip()) + '"' : '';
        ops += '<button class="btn sm ghost" data-op="extract" title="解压"' + exDis + '>▥</button>';
      }
    }
    // 分享是读操作：只读策略下仍然可用
    ops += '<button class="btn sm ghost" data-op="share" title="分享">↗</button>';
    var ro2 = strategyReadOnly();
    var dis = ro2 ? ' disabled title="' + R6T5.esc(readOnlyTip()) + '"' : '';
    ops += '<button class="btn sm ghost" data-op="rename" title="重命名"' + dis + '>✎</button>' +
      '<button class="btn sm ghost" data-op="move" title="移动"' + dis + '>➦</button>' +
      '<button class="btn sm ghost danger" data-op="delete" title="删除"' + dis + '>✕</button>';
    return ops;
  }

  function isZipFile(it) {
    if (it.type !== 'file') return false;
    var ext = String(it.name || '').split('.').pop().toLowerCase();
    return ext === 'zip' || (it.mime || '').indexOf('zip') >= 0;
  }

  function bindItemEvents(area) {
    area.querySelectorAll('[data-path]').forEach(function (row) {
      var path = row.getAttribute('data-path');
      var type = row.getAttribute('data-type');
      var check = row.querySelector('.row-check-input');
      if (check) {
        check.addEventListener('click', function (e) { e.stopPropagation(); });
        check.addEventListener('change', function (e) {
          onRowCheck(path, check.checked, e.shiftKey);
        });
      }
      row.querySelectorAll('[data-op]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var op = btn.getAttribute('data-op');
          var item = Files.state.items.find(function (x) { return x.path === path; });
          if (!item) return;
          if (op === 'download') downloadItem(item);
          else if (op === 'preview') openPreview(item);
          else if (op === 'share') openShare(item);
          else if (op === 'rename') openRename(item);
          else if (op === 'move') openMove(item);
          else if (op === 'delete') openDelete(item);
          else if (op === 'extract') openExtract(item);
        });
      });
      row.querySelector('.name, .fname, .file-card') && row.addEventListener('click', function (e) {
        if (e.target.closest('[data-op]') || e.target.closest('.row-check')) return;
        if (type === 'dir') loadDir(path);
        else {
          var item = Files.state.items.find(function (x) { return x.path === path; });
          if (item) downloadItem(item);
        }
      });
    });
    /* 表头全选 */
    var head = area.querySelector('#head-select-all');
    if (head) {
      head.addEventListener('change', function () { toggleSelectAll(head.checked); });
    }
  }

  /* ---------- 多选 ---------- */

  function currentSelectableItems() {
    return Files.state.items.slice();
  }

  function onRowCheck(path, checked, shiftKey) {
    var list = currentSelectableItems();
    if (shiftKey && Files.lastCheckedPath) {
      var from = list.findIndex(function (x) { return x.path === Files.lastCheckedPath; });
      var to = list.findIndex(function (x) { return x.path === path; });
      if (from >= 0 && to >= 0) {
        var lo = Math.min(from, to), hi = Math.max(from, to);
        for (var i = lo; i <= hi; i += 1) {
          if (checked) Files.selected.add(list[i].path);
          else Files.selected.delete(list[i].path);
        }
      } else {
        applyOne(path, checked);
      }
    } else {
      applyOne(path, checked);
    }
    Files.lastCheckedPath = path;
    renderItems();
  }

  function applyOne(path, checked) {
    if (checked) Files.selected.add(path);
    else Files.selected.delete(path);
  }

  function toggleSelectAll(checked) {
    currentSelectableItems().forEach(function (it) {
      if (checked) Files.selected.add(it.path);
      else Files.selected.delete(it.path);
    });
    renderItems();
  }

  function selectedItems() {
    return Files.state.items.filter(function (x) { return Files.selected.has(x.path); });
  }

  function renderBatchBar() {
    var bar = document.getElementById('batch-bar');
    if (!bar) return;
    var sel = selectedItems();
    var ro = strategyReadOnly();
    var count = sel.length;
    if (count === 0) {
      bar.classList.add('hide');
      return;
    }
    bar.classList.remove('hide');
    var totalBytes = sel.reduce(function (s, it) {
      return s + (it.type === 'file' && Number.isFinite(Number(it.sizeBytes)) ? Number(it.sizeBytes) : 0);
    }, 0);
    var sizeLabel = sel.some(function (it) { return it.type === 'dir'; })
      ? R6T5.fmtBytes(totalBytes) + '（目录大小未计入）'
      : R6T5.fmtBytes(totalBytes);
    var countEl = document.getElementById('batch-count');
    countEl.textContent = count + ' 项 · ' + sizeLabel;

    var zipBtn = document.getElementById('batch-zip');
    var compressBtn = document.getElementById('batch-compress');
    var delBtn = document.getElementById('batch-delete');
    [zipBtn, compressBtn, delBtn].forEach(function (b) { b.disabled = ro; });
    if (ro) {
      [zipBtn, compressBtn, delBtn].forEach(function (b) { b.title = readOnlyTip(); });
    } else {
      [zipBtn, compressBtn, delBtn].forEach(function (b) { b.title = ''; });
    }
    /* 压缩为 zip 仅在多选（≥2）时突出显示；单选仍可打包下载 */
    compressBtn.classList.toggle('hide', count < 2);

    var head = document.getElementById('head-select-all');
    if (head) {
      head.checked = count > 0 && count === Files.state.items.length;
      head.indeterminate = count > 0 && count < Files.state.items.length;
    }
  }

  function clearSelection() {
    Files.selected.clear();
    Files.lastCheckedPath = null;
    renderItems();
  }

  function downloadItem(item) {
    location.href = '/api/files/download?' + R6T5.qs({ path: item.path, inline: 0 });
  }

  /* ---------- 在线预览（登录态，meta 驱动） ---------- */

  async function openPreview(item) {
    var meta;
    try {
      meta = await guardedGet('/api/files/preview/meta', { path: item.path });
    } catch (e) { R6T5.toastError(e); return; }
    if (!meta || !meta.previewable) {
      R6T5.toast((meta && meta.reason) || '暂不支持在线预览', 'warn');
      return;
    }
    var url = '/api/files/preview?' + R6T5.qs({ path: item.path, exif: 1 });
    Preview.open({ title: item.name, url: url, kind: meta.kind, name: item.name });
  }

  /* ---------- 创建分享 ---------- */

  var ShareForm = { target: null };

  function openShare(item) {
    ShareForm.target = item;
    document.getElementById('share-target').textContent =
      item.name + (item.type === 'dir' ? '（文件夹）' : '');
    var sel = document.getElementById('share-expires');
    sel.value = 'permanent';
    toggleCustomExpires();
    document.getElementById('share-code').value = '';
    document.getElementById('share-max').value = '';
    document.getElementById('share-preview').checked = true;
    document.getElementById('share-err').textContent = '';
    var result = document.getElementById('share-result');
    result.classList.add('hide');
    result.innerHTML = '';
    R6T5.modal.open('#m-share');
  }

  function toggleCustomExpires() {
    var sel = document.getElementById('share-expires');
    var custom = document.getElementById('share-expires-custom');
    custom.classList.toggle('hide', sel.value !== 'custom');
  }

  function genRandomCode() {
    var chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    var out = '';
    for (var i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById('share-code').value = out;
  }

  async function submitShare() {
    if (!ShareForm.target) return;
    var errBox = document.getElementById('share-err');
    errBox.textContent = '';
    var sel = document.getElementById('share-expires');
    var expiresIn = sel.value === 'custom'
      ? document.getElementById('share-expires-custom').value
      : sel.value;
    var code = document.getElementById('share-code').value.trim();
    var maxRaw = document.getElementById('share-max').value.trim();
    var allowPreview = document.getElementById('share-preview').checked;

    var body = {
      path: ShareForm.target.path,
      expiresIn: expiresIn || 'permanent',
      code: code,
      maxDownloads: maxRaw === '' ? null : Number(maxRaw),
      allowPreview: allowPreview
    };
    var btn = document.getElementById('share-ok');
    btn.disabled = true;
    try {
      var res = await guardedPost('/api/shares', body);
      renderShareResult(res.item);
    } catch (e) {
      errBox.textContent = (e && e.message) || '创建分享失败';
      R6T5.toastError(e);
    } finally {
      btn.disabled = false;
    }
  }

  function renderShareResult(item) {
    var link = location.origin + item.url;
    var result = document.getElementById('share-result');
    result.classList.remove('hide');
    result.innerHTML =
      '<div class="note ok"><span class="ico">✓</span><div><b>分享链接已创建</b>' +
      (item.hasCode ? ' · 提取码已设置' : '') + '</div></div>' +
      '<div class="share-link-row mt3">' +
      '<input class="input flex1 mono-sm" id="share-link-input" readonly value="' + R6T5.esc(link) + '">' +
      '<button class="btn sm" id="share-copy" type="button">复制链接</button></div>' +
      '<div class="share-meta faint small mt2">' +
      (item.isDir ? '文件夹' : '文件') + ' · ' +
      (item.expiresAt ? '有效期至 ' + R6T5.fmtTime(item.expiresAt) : '永久有效') + ' · ' +
      (item.maxDownloads == null ? '不限下载次数' : '上限 ' + item.maxDownloads + ' 次') +
      '</div>';
    result.querySelector('#share-copy').addEventListener('click', function () {
      copyText(link, this);
    });
  }

  function copyText(text, btn) {
    var done = function () {
      var old = btn.textContent;
      btn.textContent = '已复制';
      R6T5.toast('链接已复制到剪贴板', 'ok');
      setTimeout(function () { btn.textContent = old; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) { /* 忽略 */ }
    ta.remove();
  }

  /* ---------- 我的分享（抽屉） ---------- */

  var SHARE_STATUS_LABEL = {
    active: { label: '有效', cls: 'ok' },
    expired: { label: '已过期', cls: 'warn' },
    revoked: { label: '已撤销', cls: 'danger' },
    exhausted: { label: '次数用尽', cls: 'danger' }
  };

  function bindMySharesDrawer() {
    var nav = document.getElementById('nav-share');
    var mask = document.getElementById('ms-mask');
    var drawer = document.getElementById('my-shares-drawer');
    var close = document.getElementById('ms-close');
    if (!nav || !drawer) return;

    function open() {
      mask.classList.add('open');
      drawer.classList.add('open');
      loadMyShares();
    }
    function closeDrawer() {
      mask.classList.remove('open');
      drawer.classList.remove('open');
    }
    nav.classList.remove('disabled');
    nav.removeAttribute('title');
    nav.addEventListener('click', function (e) { e.preventDefault(); open(); });
    close.addEventListener('click', closeDrawer);
    mask.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  async function loadMyShares() {
    var body = document.getElementById('ms-list');
    body.innerHTML = '<div class="skel" style="height:14px"></div>';
    var res;
    try { res = await guardedGet('/api/shares'); }
    catch (e) { R6T5.toastError(e); body.innerHTML = ''; return; }
    var items = res.items || [];
    if (!items.length) {
      body.innerHTML = '<div class="empty"><div class="ico">↗</div><h3>还没有分享</h3>' +
        '<p>在文件或文件夹上点击「分享」，即可生成对外访问链接。</p></div>';
      return;
    }
    body.innerHTML = items.map(function (it) {
      var st = SHARE_STATUS_LABEL[it.status] || { label: it.status || '—', cls: '' };
      var meta = (it.isDir ? '文件夹' : '文件') + ' · ' +
        (it.expiresAt ? '有效期至 ' + R6T5.fmtTime(it.expiresAt) : '永久有效') + ' · ' +
        (it.maxDownloads == null
          ? '已下载 ' + it.downloadCount + ' 次（不限）'
          : '已下载 ' + it.downloadCount + ' / ' + it.maxDownloads + ' 次');
      return '<div class="ms-item" data-id="' + R6T5.esc(it.id) + '">' +
        '<div class="ms-head"><div class="fname">' + R6T5.esc(it.name) + '</div>' +
        '<span class="badge ' + st.cls + '">' + st.label + '</span></div>' +
        '<div class="ms-meta">' + R6T5.esc(meta) + '</div>' +
        '<div class="ms-sub mono-sm">' + R6T5.esc(it.url) + '</div>' +
        '<div class="ms-ops">' +
        (it.allowPreview ? '<span class="badge info">可预览</span>' : '<span class="badge">不可预览</span>') +
        (it.hasCode ? '<span class="badge warn">有提取码</span>' : '<span class="badge">无提取码</span>') +
        '<span class="spacer"></span>' +
        '<button class="btn sm ghost" data-op="open" type="button">打开</button>' +
        '<button class="btn sm danger" data-op="revoke" type="button">撤销</button>' +
        '</div></div>';
    }).join('');

    body.querySelectorAll('.ms-item').forEach(function (row) {
      var id = row.getAttribute('data-id');
      var item = items.find(function (x) { return x.id === id; });
      row.querySelector('[data-op="open"]').addEventListener('click', function () {
        if (item) window.open(item.url, '_blank', 'noopener');
      });
      row.querySelector('[data-op="revoke"]').addEventListener('click', function () { revokeMyShare(item); });
    });
  }

  async function revokeMyShare(item) {
    if (!item) return;
    if (!confirm('确定撤销分享「' + item.name + '」？撤销后链接将立即失效，他人无法再访问。')) return;
    try {
      await guardedDel('/api/shares/' + encodeURIComponent(item.id));
      R6T5.toast('分享已撤销', 'ok');
      loadMyShares();
    } catch (e) { R6T5.toastError(e); }
  }

  /* ---------- 工具栏：上传 / 新建 / 搜索 / 视图 ---------- */

  function bindFilesToolbar() {
    var fileInput = document.getElementById('file-input');
    document.getElementById('upload-btn').addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files.length) uploadFiles(fileInput.files);
      fileInput.value = '';
    });

    document.getElementById('mkdir-btn').addEventListener('click', openMkdir);

    /* 批量操作条 */
    document.getElementById('batch-clear').addEventListener('click', clearSelection);
    document.getElementById('batch-zip').addEventListener('click', batchZipDownload);
    document.getElementById('batch-compress').addEventListener('click', openCompress);
    document.getElementById('batch-delete').addEventListener('click', batchDeleteSelected);

    /* 续传提示 */
    document.getElementById('resume-btn').addEventListener('click', resumePendingUploads);
    document.getElementById('resume-dismiss').addEventListener('click', dismissResumeBanner);

    /* 拖拽 */
    var dz = document.getElementById('dropzone');
    ['dragover', 'dragenter'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); });
    });
    dz.addEventListener('drop', function (e) {
      if (strategyReadOnly()) {
        R6T5.toast(readOnlyTip(), 'warn');
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
    });

    /* 视图切换 */
    var toggle = document.getElementById('view-toggle');
    toggle.querySelectorAll('button').forEach(function (b) {
      if (b.getAttribute('data-view') === Files.state.view) {
        toggle.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
      }
      b.addEventListener('click', function () {
        Files.state.view = b.getAttribute('data-view');
        localStorage.setItem('r6t5.view', Files.state.view);
        toggle.querySelectorAll('button').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        renderItems();
      });
    });

    /* 搜索（防抖） */
    var input = document.getElementById('search-input');
    var clearBtn = document.getElementById('search-clear');
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (!q) {
        clearBtn.classList.add('hide');
        loadDir(Files.state.path);
        return;
      }
      timer = setTimeout(function () { doSearch(q); }, 250);
    });
    clearBtn.addEventListener('click', function () { loadDir(Files.state.path); });
  }

  async function doSearch(q) {
    Files.state.searching = true;
    Files.state.q = q;
    var res = await guardedGet('/api/files/search', { q: q, path: Files.state.path });
    Files.state.items = res.items || [];
    document.getElementById('search-clear').classList.remove('hide');
    renderItems();
  }

  /* ---------- 上传：小文件走表单直传，大文件走分片 ---------- */

  function uploadFiles(fileList) {
    if (strategyReadOnly()) {
      R6T5.toast(readOnlyTip(), 'warn');
      return;
    }
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    files.forEach(function (file) {
      if (file.size > CHUNK_THRESHOLD) startChunkUpload(file);
      else uploadOneSimple(file);
    });
  }

  function uploadOneSimple(file) {
    var queue = document.getElementById('upload-queue');
    queue.classList.remove('hide');
    var row = document.createElement('div');
    row.className = 'up-row card tight';
    row.innerHTML =
      '<div class="row tight"><span class="up-ico">↑</span>' +
      '<span class="up-name flex1 trunc"></span><span class="up-status faint"></span></div>' +
      '<div class="bar thin mt2"><i style="width:0%"></i></div>';
    row.querySelector('.up-name').textContent = file.name;
    queue.appendChild(row);
    var bar = row.querySelector('.bar i');
    var status = row.querySelector('.up-status');

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload?' + R6T5.qs({ path: Files.state.path }));
    xhr.upload.onprogress = function (e) {
      if (e.lengthComputable) {
        var p = Math.round(e.loaded / e.total * 100);
        bar.style.width = p + '%';
        status.textContent = p + '%';
      }
    };
    xhr.onload = function () {
      var data = null;
      try { data = JSON.parse(xhr.responseText); } catch (_) { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        bar.style.width = '100%';
        status.textContent = '完成';
        status.className = 'ok';
        setTimeout(function () { row.remove(); }, 2600);
        loadDir(Files.state.path);
      } else {
        var err = (data && data.error) || {};
        status.textContent = '失败';
        status.className = 'danger';
        R6T5.toast(archiveErrMsg(err.code, err.details, err.message), 'danger');
      }
    };
    xhr.onerror = function () {
      status.textContent = '失败';
      status.className = 'danger';
      R6T5.toast('网络错误，上传失败', 'danger');
    };
    var fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  }

  /* ---------- 分片上传（init → 并发 PUT 分片 → complete，支持续传/取消/重试） ---------- */

  function chunkQueueRow(title) {
    var queue = document.getElementById('upload-queue');
    queue.classList.remove('hide');
    var row = document.createElement('div');
    row.className = 'up-row card tight chunk-up';
    row.innerHTML =
      '<div class="row tight"><span class="up-ico">↑</span>' +
      '<span class="up-name flex1 trunc"></span><span class="up-status faint"></span></div>' +
      '<div class="bar thin mt2" role="progressbar" aria-label="上传进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i style="width:0%"></i></div>' +
      '<div class="row tight mt2 chunk-ops hide">' +
      '<button class="btn sm ghost" data-chunk="retry" type="button">重试</button>' +
      '<button class="btn sm danger" data-chunk="cancel" type="button">取消上传</button>' +
      '</div>';
    row.querySelector('.up-name').textContent = title;
    queue.appendChild(row);
    return row;
  }

  function chunkJobView(job) {
    return {
      file: job.file,
      uploadId: job.uploadId,
      parentPath: job.parentPath,
      name: job.name,
      sizeBytes: job.sizeBytes,
      chunkSize: job.chunkSize,
      totalChunks: job.totalChunks,
      received: new Set(job.received || []),
      cancelled: false,
      failed: false,
      row: job.row,
      bar: job.row.querySelector('.bar i'),
      status: job.row.querySelector('.up-status'),
      ops: job.row.querySelector('.chunk-ops')
    };
  }

  async function startChunkUpload(file, opts) {
    opts = opts || {};
    var row = chunkQueueRow(file.name);
    var job = { file: file, row: row, received: opts.received || [], chunkSize: opts.chunkSize,
      uploadId: opts.uploadId, parentPath: Files.state.path, name: file.name, sizeBytes: file.size };
    var view = chunkJobView(job);
    Files.chunkJobs.push(view);
    setChunkStatus(view, '初始化…', 'faint');

    try {
      var initBody = {
        parentPath: Files.state.path,
        name: file.name,
        sizeBytes: file.size,
        chunkSize: DEFAULT_CHUNK_SIZE
      };
      if (opts.overwrite) initBody.overwrite = '1';
      var initRes = await guardedPost('/api/uploads/init', initBody);
      view.uploadId = initRes.uploadId;
      view.chunkSize = initRes.chunkSize;
      view.totalChunks = initRes.totalChunks;
      view.received = new Set(initRes.received || []);
      await runChunkJob(view);
    } catch (e) {
      if (view.cancelled) return;
      chunkFail(view, e, true);
    }
  }

  function chunkPartSlice(view, index) {
    var start = index * view.chunkSize;
    var end = Math.min(start + view.chunkSize, view.sizeBytes);
    return view.file.slice(start, end);
  }

  async function runChunkJob(view) {
    if (view.cancelled) return;
    /* 续传场景：先拉详情拿最新 missing */
    var missing = [];
    try {
      var detail = await guardedGet('/api/uploads/' + encodeURIComponent(view.uploadId));
      var item = detail.item || {};
      view.received = new Set(item.received || []);
      view.totalChunks = item.totalChunks || view.totalChunks;
      view.chunkSize = item.chunkSize || view.chunkSize;
      missing = item.missing && item.missing.length ? item.missing : missingList(view);
    } catch (e) {
      if (e && e.code === 'upload_session_expired') throw e;
      missing = missingList(view);
    }
    updateChunkBar(view);

    var queue = missing.slice();
    var inFlight = 0;
    var aborted = false;

    async function worker() {
      while (queue.length && !aborted && !view.cancelled) {
        var index = queue.shift();
        if (view.received.has(index)) continue;
        inFlight += 1;
        try {
          await putPartWithRetry(view, index);
          view.received.add(index);
          updateChunkBar(view);
        } catch (e) {
          aborted = true;
          queue.unshift(index);
          chunkFail(view, e, false);
          return;
        } finally {
          inFlight -= 1;
        }
      }
    }

    var workers = [];
    for (var w = 0; w < CHUNK_CONCURRENCY; w += 1) workers.push(worker());
    await Promise.all(workers);

    if (view.cancelled || aborted) return;

    setChunkStatus(view, '合并中…', 'faint');
    /* complete 返回 409 upload_incomplete 且 details.missing 有片时，自动补齐缺失片再 complete，最多 2 轮 */
    const MAX_COMPLETE_ROUNDS = 2;
    for (let round = 0; ; round += 1) {
      try {
        var completeRes = await guardedPost('/api/uploads/' + encodeURIComponent(view.uploadId) + '/complete', {});
        chunkDone(view, completeRes && completeRes.item);
        return;
      } catch (e) {
        const missing = e && e.details && Array.isArray(e.details.missing)
          ? e.details.missing.map(Number).filter(Number.isInteger)
          : [];
        if (e && e.code === 'upload_incomplete' && missing.length && round < MAX_COMPLETE_ROUNDS) {
          setChunkStatus(view, '补齐缺失分片（第 ' + (round + 1) + ' 轮）…', 'warn');
          for (const idx of missing) {
            if (view.cancelled) return;
            if (view.received.has(idx)) continue;
            await putPartWithRetry(view, idx);
            view.received.add(idx);
          }
          updateChunkBar(view);
          setChunkStatus(view, '合并中…', 'faint');
          continue;
        }
        chunkFail(view, e, false);
        return;
      }
    }
  }

  function missingList(view) {
    var out = [];
    for (var i = 0; i < view.totalChunks; i += 1) {
      if (!view.received.has(i)) out.push(i);
    }
    return out;
  }

  async function putPartWithRetry(view, index) {
    var attempt = 0;
    while (attempt <= CHUNK_MAX_RETRY) {
      if (view.cancelled) throw new R6T5.ApiError('upload_aborted', '已取消上传', 0);
      var blob = chunkPartSlice(view, index);
      try {
        var res = await fetch('/api/uploads/' + encodeURIComponent(view.uploadId) + '/part/' + index, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: blob
        });
        if (!res.ok) {
          var data = null;
          try { data = await res.json(); } catch (_) { data = null; }
          var err = (data && data.error) || {};
          throw new R6T5.ApiError(err.code || 'http_' + res.status, err.message || '分片上传失败（' + res.status + '）', res.status, err.details);
        }
        return await res.json();
      } catch (e) {
        attempt += 1;
        if (view.cancelled) throw e;
        if (attempt > CHUNK_MAX_RETRY) throw e;
        var delay = CHUNK_RETRY_BASE_MS * Math.pow(2, attempt - 1);
        setChunkStatus(view, '第 ' + index + ' 片重试（' + attempt + '/' + CHUNK_MAX_RETRY + '）…', 'warn');
        await sleep(delay);
      }
    }
  }

  function updateChunkBar(view) {
    var done = view.received.size;
    var pct = view.totalChunks ? Math.round(done / view.totalChunks * 100) : 0;
    view.bar.style.width = pct + '%';
    view.bar.parentElement.setAttribute('aria-valuenow', String(pct));
    var bytesDone = Math.min(view.sizeBytes, view.received.size * view.chunkSize);
    view.status.textContent = done + ' / ' + view.totalChunks + ' 片 · ' + pct + '%';
  }

  function setChunkStatus(view, text, cls) {
    view.status.textContent = text;
    view.status.className = cls || 'faint';
  }

  function chunkDone(view, item) {
    view.bar.style.width = '100%';
    view.bar.parentElement.setAttribute('aria-valuenow', '100');
    setChunkStatus(view, '完成', 'ok');
    Files.chunkJobs = Files.chunkJobs.filter(function (j) { return j !== view; });
    if (item && item.path) {
      Files.highlightedPath = item.path;
      setTimeout(function () { Files.highlightedPath = null; }, 4000);
    }
    setTimeout(function () { view.row.remove(); }, 2600);
    loadDir(Files.state.path);
  }

  function chunkFail(view, e, fatal) {
    view.failed = true;
    view.ops.classList.remove('hide');
    var errMsg = archiveErrMsg(e && e.code, e && e.details, e && e.message);
    setChunkStatus(view, '失败', 'danger');
    R6T5.toast(errMsg, 'danger');
    var retryBtn = view.row.querySelector('[data-chunk="retry"]');
    var cancelBtn = view.row.querySelector('[data-chunk="cancel"]');
    retryBtn.onclick = function () {
      view.failed = false;
      view.ops.classList.add('hide');
      setChunkStatus(view, '继续上传…', 'faint');
      runChunkJob(view).catch(function (err) { chunkFail(view, err, false); });
    };
    cancelBtn.onclick = function () { abortChunkJob(view); };
    if (fatal && e && e.code === 'upload_session_expired') {
      view.row.remove();
      Files.chunkJobs = Files.chunkJobs.filter(function (j) { return j !== view; });
    }
  }

  async function abortChunkJob(view) {
    view.cancelled = true;
    if (view.uploadId) {
      try { await guardedDel('/api/uploads/' + encodeURIComponent(view.uploadId)); } catch (_) { /* 会话可能已清理 */ }
    }
    view.row.remove();
    Files.chunkJobs = Files.chunkJobs.filter(function (j) { return j !== view; });
    R6T5.toast('已取消该上传', 'warn');
    refreshResumeBanner();
  }

  /* 取消按钮绑定（事件委托到队列） */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-chunk]');
    if (!btn) return;
    var row = btn.closest('.up-row');
    var view = Files.chunkJobs.find(function (j) { return j.row === row; });
    if (!view) return;
    if (btn.getAttribute('data-chunk') === 'cancel') abortChunkJob(view);
  });

  /* ---------- 未完成会话：续传提示 ---------- */

  async function refreshResumeBanner() {
    var banner = document.getElementById('resume-banner');
    var text = document.getElementById('resume-banner-text');
    var btn = document.getElementById('resume-btn');
    var dismiss = document.getElementById('resume-dismiss');
    var items;
    try {
      var res = await guardedGet('/api/uploads');
      items = res.items || [];
    } catch (_) { items = []; }
    if (!items.length) { banner.classList.add('hide'); return; }
    var cur = items.filter(function (it) { return it.parentPath === Files.state.path; });
    var list = cur.length ? cur : items;
    if (!list.length) { banner.classList.add('hide'); return; }
    banner.classList.remove('hide');
    var total = list.reduce(function (s, it) { return s + (it.receivedCount || 0); }, 0);
    text.textContent = '（' + list.length + ' 个文件，已收 ' + total + ' 片）' +
      (cur.length ? '' : ' 会话不在当前目录，将按原目录继续');
    btn.disabled = strategyReadOnly();
    dismiss.disabled = strategyReadOnly();
  }

  async function resumePendingUploads() {
    var res;
    try { res = await guardedGet('/api/uploads'); }
    catch (e) { R6T5.toastError(e); return; }
    var items = res.items || [];
    if (!items.length) { document.getElementById('resume-banner').classList.add('hide'); return; }
    /* 逐个续传：需要原始 File 对象，浏览器无法重建；这里把会话挂到队列行，
       提示用户重新选择同名文件以补齐缺失分片。 */
    var pending = items[0];
    var input = document.getElementById('file-input');
    var note = '请重新选择「' + pending.name + '」以继续未完成的上传（已收 ' +
      pending.receivedCount + ' / ' + pending.totalChunks + ' 片）';
    R6T5.toast(note, 'info');
    input.setAttribute('data-resume-id', pending.uploadId);
    input.click();
  }

  function dismissResumeBanner() {
    document.getElementById('resume-banner').classList.add('hide');
  }

  /* 续传：用户重新选回同名文件时，按会话 missing 补齐 */
  function wireResumeInput() {
    var input = document.getElementById('file-input');
    input.addEventListener('change', function () {
      var resumeId = input.getAttribute('data-resume-id');
      input.removeAttribute('data-resume-id');
      if (!resumeId || !input.files.length) return;
      var file = input.files[0];
      startChunkUpload(file, { uploadId: resumeId, overwrite: true }).catch(function () {});
      input.value = '';
    });
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- 错误码 → 中文文案（上传 / 打包 / 压缩 / 解压共用） ---------- */

  function archiveErrMsg(code, details, fallback) {
    details = details || {};
    switch (code) {
      case 'strategy_readonly':
        return '当前目录绑定的是只读存储策略，不能写入';
      case 'quota_file':
        return '单文件超过本组上限 ' + R6T5.fmtBytes(details.limitBytes) + '（当前 ' + R6T5.fmtBytes(details.sizeBytes) + '）';
      case 'quota_space':
        return '空间不足，还差 ' + R6T5.fmtBytes(details.needBytes);
      case 'quota_traffic':
        return '7 天上传流量已用尽（已用 ' + R6T5.fmtBytes(details.usedBytes) + ' / 上限 ' + R6T5.fmtBytes(details.limitBytes) + '），周期结束后恢复';
      case 'conflict':
        return '同名文件已存在，未覆盖';
      case 'integration_not_configured':
        return '外部存储尚未配置，请联系管理员';
      case 'storage_not_configured':
        return '站点还没有可用的存储策略，请联系管理员添加';
      case 'zip_slip_blocked':
        return '压缩包内含越界路径（../ 或绝对路径），出于安全已拒绝解压';
      case 'zip_invalid':
        return '压缩包格式无效或已损坏，无法解压';
      case 'zip_too_large':
        return '解压后体积超出上限 ' + R6T5.fmtBytes(details.limitBytes);
      case 'zip_too_many_entries':
        return '压缩包条目数量超出上限（' + (details.entries || '—') + ' 条）';
      case 'upload_incomplete':
        return '分片尚未全部上传完成，请补齐缺失分片后再完成';
      case 'upload_session_expired':
        return '上传会话已过期，请重新选择文件上传';
      case 'upload_session_not_found':
        return '上传会话不存在或已清理，请重新开始';
      case 'upload_part_out_of_range':
        return '分片序号超出范围';
      case 'not_found':
        return '路径不存在或已被移动';
      case 'invalid_input':
        return fallback || '请求参数不正确';
      default:
        return fallback || '操作失败，请稍后重试';
    }
  }

  /* ---------- 批量打包下载 / 在线压缩 / 解压 ---------- */

  function selectedPaths() {
    return selectedItems().map(function (it) { return it.path; });
  }

  /* 批量删除：逐个调用单条删除 API，汇总成功/失败并 toast 后端 message */
  async function batchDeleteSelected() {
    var sel = selectedItems();
    if (!sel.length) return;
    if (strategyReadOnly()) { R6T5.toast(readOnlyTip(), 'warn'); return; }
    if (!confirm('确定删除选中的 ' + sel.length + ' 项？删除后先进入回收站。')) return;
    var ok = 0;
    var fail = 0;
    var failMsgs = [];
    for (var i = 0; i < sel.length; i += 1) {
      var it = sel[i];
      try {
        await guardedDel('/api/files', { path: it.path });
        ok += 1;
        Files.selected.delete(it.path);
      } catch (e) {
        fail += 1;
        failMsgs.push(it.name + '：' + ((e && e.message) || '失败'));
      }
    }
    if (fail === 0) {
      R6T5.toast('已删除 ' + ok + ' 项', 'ok');
    } else {
      R6T5.toast('已删除 ' + ok + ' 项，失败 ' + fail + ' 项' +
        (failMsgs.length ? '（' + failMsgs.slice(0, 3).join('；') + '）' : ''), 'danger');
    }
    loadDir(Files.state.path);
  }

  async function batchZipDownload() {
    var paths = selectedPaths();
    if (!paths.length) return;
    if (strategyReadOnly()) { R6T5.toast(readOnlyTip(), 'warn'); return; }
    var plan;
    try {
      plan = await guardedPost('/api/files/zip/plan', { paths: paths });
    } catch (e) { R6T5.toastError(archiveErrMsg(e && e.code, e && e.details, e && e.message)); return; }
    if (plan.tooLarge) {
      R6T5.toast('打包体积超出上限（共 ' + R6T5.fmtBytes(plan.totalBytes) + '），请分批下载', 'warn');
      return;
    }
    if (plan.entries > 10000) {
      R6T5.toast('打包条目过多（' + plan.entries + ' 条），请分批下载', 'warn');
      return;
    }
    var btn = document.getElementById('batch-zip');
    var oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '打包中…';
    try {
      var res = await fetch('/api/files/zip', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: paths })
      });
      if (!res.ok) {
        var data = null;
        try { data = await res.json(); } catch (_) { data = null; }
        var err = (data && data.error) || {};
        throw new R6T5.ApiError(err.code || 'http_' + res.status, err.message || '打包下载失败（' + res.status + '）', res.status, err.details);
      }
      var blob = await res.blob();
      var fileName = parseZipDownloadName(res.headers.get('content-disposition')) || '打包下载.zip';
      triggerBlobDownload(blob, fileName);
      R6T5.toast('已开始下载 ' + plan.entries + ' 个文件', 'ok');
    } catch (e) {
      R6T5.toast(archiveErrMsg(e && e.code, e && e.details, e && e.message), 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  function parseZipDownloadName(disposition) {
    if (!disposition) return '';
    var m = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (m) { try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; } }
    var plain = disposition.match(/filename="?([^";]+)"?/i);
    return plain ? plain[1] : '';
  }

  function triggerBlobDownload(blob, fileName) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
  }

  /* 在线压缩 */
  var CompressForm = { paths: [] };

  function openCompress() {
    if (strategyReadOnly()) { R6T5.toast(readOnlyTip(), 'warn'); return; }
    CompressForm.paths = selectedPaths();
    if (!CompressForm.paths.length) return;
    var input = document.getElementById('compress-name');
    input.value = '打包.zip';
    document.getElementById('compress-err').textContent = '';
    R6T5.modal.open('#m-compress');
    input.focus();
    input.select();
  }

  async function submitCompress() {
    var input = document.getElementById('compress-name');
    var errBox = document.getElementById('compress-err');
    var name = input.value.trim();
    if (!name) { errBox.textContent = '请输入压缩包名称'; return; }
    var btn = document.getElementById('compress-ok');
    btn.disabled = true;
    errBox.textContent = '';
    try {
      var res = await guardedPost('/api/files/compress', {
        paths: CompressForm.paths,
        targetPath: Files.state.path,
        name: name
      });
      R6T5.modal.close('#m-compress');
      R6T5.toast('已压缩 ' + (res.entries || 0) + ' 个条目为 ' + (res.item && res.item.name), 'ok');
      if (res.item && res.item.path) {
        Files.highlightedPath = res.item.path;
        setTimeout(function () { Files.highlightedPath = null; }, 4000);
      }
      clearSelection();
      loadDir(Files.state.path);
    } catch (e) {
      errBox.textContent = archiveErrMsg(e && e.code, e && e.details, e && e.message);
    } finally {
      btn.disabled = false;
    }
  }

  /* 解压 */
  var ExtractForm = { target: null };

  function openExtract(item) {
    if (strategyReadOnly()) { R6T5.toast(readOnlyTip(), 'warn'); return; }
    ExtractForm.target = item;
    document.getElementById('extract-src-name').textContent = item.name;
    var dirs = Files.state.items.filter(function (x) { return x.type === 'dir'; });
    var sel = document.getElementById('extract-target-dir');
    sel.innerHTML = '<option value="">— 当前目录 —</option>' +
      '<option value="' + R6T5.esc(Files.state.path) + '">当前目录（' + R6T5.esc(R6T5.basename(Files.state.path) || Files.email) + '）</option>' +
      dirs.map(function (d) {
        return '<option value="' + R6T5.esc(d.path) + '">' + R6T5.esc(d.name) + '</option>';
      }).join('');
    document.getElementById('extract-target-path').value = '';
    var result = document.getElementById('extract-result');
    result.classList.add('hide');
    result.innerHTML = '';
    document.getElementById('extract-err').textContent = '';
    R6T5.modal.open('#m-extract');
  }

  async function submitExtract() {
    if (!ExtractForm.target) return;
    var sel = document.getElementById('extract-target-dir');
    var manual = document.getElementById('extract-target-path').value.trim();
    var targetPath = manual || sel.value || Files.state.path;
    var errBox = document.getElementById('extract-err');
    var result = document.getElementById('extract-result');
    var btn = document.getElementById('extract-ok');
    errBox.textContent = '';
    btn.disabled = true;
    try {
      var res = await guardedPost('/api/files/extract', { path: ExtractForm.target.path, targetPath: targetPath });
      renderExtractResult(res);
      loadDir(Files.state.path);
    } catch (e) {
      errBox.textContent = archiveErrMsg(e && e.code, e && e.details, e && e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function renderExtractResult(res) {
    var result = document.getElementById('extract-result');
    result.classList.remove('hide');
    var skipped = (res.skipped || []).slice(0, 5);
    var skipHtml = skipped.length
      ? '<div class="extract-skip mt2"><span class="faint small">已跳过 ' + (res.skipped || []).length + ' 个同名文件：</span>' +
        skipped.map(function (s) { return '<div class="mono-sm trunc">· ' + R6T5.esc(s.name) + (s.reason === 'exists' ? '（已存在）' : '') + '</div>'; }).join('') +
        '</div>'
      : '';
    result.innerHTML =
      '<div class="note ok"><span class="ico">✓</span><div>解压完成：新增 ' + (res.extracted || 0) +
      ' 个文件' + ((res.skipped || []).length ? '，跳过 ' + res.skipped.length + ' 个' : '') +
      '，共 ' + R6T5.fmtBytes(res.totalBytes) + '</div></div>' + skipHtml;
  }

  function bindArchiveModals() {
    R6T5.modal.bind('#m-compress');
    R6T5.modal.bind('#m-extract');
    document.getElementById('compress-cancel').addEventListener('click', function () { R6T5.modal.close('#m-compress'); });
    document.getElementById('compress-ok').addEventListener('click', submitCompress);
    document.getElementById('extract-cancel').addEventListener('click', function () { R6T5.modal.close('#m-extract'); });
    document.getElementById('extract-ok').addEventListener('click', submitExtract);
  }

  /* ---------- 弹窗：新建文件夹 / 重命名 / 移动 / 删除 ---------- */

  function bindFileModals() {
    R6T5.modal.bind('#m-mkdir');
    R6T5.modal.bind('#m-rename');
    R6T5.modal.bind('#m-move');
    R6T5.modal.bind('#m-delete');

    document.getElementById('mkdir-cancel').addEventListener('click', function () { R6T5.modal.close('#m-mkdir'); });
    document.getElementById('mkdir-ok').addEventListener('click', submitMkdir);

    document.getElementById('rename-cancel').addEventListener('click', function () { R6T5.modal.close('#m-rename'); });
    document.getElementById('rename-ok').addEventListener('click', submitRename);

    document.getElementById('move-cancel').addEventListener('click', function () { R6T5.modal.close('#m-move'); });
    document.getElementById('move-ok').addEventListener('click', submitMove);

    document.getElementById('delete-cancel').addEventListener('click', function () { R6T5.modal.close('#m-delete'); });
    document.getElementById('delete-ok').addEventListener('click', submitDelete);

    /* 分享弹窗 */
    R6T5.modal.bind('#m-share');
    document.getElementById('share-cancel').addEventListener('click', function () { R6T5.modal.close('#m-share'); });
    document.getElementById('share-ok').addEventListener('click', submitShare);
    document.getElementById('share-expires').addEventListener('change', toggleCustomExpires);
    document.getElementById('share-code-gen').addEventListener('click', genRandomCode);
  }

  function openMkdir() {
    var input = document.getElementById('mkdir-name');
    input.value = '';
    R6T5.modal.open('#m-mkdir');
    input.focus();
  }

  async function submitMkdir() {
    var input = document.getElementById('mkdir-name');
    var name = input.value.trim();
    if (!name) { R6T5.toast('请输入文件夹名称', 'warn'); return; }
    try {
      await guardedPost('/api/files/folder', { path: Files.state.path, name: name });
      R6T5.modal.close('#m-mkdir');
      R6T5.toast('已创建文件夹', 'ok');
      loadDir(Files.state.path);
    } catch (e) { R6T5.toastError(e); }
  }

  var renameTarget = null;
  function openRename(item) {
    renameTarget = item;
    var input = document.getElementById('rename-name');
    input.value = item.name;
    document.getElementById('rename-title').textContent = '重命名 · ' + item.name;
    R6T5.modal.open('#m-rename');
    input.focus();
    input.select();
  }

  async function submitRename() {
    if (!renameTarget) return;
    var input = document.getElementById('rename-name');
    var newName = input.value.trim();
    if (!newName) { R6T5.toast('请输入新名称', 'warn'); return; }
    try {
      await guardedPost('/api/files/rename', { path: renameTarget.path, newName: newName });
      R6T5.modal.close('#m-rename');
      R6T5.toast('已重命名', 'ok');
      loadDir(Files.state.path);
    } catch (e) { R6T5.toastError(e); }
  }

  var moveTarget = null;
  function openMove(item) {
    moveTarget = item;
    var dirs = Files.state.items.filter(function (x) { return x.type === 'dir'; });
    var sel = document.getElementById('move-target-dir');
    sel.innerHTML = '<option value="">— 选择当前目录下的文件夹 —</option>' +
      '<option value="' + R6T5.esc(Files.email) + '">根目录（' + R6T5.esc(Files.email) + '）</option>' +
      dirs.map(function (d) {
        return '<option value="' + R6T5.esc(d.path) + '">' + R6T5.esc(d.name) + '</option>';
      }).join('');
    document.getElementById('move-target-path').value = '';
    document.getElementById('move-title').textContent = '移动 · ' + item.name;
    R6T5.modal.open('#m-move');
  }

  async function submitMove() {
    if (!moveTarget) return;
    var sel = document.getElementById('move-target-dir');
    var manual = document.getElementById('move-target-path').value.trim();
    var targetPath = manual || sel.value;
    if (!targetPath) { R6T5.toast('请选择或填写目标目录', 'warn'); return; }
    try {
      await guardedPost('/api/files/move', { path: moveTarget.path, targetPath: targetPath });
      R6T5.modal.close('#m-move');
      R6T5.toast('已移动', 'ok');
      loadDir(Files.state.path);
    } catch (e) { R6T5.toastError(e); }
  }

  var deleteTarget = null;
  function openDelete(item) {
    deleteTarget = item;
    document.getElementById('delete-name').textContent = item.name;
    R6T5.modal.open('#m-delete');
  }

  async function submitDelete() {
    if (!deleteTarget) return;
    try {
      await guardedDel('/api/files', { path: deleteTarget.path });
      R6T5.modal.close('#m-delete');
      R6T5.toast('已移入回收站', 'ok');
      loadDir(Files.state.path);
    } catch (e) { R6T5.toastError(e); }
  }

  /* ---------- 回收站抽屉 ---------- */

  function bindTrashDrawer() {
    var nav = document.getElementById('nav-trash');
    var mask = document.getElementById('trash-mask');
    var drawer = document.getElementById('trash-drawer');
    var close = document.getElementById('trash-close');

    function open() {
      mask.classList.add('open');
      drawer.classList.add('open');
      loadTrash();
    }
    function closeDrawer() {
      mask.classList.remove('open');
      drawer.classList.remove('open');
    }
    nav.addEventListener('click', function (e) { e.preventDefault(); open(); });
    close.addEventListener('click', closeDrawer);
    mask.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  async function loadTrash() {
    var body = document.getElementById('trash-list');
    body.innerHTML = '<div class="skel" style="height:14px"></div>';
    var res;
    try { res = await guardedGet('/api/trash'); }
    catch (e) { R6T5.toastError(e); body.innerHTML = ''; return; }
    var items = res.items || [];
    if (!items.length) {
      body.innerHTML = '<div class="empty"><div class="ico">♻</div><h3>回收站是空的</h3><p>删除的文件会先放到这里，保留 ' + (res.retentionDays || 30) + ' 天。</p></div>';
      return;
    }
    body.innerHTML = items.map(function (it) {
      return '<div class="trash-item" data-path="' + R6T5.esc(it.path) + '">' +
        '<div class="ti-name"><div class="fname">' + R6T5.esc(it.name) + '</div>' +
        '<div class="ti-meta">' + R6T5.fmtBytes(it.sizeBytes) + ' · 删除于 ' + R6T5.fmtAgo(it.deletedAt) +
        (it.expiresAt ? ' · 过期 ' + R6T5.fmtTime(it.expiresAt) : '') + '</div></div>' +
        '<button class="btn sm" data-op="restore">恢复</button>' +
        '<button class="btn sm danger" data-op="purge">彻底删除</button></div>';
    }).join('');
    body.querySelectorAll('.trash-item').forEach(function (row) {
      var path = row.getAttribute('data-path');
      row.querySelector('[data-op=restore]').addEventListener('click', function () { restoreTrash(path); });
      row.querySelector('[data-op=purge]').addEventListener('click', function () { purgeTrash(path); });
    });
  }

  async function restoreTrash(path) {
    try {
      await guardedPost('/api/trash/restore', { path: path });
      R6T5.toast('已恢复', 'ok');
      loadTrash();
      loadDir(Files.state.path);
    } catch (e) { R6T5.toastError(e); }
  }

  async function purgeTrash(path) {
    if (!confirm('彻底删除后不可恢复，确定删除该项目吗？')) return;
    try {
      await guardedDelBody('/api/trash', { path: path });
      R6T5.toast('已彻底删除', 'ok');
      loadTrash();
      loadDir(Files.state.path);
    } catch (e) { R6T5.toastError(e); }
  }

  /* ---------- 配额面板 ---------- */

  function renderQuota() {
    var q = Files.quota;
    var panel = document.getElementById('quota-panel');
    if (!q || !panel) return;
    var spacePct = q.spaceLimitBytes ? Math.min(100, q.usedBytes / q.spaceLimitBytes * 100) : 0;
    var trafficPct = q.traffic7dLimitBytes ? Math.min(100, q.traffic7dUsedBytes / q.traffic7dLimitBytes * 100) : 0;
    var spaceCls = spacePct >= 90 ? 'danger' : spacePct >= 70 ? 'warn' : '';
    var trafficCls = trafficPct >= 90 ? 'danger' : trafficPct >= 70 ? 'warn' : '';
    panel.innerHTML =
      '<div class="quota-grid">' +
      '<div class="quota-block"><div class="q-head"><span>空间使用</span><span class="v">' +
        R6T5.fmtBytes(q.usedBytes) + ' / ' + R6T5.fmtBytes(q.spaceLimitBytes) + '</span></div>' +
      '<div class="bar ' + spaceCls + '"><i style="width:' + spacePct.toFixed(1) + '%"></i></div>' +
      '<div class="q-sub">剩余 ' + R6T5.fmtBytes(q.spaceRemainingBytes) + '</div></div>' +
      '<div class="quota-block"><div class="q-head"><span>7 天上传流量</span><span class="v">' +
        R6T5.fmtBytes(q.traffic7dUsedBytes) + ' / ' + R6T5.fmtBytes(q.traffic7dLimitBytes) + '</span></div>' +
      '<div class="bar ' + trafficCls + '"><i style="width:' + trafficPct.toFixed(1) + '%"></i></div>' +
      '<div class="q-sub">剩余 ' + R6T5.fmtBytes(q.traffic7dRemainingBytes) + '</div></div>' +
      '</div>';
  }

  /* ================= 账户页 ================= */

  async function initAccount() {
    bindLogout();
    var data;
    try { data = await guardedGet('/api/account'); }
    catch (e) { if (e.status === 401) redirectLogin(); throw e; }
    var q = data.quota || {};
    document.getElementById('acct-email').textContent = data.user.email;
    document.getElementById('acct-group').textContent = data.user.groupName || '—';

    var spacePct = q.spaceLimitBytes ? Math.min(100, q.usedBytes / q.spaceLimitBytes * 100) : 0;
    var trafficPct = q.traffic7dLimitBytes ? Math.min(100, q.traffic7dUsedBytes / q.traffic7dLimitBytes * 100) : 0;
    var spaceCls = spacePct >= 90 ? 'danger' : spacePct >= 70 ? 'warn' : '';
    var trafficCls = trafficPct >= 90 ? 'danger' : trafficPct >= 70 ? 'warn' : '';

    document.getElementById('stat-used').innerHTML = R6T5.fmtBytes(q.usedBytes) + '<small> / ' + R6T5.fmtBytes(q.spaceLimitBytes) + '</small>';
    document.getElementById('stat-used-bar').className = 'bar ' + spaceCls;
    document.getElementById('stat-used-bar').querySelector('i').style.width = spacePct.toFixed(1) + '%';
    document.getElementById('stat-used-sub').textContent = '剩余 ' + R6T5.fmtBytes(q.spaceRemainingBytes);

    document.getElementById('stat-maxfile').textContent = R6T5.fmtBytes(q.maxFileSizeBytes);

    document.getElementById('stat-traffic-used').textContent = R6T5.fmtBytes(q.traffic7dUsedBytes);
    document.getElementById('stat-traffic-limit').textContent = R6T5.fmtBytes(q.traffic7dLimitBytes);
    document.getElementById('stat-traffic-remain').textContent = R6T5.fmtBytes(q.traffic7dRemainingBytes);
    document.getElementById('stat-traffic-bar').className = 'bar ' + trafficCls;
    document.getElementById('stat-traffic-bar').querySelector('i').style.width = trafficPct.toFixed(1) + '%';

    renderByType(data.byType || {});
    renderRecent(data.recentUploads || []);
  }

  function renderByType(bt) {
    var total = (bt.image || 0) + (bt.document || 0) + (bt.other || 0);
    var rows = [
      { label: '图片', bytes: bt.image || 0 },
      { label: '文档', bytes: bt.document || 0 },
      { label: '其他', bytes: bt.other || 0 }
    ];
    var box = document.getElementById('bytype-list');
    box.innerHTML = rows.map(function (r) {
      var pct = total > 0 ? (r.bytes / total * 100) : 0;
      return '<div class="bytype-row"><span class="bt-label">' + r.label + '</span>' +
        '<div class="bar thin"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<span class="bt-val">' + R6T5.fmtBytes(r.bytes) + ' · ' + pct.toFixed(0) + '%</span></div>';
    }).join('');
  }

  function renderRecent(list) {
    var box = document.getElementById('recent-list');
    if (!list.length) {
      box.innerHTML = '<div class="empty"><div class="ico">▢</div><h3>最近还没有上传</h3></div>';
      return;
    }
    box.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>文件</th><th class="num">大小</th><th>上传时间</th></tr></thead><tbody>' +
      list.map(function (it) {
        var name = R6T5.basename(it.path);
        return '<tr><td><div class="name"><span class="fic">▤</span><span class="fname">' + R6T5.esc(name) + '</span></div></td>' +
          '<td class="num">' + R6T5.fmtBytes(it.sizeBytes) + '</td><td>' + R6T5.fmtAgo(it.at) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ================= 公开分享页（/share/:token 与 /s/:token） ================= */

  var PublicShare = { token: '', meta: null };

  function shareErrView(e) {
    var title, msg;
    switch (e && e.code) {
      case 'share_not_found': title = '链接不存在'; msg = '分享链接不存在或已被删除，请确认链接是否完整。'; break;
      case 'share_expired': title = '链接已过期'; msg = '该分享已超过有效期，无法继续访问。'; break;
      case 'share_revoked': title = '链接已撤销'; msg = '分享者已撤销该链接，无法继续访问。'; break;
      case 'share_exceeded': title = '下载次数已用完'; msg = '该分享的下载次数已用完，无法继续访问。'; break;
      case 'forbidden': title = '无权限'; msg = (e && e.message) || '无权访问该分享内容。'; break;
      case 'storage_not_configured': title = '暂不可用'; msg = '站点还没有可用的存储策略，请稍后再试。'; break;
      default: title = '访问失败'; msg = (e && e.message) || '请稍后重试。';
    }
    return '<div class="note danger share-error"><span class="ico">⚠</span><div>' +
      '<b>' + R6T5.esc(title) + '</b><p class="mt1 mb0">' + R6T5.esc(msg) + '</p></div></div>';
  }

  function expiryText(share) {
    return share.expiresAt ? '有效期至 ' + R6T5.fmtTime(share.expiresAt) : '永久有效';
  }

  function remainingText(share) {
    return share.remaining == null ? '不限下载次数' : '剩余 ' + share.remaining + ' 次下载';
  }

  function shareDownloadUrl(path) {
    var q = path ? R6T5.qs({ path: path }) : '';
    return '/api/share/' + encodeURIComponent(PublicShare.token) + '/download' + (q ? '?' + q : '');
  }

  function sharePreviewUrl(path) {
    return '/api/share/' + encodeURIComponent(PublicShare.token) + '/preview' +
      (path ? '?' + R6T5.qs({ path: path }) : '');
  }

  async function initShare() {
    var m = location.pathname.match(/^\/(?:share|s)\/([^/?#]+)/);
    PublicShare.token = m ? decodeURIComponent(m[1]) : '';
    Preview.ensure();
    await loadPublicShare();
  }

  async function loadPublicShare() {
    var body = document.getElementById('share-body');
    if (!PublicShare.token) {
      body.innerHTML = shareErrView({ code: 'share_not_found', message: '分享链接无效，缺少标识。' });
      return;
    }
    var data;
    try {
      data = await R6T5.get('/api/share/' + encodeURIComponent(PublicShare.token));
    } catch (e) {
      body.innerHTML = shareErrView(e);
      return;
    }
    PublicShare.meta = data.share;
    if (data.locked) renderShareLocked(data.share);
    else renderShareReady(data.share);
  }

  function renderShareLocked(share) {
    var body = document.getElementById('share-body');
    body.innerHTML =
      '<p class="login-sub">该链接受提取码保护，请输入提取码后访问。</p>' +
      '<form id="share-unlock-form" class="stack">' +
      '<div class="field"><label for="share-code-input">提取码</label>' +
      '<input class="input" id="share-code-input" type="text" maxlength="16" autocomplete="off" placeholder="请输入提取码">' +
      '<div class="login-err" id="share-unlock-err"></div></div>' +
      '<button class="btn primary block" id="share-unlock-btn" type="submit">访问分享</button>' +
      '</form>';
    var form = document.getElementById('share-unlock-form');
    var errBox = document.getElementById('share-unlock-err');
    var btn = document.getElementById('share-unlock-btn');
    document.getElementById('share-code-input').focus();
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      errBox.textContent = '';
      btn.disabled = true;
      btn.textContent = '校验中…';
      var code = document.getElementById('share-code-input').value.trim();
      try {
        await R6T5.post('/api/share/' + encodeURIComponent(PublicShare.token) + '/unlock', { code: code });
        await loadPublicShare();
      } catch (err) {
        var msg;
        switch (err && err.code) {
          case 'share_code_invalid': msg = '提取码不正确'; break;
          case 'forbidden': msg = err.message || '提取码错误次数过多，请 15 分钟后再试'; break;
          default: msg = (err && err.message) || '校验失败，请稍后重试';
        }
        errBox.textContent = msg;
        btn.disabled = false;
        btn.textContent = '访问分享';
      }
    });
  }

  function renderShareReady(share) {
    var body = document.getElementById('share-body');
    var wrap = document.getElementById('share-wrap');
    wrap.classList.toggle('wide', share.isDir);

    var badgeType = share.isDir
      ? '<span class="badge acc">文件夹</span>'
      : '<span class="badge info">文件</span>';
    var previewBadge = share.allowPreview ? '<span class="badge ok">可在线预览</span>' : '<span class="badge">不可预览</span>';

    var head =
      '<h1 class="share-title">' + R6T5.esc(share.name) + '</h1>' +
      '<div class="share-badges">' + badgeType + previewBadge + '</div>' +
      '<div class="share-meta">' +
      '<span>' + R6T5.esc(remainingText(share)) + '</span><span>·</span>' +
      '<span>' + R6T5.esc(expiryText(share)) + '</span></div>';

    if (share.isDir) {
      body.innerHTML = head +
        '<nav class="crumbs" id="share-crumbs" aria-label="目录"></nav>' +
        '<div id="share-dir-list" class="stack"></div>';
      loadShareDir('');
    } else {
      var previewBtn = share.allowPreview
        ? '<button class="btn" id="share-preview-btn" type="button">◈ 预览</button>' : '';
      body.innerHTML = head +
        '<div class="share-actions">' +
        '<a class="btn primary" id="share-download-btn" href="' + shareDownloadUrl('') + '">↓ 下载</a>' +
        previewBtn + '</div>';
      var pv = document.getElementById('share-preview-btn');
      if (pv) pv.addEventListener('click', function () {
        Preview.open({
          title: share.name,
          url: sharePreviewUrl(''),
          kind: kindByName(share.name),
          name: share.name
        });
      });
    }
  }

  async function loadShareDir(path) {
    var listBox = document.getElementById('share-dir-list');
    var crumbsBox = document.getElementById('share-crumbs');
    listBox.innerHTML = '<div class="skel" style="height:14px"></div>';
    var res;
    try {
      res = await R6T5.get('/api/share/' + encodeURIComponent(PublicShare.token) + '/list', { path: path || '' });
    } catch (e) {
      listBox.innerHTML = '<div class="note danger"><span class="ico">⚠</span><div>' +
        R6T5.esc((e && e.message) || '目录读取失败') + '</div></div>';
      return;
    }
    renderShareCrumbs(res.crumbs || []);
    var items = res.items || [];
    if (!items.length) {
      listBox.innerHTML = '<div class="empty"><div class="ico">▢</div><h3>文件夹是空的</h3></div>';
      return;
    }
    listBox.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>名称</th><th class="num">大小</th><th>修改时间</th><th></th></tr></thead><tbody>' +
      items.map(function (it) {
        var size = it.type === 'dir' ? '—' : (it.sizeBytes == null ? '—' : R6T5.fmtBytes(it.sizeBytes));
        var ops = '';
        if (it.type === 'file') {
          ops += '<a class="btn sm ghost" href="' + shareDownloadUrl(it.path) + '" title="下载">↓</a>';
          if (PublicShare.meta.allowPreview) {
            ops += '<button class="btn sm ghost" data-op="preview" title="预览">◈</button>';
          }
        }
        return '<tr class="file-row" data-path="' + R6T5.esc(it.path) + '" data-type="' + it.type + '">' +
          '<td><div class="name"><span class="fic">' + R6T5.esc(iconFor(it)) + '</span>' +
          '<span class="fname" title="' + R6T5.esc(it.name) + '">' + R6T5.esc(it.name) + '</span></div></td>' +
          '<td class="num meta">' + size + '</td>' +
          '<td class="when">' + R6T5.fmtAgo(it.updatedAt) + '</td>' +
          '<td><div class="ops">' + ops + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';

    listBox.querySelectorAll('tr.file-row').forEach(function (row) {
      var p = row.getAttribute('data-path');
      var type = row.getAttribute('data-type');
      row.querySelector('.name').addEventListener('click', function () {
        if (type === 'dir') loadShareDir(p);
      });
      var pv = row.querySelector('[data-op="preview"]');
      if (pv) pv.addEventListener('click', function (e) {
        e.stopPropagation();
        var it = items.find(function (x) { return x.path === p; });
        Preview.open({ title: it.name, url: sharePreviewUrl(p), kind: kindByName(it.name), name: it.name });
      });
    });
  }

  function renderShareCrumbs(crumbs) {
    var box = document.getElementById('share-crumbs');
    box.innerHTML = '';
    crumbs.forEach(function (c, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '/';
        box.appendChild(sep);
      }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'crumb' + (i === crumbs.length - 1 ? ' current' : '');
      b.textContent = c.label;
      if (i < crumbs.length - 1) b.addEventListener('click', function () { loadShareDir(c.path); });
      box.appendChild(b);
    });
  }

  /* ================= 启动 ================= */

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-page');
    if (page === 'login') initLogin();
    else if (page === 'files') initFiles();
    else if (page === 'account') initAccount();
    else if (page === 'share') initShare();
  });

  global.App = { Files: Files, R6T5: R6T5,
    selectPaths: function (paths) {
      Files.selected = new Set(paths);
      renderItems();
    },
    clearSelection: clearSelection
  };
})(window);
