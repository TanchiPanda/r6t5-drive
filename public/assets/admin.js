/* R6T5 Drive · 管理端全部交互（单文件，无第三方库）
   依赖公共库 /assets/api.js（R6T5）。所有请求走 cookie 会话；401 统一跳登录页。 */
(function (global) {
  'use strict';

  const R6T5 = global.R6T5;
  if (!R6T5) throw new Error('R6T5 公共库未加载');

  const Admin = {
    /* 审计动作枚举 → 中文（与契约 §8 保持一致） */
    actionMap: {
      login: '登录', logout: '登出', upload: '上传', download: '下载', delete: '删除',
      restore: '恢复', rename: '重命名', move: '移动', mkdir: '新建目录',
      admin_login: '管理员登录', settings_update: '更新设置', group_create: '创建用户组',
      storage_create: '创建存储策略', user_disable: '禁用用户', share_create: '创建分享'
    },
    actionLabel(a) { return Admin.actionMap[a] || a || '—'; },

    /* ---------- 受守卫的请求：401 → 跳登录页 ---------- */
    async _guard(fn, ...args) {
      try { return await fn(...args); }
      catch (e) {
        if (e && e.status === 401) { global.location.href = '/admin/login.html'; }
        throw e;
      }
    },
    get(p, q) { return Admin._guard(R6T5.get, p, q); },
    post(p, b) { return Admin._guard(R6T5.post, p, b); },
    patch(p, b) { return Admin._guard(R6T5.patch, p, b); },
    del(p, q) { return Admin._guard(R6T5.del, p, q); },

    /* ---------- 小工具 ---------- */
    esc: s => R6T5.esc(s),
    bytes: n => R6T5.fmtBytes(n),
    time: t => R6T5.fmtTime(t),
    ago: t => R6T5.fmtAgo(t),
    $: sel => document.querySelector(sel),
    $$: sel => Array.from(document.querySelectorAll(sel)),

    /* 把“数值 + 单位”换算成字节；unit ∈ GB/MB */
    toBytes(value, unit) {
      const v = Number(value);
      if (!isFinite(v) || v <= 0) return null;
      const mb = 1024 * 1024, gb = 1024 * mb;
      return Math.round(v * (unit === 'GB' ? gb : mb));
    },
    /* 字节拆成数值 + 单位（供弹窗回显） */
    fromBytes(bytes) {
      const mb = 1024 * 1024, gb = 1024 * mb;
      if (bytes >= gb && bytes % gb === 0) return { value: bytes / gb, unit: 'GB' };
      return { value: Math.round((bytes / mb) * 10) / 10, unit: 'MB' };
    },

    cssVar(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    },

    /* 页面内提示条：danger 展示后端 message；不能静默失败 */
    alert(el, e, fallback) {
      if (!el) return;
      const msg = (e && e.message) || fallback || '操作失败，请稍后重试';
      el.classList.remove('hide');
      el.innerHTML = '<div class="note danger"><span class="ico">⚠</span><div>' + R6T5.esc(msg) + '</div></div>';
    },
    clearAlert(el) { if (el) { el.classList.add('hide'); el.innerHTML = ''; } },

    /* ---------- 会话守卫 + 顶栏身份 / 退出 ---------- */
    async requireAdmin() {
      let session = null;
      try { session = await R6T5.get('/api/admin/session'); }
      catch (e) {
        if (e && e.status === 401) { global.location.href = '/admin/login.html'; return null; }
        throw e;
      }
      Admin.renderIdentity(session && session.admin);
      return session && session.admin;
    },

    renderIdentity(admin) {
      const chip = Admin.$('#admin-chip');
      const id = Admin.$('#admin-identity');
      if (!admin) {
        if (chip) chip.innerHTML = '<span class="faint">未登录</span>';
        if (id) id.textContent = '未登录';
        return;
      }
      const src = admin.passwordSource === 'env' ? '环境变量' : '首次启动生成';
      const txt = '管理员 · ' + src;
      if (chip) chip.innerHTML = '<span class="dot-s"></span>' + R6T5.esc(txt);
      if (id) id.textContent = txt;
    },

    bindLogout() {
      const btn = Admin.$('#logout-btn');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        try { await R6T5.post('/api/admin/logout', {}); } catch (_) { /* 忽略，直接跳走 */ }
        global.location.href = '/admin/login.html';
      });
    },

    /* 退出时把后端 message 原样提示（409 冲突等） */
    toastErr(e) { R6T5.toastError(e); },

    /* ---------- 初始化状态提示条（home 页） ---------- */
    async loadSetupNote() {
      const box = Admin.$('#setup-note');
      if (!box) return;
      try {
        const st = await Admin.get('/api/admin/setup/status');
        if (!st || st.next === 'ready') {
          box.innerHTML = '<div class="note ok"><span class="ico">✓</span><div><b>初始化已完成</b>，站点可以使用邮箱登录。</div></div>';
          return;
        }
        const link = st.link ? '<a class="btn sm" href="' + R6T5.esc(st.link) + '">' + R6T5.esc(st.linkLabel || '前往') + '</a>' : '';
        box.innerHTML = '<div class="note warn"><span class="ico">!</span><div class="flex1"><b>待完成初始化</b><p class="mt1 mb0">' +
          R6T5.esc(st.hint || '还有初始化项未完成') + '</p></div>' + link + '</div>';
      } catch (e) {
        Admin.alert(box, e, '初始化状态读取失败');
      }
    }
  };

  /* =====================================================================
     各页面初始化
     ===================================================================== */

  /* ---------- 概览 home ---------- */
  async function initHome() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    await Admin.loadSetupNote();

    const alertBox = Admin.$('#page-alert');
    let overview;
    try { overview = await Admin.get('/api/admin/overview'); }
    catch (e) { Admin.alert(alertBox, e); return; }

    const o = overview || {};
    const stats = [
      { k: '用户总数', v: (o.users && o.users.total) ?? '—', d: '已禁用 ' + ((o.users && o.users.disabled) ?? 0) + ' 人' },
      { k: '近 7 日活跃', v: (o.users && o.users.active7d) ?? '—', d: '近 7 天有登录行为' },
      { k: '占用空间', v: Admin.bytes(o.storage && o.storage.usedBytes), d: '文件 ' + ((o.storage && o.storage.fileCount) ?? 0) + ' 个 · 回收站 ' + ((o.storage && o.storage.trashCount) ?? 0) + ' 项' },
      { k: '近 7 日上传流量', v: Admin.bytes(o.traffic && o.traffic.up7dBytes), d: '今日上传 ' + Admin.bytes(o.traffic && o.traffic.upTodayBytes) }
    ];
    const statBox = Admin.$('#stats');
    if (statBox) {
      statBox.innerHTML = stats.map(s =>
        '<div class="stat"><div class="k">' + R6T5.esc(s.k) + '</div><div class="v">' + R6T5.esc(String(s.v)) + '</div><div class="d">' + R6T5.esc(s.d) + '</div></div>'
      ).join('');
    }

    drawTrend(o.series || {});
    drawStorageRing((o.storage && o.storage.byStrategy) || []);
    renderGroups(o.groups || []);
    renderRecent(o.recent || []);

    const refresh = Admin.$('#btn-refresh');
    if (refresh) refresh.addEventListener('click', () => initHome());
    global.addEventListener('r6t5:theme', () => drawTrend(o.series || {}));
  }

  function drawTrend(series) {
    const cv = Admin.$('#trend-chart');
    if (!cv || !series.days || !series.days.length) return;
    const ctx = cv.getContext('2d');
    const dpr = global.devicePixelRatio || 1;
    const W = cv.clientWidth || 600, H = 220;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const acc = Admin.cssVar('--acc');
    const info = Admin.cssVar('--info');
    const muted = Admin.cssVar('--muted');
    const line = Admin.cssVar('--line-strong');

    const uploads = series.uploads || [];
    const traffic = series.trafficBytes || [];
    const n = series.days.length;
    const padL = 44, padR = 16, padT = 16, padB = 28;
    const iw = W - padL - padR, ih = H - padT - padB;

    const maxUp = Math.max(1, ...uploads);
    const maxTr = Math.max(1, ...traffic);

    // 网格 + 横轴标签
    ctx.font = '11px var(--font-mono)';
    ctx.fillStyle = muted;
    ctx.strokeStyle = line;
    for (let g = 0; g <= 4; g++) {
      const y = padT + ih * g / 4;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    }
    series.days.forEach((d, i) => {
      const x = padL + iw * i / (n - 1);
      ctx.fillText(d, x - 14, H - 8);
    });

    // 上传量柱状（acc）
    const bw = Math.max(4, iw / n * 0.32);
    uploads.forEach((v, i) => {
      const x = padL + iw * i / (n - 1);
      const h = ih * (v / maxUp);
      ctx.fillStyle = acc;
      ctx.globalAlpha = .85;
      ctx.fillRect(x - bw / 2, padT + ih - h, bw, h);
      ctx.globalAlpha = 1;
    });

    // 流量折线（info）
    ctx.strokeStyle = info; ctx.lineWidth = 2; ctx.beginPath();
    traffic.forEach((v, i) => {
      const x = padL + iw * i / (n - 1);
      const y = padT + ih - ih * (v / maxTr);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    traffic.forEach((v, i) => {
      const x = padL + iw * i / (n - 1);
      const y = padT + ih - ih * (v / maxTr);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = info; ctx.fill();
    });
  }

  function drawStorageRing(byStrategy) {
    const ring = Admin.$('#storage-ring');
    const legend = Admin.$('#storage-ring-legend');
    if (!ring || !legend) return;
    const total = byStrategy.reduce((s, x) => s + (x.usedBytes || 0), 0);
    if (!byStrategy.length || !total) {
      ring.style.background = 'var(--panel-3)';
      ring.innerHTML = '<div class="ring-center"><div class="v">—</div><div class="k">暂无数据</div></div>';
      legend.innerHTML = '<div class="faint small">还没有存储用量数据</div>';
      return;
    }
    const palette = ['--acc', '--info', '--warn', '--ok', '--faint'];
    let acc = 0;
    const stops = byStrategy.map((s, i) => {
      const share = (s.usedBytes || 0) / total;
      const from = acc * 100, to = (acc + share) * 100;
      acc += share;
      const c = Admin.cssVar(palette[i % palette.length]);
      return c + ' ' + from.toFixed(2) + '% ' + to.toFixed(2) + '%';
    });
    ring.style.background = 'conic-gradient(' + stops.join(',') + ')';
    ring.innerHTML = '<div class="ring-center"><div class="v">' + Admin.bytes(total) + '</div><div class="k">已用总量</div></div>';
    legend.innerHTML = byStrategy.map((s, i) => {
      const c = Admin.cssVar(palette[i % palette.length]);
      const share = Math.round((s.usedBytes || 0) / total * 100);
      return '<div class="li"><span class="sw" style="background:' + c + '"></span><span class="nm">' +
        R6T5.esc(s.name) + '</span><span class="val">' + Admin.bytes(s.usedBytes) + ' · ' + share + '%</span></div>';
    }).join('');
  }

  function renderGroups(groups) {
    const box = Admin.$('#group-dist');
    if (!box) return;
    if (!groups.length) { box.innerHTML = '<div class="empty"><div class="ico">▢</div><h3>还没有用户组</h3><p>请先在用户组页面创建分组。</p></div>'; return; }
    const max = Math.max(1, ...groups.map(g => g.userCount || 0));
    box.innerHTML = groups.map(g => {
      const pct = Math.round((g.userCount || 0) / max * 100);
      return '<div class="mb3"><div class="row tight mb2"><span class="flex1">' + R6T5.esc(g.name) + '</span>' +
        '<span class="muted small">' + (g.userCount || 0) + ' 人</span></div>' +
        '<div class="bar"><i style="width:' + pct + '%"></i></div></div>';
    }).join('');
  }

  function renderRecent(recent) {
    const box = Admin.$('#recent-list');
    if (!box) return;
    if (!recent.length) { box.innerHTML = '<div class="faint small">暂无最近操作</div>'; return; }
    box.innerHTML = recent.map(r =>
      '<div class="tl-item"><span class="tl-dot"></span><div class="tl-body">' +
      '<div class="tl-line"><span class="tl-email">' + R6T5.esc(r.email || '—') + '</span>' +
      '<span class="badge act">' + R6T5.esc(Admin.actionLabel(r.action)) + '</span>' +
      (r.bytes ? '<span class="tl-meta">' + Admin.bytes(r.bytes) + '</span>' : '') +
      '<span class="tl-meta spacer">' + Admin.ago(r.at) + '</span></div>' +
      '<div class="tl-target">' + R6T5.esc(r.target || '') + '</div></div></div>'
    ).join('');
  }

  /* ---------- 用户 users ---------- */
  let userGroups = [];
  let userSearchTimer = null;

  async function initUsers() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    await loadGroupsForOptions();
    await loadSupabase();
    await loadUsers();

    const sync = Admin.$('#btn-sync');
    if (sync) sync.addEventListener('click', onSync);

    const test = Admin.$('#btn-sb-test');
    if (test) test.addEventListener('click', onSupabaseTest);

    const form = Admin.$('#sb-form');
    if (form) form.addEventListener('submit', onSupabaseSave);

    const search = Admin.$('#user-search');
    if (search) search.addEventListener('input', () => {
      clearTimeout(userSearchTimer);
      userSearchTimer = setTimeout(() => loadUsers(search.value.trim()), 300);
    });
  }

  async function loadGroupsForOptions() {
    try { const r = await Admin.get('/api/admin/groups'); userGroups = (r && r.items) || []; }
    catch (e) { userGroups = []; Admin.toastErr(e); }
  }

  async function loadSupabase() {
    const box = Admin.$('#sb-info');
    const note = Admin.$('#sb-alert');
    Admin.clearAlert(note);
    let d;
    try { d = await Admin.get('/api/admin/supabase'); }
    catch (e) { Admin.alert(note, e, 'Supabase 配置读取失败'); return; }
    if (!d || !d.configured) {
      box.innerHTML = '<div class="faint small">尚未配置 Supabase，请在下方填写 URL 与密钥。</div>';
      return;
    }
    const lc = d.lastCheck || {};
    const badge = lc.ok
      ? '<span class="badge ok"><span class="dot-s"></span>连通正常 · ' + (lc.latencyMs != null ? lc.latencyMs + 'ms' : '') + '</span>'
      : '<span class="badge danger"><span class="dot-s"></span>自检未通过</span>';
    box.innerHTML =
      '<div class="kv-line"><span class="k">URL</span><span class="v">' + R6T5.esc(d.url || '—') + '</span></div>' +
      '<div class="kv-line"><span class="k">anon Key</span><span class="v">' + R6T5.esc(d.anonKeyMasked || '—') + '</span></div>' +
      '<div class="kv-line"><span class="k">service Key</span><span class="v">' + R6T5.esc(d.serviceKeyMasked || '—') + '</span></div>' +
      '<div class="kv-line"><span class="k">最近自检</span><span class="v">' + badge + ' <span class="faint">@ ' + Admin.time(lc.at || d.updatedAt) + '</span></span></div>';
  }

  async function onSupabaseSave(ev) {
    ev.preventDefault();
    const note = Admin.$('#sb-alert');
    const err = Admin.$('#sb-err');
    Admin.clearAlert(note);
    const url = Admin.$('#sb-url').value.trim();
    const anonKey = Admin.$('#sb-anon').value.trim();
    const serviceKey = Admin.$('#sb-service').value.trim();
    try {
      await Admin.post('/api/admin/supabase', { url, anonKey, serviceKey });
      R6T5.toast('Supabase 配置已保存', 'ok');
      if (err) err.textContent = '';
      Admin.$('#sb-form').reset();
      await loadSupabase();
    } catch (e) {
      const msg = (e && e.message) || '保存失败';
      if (err) err.textContent = msg + '（配置未保存）';
      Admin.alert(note, e, '配置未保存');
      Admin.toastErr(e);
    }
  }

  async function onSupabaseTest() {
    const note = Admin.$('#sb-test-result');
    if (!note) return;
    note.classList.remove('hide');
    try {
      const r = await Admin.post('/api/admin/supabase/test', {});
      if (r && r.ok) {
        const checks = r.checks ? Object.keys(r.checks).filter(k => r.checks[k]).map(k => R6T5.esc(k)).join('、') : '';
        note.innerHTML = '<div class="note ok"><span class="ico">✓</span><div>连通正常' + (r.latencyMs != null ? ' · ' + r.latencyMs + 'ms' : '') +
          (checks ? ' · 检查项：' + checks : '') + '</div></div>';
      } else {
        note.innerHTML = '<div class="note danger"><span class="ico">⚠</span><div>' + R6T5.esc((r && r.error && r.error.message) || (r && r.message) || '自检未通过') + '</div></div>';
      }
    } catch (e) { Admin.alert(note, e, '自检请求失败'); }
  }

  async function onSync() {
    try {
      const r = await Admin.post('/api/admin/users/sync', {});
      R6T5.toast('同步完成：新增 ' + (r.added || 0) + '，更新 ' + (r.updated || 0) + '，共 ' + (r.total || 0) + ' 人', 'ok');
      await loadUsers();
    } catch (e) { Admin.toastErr(e); }
  }

  async function loadUsers(q) {
    const tbody = Admin.$('#user-rows');
    const alertBox = Admin.$('#page-alert');
    Admin.clearAlert(alertBox);
    let d;
    try { d = await Admin.get('/api/admin/users', { q: q || '' }); }
    catch (e) { Admin.alert(alertBox, e, '用户列表读取失败'); return; }
    const items = (d && d.items) || [];
    Admin.$('#user-total').textContent = (d && d.total) != null ? d.total + ' 人' : '—';
    if (!items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8"><div class="empty"><div class="ico">▢</div><h3>没有匹配的用户</h3><p>调整搜索条件，或从 Supabase 同步用户。</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = items.map(u => {
      const opts = userGroups.map(g =>
        '<option value="' + R6T5.esc(g.id) + '"' + (g.id === u.groupId ? ' selected' : '') + '>' + R6T5.esc(g.name) + '</option>'
      ).join('');
      const dis = !!u.disabled;
      return '<tr data-id="' + R6T5.esc(u.id) + '">' +
        '<td><div class="name">' + R6T5.esc(u.email) + '</div>' + (u.displayName ? '<div class="faint small">' + R6T5.esc(u.displayName) + '</div>' : '') + '</td>' +
        '<td><select class="select cell-select" data-field="groupId">' + opts + '</select></td>' +
        '<td class="num">' + Admin.bytes(u.usedBytes) + '</td>' +
        '<td class="num">' + (u.fileCount ?? 0) + '</td>' +
        '<td>' + Admin.ago(u.lastLoginAt) + '</td>' +
        '<td><label class="switch"><input type="checkbox" data-field="disabled"' + (dis ? ' checked' : '') + '><span></span></label></td>' +
        '<td>' + (dis ? '<span class="badge danger">已禁用</span>' : '<span class="badge ok">正常</span>') + '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('select[data-field="groupId"]').forEach(sel => {
      sel.addEventListener('change', async () => {
        const tr = sel.closest('tr');
        const id = tr.dataset.id;
        try {
          await Admin.patch('/api/admin/users/' + encodeURIComponent(id), { groupId: sel.value });
          R6T5.toast('已调整用户组', 'ok');
        } catch (e) { Admin.toastErr(e); await loadUsers(q); }
      });
    });
    tbody.querySelectorAll('input[data-field="disabled"]').forEach(sw => {
      sw.addEventListener('change', async () => {
        const tr = sw.closest('tr');
        const id = tr.dataset.id;
        try {
          await Admin.patch('/api/admin/users/' + encodeURIComponent(id), { disabled: sw.checked });
          R6T5.toast(sw.checked ? '用户已禁用' : '用户已恢复', 'ok');
          await loadUsers(q);
        } catch (e) { Admin.toastErr(e); sw.checked = !sw.checked; }
      });
    });
  }

  /* ---------- 文件系统：存储策略 / 目录绑定 / 解析预览 ---------- */
  let storageTypes = [];
  let currentType = null;
  let strategies = [];
  let editingStrategy = null;
  let testState = { status: 'untested', message: '' };

  const TYPE_LABEL = { volume: '本地卷', s3: 'S3', github: 'GitHub' };
  const TYPE_BADGE = { volume: '', s3: 'info', github: 'warn' };
  const MATCH_LABEL = { binding: '目录绑定', group: '用户组默认', local: '本地默认' };

  function typeText(t) { return TYPE_LABEL[t] || t; }

  async function initStorage() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    await loadStorageTypes();
    await loadStorageList();
    await loadBindings();
    await prefillResolvePath();

    const add = Admin.$('#btn-add-strategy');
    if (add) add.addEventListener('click', () => openStrategyModal(null));
    const form = Admin.$('#strategy-form');
    if (form) form.addEventListener('submit', onStrategySubmit);
    const typeSel = Admin.$('#st-type');
    if (typeSel) typeSel.addEventListener('change', () => renderTypeDisclosure());
    const testBtn = Admin.$('#st-test');
    if (testBtn) testBtn.addEventListener('click', onTestConnection);

    const bAdd = Admin.$('#btn-add-binding');
    if (bAdd) bAdd.addEventListener('click', () => openBindingModal(null));
    const bForm = Admin.$('#binding-form');
    if (bForm) bForm.addEventListener('submit', onBindingSubmit);
    Admin.$$('input[name="bd-scope"]').forEach(r => r.addEventListener('change', syncScopeField));

    const rsBtn = Admin.$('#rs-resolve');
    if (rsBtn) rsBtn.addEventListener('click', doResolve);
    const rsPath = Admin.$('#rs-path');
    if (rsPath) rsPath.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doResolve(); } });

    // 自测参数：?open=modal-add 打开弹窗；生产不带参数为关闭态
    if (new URLSearchParams(location.search).get('open') === 'modal-add') openStrategyModal(null);
  }

  async function loadStorageTypes() {
    try { const r = await Admin.get('/api/admin/storage/types'); storageTypes = (r && r.items) || []; }
    catch (e) { storageTypes = []; Admin.toastErr(e); }
  }

  async function loadStorageList() {
    const tbody = Admin.$('#strategy-rows');
    const alertBox = Admin.$('#page-alert');
    Admin.clearAlert(alertBox);
    let d;
    try { d = await Admin.get('/api/admin/storage'); }
    catch (e) { Admin.alert(alertBox, e, '存储策略读取失败'); return; }
    strategies = (d && d.items) || [];
    if (!strategies.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="8"><div class="empty"><div class="ico">▢</div><h3>还没有存储策略</h3><p>添加一条本地数据卷后，站点才能接收文件。</p><div class="actions"><button class="btn primary" type="button" id="empty-add">添加策略</button></div></div></td></tr>';
      const ea = Admin.$('#empty-add');
      if (ea) ea.addEventListener('click', () => openStrategyModal(null));
      return;
    }
    tbody.innerHTML = strategies.map(s => {
      const cap = s.capacityBytes || 0, used = s.usedBytes || 0;
      const pct = cap ? Math.min(100, Math.round(used / cap * 100)) : 0;
      const barCls = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';
      const capBadge = s.readOnly ? '<span class="badge warn">只读</span>' : '<span class="badge ok">可写</span>';
      const health = s.health || {};
      const healthBadge = health.ok === true
        ? '<span class="badge ok"><span class="dot-s"></span>正常</span>'
        : health.ok === false
          ? '<span class="badge danger"><span class="dot-s"></span>异常</span>'
          : '<span class="badge"><span class="dot-s"></span>未检测</span>';
      const masked = Object.entries(s.configMasked || {})
        .map(([k, v]) => R6T5.esc(k) + '=' + R6T5.esc(v)).join(' · ');
      return '<tr data-id="' + R6T5.esc(s.id) + '">' +
        '<td><div class="name">' + R6T5.esc(s.name) + '</div></td>' +
        '<td><span class="badge ' + (TYPE_BADGE[s.type] || '') + '">' + R6T5.esc(typeText(s.type)) + '</span></td>' +
        '<td>' + R6T5.esc(s.region || '—') + (masked ? '<div class="faint small mono-sm mt1">' + masked + '</div>' : '') + '</td>' +
        '<td class="num">' + Admin.bytes(cap) + '</td>' +
        '<td><div class="row tight"><div class="bar flex1 ' + barCls + '"><i style="width:' + pct + '%"></i></div><span class="small muted">' + pct + '%</span></div><div class="faint small">已用 ' + Admin.bytes(used) + '</div></td>' +
        '<td>' + capBadge + '</td>' +
        '<td title="' + R6T5.esc(health.message || '') + '">' + healthBadge +
        (health.message ? '<div class="faint small">' + R6T5.esc(health.message) + '</div>' : '') + '</td>' +
        '<td><div class="row-actions"><button class="btn sm" type="button" data-act="test">测试</button>' +
        '<button class="btn sm ghost" type="button" data-act="edit">编辑</button>' +
        '<button class="btn sm danger" type="button" data-act="del">删除</button></div></td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-act="test"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.closest('tr').dataset.id;
        btn.disabled = true;
        try {
          const r = await Admin.post('/api/admin/storage/' + encodeURIComponent(id) + '/test', {});
          if (r && r.ok) R6T5.toast('连通正常' + (r.writable ? '（可写）' : '（只读）') + (r.message ? '：' + r.message : ''), 'ok');
          else R6T5.toast((r && r.message) || '测试未通过', 'warn');
        } catch (e) { Admin.toastErr(e); }
        finally { btn.disabled = false; }
      });
    });
    tbody.querySelectorAll('[data-act="edit"]').forEach(btn =>
      btn.addEventListener('click', () => openStrategyModal(strategies.find(x => x.id === btn.closest('tr').dataset.id))));
    tbody.querySelectorAll('[data-act="del"]').forEach(btn =>
      btn.addEventListener('click', () => onStrategyDelete(strategies.find(x => x.id === btn.closest('tr').dataset.id))));
  }

  async function onStrategyDelete(s) {
    if (!s) return;
    if (!confirm('确定删除策略「' + s.name + '」？删除前需确认该策略下没有文件。')) return;
    try {
      await Admin.del('/api/admin/storage/' + encodeURIComponent(s.id));
      R6T5.toast('策略已删除', 'ok');
      await loadStorageList();
    } catch (e) { Admin.toastErr(e); }
  }

  function openStrategyModal(s) {
    editingStrategy = s || null;
    const m = Admin.$('#m-add');
    if (!m) return;
    Admin.$('#m-add-title').textContent = s ? '编辑存储策略' : '添加存储策略';
    const typeSel = Admin.$('#st-type');
    typeSel.innerHTML = storageTypes.map(t =>
      '<option value="' + R6T5.esc(t.type) + '">' + R6T5.esc(t.label) + '</option>'
    ).join('');
    currentType = storageTypes.find(t => t.type === (s ? s.type : 'volume')) || storageTypes[0];
    if (currentType) typeSel.value = currentType.type;
    Admin.$('#st-name').value = s ? s.name : '';
    Admin.$('#st-region').value = s ? (s.region || '') : '';
    const cap = s ? Admin.fromBytes(s.capacityBytes || 0) : { value: '', unit: 'GB' };
    Admin.$('#st-capacity').value = cap.value;
    Admin.$('#st-capacity-unit').value = cap.unit;
    Admin.$('#st-readonly').checked = !!(s && s.readOnly);
    Admin.$('#st-err').textContent = '';
    resetTestNote();
    renderTypeDisclosure();
    if (s) {
      // 回填非密钥配置；密钥类（**** 末四位）不回显，留空待填
      const masked = s.configMasked || {};
      Admin.$$('#st-dyn-fields [data-dyn]').forEach(i => {
        const k = i.dataset.dyn;
        if (masked[k] != null && !/^\*\*\*\*/.test(String(masked[k]))) i.value = masked[k];
      });
    }
    R6T5.modal.open('#m-add');
  }

  function renderTypeDisclosure() {
    const typeSel = Admin.$('#st-type');
    currentType = storageTypes.find(t => t.type === typeSel.value) || null;
    const box = Admin.$('#st-disclosure');
    const ack = Admin.$('#st-ack');
    const submit = Admin.$('#st-submit');
    const dyn = Admin.$('#st-dyn-fields');
    if (!currentType) return;

    const pub = (currentType.publicFields || []).map(f =>
      '<div class="li"><span class="key">' + R6T5.esc(f.key) + '</span><span>' + R6T5.esc(f.label) + '</span></div>'
    ).join('');
    const priv = (currentType.neverPublic || []).map(f =>
      '<div class="li"><span class="key">' + R6T5.esc(f.key) + '</span><span>' + R6T5.esc(f.label) + '</span></div>'
    ).join('');

    box.innerHTML =
      '<div class="dc-block"><div class="dc-title">将对普通用户展示</div><div class="dc-list">' + (pub || '<div class="faint">无</div>') + '</div></div>' +
      '<div class="dc-block"><div class="dc-title">仅服务端保存（永不下发）</div><div class="dc-list">' + (priv || '<div class="faint">无</div>') + '</div></div>' +
      '<div class="notice">' + R6T5.esc(currentType.notice || '') + '</div>' +
      (currentType.docsHint ? '<div class="faint small mt2">' + R6T5.esc(currentType.docsHint) + '</div>' : '');

    dyn.innerHTML = (currentType.fields || []).map(f => {
      const secretHint = f.secret ? '<span class="help warn">仅存服务端，不会回显</span>' : '';
      let control;
      if (f.type === 'select') {
        const opts = (f.options || []).map(o =>
          '<option value="' + R6T5.esc(o.value) + '"' + (String(f.default) === String(o.value) ? ' selected' : '') + '>' +
          R6T5.esc(o.label) + '</option>').join('');
        control = '<select class="select" data-dyn="' + R6T5.esc(f.key) + '">' + opts + '</select>';
      } else {
        const inputType = f.type === 'password' || f.secret ? 'password' : 'text';
        control = '<input class="input" data-dyn="' + R6T5.esc(f.key) + '" type="' + inputType + '" placeholder="' + R6T5.esc(f.placeholder || '') + '" value="' + R6T5.esc(f.default || '') + '">';
      }
      return '<div class="field"><label>' + R6T5.esc(f.label) + (f.required ? ' *' : '') + '</label>' + control +
        (f.help ? '<span class="help">' + R6T5.esc(f.help) + '</span>' : '') + secretHint + '</div>';
    }).join('');

    // GitHub 策略强制只读，不可取消
    const ro = Admin.$('#st-readonly');
    if (currentType.type === 'github') { ro.checked = true; ro.disabled = true; }
    else { ro.disabled = false; }

    // 切换类型后旧的自检结果作废，清空测试提示
    resetTestNote();

    const sync = () => { submit.disabled = !ack.checked; };
    ack.onchange = sync;
    sync();
  }

  function resetTestNote() {
    testState = { status: 'untested', message: '' };
    const note = Admin.$('#st-test-note');
    if (note) note.innerHTML = '';
    const warn = Admin.$('#st-test-warn');
    if (warn) { warn.textContent = ''; warn.className = 'help'; }
  }

  function readDynConfig() {
    const config = {};
    Admin.$$('#st-dyn-fields [data-dyn]').forEach(i => { config[i.dataset.dyn] = i.value.trim(); });
    return config;
  }

  async function onTestConnection() {
    if (!currentType) return;
    const btn = Admin.$('#st-test');
    btn.disabled = true;
    const config = readDynConfig();
    try {
      const r = await Admin.post('/api/admin/storage/validate', { type: currentType.type, config });
      const ok = !!(r && r.ok);
      testState = { status: ok ? 'ok' : 'fail', message: (r && r.message) || (ok ? '测试通过' : '测试未通过') };
      Admin.$('#st-test-note').innerHTML =
        '<div class="note ' + (ok ? 'ok' : 'danger') + '"><span class="ico">' + (ok ? '✓' : '⚠') + '</span><div>' +
        R6T5.esc(testState.message) + '</div></div>';
      const warn = Admin.$('#st-test-warn');
      if (ok) { warn.textContent = '自检通过'; warn.className = 'help ok'; }
      else { warn.textContent = '未通过自检，仍可保存，建议先修正配置'; warn.className = 'help warn'; }
    } catch (e) {
      testState = { status: 'fail', message: (e && e.message) || '测试失败' };
      Admin.$('#st-test-note').innerHTML =
        '<div class="note danger"><span class="ico">⚠</span><div>' + R6T5.esc(testState.message) + '</div></div>';
      const warn = Admin.$('#st-test-warn');
      warn.textContent = '未通过自检，仍可保存，建议先修正配置';
      warn.className = 'help warn';
      Admin.toastErr(e);
    } finally { btn.disabled = false; }
  }

  async function onStrategySubmit(ev) {
    ev.preventDefault();
    const err = Admin.$('#st-err');
    if (!currentType) { err.textContent = '请选择存储类型'; return; }

    const name = Admin.$('#st-name').value.trim();
    const region = Admin.$('#st-region').value.trim();
    const capBytes = Admin.toBytes(Admin.$('#st-capacity').value, Admin.$('#st-capacity-unit').value);
    const readOnly = Admin.$('#st-readonly').checked;
    const ack = Admin.$('#st-ack').checked;

    if (!name) { err.textContent = '请填写策略名'; return; }
    if (capBytes == null) { err.textContent = '请填写合法容量'; return; }
    if (!ack) { err.textContent = '请先勾选信息展示告知确认'; return; }

    const config = readDynConfig();
    const missing = (currentType.fields || []).find(f => f.required && !config[f.key]);
    if (missing) { err.textContent = '请填写必填项：' + missing.label; return; }

    const body = { name, type: currentType.type, region, capacityBytes: capBytes, readOnly, config, acknowledgeDisclosure: true };
    try {
      if (editingStrategy) await Admin.patch('/api/admin/storage/' + encodeURIComponent(editingStrategy.id), body);
      else await Admin.post('/api/admin/storage', body);
      R6T5.toast(editingStrategy ? '存储策略已更新' : '存储策略已创建', 'ok');
      R6T5.modal.close('#m-add');
      Admin.$('#strategy-form').reset();
      await loadStorageList();
    } catch (e) {
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

  /* ---------- 目录绑定 ---------- */
  let editingBinding = null;

  async function loadBindings() {
    const tbody = Admin.$('#binding-rows');
    let d;
    try { d = await Admin.get('/api/admin/bindings'); }
    catch (e) { Admin.toastErr(e); tbody.innerHTML = ''; return; }
    const items = (d && d.items) || [];
    if (!items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="4"><div class="empty"><div class="ico">▢</div><h3>还没有目录绑定</h3><p>把某个目录映射到指定策略；未命中绑定的目录走用户组默认或本地默认。</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = items.map(b => {
      const dirLabel = b.scope === 'user'
        ? R6T5.esc(b.email || '—') + ' · ' + R6T5.esc(b.subPath || '用户根')
        : '所有用户 · ' + R6T5.esc(b.subPath || '用户根');
      return '<tr data-id="' + R6T5.esc(b.id) + '">' +
        '<td><div class="name">' + dirLabel + '</div></td>' +
        '<td><div class="row tight"><span>' + R6T5.esc(b.strategyName || '—') + '</span>' +
        '<span class="badge ' + (TYPE_BADGE[b.strategyType] || '') + '">' + R6T5.esc(typeText(b.strategyType)) + '</span>' +
        (b.strategyReadOnly ? '<span class="badge warn">只读</span>' : '') + '</div></td>' +
        '<td>' + Admin.time(b.createdAt) + '</td>' +
        '<td><div class="row-actions"><button class="btn sm ghost" type="button" data-act="edit">编辑</button>' +
        '<button class="btn sm danger" type="button" data-act="del">删除</button></div></td>' +
        '</tr>';
    }).join('');
    tbody.querySelectorAll('[data-act="edit"]').forEach(btn =>
      btn.addEventListener('click', () => openBindingModal(items.find(x => x.id === btn.closest('tr').dataset.id))));
    tbody.querySelectorAll('[data-act="del"]').forEach(btn =>
      btn.addEventListener('click', () => onBindingDelete(items.find(x => x.id === btn.closest('tr').dataset.id))));
  }

  function syncScopeField() {
    const user = Admin.$('#bd-scope-user').checked;
    Admin.$('#bd-email-field').classList.toggle('hide', !user);
  }

  function openBindingModal(b) {
    editingBinding = b || null;
    Admin.$('#m-bind-title').textContent = b ? '编辑目录绑定' : '新增目录绑定';
    Admin.$('#bd-err').textContent = '';
    const sel = Admin.$('#bd-strategy');
    sel.innerHTML = strategies.map(s =>
      '<option value="' + R6T5.esc(s.id) + '">' + R6T5.esc(s.name) + '（' + R6T5.esc(typeText(s.type)) + '）</option>').join('');
    if (b) {
      sel.value = b.strategyId;
      Admin.$('#bd-scope-' + b.scope).checked = true;
      Admin.$('#bd-email').value = b.email || '';
      Admin.$('#bd-subpath').value = b.subPath || '';
    } else {
      Admin.$('#bd-scope-site').checked = true;
      Admin.$('#bd-email').value = '';
      Admin.$('#bd-subpath').value = '';
    }
    syncScopeField();
    R6T5.modal.open('#m-bind');
  }

  async function onBindingSubmit(ev) {
    ev.preventDefault();
    const err = Admin.$('#bd-err');
    const strategyId = Admin.$('#bd-strategy').value;
    const scope = Admin.$('input[name="bd-scope"]:checked').value;
    const email = Admin.$('#bd-email').value.trim();
    const subPath = Admin.$('#bd-subpath').value.trim();
    if (!strategyId) { err.textContent = '请选择策略'; return; }
    if (scope === 'user' && !email) { err.textContent = '指定用户时请填写邮箱'; return; }
    const body = { strategyId, scope, subPath };
    if (scope === 'user') body.email = email;
    try {
      if (editingBinding) await Admin.patch('/api/admin/bindings/' + encodeURIComponent(editingBinding.id), body);
      else await Admin.post('/api/admin/bindings', body);
      R6T5.toast('绑定已保存', 'ok');
      R6T5.modal.close('#m-bind');
      await loadBindings();
    } catch (e) {
      // 409 冲突等：后端 message 原样展示在弹窗内
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

  async function onBindingDelete(b) {
    if (!b) return;
    const dirLabel = b.scope === 'user' ? (b.email || '—') : '所有用户';
    if (!confirm('确定删除绑定「' + dirLabel + ' · ' + (b.subPath || '用户根') + '」？')) return;
    try {
      await Admin.del('/api/admin/bindings/' + encodeURIComponent(b.id));
      R6T5.toast('绑定已删除', 'ok');
      await loadBindings();
    } catch (e) { Admin.toastErr(e); }
  }

  /* ---------- 解析预览 ---------- */
  async function prefillResolvePath() {
    const input = Admin.$('#rs-path');
    if (!input) return;
    try { const me = await R6T5.get('/api/me'); if (me && me.user) input.value = me.user.email; }
    catch (_) { /* 留空，由管理员手填 */ }
  }

  async function doResolve() {
    const path = Admin.$('#rs-path').value.trim();
    const box = Admin.$('#rs-result');
    if (!path) {
      box.innerHTML = '<div class="note warn"><span class="ico">!</span><div>请输入要解析的目录路径。</div></div>';
      return;
    }
    let r;
    try { r = await Admin.get('/api/admin/bindings/resolve', { path }); }
    catch (e) { Admin.toastErr(e); box.innerHTML = ''; return; }
    const s = r.strategy || {};
    const matchedBy = MATCH_LABEL[r.matchedBy] || r.matchedBy || '—';
    box.innerHTML =
      '<div class="note info"><span class="ico">i</span><div class="flex1">' +
      '<div class="row tight"><b>' + R6T5.esc(s.name || '—') + '</b>' +
      '<span class="badge ' + (TYPE_BADGE[s.type] || '') + '">' + R6T5.esc(typeText(s.type)) + '</span>' +
      (s.readOnly ? '<span class="badge warn">只读</span>' : '<span class="badge ok">可写</span>') + '</div>' +
      '<div class="faint small mt1">命中方式：' + R6T5.esc(matchedBy) +
      (r.bindingId ? ' · 绑定 ' + R6T5.esc(r.bindingId) : '') +
      (r.subPath ? ' · 子目录 ' + R6T5.esc(r.subPath) : '') + '</div>' +
      '</div></div>';
  }

  /* ---------- 用户组 groups ---------- */
  let editingGroup = null;

  async function initGroups() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    await loadGroups();

    const add = Admin.$('#btn-add-group');
    if (add) add.addEventListener('click', () => openGroupModal(null));
    const form = Admin.$('#group-form');
    if (form) form.addEventListener('submit', onGroupSubmit);
  }

  async function loadGroups() {
    const box = Admin.$('#group-cards');
    const alertBox = Admin.$('#page-alert');
    Admin.clearAlert(alertBox);
    let d;
    try { d = await Admin.get('/api/admin/groups'); }
    catch (e) { Admin.alert(alertBox, e, '用户组读取失败'); return; }
    const items = (d && d.items) || [];
    if (!items.length) {
      box.innerHTML = '<div class="empty"><div class="ico">▢</div><h3>还没有用户组</h3><p>创建用户组以分配空间、单文件与流量上限。</p><div class="actions"><button class="btn primary" type="button" id="empty-add">新建用户组</button></div></div>';
      Admin.$('#empty-add').addEventListener('click', () => openGroupModal(null));
      return;
    }
    box.innerHTML = '<div class="grid g3">' + items.map(g =>
      '<div class="card group-card" data-id="' + R6T5.esc(g.id) + '">' +
      '<div class="gc-head"><h3>' + R6T5.esc(g.name) + '</h3>' +
      (g.isDefault ? '<span class="badge acc">默认组</span>' : '') + '</div>' +
      '<div class="gc-grid">' +
      '<div class="gc-cell"><div class="k">空间上限</div><div class="v">' + Admin.bytes(g.spaceLimitBytes) + '</div></div>' +
      '<div class="gc-cell"><div class="k">单文件上限</div><div class="v">' + Admin.bytes(g.maxFileSizeBytes) + '</div></div>' +
      '<div class="gc-cell"><div class="k">7 天上传流量</div><div class="v">' + Admin.bytes(g.traffic7dLimitBytes) + '</div></div>' +
      '</div>' +
      '<div class="row tight"><span class="muted small">成员 ' + (g.userCount || 0) + ' 人</span><span class="spacer"></span>' +
      '<button class="btn sm" type="button" data-act="edit">编辑</button>' +
      '<button class="btn sm danger" type="button" data-act="del">删除</button></div>' +
      '</div>'
    ).join('') + '</div>';

    box.querySelectorAll('[data-act="edit"]').forEach(b =>
      b.addEventListener('click', () => openGroupModal(items.find(x => x.id === b.closest('.card').dataset.id))));
    box.querySelectorAll('[data-act="del"]').forEach(b =>
      b.addEventListener('click', () => onGroupDelete(items.find(x => x.id === b.closest('.card').dataset.id))));
  }

  function openGroupModal(g) {
    editingGroup = g || null;
    const title = Admin.$('#m-group-title');
    const form = Admin.$('#group-form');
    form.reset();
    Admin.$('#group-err').textContent = '';
    title.textContent = g ? '编辑用户组' : '新建用户组';

    const setLimit = (id, bytes) => {
      const v = Admin.fromBytes(bytes || 0);
      Admin.$('#' + id + '-v').value = v.value;
      Admin.$('#' + id + '-u').value = v.unit;
    };
    setLimit('g-space', g && g.spaceLimitBytes);
    setLimit('g-file', g && g.maxFileSizeBytes);
    setLimit('g-traffic', g && g.traffic7dLimitBytes);
    Admin.$('#g-name').value = g ? g.name : '';
    Admin.$('#g-default').checked = !!(g && g.isDefault);
    R6T5.modal.open('#m-group');
  }

  async function onGroupSubmit(ev) {
    ev.preventDefault();
    const err = Admin.$('#group-err');
    const name = Admin.$('#g-name').value.trim();
    const space = Admin.toBytes(Admin.$('#g-space-v').value, Admin.$('#g-space-u').value);
    const file = Admin.toBytes(Admin.$('#g-file-v').value, Admin.$('#g-file-u').value);
    const traffic = Admin.toBytes(Admin.$('#g-traffic-v').value, Admin.$('#g-traffic-u').value);
    if (!name) { err.textContent = '请填写组名'; return; }
    if (space == null || file == null || traffic == null) { err.textContent = '三个上限都需填写正数'; return; }
    const body = { name, spaceLimitBytes: space, maxFileSizeBytes: file, traffic7dLimitBytes: traffic, isDefault: Admin.$('#g-default').checked };
    try {
      if (editingGroup) await Admin.patch('/api/admin/groups/' + encodeURIComponent(editingGroup.id), body);
      else await Admin.post('/api/admin/groups', body);
      R6T5.toast('用户组已保存', 'ok');
      R6T5.modal.close('#m-group');
      await loadGroups();
    } catch (e) {
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

  async function onGroupDelete(g) {
    if (!g) return;
    if (!confirm('确定删除用户组「' + g.name + '」？')) return;
    try {
      await Admin.del('/api/admin/groups/' + encodeURIComponent(g.id));
      R6T5.toast('用户组已删除', 'ok');
      await loadGroups();
    } catch (e) {
      // 409 时把后端 message 原样提示（组内有用户 / 默认组不可删）
      Admin.toastErr(e);
    }
  }

  /* ---------- 分享 shares（P1 占位） ---------- */
  async function initShares() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    const box = Admin.$('#share-state');
    let d;
    try { d = await Admin.get('/api/shares'); }
    catch (e) { Admin.alert(Admin.$('#page-alert'), e, '分享状态读取失败'); return; }
    const available = !!(d && d.available);
    if (available) {
      box.innerHTML = '<div class="note info"><span class="ico">i</span><div>分享功能已开启，共 ' + ((d.items || []).length) + ' 条分享。</div></div>';
    } else {
      box.innerHTML = '<div class="empty"><div class="ico">▤</div><h3>分享将在 P2 提供</h3>' +
        '<p>当前版本未开放分享能力（接口返回 available:false）。P2 将支持：有效期、提取码、下载次数、文件夹分享。</p></div>' +
        '<div class="placeholder-grid mt4">' +
        '<div class="ph"><div class="k">有效期</div><div class="d">按天 / 永久设置分享链接过期时间</div></div>' +
        '<div class="ph"><div class="k">提取码</div><div class="d">可选 4 位提取码保护链接</div></div>' +
        '<div class="ph"><div class="k">下载次数</div><div class="d">限制单链接最大下载次数</div></div>' +
        '<div class="ph"><div class="k">文件夹分享</div><div class="d">整目录打包对外分享</div></div>' +
        '</div>';
    }
  }

  /* ---------- 回收站 trash ---------- */
  async function initTrash() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    const tbody = Admin.$('#trash-rows');
    const empty = Admin.$('#trash-empty');
    const alertBox = Admin.$('#page-alert');
    let d;
    try { d = await Admin.get('/api/admin/trash'); }
    catch (e) { Admin.alert(alertBox, e, '回收站读取失败'); return; }
    const items = (d && d.items) || [];
    const days = (d && d.retentionDays) != null ? d.retentionDays : 30;
    const table = Admin.$('#trash-table');
    if (!items.length) {
      empty.classList.remove('hide');
      if (table) table.classList.add('hide');
      empty.querySelector('p').textContent = '用户删除的文件在此保留 ' + days + ' 天后自动清理（P1 仅展示，不提供恢复/彻底删除操作）。';
      tbody.innerHTML = '';
      return;
    }
    empty.classList.add('hide');
    if (table) table.classList.remove('hide');
    tbody.innerHTML = items.map(n => {
      const remain = remainDays(n.expiresAt);
      const remainTxt = remain < 0 ? '<span class="badge danger">已过期</span>'
        : '<span class="badge ' + (remain <= 3 ? 'warn' : 'ok') + '">' + remain + ' 天</span>';
      return '<tr>' +
        '<td>' + R6T5.esc(n.email || '—') + '</td>' +
        '<td><div class="name">' + R6T5.esc(n.name || Admin.basename(n.path)) + '</div><div class="faint small mono-sm">' + R6T5.esc(n.path || '') + '</div></td>' +
        '<td class="num">' + Admin.bytes(n.sizeBytes) + '</td>' +
        '<td>' + Admin.time(n.deletedAt) + '</td>' +
        '<td>' + Admin.time(n.expiresAt) + '</td>' +
        '<td>' + remainTxt + '</td>' +
        '</tr>';
    }).join('');
  }

  function remainDays(expiresAt) {
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    return Math.ceil(ms / 86400e3);
  }

  /* ---------- 审计 audit ---------- */
  const auditState = { page: 1, action: '', email: '' };

  async function initAudit() {
    Admin.bindLogout();
    await Admin.requireAdmin();

    const sel = Admin.$('#audit-action');
    sel.innerHTML = '<option value="">全部动作</option>' + Object.keys(Admin.actionMap).map(k =>
      '<option value="' + k + '">' + R6T5.esc(Admin.actionMap[k]) + '</option>').join('');

    sel.addEventListener('change', () => { auditState.action = sel.value; auditState.page = 1; loadAudit(); });
    const email = Admin.$('#audit-email');
    email.addEventListener('keydown', e => { if (e.key === 'Enter') { auditState.email = email.value.trim(); auditState.page = 1; loadAudit(); } });
    Admin.$('#audit-search').addEventListener('click', () => { auditState.email = email.value.trim(); auditState.page = 1; loadAudit(); });
    Admin.$('#audit-prev').addEventListener('click', () => { if (auditState.page > 1) { auditState.page--; loadAudit(); } });
    Admin.$('#audit-next').addEventListener('click', () => { auditState.page++; loadAudit(); });

    await loadAudit();
  }

  async function loadAudit() {
    const tbody = Admin.$('#audit-rows');
    const alertBox = Admin.$('#page-alert');
    Admin.clearAlert(alertBox);
    let d;
    try {
      d = await Admin.get('/api/admin/audit', { page: auditState.page, pageSize: 30, action: auditState.action, email: auditState.email });
    } catch (e) { Admin.alert(alertBox, e, '审计记录读取失败'); return; }
    const items = (d && d.items) || [];
    const total = (d && d.total) || 0;
    const pages = Math.max(1, Math.ceil(total / ((d && d.pageSize) || 30)));
    Admin.$('#audit-count').textContent = '共 ' + total + ' 条 · 第 ' + auditState.page + '/' + pages + ' 页';
    Admin.$('#audit-prev').disabled = auditState.page <= 1;
    Admin.$('#audit-next').disabled = auditState.page >= pages;

    if (!items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7"><div class="empty"><div class="ico">▢</div><h3>没有审计记录</h3><p>调整动作或邮箱筛选后重试。</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = items.map(a =>
      '<tr>' +
      '<td>' + Admin.time(a.at) + '</td>' +
      '<td>' + R6T5.esc(a.email || '—') + '</td>' +
      '<td><span class="badge act">' + R6T5.esc(Admin.actionLabel(a.action)) + '</span></td>' +
      '<td class="trunc">' + R6T5.esc(a.target || '—') + '</td>' +
      '<td class="num">' + Admin.bytes(a.bytes) + '</td>' +
      '<td class="mono-sm">' + R6T5.esc(a.ip || '—') + '</td>' +
      '<td class="faint small">' + R6T5.esc(a.detail || '') + '</td>' +
      '</tr>'
    ).join('');
  }

  /* ---------- 站点设置 settings ---------- */
  let settingGroups = [];

  async function initSettings() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    try { const r = await Admin.get('/api/admin/groups'); settingGroups = (r && r.items) || []; }
    catch (_) { settingGroups = []; }

    const alertBox = Admin.$('#page-alert');
    let s;
    try { s = await Admin.get('/api/admin/settings'); }
    catch (e) { Admin.alert(alertBox, e, '站点设置读取失败'); return; }

    const f = Admin.$('#settings-form');
    f.siteName.value = s.siteName || '';
    f.publicUrl.value = s.publicUrl || '';
    f.allowSignup.checked = !!s.allowSignup;
    f.trashRetentionDays.value = s.trashRetentionDays ?? 30;
    f.themeDefault.value = s.themeDefault || 'dark';

    const gsel = f.defaultGroupId;
    gsel.innerHTML = settingGroups.map(g =>
      '<option value="' + R6T5.esc(g.id) + '"' + (g.id === s.defaultGroupId ? ' selected' : '') + '>' + R6T5.esc(g.name) + '</option>'
    ).join('');

    // defaults.* === true 的字段加黄色高亮：仍是出厂默认值
    const defaults = s.defaults || {};
    [['siteName', 'siteName'], ['publicUrl', 'publicUrl'], ['defaultGroupId', 'defaultGroupId']].forEach(([field, key]) => {
      if (defaults[key] === true) {
        const wrap = f[field].closest('.field');
        wrap.classList.add('is-default');
        const tag = document.createElement('span');
        tag.className = 'default-tag';
        tag.textContent = '！仍是出厂默认值';
        wrap.querySelector('label').appendChild(tag);
      }
    });

    f.addEventListener('submit', onSettingsSave);
  }

  async function onSettingsSave(ev) {
    ev.preventDefault();
    const f = Admin.$('#settings-form');
    const body = {
      siteName: f.siteName.value.trim(),
      publicUrl: f.publicUrl.value.trim(),
      defaultGroupId: f.defaultGroupId.value,
      allowSignup: f.allowSignup.checked,
      trashRetentionDays: Number(f.trashRetentionDays.value),
      themeDefault: f.themeDefault.value
    };
    try {
      await Admin.patch('/api/admin/settings', body);
      R6T5.toast('站点设置已保存', 'ok');
    } catch (e) { Admin.toastErr(e); }
  }

  /* ---------- 登录 login ---------- */
  function initLogin() {
    const form = Admin.$('#login-form');
    if (!form) return;
    const err = Admin.$('#login-err');
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      const pwd = Admin.$('#login-password').value;
      try {
        await R6T5.post('/api/admin/login', { password: pwd });
        global.location.href = '/admin/home.html';
      } catch (e) {
        if (e && e.status === 401) err.textContent = e.code === 'rate_limited' ? (e.message || '登录尝试过多，请稍后再试') : '管理密码不正确';
        else err.textContent = (e && e.message) || '登录失败';
      }
    });
  }

  /* ---------- 弹窗通用绑定（遮罩点击 / ESC / data-close） ---------- */
  function bindModals() {
    Admin.$$('.modal-mask').forEach(m => { if (m.id) R6T5.modal.bind('#' + m.id); });
    Admin.$$('[data-close]').forEach(b => b.addEventListener('click', () => {
      const m = b.closest('.modal-mask');
      if (m && m.id) R6T5.modal.close('#' + m.id);
    }));
  }

  /* ---------- 路由 ---------- */
  const routers = {
    home: initHome, users: initUsers, storage: initStorage, groups: initGroups,
    shares: initShares, trash: initTrash, audit: initAudit, settings: initSettings, login: initLogin
  };

  document.addEventListener('DOMContentLoaded', () => {
    const page = document.body.dataset.page;
    const fn = routers[page];
    if (!fn) return;
    bindModals();
    Promise.resolve(fn()).catch(e => {
      if (e && e.status === 401) return; // 守卫已跳转
      R6T5.toastError(e);
      const box = document.querySelector('#page-alert');
      if (box) Admin.alert(box, e, '页面初始化失败');
    });
  });

  global.Admin = Admin;
})(window);
