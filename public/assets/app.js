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
    noteBody.textContent = s.hint || (ready ? '配置完成，可以使用邮箱登录' : '站点尚未配置完成');
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
      if (status.next === 'supabase' && status.link) {
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
          case 'invalid_credentials': msg = '邮箱或密码不正确'; break;
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
    }
  };

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
    bindTrashDrawer();
  }

  /* ---------- 目录加载 ---------- */

  async function loadDir(path) {
    Files.state.path = path || Files.email;
    Files.state.searching = false;
    Files.state.q = '';
    var searchInput = document.getElementById('search-input');
    searchInput.value = '';
    document.getElementById('search-clear').classList.add('hide');
    var res = await guardedGet('/api/files', { path: Files.state.path });
    Files.state.crumbs = res.crumbs || [];
    Files.state.items = res.items || [];
    Files.state.strategy = res.strategy || null;
    if (res.quota) { Files.quota = res.quota; renderQuota(); }
    renderCrumbs();
    renderStrategyBadge();
    applyReadOnly();
    renderItems();
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
      return;
    }
    var q = Files.state.searching ? Files.state.q : '';
    if (Files.state.view === 'grid') {
      area.className = 'file-grid';
      area.innerHTML = items.map(function (it) {
        var nameHtml = hlName(it.name, q);
        var meta = it.type === 'dir'
          ? (it.itemCount != null ? it.itemCount + ' 项' : '文件夹')
          : (it.sizeBytes == null ? '—' : R6T5.fmtBytes(it.sizeBytes));
        var remote = it.remote ? '<span class="badge acc">云端</span>' : '';
        return '<div class="file-card" data-path="' + R6T5.esc(it.path) + '" data-type="' + it.type + '">' +
          '<div class="fic">' + iconFor(it) + '</div>' +
          '<div class="fname" title="' + R6T5.esc(it.name) + '">' + nameHtml + remote + '</div>' +
          '<div class="meta"><span>' + meta + '</span><span>' + R6T5.fmtAgo(it.updatedAt) + '</span></div>' +
          '<div class="ops">' + opsHtml(it) + '</div></div>';
      }).join('');
    } else {
      area.className = 'file-list';
      area.innerHTML =
        '<div class="table-wrap"><table class="table"><thead><tr>' +
        '<th>名称</th><th class="num">大小</th><th>修改时间</th><th></th></tr></thead><tbody>' +
        items.map(function (it) {
          var nameHtml = hlName(it.name, q);
          var size = it.type === 'dir' ? '—' : (it.sizeBytes == null ? '—' : R6T5.fmtBytes(it.sizeBytes));
          var remote = it.remote ? '<span class="badge acc">云端</span>' : '';
          return '<tr class="file-row" data-path="' + R6T5.esc(it.path) + '" data-type="' + it.type + '">' +
            '<td><div class="name"><span class="fic">' + iconFor(it) + '</span>' +
            '<span class="fname" title="' + R6T5.esc(it.name) + '">' + nameHtml + '</span>' + remote + '</div></td>' +
            '<td class="num meta">' + size + '</td>' +
            '<td class="when">' + R6T5.fmtAgo(it.updatedAt) + '</td>' +
            '<td><div class="ops">' + opsHtml(it) + '</div></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    bindItemEvents(area);
  }

  function opsHtml(it) {
    var ops = '';
    if (it.type === 'file') {
      ops += '<button class="btn sm ghost" data-op="download" title="下载">↓</button>';
    }
    var ro = strategyReadOnly();
    var dis = ro ? ' disabled title="' + R6T5.esc(readOnlyTip()) + '"' : '';
    ops += '<button class="btn sm ghost" data-op="rename" title="重命名"' + dis + '>✎</button>' +
      '<button class="btn sm ghost" data-op="move" title="移动"' + dis + '>➦</button>' +
      '<button class="btn sm ghost danger" data-op="delete" title="删除"' + dis + '>✕</button>';
    return ops;
  }

  function bindItemEvents(area) {
    area.querySelectorAll('[data-path]').forEach(function (row) {
      var path = row.getAttribute('data-path');
      var type = row.getAttribute('data-type');
      row.querySelectorAll('[data-op]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var op = btn.getAttribute('data-op');
          var item = Files.state.items.find(function (x) { return x.path === path; });
          if (!item) return;
          if (op === 'download') downloadItem(item);
          else if (op === 'rename') openRename(item);
          else if (op === 'move') openMove(item);
          else if (op === 'delete') openDelete(item);
        });
      });
      row.querySelector('.name, .fname, .file-card') && row.addEventListener('click', function (e) {
        if (e.target.closest('[data-op]')) return;
        if (type === 'dir') loadDir(path);
        else {
          var item = Files.state.items.find(function (x) { return x.path === path; });
          if (item) downloadItem(item);
        }
      });
    });
  }

  function downloadItem(item) {
    location.href = '/api/files/download?' + R6T5.qs({ path: item.path, inline: 0 });
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

  /* ---------- 上传（XHR 拿进度） ---------- */

  function uploadFiles(fileList) {
    if (strategyReadOnly()) {
      R6T5.toast(readOnlyTip(), 'warn');
      return;
    }
    var files = Array.prototype.slice.call(fileList);
    if (!files.length) return;
    files.forEach(uploadOne);
  }

  function uploadOne(file) {
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
        R6T5.toast(uploadErrMsg(err.code, err.details, err.message), 'danger');
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

  function uploadErrMsg(code, details, fallback) {
    details = details || {};
    switch (code) {
      case 'quota_file':
        return '单文件超过本组上限 ' + R6T5.fmtBytes(details.limitBytes) + '（当前文件 ' + R6T5.fmtBytes(details.sizeBytes) + '）';
      case 'quota_space':
        return '空间不足，还差 ' + R6T5.fmtBytes(details.needBytes);
      case 'quota_traffic':
        return '7 天上传流量已用尽（已用 ' + R6T5.fmtBytes(details.usedBytes) + ' / 上限 ' + R6T5.fmtBytes(details.limitBytes) + '），周期结束后恢复';
      default:
        return fallback || '上传失败';
    }
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

  /* ================= 分享占位页 ================= */

  async function initShare() {
    var m = location.pathname.match(/^\/share\/(.+)$/);
    var token = m ? decodeURIComponent(m[1]) : '';
    var available = false;
    var hit = false;
    if (token) {
      try {
        var data = await R6T5.get('/api/share/' + encodeURIComponent(token));
        hit = true;
        available = !!(data && data.available);
      } catch (e) {
        /* 501 / available:false 均按 P2 占位处理，不造假数据 */
        available = false;
      }
    }
    var wrap = document.getElementById('share-body');
    if (available && hit) {
      wrap.innerHTML = '<div class="note info"><span class="ico">i</span><div>分享已存在（P2 开放后在此展示文件列表与下载）。</div></div>';
      return;
    }
    wrap.innerHTML =
      '<div class="note warn"><span class="ico">!</span><div class="note-body"><b>分享能力将在 P2 开放</b>，当前为骨架占位，不提供真实下载。</div></div>' +
      '<div class="share-feats">' +
      '<div class="feat"><span class="ic">◷</span><span>有效期：可设置链接过期时间，到期自动失效</span></div>' +
      '<div class="feat"><span class="ic">🔒</span><span>提取码：访问分享时需输入提取码</span></div>' +
      '<div class="feat"><span class="ic">↧</span><span>下载次数：可限制最大下载次数</span></div>' +
      '<div class="feat"><span class="ic">▣</span><span>文件夹分享：整个目录只读分享给他人</span></div>' +
      '</div>' +
      '<div class="field"><label>提取码</label>' +
      '<input class="input" type="text" placeholder="P2 开放后可用" disabled>' +
      '<span class="help">当前版本提取码校验尚未启用。</span></div>' +
      '<button class="btn block" type="button" disabled>访问分享</button>';
  }

  /* ================= 启动 ================= */

  document.addEventListener('DOMContentLoaded', function () {
    var page = document.body.getAttribute('data-page');
    if (page === 'login') initLogin();
    else if (page === 'files') initFiles();
    else if (page === 'account') initAccount();
    else if (page === 'share') initShare();
  });

  global.App = { Files: Files, R6T5: R6T5 };
})(window);
