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
    put(p, b) { return Admin._guard(R6T5.request, p, { method: 'PUT', body: b || {} }); },

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

    /* ---------- 用户组配额：1024 进制，BigInt 解析（不用 Number 乘除，避免丢精度） ---------- */
    UNIT_LIST: ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'],
    _unitFactors: null,
    unitFactors() {
      if (!Admin._unitFactors) Admin._unitFactors = Admin.UNIT_LIST.map((_, i) => 1024n ** BigInt(i));
      return Admin._unitFactors;
    },
    /* 十进制字节字符串 → { value, unit, bytes }；非法输入返回 null */
    splitLimit(bytesStr) {
      let bytes;
      try { bytes = BigInt(String(bytesStr == null ? '0' : bytesStr).trim()); }
      catch (_) { return null; }
      if (bytes < 0n) bytes = 0n;
      const factors = Admin.unitFactors();
      if (bytes === 0n) return { value: '0', unit: 'GB', bytes: 0n };
      let idx = 0;
      for (let i = factors.length - 1; i >= 0; i--) {
        if (bytes >= factors[i]) { idx = i; break; }
      }
      const factor = factors[idx];
      const whole = bytes / factor;
      const rem = bytes % factor;
      let value;
      if (rem === 0n) {
        value = whole.toString();
      } else {
        const tenths = Number(rem * 10n / factor);
        value = String(Math.round((Number(whole) + tenths / 10) * 10) / 10);
      }
      return { value, unit: Admin.UNIT_LIST[idx], bytes };
    },
    /* 数值 + 单位 → BigInt 字节（支持最多 3 位小数）；非法返回 null */
    limitToBytes(valueStr, unit) {
      const factors = Admin.unitFactors();
      const ui = Admin.UNIT_LIST.indexOf(unit);
      if (ui < 0) return null;
      const m = String(valueStr == null ? '' : valueStr).trim().match(/^(\d+)(?:\.(\d{1,3}))?$/);
      if (!m) return null;
      const dec = m[2] || '';
      const scale = 10n ** BigInt(dec.length);
      const num = BigInt(m[1] + dec.padEnd(dec.length, '0'));
      return (num * factors[ui]) / scale;
    },
    /* 读取表单一组限额；返回 { value, unit, bytes } 或 null */
    readLimit(vId, uId) {
      const v = Admin.$('#' + vId).value.trim();
      const u = Admin.$('#' + uId).value;
      const bytes = Admin.limitToBytes(v, u);
      if (bytes == null) return null;
      return { value: v, unit: u, bytes };
    },
    /* 输入右侧预览：= X 字节 / 人类可读；非法输入显示错误提示而不是 NaN */
    refreshLimitPreview(vId, uId, pvId) {
      const pv = Admin.$('#' + pvId);
      if (!pv) return;
      const bytes = Admin.limitToBytes(Admin.$('#' + vId).value, Admin.$('#' + uId).value);
      if (bytes == null) {
        pv.textContent = '请填写不小于 0 的数值';
        pv.classList.add('is-err');
        return;
      }
      pv.classList.remove('is-err');
      pv.textContent = '= ' + bytes.toString() + ' 字节 · ' + R6T5.fmtBytes(Number(bytes));
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
      let txt;
      if (admin.via === 'sudo') {
        txt = '管理员 · sudo 组' + (admin.email ? ' · ' + admin.email : '');
      } else {
        const src = admin.passwordSource === 'env' ? '环境变量' : '首次启动生成';
        txt = '管理员 · ' + src;
      }
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
    await initUserSource();

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

  /* ---------- 概览：账号来源开关（Supabase / 数据卷） ---------- */
  let usourceCurrent = 'supabase';

  async function initUserSource() {
    const bar = Admin.$('#user-source-bar');
    if (!bar) return;
    await loadUserSource();

    const sw = Admin.$('#usource-switch');
    const infoBtn = Admin.$('#usource-info-btn');
    const tip = Admin.$('#usource-tip');
    if (!sw) return;

    const hideTip = () => tip.classList.remove('show');
    infoBtn.addEventListener('mouseenter', () => tip.classList.add('show'));
    infoBtn.addEventListener('mouseleave', hideTip);
    infoBtn.addEventListener('click', e => { e.stopPropagation(); tip.classList.add('show'); });
    document.addEventListener('click', e => { if (!infoBtn.contains(e.target)) hideTip(); });

    sw.addEventListener('change', () => {
      const target = sw.checked ? 'volume' : 'supabase';
      // 先回到服务端当前状态；确认成功后再由 loadUserSource() 回填，避免取消 / 失败时停在错误位置
      sw.checked = usourceCurrent === 'volume';
      openUserSourceConfirm(target);
    });
  }

  async function loadUserSource() {
    const sw = Admin.$('#usource-switch');
    const state = Admin.$('#usource-state');
    const at = Admin.$('#usource-switched-at');
    let d;
    try { d = await Admin.get('/api/admin/user-source'); }
    catch (e) { Admin.toastErr(e); return; }
    usourceCurrent = d.userSource === 'volume' ? 'volume' : 'supabase';
    if (sw) sw.checked = usourceCurrent === 'volume';
    if (state) state.textContent = usourceCurrent === 'volume' ? '当前：数据卷账号' : '当前：Supabase 账号';
    if (at) at.textContent = d.switchedAt ? '切换时间：' + Admin.time(d.switchedAt) : '';
  }

  function openUserSourceConfirm(target) {
    const modal = Admin.$('#m-usource');
    if (!modal) return;
    const desc = Admin.$('#usource-modal-desc');
    const err = Admin.$('#usource-err');
    const confirmBtn = Admin.$('#usource-confirm');
    err.textContent = '';
    desc.textContent = target === 'volume'
      ? '确认将认证来源切换为数据卷账号吗？切换后本地账号密码哈希存于数据卷。'
      : '确认将认证来源切回 Supabase 账号吗？';
    R6T5.modal.open('#m-usource');

    const onConfirm = async () => {
      confirmBtn.disabled = true;
      err.textContent = '';
      try {
        await Admin.put('/api/admin/user-source', { source: target, confirm: true });
        R6T5.modal.close('#m-usource');
        R6T5.toast(target === 'volume' ? '已切换到数据卷账号管理' : '已切回 Supabase 账号管理', 'ok');
        await loadUserSource();
        await Admin.loadSetupNote();
      } catch (e) {
        err.textContent = (e && e.message) || '切换失败';
        Admin.toastErr(e);
        await loadUserSource(); // 失败后开关回到服务端真实状态
      } finally {
        confirmBtn.disabled = false;
      }
    };
    confirmBtn.onclick = onConfirm;
  }

  /* ---------- 用户 users ---------- */
  let userGroups = [];
  let userSearchTimer = null;
  let userLastQuery = '';
  let drawerUser = null;

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

    const addBtn = Admin.$('#btn-add-user');
    if (addBtn) addBtn.addEventListener('click', openCreateUserModal);

    const createForm = Admin.$('#user-create-form');
    if (createForm) createForm.addEventListener('submit', onCreateUserSubmit);

    const pwForm = Admin.$('#user-password-form');
    if (pwForm) pwForm.addEventListener('submit', onPasswordSubmit);

    const delConfirm = Admin.$('#del-confirm');
    if (delConfirm) delConfirm.addEventListener('click', onDeleteConfirm);

    const delRadios = Admin.$$('input[name="del-files"]');
    delRadios.forEach(r => r.addEventListener('change', syncDeleteWarn));

    bindDrawer();
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

  function timeOrNone(t) { return t ? Admin.time(t) : '无记录'; }
  function sourceLabel(s) { return s === 'local' ? '本地账号' : 'Supabase 账号'; }
  function statusBadge(u) {
    return u.status === 'banned'
      ? '<span class="badge danger">已封禁</span>'
      : '<span class="badge ok">正常</span>';
  }
  function avatarLetter(email) {
    const ch = String(email || '?').trim().charAt(0) || '?';
    return R6T5.esc(ch.toUpperCase());
  }

  async function loadUsers(q) {
    userLastQuery = q || '';
    const tbody = Admin.$('#user-rows');
    const alertBox = Admin.$('#page-alert');
    Admin.clearAlert(alertBox);
    let d;
    try { d = await Admin.get('/api/admin/users', { q: userLastQuery }); }
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
      return '<tr data-id="' + R6T5.esc(u.id) + '" class="user-row">' +
        '<td><div class="name"><span class="avatar">' + avatarLetter(u.email) + '</span>' +
        '<span class="email-cell"><span class="email-line">' + R6T5.esc(u.email) + '</span>' +
        (u.displayName ? '<span class="faint small">' + R6T5.esc(u.displayName) + '</span>' : '') + '</span></span></div></td>' +
        '<td><select class="select cell-select" data-field="groupId">' + opts + '</select></td>' +
        '<td class="num">' + Admin.bytes(u.usedBytes) + '</td>' +
        '<td class="num">' + (u.fileCount ?? 0) + '</td>' +
        '<td>' + timeOrNone(u.registeredAt) + '</td>' +
        '<td>' + timeOrNone(u.lastLoginAt) + '</td>' +
        '<td>' + statusBadge(u) + '</td>' +
        '<td><span class="badge ' + (u.source === 'local' ? 'info' : 'acc') + '">' + sourceLabel(u.source) + '</span></td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('select[data-field="groupId"]').forEach(sel => {
      sel.addEventListener('change', async () => {
        const tr = sel.closest('tr');
        const id = tr.dataset.id;
        try {
          await Admin.patch('/api/admin/users/' + encodeURIComponent(id), { groupId: sel.value });
          R6T5.toast('已调整用户组', 'ok');
        } catch (e) { Admin.toastErr(e); await loadUsers(userLastQuery); }
      });
    });

    tbody.querySelectorAll('tr.user-row').forEach(tr => {
      tr.addEventListener('click', ev => {
        // 行内下拉 / 开关 / 按钮 / 链接点击不触发抽屉
        if (ev.target.closest('select,input,button,a,label')) return;
        const id = tr.dataset.id;
        const u = items.find(x => x.id === id);
        if (u) openDrawer(u);
      });
    });

    // 抽屉打开期间刷新过列表：同步抽屉里的用户数据
    if (drawerUser) {
      const fresh = items.find(x => x.id === drawerUser.id);
      if (fresh) { drawerUser = fresh; renderDrawer(); }
    }
  }

  /* ---------- 用户详情抽屉 ---------- */
  function bindDrawer() {
    const mask = Admin.$('#user-drawer-mask');
    const drawer = Admin.$('#user-drawer');
    if (!mask || !drawer) return;
    const close = Admin.$('#drawer-close');
    if (close) close.addEventListener('click', closeDrawer);
    mask.addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
  }

  function openDrawer(u) {
    drawerUser = u;
    renderDrawer();
    Admin.$('#user-drawer-mask').classList.add('open');
    Admin.$('#user-drawer').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeDrawer() {
    const mask = Admin.$('#user-drawer-mask');
    const drawer = Admin.$('#user-drawer');
    if (mask) mask.classList.remove('open');
    if (drawer) drawer.classList.remove('open');
    document.body.style.overflow = '';
    drawerUser = null;
  }

  function drawerField(k, v) {
    return '<div class="drawer-field"><span class="k">' + R6T5.esc(k) + '</span><span class="v">' + R6T5.esc(v) + '</span></div>';
  }

  function renderDrawer() {
    const body = Admin.$('#drawer-body');
    const u = drawerUser;
    if (!u || !body) return;
    const isLocal = u.source === 'local';
    const banned = u.status === 'banned';
    const folderHref = '/files?path=' + encodeURIComponent(u.email);
    const pwAttr = isLocal ? '' : ' disabled title="Supabase 账号密码需在 Supabase 侧修改"';
    body.innerHTML =
      '<div class="drawer-user">' +
        '<span class="avatar lg">' + avatarLetter(u.email) + '</span>' +
        '<div class="flex1"><div class="drawer-email">' + R6T5.esc(u.email) + '</div>' +
        '<div class="faint small">' + R6T5.esc(u.displayName || '—') + '</div></div>' +
      '</div>' +
      '<div class="drawer-fields">' +
        drawerField('所属用户组', u.groupName || '未分组') +
        drawerField('最后登录时间', timeOrNone(u.lastLoginAt)) +
        drawerField('注册成功时间', timeOrNone(u.registeredAt)) +
        drawerField('当前状态', banned ? '已封禁' : '正常') +
        drawerField('账号来源', sourceLabel(u.source)) +
      '</div>' +
      '<div class="drawer-actions">' +
        '<a class="btn sm" href="' + R6T5.esc(folderHref) + '" target="_blank" rel="noopener">打开用户文件夹</a>' +
        '<button class="btn sm" type="button" id="drawer-ban">' + (banned ? '解封' : '封禁') + '</button>' +
        '<button class="btn sm" type="button" id="drawer-password"' + pwAttr + '>修改密码</button>' +
        '<button class="btn sm danger" type="button" id="drawer-delete">一键删号</button>' +
      '</div>';

    Admin.$('#drawer-ban').addEventListener('click', onToggleBan);
    Admin.$('#drawer-password').addEventListener('click', openPasswordModal);
    Admin.$('#drawer-delete').addEventListener('click', openDeleteModal);
  }

  async function onToggleBan() {
    const u = drawerUser;
    if (!u) return;
    const next = u.status === 'banned' ? 'active' : 'banned';
    try {
      const r = await Admin.patch('/api/admin/users/' + encodeURIComponent(u.id), { status: next });
      R6T5.toast(next === 'banned' ? '已封禁，该用户会话立即失效' : '已解封', 'ok');
      await loadUsers(userLastQuery);
      if (r && r.item) { drawerUser = r.item; renderDrawer(); }
    } catch (e) { Admin.toastErr(e); }
  }

  /* ---------- 重置密码 ---------- */
  function openPasswordModal() {
    const u = drawerUser;
    if (!u) return;
    if (u.source !== 'local') { R6T5.toast('Supabase 账号密码请在 Supabase 侧修改', 'warn'); return; }
    Admin.$('#pw-err').textContent = '';
    Admin.$('#pw-new').value = '';
    R6T5.modal.open('#m-user-password');
  }

  async function onPasswordSubmit(ev) {
    ev.preventDefault();
    const u = drawerUser;
    const err = Admin.$('#pw-err');
    const pw = Admin.$('#pw-new').value;
    if (!u) return;
    if (!pw || pw.length < 6) { err.textContent = '密码至少 6 位'; return; }
    try {
      await Admin.post('/api/admin/users/' + encodeURIComponent(u.id) + '/password', { password: pw });
      R6T5.toast('密码已重置', 'ok');
      R6T5.modal.close('#m-user-password');
    } catch (e) {
      err.textContent = (e && e.message) || '重置失败';
      Admin.toastErr(e);
    }
  }

  /* ---------- 一键删号 ---------- */
  function openDeleteModal() {
    const u = drawerUser;
    if (!u) return;
    Admin.$('#del-user-label').textContent = '确定删除账号「' + u.email + '」吗？该操作不可撤销。';
    Admin.$('#del-sb-note').classList.toggle('hide', u.source === 'local');
    Admin.$('#del-err').textContent = '';
    const radio = Admin.$('input[name="del-files"][value="0"]');
    if (radio) radio.checked = true;
    syncDeleteWarn();
    R6T5.modal.open('#m-user-delete');
  }

  function syncDeleteWarn() {
    const warn = Admin.$('#del-files-warn');
    const checked = Admin.$('input[name="del-files"]:checked');
    if (warn) warn.classList.toggle('hide', !checked || checked.value !== '1');
  }

  async function onDeleteConfirm() {
    const u = drawerUser;
    const err = Admin.$('#del-err');
    if (!u) return;
    const checked = Admin.$('input[name="del-files"]:checked');
    const deleteFiles = checked ? checked.value : '0';
    err.textContent = '';
    try {
      const r = await Admin.del('/api/admin/users/' + encodeURIComponent(u.id), { deleteFiles });
      R6T5.modal.close('#m-user-delete');
      closeDrawer();
      R6T5.toast((r && r.message) || '账号已删除', 'ok');
      await loadUsers(userLastQuery);
    } catch (e) {
      err.textContent = (e && e.message) || '删除失败';
      Admin.toastErr(e);
    }
  }

  /* ---------- 新建账号 ---------- */
  function openCreateUserModal() {
    const form = Admin.$('#user-create-form');
    if (form) form.reset();
    Admin.$('#cu-err').textContent = '';
    const sel = Admin.$('#cu-group');
    if (sel) {
      sel.innerHTML = '<option value="">未分组</option>' + userGroups.map(g =>
        '<option value="' + R6T5.esc(g.id) + '">' + R6T5.esc(g.name) + '</option>').join('');
    }
    R6T5.modal.open('#m-user-create');
  }

  async function onCreateUserSubmit(ev) {
    ev.preventDefault();
    const err = Admin.$('#cu-err');
    const email = Admin.$('#cu-email').value.trim().toLowerCase();
    const password = Admin.$('#cu-password').value;
    const displayName = Admin.$('#cu-display').value.trim();
    const groupId = Admin.$('#cu-group').value || null;
    if (!email) { err.textContent = '请填写邮箱'; return; }
    if (!password || password.length < 6) { err.textContent = '密码至少 6 位'; return; }
    try {
      await Admin.post('/api/admin/users', { email, password, displayName, groupId });
      R6T5.toast('账号已创建', 'ok');
      R6T5.modal.close('#m-user-create');
      await loadUsers(userLastQuery);
    } catch (e) {
      // 412 supabase_not_configured 等：后端 message 原样展示在弹窗内
      err.textContent = (e && e.message) || '创建失败';
      Admin.toastErr(e);
    }
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

    // 三个限额输入的即时字节预览
    [['g-space', 'g-space-v', 'g-space-u', 'g-space-pv'],
     ['g-file', 'g-file-v', 'g-file-u', 'g-file-pv'],
     ['g-traffic', 'g-traffic-v', 'g-traffic-u', 'g-traffic-pv']].forEach(([, vId, uId, pvId]) => {
      const v = Admin.$('#' + vId), u = Admin.$('#' + uId);
      if (v) v.addEventListener('input', () => Admin.refreshLimitPreview(vId, uId, pvId));
      if (u) u.addEventListener('change', () => Admin.refreshLimitPreview(vId, uId, pvId));
    });

    bindSudoConfirm();
  }

  /* sudo 复选框二次确认：取消回退；取消勾选不需要确认 */
  function bindSudoConfirm() {
    const box = Admin.$('#g-sudo');
    const modal = Admin.$('#m-sudo-confirm');
    if (!box || !modal) return;
    const cancel = () => { box.checked = false; R6T5.modal.close('#m-sudo-confirm'); };
    box.addEventListener('change', () => {
      if (box.checked) {
        box.checked = false; // 先回退，等确认后再勾上
        R6T5.modal.open('#m-sudo-confirm');
      }
    });
    const cancelBtn = Admin.$('#sudo-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancel);
    modal.addEventListener('click', e => { if (e.target === modal) cancel(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) cancel();
    });
    const confirmBtn = Admin.$('#sudo-confirm');
    if (confirmBtn) confirmBtn.addEventListener('click', () => {
      box.checked = true;
      R6T5.modal.close('#m-sudo-confirm');
    });
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
    box.innerHTML = '<div class="grid g3">' + items.map(g => {
      const badges =
        (g.allowSelfSignup ? '<span class="badge info">自助注册</span>' : '') +
        (g.isSudo ? '<span class="badge warn">sudo</span>' : '') +
        (g.isDefault ? '<span class="badge acc">默认组</span>' : '');
      return '<div class="card group-card" data-id="' + R6T5.esc(g.id) + '">' +
      '<div class="gc-head"><h3>' + R6T5.esc(g.name) + '</h3>' + badges + '</div>' +
      '<div class="gc-grid">' +
      '<div class="gc-cell"><div class="k">空间上限</div><div class="v">' + R6T5.esc(g.spaceLimitText || Admin.bytes(g.spaceLimitBytes)) + '</div></div>' +
      '<div class="gc-cell"><div class="k">单文件上限</div><div class="v">' + R6T5.esc(g.maxFileSizeText || Admin.bytes(g.maxFileSizeBytes)) + '</div></div>' +
      '<div class="gc-cell"><div class="k">7 天上传流量</div><div class="v">' + R6T5.esc(g.traffic7dLimitText || Admin.bytes(g.traffic7dLimitBytes)) + '</div></div>' +
      '</div>' +
      '<div class="row tight"><span class="muted small">成员 ' + (g.userCount || 0) + ' 人</span><span class="spacer"></span>' +
      '<button class="btn sm" type="button" data-act="edit">编辑</button>' +
      '<button class="btn sm danger" type="button" data-act="del">删除</button></div>' +
      '</div>';
    }).join('') + '</div>';

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

    const setLimit = (prefix, bytesStr) => {
      const parts = Admin.splitLimit(bytesStr);
      Admin.$('#' + prefix + '-v').value = parts ? parts.value : '';
      Admin.$('#' + prefix + '-u').value = parts ? parts.unit : 'GB';
      Admin.refreshLimitPreview(prefix + '-v', prefix + '-u', prefix + '-pv');
    };
    setLimit('g-space', g && g.spaceLimitBytes);
    setLimit('g-file', g && g.maxFileSizeBytes);
    setLimit('g-traffic', g && g.traffic7dLimitBytes);
    Admin.$('#g-name').value = g ? g.name : '';
    Admin.$('#g-default').checked = !!(g && g.isDefault);
    Admin.$('#g-self-signup').checked = !!(g && g.allowSelfSignup);
    Admin.$('#g-sudo').checked = !!(g && g.isSudo);
    R6T5.modal.open('#m-group');
  }

  async function onGroupSubmit(ev) {
    ev.preventDefault();
    const err = Admin.$('#group-err');
    err.textContent = '';
    const name = Admin.$('#g-name').value.trim();
    const space = Admin.readLimit('g-space-v', 'g-space-u');
    const file = Admin.readLimit('g-file-v', 'g-file-u');
    const traffic = Admin.readLimit('g-traffic-v', 'g-traffic-u');
    if (!name) { err.textContent = '请填写组名'; return; }
    if (!space || !file || !traffic) { err.textContent = '三个上限都需填写合法数值'; return; }
    // 两种写法都带：对象写法为契约主形态；字节字符串为旧写法兼容（含当前 PATCH 适配层）
    const body = {
      name,
      spaceLimit: { value: space.value, unit: space.unit },
      spaceLimitBytes: space.bytes.toString(),
      maxFileSize: { value: file.value, unit: file.unit },
      maxFileSizeBytes: file.bytes.toString(),
      traffic7dLimit: { value: traffic.value, unit: traffic.unit },
      traffic7dLimitBytes: traffic.bytes.toString(),
      allowSelfSignup: Admin.$('#g-self-signup').checked,
      isSudo: Admin.$('#g-sudo').checked,
      isDefault: Admin.$('#g-default').checked
    };
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

  /* ---------- 分享 shares（管理端列表 + 撤销） ---------- */
  const ADMIN_SHARE_STATUS = {
    active: { label: '有效', cls: 'ok' },
    expired: { label: '已过期', cls: 'warn' },
    revoked: { label: '已撤销', cls: 'danger' },
    exhausted: { label: '次数用尽', cls: 'danger' }
  };
  const adminShareState = { status: '', email: '' };

  async function initShares() {
    Admin.bindLogout();
    await Admin.requireAdmin();

    const sel = Admin.$('#share-status');
    const email = Admin.$('#share-email');
    Admin.$('#share-search').addEventListener('click', () => {
      adminShareState.status = sel.value;
      adminShareState.email = email.value.trim();
      loadAdminShares();
    });
    sel.addEventListener('change', () => {
      adminShareState.status = sel.value;
      adminShareState.email = email.value.trim();
      loadAdminShares();
    });
    email.addEventListener('keydown', e => {
      if (e.key === 'Enter') { adminShareState.email = email.value.trim(); loadAdminShares(); }
    });

    await loadAdminShares();
  }

  async function loadAdminShares() {
    const box = Admin.$('#share-state');
    const alertBox = Admin.$('#page-alert');
    Admin.clearAlert(alertBox);
    let d;
    try {
      d = await Admin.get('/api/admin/shares', { status: adminShareState.status, email: adminShareState.email, limit: 200 });
    } catch (e) { Admin.alert(alertBox, e, '分享列表读取失败'); box.innerHTML = ''; return; }
    const items = (d && d.items) || [];
    Admin.$('#share-count').textContent = '共 ' + ((d && d.total) != null ? d.total : items.length) + ' 条';

    if (!items.length) {
      box.innerHTML = '<div class="empty"><div class="ico">↗</div><h3>没有匹配的分享</h3>' +
        '<p>调整状态或邮箱筛选后重试；当前还没有对外分享链接。</p></div>';
      return;
    }

    box.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
      '<th>分享者</th><th>对象</th><th>类型</th><th>状态</th><th>有效期</th>' +
      '<th class="num">已下载 / 上限</th><th>提取码</th><th>创建时间</th><th></th>' +
      '</tr></thead><tbody>' +
      items.map(it => {
        const st = ADMIN_SHARE_STATUS[it.status] || { label: it.status || '—', cls: '' };
        const dl = it.maxDownloads == null ? it.downloadCount + ' / 不限' : it.downloadCount + ' / ' + it.maxDownloads;
        return '<tr data-id="' + R6T5.esc(it.id) + '">' +
          '<td>' + R6T5.esc(it.email || '—') + '</td>' +
          '<td><div class="name"><span class="fname">' + R6T5.esc(it.name) + '</span></div>' +
          '<div class="faint small mono-sm">' + R6T5.esc(it.path || '') + '</div></td>' +
          '<td>' + (it.isDir ? '文件夹' : '文件') + '</td>' +
          '<td><span class="badge ' + st.cls + '">' + st.label + '</span></td>' +
          '<td>' + (it.expiresAt ? Admin.time(it.expiresAt) : '永久') + '</td>' +
          '<td class="num">' + dl + '</td>' +
          '<td>' + (it.hasCode ? '<span class="badge warn">有</span>' : '<span class="badge">无</span>') + '</td>' +
          '<td>' + Admin.time(it.createdAt) + '</td>' +
          '<td><div class="row-actions"><button class="btn sm danger" data-act="revoke" type="button">撤销</button></div></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';

    box.querySelectorAll('[data-act="revoke"]').forEach(btn =>
      btn.addEventListener('click', () => onAdminRevoke(items.find(x => x.id === btn.closest('tr').dataset.id))));
  }

  async function onAdminRevoke(it) {
    if (!it) return;
    if (!confirm('确定撤销「' + it.name + '」的分享？撤销后链接立即失效，他人无法再访问。')) return;
    try {
      await Admin.del('/api/admin/shares/' + encodeURIComponent(it.id));
      R6T5.toast('分享已撤销', 'ok');
      await loadAdminShares();
    } catch (e) { Admin.toastErr(e); }
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

  /* ---------- 品牌与外观（P8-A） ---------- */
  const BRAND_SLOT_FIELDS = {
    logoLight: 'logoLightUrl', logoDark: 'logoDarkUrl', favicon: 'faviconUrl',
    icon192: 'icon192Url', iconLarge: 'iconLargeUrl',
  };
  const BRAND_FALLBACKS = {
    logoLight: '/assets/favicon.svg', logoDark: '/assets/icons/favicon.svg',
    favicon: '/assets/favicon.svg', icon192: '/assets/icons/favicon.svg',
    iconLarge: '/assets/icons/favicon.svg',
  };

  function brandRenderSlots(cfg) {
    Admin.$$('#brand-slots .brand-slot').forEach(wrap => {
      const slot = wrap.dataset.slot;
      const field = BRAND_SLOT_FIELDS[slot];
      const value = (cfg && cfg[field]) || '';
      wrap.querySelector('[data-brand-url]').value = value;
      wrap.querySelector('[data-brand-default]').classList.toggle('hide', !!value);
      wrap.querySelector('[data-brand-meta]').textContent = value
        ? '当前：' + value
        : '回落默认 ' + BRAND_FALLBACKS[slot];
    });
    const ta = Admin.$('#b-sidebarHtml');
    if (ta) ta.value = (cfg && cfg.sidebarHtml) || '';
  }

  async function initBrandSettings() {
    const box = Admin.$('#brand-slots');
    if (!box) return;
    let cfg;
    try { cfg = await Admin.get('/api/admin/branding'); }
    catch (e) { R6T5.toastError(e); return; }
    brandRenderSlots(cfg);

    async function reloadBrand() {
      try { const c = await Admin.get('/api/admin/branding'); brandRenderSlots(c); } catch (_) {}
      R6T5.brand.load();
    }

    // 上传
    Admin.$$('#brand-slots [data-brand-file]').forEach(input => {
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const slot = input.closest('.brand-slot').dataset.slot;
        const fd = new FormData();
        fd.append('file', file);
        try {
          const r = await R6T5.request('/api/admin/branding/upload?slot=' + encodeURIComponent(slot), { method: 'POST', body: fd });
          R6T5.toast('已上传 ' + slot, 'ok');
          input.value = '';
          await reloadBrand();
        } catch (e) { R6T5.toastError(e); input.value = ''; }
      });
    });

    // 清除
    Admin.$$('#brand-slots [data-brand-clear]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slot = btn.closest('.brand-slot').dataset.slot;
        try {
          await Admin.del('/api/admin/branding/' + encodeURIComponent(slot));
          R6T5.toast('已清除 ' + slot, 'ok');
          await reloadBrand();
        } catch (e) { R6T5.toastError(e); }
      });
    });

    // 预览
    const previewBtn = Admin.$('#b-preview-btn');
    if (previewBtn) previewBtn.addEventListener('click', () => {
      const raw = Admin.$('#b-sidebarHtml').value || '';
      const clean = R6T5.sanitizeSidebarHtml(raw);
      const frame = Admin.$('#brand-preview-frame');
      frame.srcdoc = R6T5.brand.sideHtmlDoc(clean || '<p>（无内容）</p>', R6T5.theme.get());
      frame.onload = () => R6T5.brand.fitFrame(frame, 260);
      R6T5.modal.open('#m-brand-preview');
    });

    // 保存
    const saveBtn = Admin.$('#b-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const body = {};
      Admin.$$('#brand-slots .brand-slot').forEach(wrap => {
        const slot = wrap.dataset.slot;
        body[BRAND_SLOT_FIELDS[slot]] = wrap.querySelector('[data-brand-url]').value.trim();
      });
      body.sidebarHtml = Admin.$('#b-sidebarHtml').value;
      try {
        const r = await Admin.patch('/api/admin/branding', body);
        const item = r && r.item;
        if (item) brandRenderSlots(item);
        if (r && r.sidebarHtmlRaw && item && item.sidebarHtml && r.sidebarHtmlRaw !== item.sidebarHtml) {
          R6T5.toast('部分侧边栏内容已被安全移除', 'warn');
        } else {
          R6T5.toast('品牌配置已保存', 'ok');
        }
        await reloadBrand();
      } catch (e) { R6T5.toastError(e); }
    });
  }

  /* ---------- P8-B：邮件（SMTP） ---------- */

  function providerReasonText(reason) {
    switch (reason) {
      case 'missing_secret': return '当前 provider 未配置服务端密钥，场景开关暂不可用';
      case 'provider_not_set': return '尚未选择验证码类型';
      case 'not_active': return '';
      case 'scene_disabled': return '';
      default: return reason ? ('当前不可用：' + reason) : '';
    }
  }

  async function loadMail() {
    let d;
    try { d = await Admin.get('/api/admin/mail'); }
    catch (e) { Admin.toastErr(e); return; }
    Admin.$('#mail-host').value = d.host || '';
    Admin.$('#mail-port').value = d.port ?? 587;
    Admin.$('#mail-username').value = d.username || '';
    const pw = Admin.$('#mail-password');
    pw.value = '';
    pw.placeholder = d.passwordSet ? '已设置（' + (d.passwordMasked || '••••') + '），留空不修改' : '留空表示不修改';
    Admin.$('#mail-secure').checked = !!d.secure;
    Admin.$('#mail-fromName').value = d.fromName || '';
    Admin.$('#mail-fromEmail').value = d.fromEmail || '';
    Admin.$('#mail-replyTo').value = d.replyTo || '';
    Admin.$('#mail-timeout').value = d.connTimeoutMs ?? 10000;
    Admin.$('#mail-status').innerHTML = d.configured
      ? '<span class="badge ok"><span class="dot-s"></span>已配置</span>'
      : '<span class="badge warn">未配置</span>';
    Admin.$('#mail-contact').textContent = d.contactEmail || '未配置';
  }

  async function onMailSave(ev) {
    ev.preventDefault();
    const err = Admin.$('#mail-err');
    err.textContent = '';
    const body = {
      host: Admin.$('#mail-host').value.trim(),
      port: Number(Admin.$('#mail-port').value),
      username: Admin.$('#mail-username').value.trim(),
      secure: Admin.$('#mail-secure').checked,
      fromName: Admin.$('#mail-fromName').value.trim(),
      fromEmail: Admin.$('#mail-fromEmail').value.trim(),
      replyTo: Admin.$('#mail-replyTo').value.trim(),
      connTimeoutMs: Number(Admin.$('#mail-timeout').value)
    };
    const pw = Admin.$('#mail-password').value;
    if (pw) body.password = pw;
    try {
      await Admin.patch('/api/admin/mail', body);
      R6T5.toast('邮件配置已保存', 'ok');
      await loadMail();
    } catch (e) {
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

  function openMailTest() {
    const err = Admin.$('#mail-test-err');
    if (err) err.textContent = '';
    Admin.$('#mail-test-to').value = '';
    R6T5.modal.open('#m-mail-test');
  }

  async function onMailTest() {
    const err = Admin.$('#mail-test-err');
    const to = (Admin.$('#mail-test-to').value || '').trim();
    if (!to) { err.textContent = '收件人不能为空'; return; }
    try {
      await Admin.post('/api/admin/mail/test', { to });
      R6T5.toast('测试邮件已发送到 ' + to, 'ok');
      R6T5.modal.close('#m-mail-test');
    } catch (e) {
      const code = e && e.details && e.details.smtpCode ? '（SMTP 码：' + e.details.smtpCode + '）' : '';
      err.textContent = ((e && e.message) || '测试发信失败') + code;
      Admin.toastErr(e);
    }
  }

  /* ---------- P8-B：注册策略 + 验证码（/api/admin/security） ---------- */

  async function loadSecurity() {
    let d;
    try { d = await Admin.get('/api/admin/security'); }
    catch (e) { Admin.toastErr(e); return; }

    const s = d.signup || {};
    Admin.$('#policy-allow').value = String(s.allowDomains || '').split(',').map(x => x.trim()).filter(Boolean).join('\n');
    Admin.$('#policy-deny').value = String(s.denyDomains || '').split(',').map(x => x.trim()).filter(Boolean).join('\n');
    Admin.$('#policy-forbid-sub').checked = !!s.forbidSubAddress;

    const cap = d.captcha || {};
    Admin.$('#cap-provider').value = cap.provider || 'turnstile';
    Admin.$('#cap-siteKey').value = cap.siteKey || '';
    const sec = Admin.$('#cap-secretKey');
    sec.value = '';
    sec.placeholder = cap.secretSet ? '已设置，留空不修改' : '留空表示不修改';
    Admin.$('#cap-onLogin').checked = !!cap.onLogin;
    Admin.$('#cap-onSignup').checked = !!cap.onSignup;
    Admin.$('#cap-onRecover').checked = !!cap.onRecover;

    const providers = cap.providers || {};
    const active = cap.provider ? providers[cap.provider] : null;
    const reason = active && active.disabledReason;
    const reasonText = providerReasonText(reason);
    Admin.$('#cap-scene-reason').textContent = reasonText;
    const disable = !!reason && reason !== 'not_active' && reason !== 'scene_disabled';
    ['#cap-onLogin', '#cap-onSignup', '#cap-onRecover'].forEach(id => { Admin.$(id).disabled = disable; });
  }

  async function onPolicySave(ev) {
    ev.preventDefault();
    const err = Admin.$('#policy-err');
    err.textContent = '';
    const lines = v => v.split(/\r?\n/).map(x => x.trim()).filter(Boolean).join(', ');
    const body = { signup: {
      allowDomains: lines(Admin.$('#policy-allow').value),
      denyDomains: lines(Admin.$('#policy-deny').value),
      forbidSubAddress: Admin.$('#policy-forbid-sub').checked
    }};
    try {
      await Admin.patch('/api/admin/security', body);
      R6T5.toast('注册策略已保存', 'ok');
      await loadSecurity();
    } catch (e) {
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

  async function onCaptchaSave(ev) {
    ev.preventDefault();
    const err = Admin.$('#cap-err');
    err.textContent = '';
    const body = { captcha: {
      provider: Admin.$('#cap-provider').value,
      siteKey: Admin.$('#cap-siteKey').value.trim(),
      onLogin: Admin.$('#cap-onLogin').checked,
      onSignup: Admin.$('#cap-onSignup').checked,
      onRecover: Admin.$('#cap-onRecover').checked
    }};
    const secKey = Admin.$('#cap-secretKey').value;
    if (secKey) body.captcha.secretKey = secKey;
    try {
      await Admin.patch('/api/admin/security', body);
      R6T5.toast('验证码配置已保存', 'ok');
      await loadSecurity();
    } catch (e) {
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

  /* ---------- P8-B：第三方登录 ---------- */

  async function loadOauth() {
    let providers = [];
    try {
      const r = await Admin.get('/api/auth/oauth/providers');
      providers = (r && r.providers) || [];
    } catch (_) { providers = []; }
    const en = Admin.$('#oauth-enabled');
    if (en) {
      en.innerHTML = providers.length
        ? providers.map(p => '<span class="badge acc">' + R6T5.esc(p.label) + '</span>').join(' ')
        : '<span class="faint">未启用</span>';
    }
    const cb = Admin.$('#oauth-callbacks');
    if (cb) {
      const origin = location.origin;
      cb.innerHTML = ['qq', 'logto', 'oidc'].map(id =>
        '<div class="kv-line"><span class="k">' + id + ' 回调地址</span><span class="v">' +
        origin + '/api/auth/oauth/' + id + '/callback</span></div>'
      ).join('');
    }
  }

  async function onOauthSave() {
    const err = Admin.$('#oauth-err');
    err.textContent = '';
    const body = { oauth: {
      qq: { appId: Admin.$('#oauth-qq-appId').value.trim(), appKey: Admin.$('#oauth-qq-appKey').value.trim() },
      logto: {
        issuer: Admin.$('#oauth-logto-issuer').value.trim(),
        clientId: Admin.$('#oauth-logto-clientId').value.trim(),
        clientSecret: Admin.$('#oauth-logto-clientSecret').value.trim()
      },
      oidc: {
        issuer: Admin.$('#oauth-oidc-issuer').value.trim(),
        clientId: Admin.$('#oauth-oidc-clientId').value.trim(),
        clientSecret: Admin.$('#oauth-oidc-clientSecret').value.trim(),
        scope: Admin.$('#oauth-oidc-scope').value.trim()
      },
      redirectBase: Admin.$('#oauth-redirectBase').value.trim()
    }};
    try {
      await Admin.patch('/api/admin/security', body);
      await loadOauth();
      R6T5.toast('第三方登录配置已保存', 'ok');
    } catch (e) {
      err.textContent = (e && e.message) || '保存失败';
      Admin.toastErr(e);
    }
  }

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
    if (f.previewOffice) f.previewOffice.value = (s.preview && s.preview.office) || 'none';
    if (f.previewPdf) f.previewPdf.value = (s.preview && s.preview.pdf) || 'pdfjs';

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

    initBrandSettings();

    // P8-B：邮件 / 注册策略 / 验证码 / 第三方登录
    await loadMail();
    await loadSecurity();
    await loadOauth();
    const mailForm = Admin.$('#mail-form');
    if (mailForm) mailForm.addEventListener('submit', onMailSave);
    const mailTest = Admin.$('#mail-test-btn');
    if (mailTest) mailTest.addEventListener('click', openMailTest);
    const mailTestSend = Admin.$('#mail-test-send');
    if (mailTestSend) mailTestSend.addEventListener('click', onMailTest);
    const policyForm = Admin.$('#policy-form');
    if (policyForm) policyForm.addEventListener('submit', onPolicySave);
    const capForm = Admin.$('#captcha-form');
    if (capForm) capForm.addEventListener('submit', onCaptchaSave);
    const oauthSave = Admin.$('#oauth-save-btn');
    if (oauthSave) oauthSave.addEventListener('click', onOauthSave);

    await initUpdateStatus();
  }

  /* ---------- 关于 / 更新 ---------- */
  function updateStatusReasonText(reason) {
    switch (reason) {
      case 'network': return '：网络不可用';
      case 'invalid_json': return '：返回内容无法解析';
      default: return reason ? '：服务端响应异常（' + reason + '）' : '';
    }
  }

  async function initUpdateStatus() {
    const box = Admin.$('#update-status');
    if (!box) return;
    const latest = Admin.$('#update-latest');
    const btn = Admin.$('#update-check-btn');

    const paintCurrent = (cur) => {
      const v = Admin.$('#update-current-version');
      const b = Admin.$('#update-current-built');
      if (v) v.textContent = (cur && cur.version) || '—';
      if (b) b.textContent = cur && cur.builtAt ? Admin.time(cur.builtAt) : '—';
    };

    const render = (d) => {
      paintCurrent(d && d.current);
      if (!d) return;
      if (d.checked === false) {
        latest.classList.add('hide');
        box.innerHTML = '<div class="note warn"><span class="ico">!</span><div>暂时无法检查更新（无网络）' +
          R6T5.esc(updateStatusReasonText(d.reason)) + '</div></div>';
        return;
      }
      if (d.hasUpdate === false) {
        latest.classList.add('hide');
        box.innerHTML = '<div class="note ok"><span class="ico">✓</span><div>已是最新版本</div></div>';
        return;
      }
      if (d.hasUpdate === true && d.latest) {
        const L = d.latest;
        box.innerHTML = '<div class="note info"><span class="ico">i</span><div>发现新版本 ' +
          R6T5.esc(L.version || '') + '</div></div>';
        Admin.$('#update-latest-version').textContent = L.version || '—';
        Admin.$('#update-latest-published').textContent = L.publishedAt ? Admin.time(L.publishedAt) : '—';
        Admin.$('#update-latest-notes').textContent = L.notes || '';
        const link = Admin.$('#update-latest-link');
        if (L.commentUrl) { link.href = L.commentUrl; link.classList.remove('hide'); }
        else link.classList.add('hide');
        Admin.$('#update-latest-command').textContent = L.upgradeCommand || '';
        latest.classList.remove('hide');
      }
    };

    const load = async () => {
      box.innerHTML = '<div class="faint small">正在检查更新…</div>';
      latest.classList.add('hide');
      try {
        const d = await Admin.get('/api/admin/update-status');
        render(d);
      } catch (e) {
        // 无网 / 远端异常时按「暂时无法检查更新」处理，不弹红字错误
        box.innerHTML = '<div class="note warn"><span class="ico">!</span><div>暂时无法检查更新（无网络）</div></div>';
      }
    };

    if (btn) btn.addEventListener('click', load);

    const copyBtn = Admin.$('#update-copy-cmd');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const text = Admin.$('#update-latest-command').textContent;
      try {
        await navigator.clipboard.writeText(text);
        R6T5.toast('升级命令已复制', 'ok');
      } catch (_) {
        R6T5.toast('复制失败，请手动复制', 'warn');
      }
    });

    await load();
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
      themeDefault: f.themeDefault.value,
      preview: {
        office: f.previewOffice ? f.previewOffice.value : undefined,
        pdf: f.previewPdf ? f.previewPdf.value : undefined,
      }
    };
    try {
      await Admin.patch('/api/admin/settings', body);
      R6T5.toast('站点设置已保存', 'ok');
    } catch (e) { Admin.toastErr(e); }
  }

  /* ---------- 登录 login（管理员密码表单 + sudo 用户组账号表单） ---------- */
  function initLogin() {
    bindAdminPasswordForm();
    bindSudoLoginForm();
    showExistingSessionHint();
  }

  function bindAdminPasswordForm() {
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

  function bindSudoLoginForm() {
    const form = Admin.$('#sudo-form');
    if (!form) return;
    const err = Admin.$('#sudo-err');
    const email = Admin.$('#sudo-email');
    const pass = Admin.$('#sudo-password');
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      err.textContent = '';
      try {
        await R6T5.post('/api/auth/login', { email: email.value.trim(), password: pass.value });
        // 登录成功后再确认该会话具备管理访问权；非 sudo 组账号由会话接口 403 拒绝
        let adminOk = true;
        try { await R6T5.get('/api/admin/session'); }
        catch (_) { adminOk = false; }
        if (!adminOk) {
          const e = new Error('该账号不属于 sudo 用户组，请使用管理员密码登录');
          e.status = 403; throw e;
        }
        global.location.href = '/admin/home.html';
      } catch (e) {
        if (e && e.status === 403) err.textContent = '该账号不属于 sudo 用户组，请使用管理员密码登录';
        else err.textContent = (e && e.message) || '登录失败';
      }
    });
  }

  /* 已有前台账号会话时给一句提示（重定向由后端处理） */
  async function showExistingSessionHint() {
    const box = Admin.$('#existing-session-note');
    if (!box) return;
    try {
      const me = await R6T5.get('/api/me');
      if (me && me.user) box.classList.remove('hide');
    } catch (_) { /* 无前台会话，不提示 */ }
  }

  /* ---------- 弹窗通用绑定（遮罩点击 / ESC / data-close） ---------- */
  function bindModals() {
    Admin.$$('.modal-mask').forEach(m => { if (m.id) R6T5.modal.bind('#' + m.id); });
    Admin.$$('[data-close]').forEach(b => b.addEventListener('click', () => {
      const m = b.closest('.modal-mask');
      if (m && m.id) R6T5.modal.close('#' + m.id);
    }));
  }

  /* ---------- 商店（商品 / 订单 / 兑换码 / 积分 / 计费） ---------- */
  const shopState = { tab: 'products', groups: [], products: [], orders: [], codes: [] };

  function shopTabs() {
    Admin.$$('#shop-tabs button').forEach(b => b.addEventListener('click', () => {
      shopState.tab = b.dataset.tab;
      Admin.$$('#shop-tabs button').forEach(x => x.classList.toggle('active', x === b));
      Admin.$$('.tab-panel').forEach(p => p.classList.add('hide'));
      Admin.$('#tab-' + shopState.tab).classList.remove('hide');
    }));
  }

  function typeLabel(t) {
    return ({ group_upgrade: '会员', storage_pack: '容量包', points: '积分', storage: '容量', group: '会员' })[t] || t;
  }

  function orderStatusLabel(s) {
    return ({ pending: '待支付', paid: '已支付', refunded: '已退款', cancelled: '已取消' })[s] || s;
  }

  function statusBadge(s) {
    const cls = s === 'paid' ? 'ok' : (s === 'pending' ? 'warn' : (s === 'refunded' ? 'danger' : ''));
    return '<span class="badge ' + cls + '">' + orderStatusLabel(s) + '</span>';
  }

  async function loadGroups() {
    const d = await Admin.get('/api/admin/groups');
    shopState.groups = d.items || [];
    const opts = shopState.groups.map(g => '<option value="' + Admin.esc(g.id) + '">' + Admin.esc(g.name) + '</option>').join('');
    ['#p-group', '#r-group'].forEach(sel => {
      const el = Admin.$(sel);
      if (el) el.innerHTML = opts;
    });
  }

  async function loadProducts() {
    const tbody = Admin.$('#p-rows');
    const d = await Admin.get('/api/admin/store/products');
    shopState.products = d.items || [];
    Admin.$('#p-count').textContent = '共 ' + shopState.products.length + ' 个';
    if (!shopState.products.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7"><div class="empty"><div class="ico">◈</div><h3>还没有商品</h3><p>用上面的表单创建第一个会员或容量包。</p></div></td></tr>';
      return;
    }
    tbody.innerHTML = shopState.products.map(p => {
      const amount = p.type === 'storage_pack' ? Admin.bytes(p.storageBytes) : (p.durationDays ? p.durationDays + ' 天' : '—');
      return '<tr><td><b>' + Admin.esc(p.name) + '</b>' + (p.tag ? ' <span class="badge warn">' + Admin.esc(p.tag) + '</span>' : '') + '</td>' +
        '<td>' + typeLabel(p.type) + '</td>' +
        '<td class="num">¥' + (Number(p.priceMinor || 0) / 100).toFixed(2) + '</td>' +
        '<td class="num">' + (p.pointsPrice == null ? '—' : p.pointsPrice) + '</td>' +
        '<td>' + amount + '</td>' +
        '<td>' + (p.enabled ? '<span class="badge ok">上架</span>' : '<span class="badge">下架</span>') + '</td>' +
        '<td><div class="shop-actions">' +
        '<button class="btn sm ghost" data-act="toggle-product" data-id="' + Admin.esc(p.id) + '">' + (p.enabled ? '下架' : '上架') + '</button>' +
        '<button class="btn sm ghost danger" data-act="del-product" data-id="' + Admin.esc(p.id) + '">删除</button>' +
        '</div></td></tr>';
    }).join('');
  }

  async function createProduct(ev) {
    ev.preventDefault();
    const type = Admin.$('#p-type').value;
    const body = {
      type,
      name: Admin.$('#p-name').value.trim(),
      tag: Admin.$('#p-tag').value.trim() || null,
      description: Admin.$('#p-desc').value.trim() || null,
      priceMinor: Math.round(Number(Admin.$('#p-price').value || 0) * 100),
      pointsPrice: Admin.$('#p-points').value ? Number(Admin.$('#p-points').value) : null,
      allowPoints: Admin.$('#p-allow-points').checked,
      durationDays: Number(Admin.$('#p-days').value || 0),
      enabled: true
    };
    if (type === 'storage_pack') {
      const gb = Number(Admin.$('#p-storage').value);
      if (!gb) { R6T5.toast('容量包需要填写扩容容量', 'danger'); return; }
      body.storageBytes = String(BigInt(Math.round(gb)) * 1024n * 1024n * 1024n);
    } else {
      body.groupId = Admin.$('#p-group').value || null;
    }
    try {
      await Admin.post('/api/admin/store/products', body);
      R6T5.toast('商品已创建', 'ok');
      Admin.$('#product-form').reset();
      await loadProducts();
    } catch (e) { R6T5.toastError(e); }
  }

  async function toggleProduct(id, nextEnabled) {
    try {
      await Admin.patch('/api/admin/store/products/' + encodeURIComponent(id), { enabled: nextEnabled });
      await loadProducts();
    } catch (e) { R6T5.toastError(e); }
  }

  async function removeProduct(id) {
    if (!confirm('下架并删除该商品？已创建的订单不受影响。')) return;
    try {
      await Admin.del('/api/admin/store/products/' + encodeURIComponent(id));
      R6T5.toast('已删除', 'ok');
      await loadProducts();
    } catch (e) { R6T5.toastError(e); }
  }

  async function loadOrders() {
    const tbody = Admin.$('#o-rows');
    const q = {};
    const st = Admin.$('#o-status').value; if (st) q.status = st;
    const ch = Admin.$('#o-channel').value; if (ch) q.channel = ch;
    const em = Admin.$('#o-email').value.trim(); if (em) q.email = em;
    let d;
    try { d = await Admin.get('/api/admin/store/orders', q); }
    catch (e) { R6T5.toastError(e); return; }
    const items = d.items || [];
    shopState.orders = items;
    Admin.$('#o-count').textContent = '共 ' + (d.total != null ? d.total : items.length) + ' 条';
    if (!items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="9"><div class="empty"><div class="ico">▢</div><h3>没有订单</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = items.map(o => {
      const acts = [];
      if (o.status === 'pending') {
        acts.push('<button class="btn sm ghost" data-act="order-paid" data-id="' + Admin.esc(o.orderNo) + '">标记已付</button>');
        acts.push('<button class="btn sm ghost" data-act="order-cancel" data-id="' + Admin.esc(o.orderNo) + '">取消</button>');
      }
      if (o.status === 'paid') {
        acts.push('<button class="btn sm ghost danger" data-act="order-refund" data-id="' + Admin.esc(o.orderNo) + '">退款</button>');
      }
      const product = shopState.products.find(p => p.id === o.productId);
      return '<tr><td><code>' + Admin.esc(o.orderNo) + '</code></td>' +
        '<td>' + Admin.esc(o.email || '匿名') + '</td>' +
        '<td>' + Admin.esc(o.shareToken ? ('付费分享 ' + o.shareToken.slice(0, 8)) : (product ? product.name : (o.productId || '—'))) + '</td>' +
        '<td class="num">¥' + (Number(o.amountMinor || 0) / 100).toFixed(2) + '</td>' +
        '<td class="num">' + (o.pointsUsed || 0) + '</td>' +
        '<td>' + (o.channel === 'points' ? '积分' : '现金') + '</td>' +
        '<td>' + statusBadge(o.status) + '</td>' +
        '<td>' + Admin.time(o.createdAt) + '</td>' +
        '<td><div class="shop-actions">' + acts.join('') + '</div></td></tr>';
    }).join('');
  }

  async function orderAction(orderNo, action) {
    const map = { 'order-paid': 'mark-paid', 'order-refund': 'refund', 'order-cancel': 'cancel' };
    const label = { 'order-paid': '标记为已支付', 'order-refund': '退款', 'order-cancel': '取消' }[action];
    if (!confirm('确认' + label + '订单 ' + orderNo + '？')) return;
    try {
      await Admin.post('/api/admin/store/orders/' + encodeURIComponent(orderNo) + '/' + map[action]);
      R6T5.toast(label + '成功', 'ok');
      await loadOrders();
    } catch (e) { R6T5.toastError(e); }
  }

  async function loadCodes() {
    const tbody = Admin.$('#r-rows');
    let d;
    try { d = await Admin.get('/api/admin/store/redeem-codes'); }
    catch (e) { R6T5.toastError(e); return; }
    const items = d.items || [];
    shopState.codes = items;
    Admin.$('#r-list-count').textContent = '共 ' + items.length + ' 个';
    if (!items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7"><div class="empty"><div class="ico">▢</div><h3>还没有兑换码</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = items.map(c => {
      let amount = '—';
      if (c.type === 'points') amount = (c.points || 0) + ' 积分';
      else if (c.type === 'storage') amount = Admin.bytes(c.storageBytes);
      else amount = '会员 ' + (c.durationDays ? c.durationDays + ' 天' : '永久');
      return '<tr><td><code>' + Admin.esc(c.code) + '</code></td>' +
        '<td>' + typeLabel(c.type) + '</td><td>' + amount + '</td>' +
        '<td>' + c.usedCount + '/' + c.maxUses + '</td>' +
        '<td><span class="badge ' + (c.status === 'active' ? 'ok' : '') + '">' + Admin.esc(c.status) + '</span></td>' +
        '<td>' + Admin.time(c.createdAt) + '</td>' +
        '<td><div class="shop-actions">' +
        (c.status === 'active' ? '<button class="btn sm ghost" data-act="code-disable" data-id="' + Admin.esc(c.code) + '">禁用</button>' : '') +
        '<button class="btn sm ghost danger" data-act="code-delete" data-id="' + Admin.esc(c.code) + '">删除</button>' +
        '</div></td></tr>';
    }).join('');
  }

  async function generateCodes(ev) {
    ev.preventDefault();
    const type = Admin.$('#r-type').value;
    const body = {
      type,
      count: Number(Admin.$('#r-count').value || 0),
      prefix: Admin.$('#r-prefix').value.trim(),
      maxUses: Number(Admin.$('#r-maxuses').value || 1),
      durationDays: Number(Admin.$('#r-days').value || 0)
    };
    const bound = Admin.$('#r-bound').value.trim();
    if (bound) body.boundEmail = bound;
    if (type === 'points') body.points = Number(Admin.$('#r-points').value || 0);
    if (type === 'storage') {
      const gb = Number(Admin.$('#r-storage').value || 0);
      body.storageBytes = String(BigInt(Math.round(gb)) * 1024n * 1024n * 1024n);
    }
    if (type === 'group') body.groupId = Admin.$('#r-group').value;
    try {
      const res = await Admin.post('/api/admin/store/redeem-codes', body);
      Admin.$('#redeem-gen-result').innerHTML = '<div class="note ok"><span class="ico">✓</span><div>已生成 ' +
        (res.codes || []).length + ' 个兑换码，批次 <code>' + Admin.esc(res.batchId || '') + '</code></div></div>';
      R6T5.toast('生成完成', 'ok');
      await loadCodes();
    } catch (e) { R6T5.toastError(e); }
  }

  async function codeAction(code, action) {
    const label = { 'code-disable': '禁用', 'code-delete': '删除' }[action];
    if (!confirm('确认' + label + '兑换码 ' + code + '？')) return;
    try {
      if (action === 'code-disable') await Admin.patch('/api/admin/store/redeem-codes/' + encodeURIComponent(code), {});
      else await Admin.del('/api/admin/store/redeem-codes/' + encodeURIComponent(code));
      R6T5.toast(label + '成功', 'ok');
      await loadCodes();
    } catch (e) { R6T5.toastError(e); }
  }

  async function adjustPoints(ev) {
    ev.preventDefault();
    const body = {
      email: Admin.$('#pt-email').value.trim(),
      delta: Number(Admin.$('#pt-delta').value || 0),
      note: Admin.$('#pt-note').value.trim() || null
    };
    try {
      const res = await Admin.post('/api/admin/points/adjust', body);
      R6T5.toast('调账完成，余额 ' + res.balance, 'ok');
      Admin.$('#points-form').reset();
      await loadLedger();
    } catch (e) { R6T5.toastError(e); }
  }

  async function loadLedger() {
    const tbody = Admin.$('#pt-rows');
    const q = { limit: 100 };
    const em = Admin.$('#pt-filter-email').value.trim();
    if (em) q.email = em;
    let d;
    try { d = await Admin.get('/api/admin/points/ledger', q); }
    catch (e) { R6T5.toastError(e); return; }
    const items = d.items || [];
    if (!items.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="6"><div class="empty"><div class="ico">▢</div><h3>没有流水</h3></div></td></tr>';
      return;
    }
    tbody.innerHTML = items.map(r => '<tr><td>' + Admin.time(r.createdAt) + '</td>' +
      '<td>' + Admin.esc(r.email) + '</td>' +
      '<td class="num">' + (r.delta > 0 ? '+' : '') + r.delta + '</td>' +
      '<td class="num">' + r.balanceAfter + '</td>' +
      '<td>' + Admin.esc(r.source) + '</td>' +
      '<td>' + Admin.esc(r.note || '—') + '</td></tr>').join('');
  }

  async function loadBilling() {
    let cfg;
    try { cfg = await Admin.get('/api/admin/store/settings'); }
    catch (e) { R6T5.toastError(e); return; }
    Admin.$('#b-ppm').value = cfg.pointsPerMinorUnit;
    Admin.$('#b-commission').value = cfg.commissionPercent;
    Admin.$('#b-grace').value = cfg.overQuotaGraceDays;
    Admin.$('#b-notify').value = cfg.notifyOnExpireDays;
    Admin.$('#b-cron1').value = cfg.cronNotifyExpr;
    Admin.$('#b-cron2').value = cfg.cronBanExpr;
    Admin.$('#b-anon').checked = !!cfg.allowAnonymousPurchase;
    Admin.$('#b-nav').checked = !!cfg.storeNavEnabled;
  }

  async function saveBilling(ev) {
    ev.preventDefault();
    const body = {
      'billing.pointsPerMinorUnit': Number(Admin.$('#b-ppm').value || 0),
      'billing.commissionPercent': Number(Admin.$('#b-commission').value || 10),
      'billing.overQuotaGraceDays': Number(Admin.$('#b-grace').value || 0),
      'billing.notifyOnExpireDays': Number(Admin.$('#b-notify').value || 0),
      'billing.cronNotifyExpr': Admin.$('#b-cron1').value.trim(),
      'billing.cronBanExpr': Admin.$('#b-cron2').value.trim(),
      'billing.allowAnonymousPurchase': Admin.$('#b-anon').checked,
      'billing.storeNavEnabled': Admin.$('#b-nav').checked
    };
    try {
      await Admin.patch('/api/admin/store/settings', body);
      R6T5.toast('设置已保存', 'ok');
      await loadCron();
    } catch (e) { R6T5.toastError(e); }
  }

  async function loadCron() {
    const tbody = Admin.$('#cron-rows');
    let d;
    try { d = await Admin.get('/api/admin/store/cron'); }
    catch (e) { R6T5.toastError(e); return; }
    const names = { notify: '到期提醒', ban: '超额封禁' };
    tbody.innerHTML = Object.keys(d).map(k => {
      const v = d[k] || {};
      return '<tr><td><b>' + (names[k] || k) + '</b></td>' +
        '<td><code>' + Admin.esc(v.expr) + '</code></td>' +
        '<td>' + (v.lastRunAt ? Admin.time(v.lastRunAt) : '—') + '</td>' +
        '<td>' + (v.lastOk == null ? '—' : (v.lastOk ? '<span class="badge ok">成功</span>' : '<span class="badge danger">失败</span>')) +
        (v.lastResult ? ' <span class="hint">' + Admin.esc(v.lastResult) + '</span>' : '') + '</td>' +
        '<td><button class="btn sm ghost" data-act="cron-run" data-id="' + k + '">立即运行</button></td></tr>';
    }).join('');
  }

  function bindShopActions() {
    document.addEventListener('click', async ev => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act, id = b.dataset.id;
      if (act === 'toggle-product') {
        const p = shopState.products.find(x => x.id === id);
        if (p) await toggleProduct(id, !p.enabled);
      } else if (act === 'del-product') await removeProduct(id);
      else if (act === 'order-paid' || act === 'order-refund' || act === 'order-cancel') await orderAction(id, act);
      else if (act === 'code-disable' || act === 'code-delete') await codeAction(id, act);
      else if (act === 'cron-run') {
        try {
          const r = await Admin.post('/api/admin/store/cron/' + encodeURIComponent(id) + '/run');
          R6T5.toast('任务已执行' + (r && r.result ? '：' + r.result : ''), 'ok');
          await loadCron();
        } catch (e) { R6T5.toastError(e); }
      }
    });
  }

  async function initShop() {
    Admin.bindLogout();
    await Admin.requireAdmin();
    shopTabs();
    bindShopActions();

    Admin.$('#p-type').addEventListener('change', () => {
      const v = Admin.$('#p-type').value;
      Admin.$('#p-group-field').classList.toggle('hide', v !== 'group_upgrade');
      Admin.$('#p-storage-field').classList.toggle('hide', v !== 'storage_pack');
    });
    Admin.$('#r-type').addEventListener('change', () => {
      const v = Admin.$('#r-type').value;
      Admin.$('#r-points-field').classList.toggle('hide', v !== 'points');
      Admin.$('#r-storage-field').classList.toggle('hide', v !== 'storage');
      Admin.$('#r-group-field').classList.toggle('hide', v !== 'group');
    });
    Admin.$('#product-form').addEventListener('submit', createProduct);
    Admin.$('#o-search').addEventListener('click', loadOrders);
    Admin.$('#redeem-gen-form').addEventListener('submit', generateCodes);
    Admin.$('#points-form').addEventListener('submit', adjustPoints);
    Admin.$('#pt-filter').addEventListener('click', loadLedger);
    Admin.$('#billing-form').addEventListener('submit', saveBilling);
    Admin.$('#cron-refresh').addEventListener('click', loadCron);

    await loadGroups();
    await Promise.all([loadProducts(), loadOrders(), loadCodes(), loadLedger(), loadBilling(), loadCron()]);
    Admin.$('#p-type').dispatchEvent(new Event('change'));
    Admin.$('#r-type').dispatchEvent(new Event('change'));
  }

  /* ---------- 路由 ---------- */
  const routers = {
    home: initHome, users: initUsers, storage: initStorage, groups: initGroups,
    shares: initShares, trash: initTrash, audit: initAudit, settings: initSettings, login: initLogin,
    shop: initShop
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
