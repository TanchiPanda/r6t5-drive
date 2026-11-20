/* 用户端商店：会员 / 容量 / 兑换码。接口：/api/store（requireUser）。 */
(function () {
  'use strict';

  var state = { me: null, products: [], tab: 'membership' };

  function $ (s, r) { return (r || document).querySelector(s); }
  function $$ (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function svgIcon (name) { return '<svg class="fic-svg" aria-hidden="true"><use href="/assets/icons/sprite.svg#i-' + name + '"></use></svg>'; }

  function money (minor) {
    var n = Number(minor || 0) / 100;
    return '¥' + (Number.isInteger(n) ? n.toFixed(2) : n.toFixed(2));
  }

  function daysText (days) {
    var d = Number(days || 0);
    if (!d) return '';
    if (d % 365 === 0) return (d / 365) + ' 年';
    if (d % 30 === 0) return (d / 30) + ' 个月';
    return d + ' 天';
  }

  function isMembership (p) { return p.type === 'group_upgrade'; }
  function isStorage (p) { return p.type === 'storage_pack'; }

  function cardHtml (p) {
    var tag = p.tag ? '<span class="badge warn">' + R6T5.esc(p.tag) + '</span>' : '';
    var descLines = String(p.description || '').split(/\r?\n/).filter(Boolean);
    var desc = descLines.length
      ? '<ul class="store-desc">' + descLines.map(function (l) { return '<li>' + R6T5.esc(l) + '</li>'; }).join('') + '</ul>'
      : '<p class="d">暂无说明</p>';

    var meta = [];
    if (isMembership(p)) meta.push('时长 ' + (daysText(p.durationDays) || '—'));
    if (isStorage(p) && p.storageBytes) meta.push('扩容 ' + R6T5.fmtBytes(p.storageBytes));

    var priceRow = '<div class="store-price"><b>' + money(p.priceMinor) + '</b>' +
      (meta.length ? '<span class="d">' + R6T5.esc(meta.join(' · ')) + '</span>' : '') + '</div>';

    var btns = '';
    if (p.canPayPoints) {
      btns += '<button class="btn" type="button" data-buy-points="' + R6T5.esc(p.id) + '">' +
        p.pointsPrice + ' 积分购买</button>';
    }
    btns += '<button class="btn primary" type="button" data-buy-cash="' + R6T5.esc(p.id) + '">现金下单</button>';

    return '<div class="card store-card">' +
      '<div class="card-head"><h3>' + R6T5.esc(p.name) + ' ' + tag + '</h3></div>' +
      desc + priceRow +
      '<div class="row tight mt2">' + btns + '</div>' +
      '</div>';
  }

  function renderLists () {
    var mem = state.products.filter(function (p) { return p.enabled && isMembership(p); });
    var sto = state.products.filter(function (p) { return p.enabled && isStorage(p); });
    $('#list-membership').innerHTML = mem.length
      ? mem.map(cardHtml).join('')
      : '<div class="empty"><div class="ico">' + svgIcon('bag') + '</div><h3>还没有会员商品</h3><p class="d">等管理员上架后就能在这里购买。</p></div>';
    $('#list-storage').innerHTML = sto.length
      ? sto.map(cardHtml).join('')
      : '<div class="empty"><div class="ico">' + svgIcon('folder') + '</div><h3>还没有容量包</h3><p class="d">等管理员上架后就能在这里扩容。</p></div>';
  }

  function renderMe () {
    var me = state.me || {};
    $('#points-chip').textContent = '积分 ' + (me.points == null ? '—' : me.points);
    $('#store-points').textContent = me.points == null ? '—' : String(me.points);
    $('#store-group').textContent = me.groupName || '标准用户';
    $('#store-space').textContent = me.spaceLimitBytes == null ? '—' : R6T5.fmtBytes(me.spaceLimitBytes);
    var exp = $('#store-expire');
    if (me.groupExpiresAt) {
      exp.textContent = '会员到期：' + R6T5.fmtTime(me.groupExpiresAt);
      exp.classList.remove('hide');
    } else {
      exp.textContent = '';
    }
  }

  function setTab (tab) {
    state.tab = tab;
    $$('#store-tabs button').forEach(function (b) {
      var on = b.getAttribute('data-tab') === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    $$('.tab-panel').forEach(function (p) { p.classList.add('hide'); });
    $('#tab-' + tab).classList.remove('hide');
  }

  async function buyWithPoints (productId) {
    var product = state.products.filter(function (p) { return p.id === productId; })[0];
    if (!product) return;
    if (!confirm('确认使用 ' + product.pointsPrice + ' 积分购买「' + product.name + '」？')) return;
    try {
      var created = await R6T5.post('/api/store/orders', { productId: productId });
      var paid = await R6T5.post('/api/store/orders/' + encodeURIComponent(created.orderNo) + '/pay-points');
      R6T5.toast('已用积分购买「' + product.name + '」', 'ok');
      await refreshMe();
      if (paid && paid.order && paid.order.status) { /* 状态由刷新后的 /me 反映 */ }
    } catch (e) { R6T5.toastError(e); }
  }

  function showOrder (info) {
    $('#order-title').textContent = '订单 ' + info.orderNo;
    var lines = [
      '<div class="k faint">应付金额</div>',
      '<div class="v">' + money(info.amountMinor) + '</div>',
      '<div class="note mt2"><span class="ico">' + svgIcon('info') + '</span><div>' + R6T5.esc(info.payInstructions || '请按管理员说明付款。') + '</div></div>',
      '<p class="d mt2">付款后把订单号发给管理员，标记已支付后权益自动到账。订单号：<code>' + R6T5.esc(info.orderNo) + '</code></p>'
    ];
    $('#order-body').innerHTML = lines.join('');
    $('#order-copy').onclick = function () {
      navigator.clipboard && navigator.clipboard.writeText(info.orderNo).then(
        function () { R6T5.toast('订单号已复制', 'ok'); },
        function () { R6T5.toast('复制失败，请手动选择', 'danger'); }
      );
    };
    R6T5.modal.open('#m-order');
  }

  async function buyWithCash (productId) {
    var product = state.products.filter(function (p) { return p.id === productId; })[0];
    if (!product) return;
    try {
      var created = await R6T5.post('/api/store/orders', { productId: productId });
      showOrder({
        orderNo: created.orderNo,
        amountMinor: created.amountMinor,
        payInstructions: created.payInstructions
      });
    } catch (e) { R6T5.toastError(e); }
  }

  function bindCards () {
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-buy-points],[data-buy-cash]');
      if (!t) return;
      var pid = t.getAttribute('data-buy-points') || t.getAttribute('data-buy-cash');
      if (t.hasAttribute('data-buy-points')) buyWithPoints(pid);
      else buyWithCash(pid);
    });
  }

  /* ---------- 兑换码 ---------- */
  function redeemErrorText (e) {
    switch (e && e.code) {
      case 'redeem_code_invalid': return '兑换码不存在或已删除';
      case 'redeem_code_disabled': return '兑换码已被禁用';
      case 'redeem_code_expired': return '兑换码已过期';
      case 'redeem_code_email_mismatch': return '该兑换码仅限指定账号使用';
      case 'redeem_code_already_used': return '你已经使用过这个兑换码';
      case 'redeem_code_exhausted': return '兑换码已被用完';
      default: return (e && e.message) || '兑换失败，请稍后重试';
    }
  }

  function describeCode (item) {
    var g = item.granted || item || {};
    if (item.type === 'storage') {
      return '容量扩容 ' + R6T5.fmtBytes(g.storageBytes || 0) +
        (item.durationDays ? '，有效期 ' + daysText(item.durationDays) : '');
    }
    if (item.type === 'points') return '积分 ' + (g.points == null ? '—' : g.points);
    if (item.type === 'group') {
      return '会员 ' + (g.durationDays ? daysText(g.durationDays) : '') + '（升级到指定用户组）';
    }
    return item.type;
  }

  async function previewCode () {
    var code = $('#redeem-code').value.trim();
    if (!code) { R6T5.toast('先填兑换码', 'danger'); return; }
    var box = $('#redeem-result');
    box.innerHTML = '<div class="skel" style="height:14px"></div>';
    try {
      var res = await R6T5.get('/api/store/redeem/' + encodeURIComponent(code) + '/preview');
      var item = res.item || {};
      box.innerHTML = '<div class="note ' + (item.available ? 'ok' : 'warn') + '"><span class="ico">' +
        svgIcon(item.available ? 'check' : 'alert') + '</span><div>' +
        (item.available
          ? '可兑换：' + R6T5.esc(describeCode(item))
          : '暂时不可兑换：' + R6T5.esc(redeemErrorText({ code: item.reason }))) +
        '</div></div>';
    } catch (e) {
      box.innerHTML = '<div class="note danger"><span class="ico">' + svgIcon('alert') + '</span><div>' + R6T5.esc(redeemErrorText(e)) + '</div></div>';
    }
  }

  async function submitRedeem (ev) {
    ev.preventDefault();
    var code = $('#redeem-code').value.trim();
    var btn = $('#redeem-submit-btn');
    if (!code) { R6T5.toast('先填兑换码', 'danger'); return; }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = '兑换中…';
    try {
      var res = await R6T5.post('/api/store/redeem', { code: code });
      $('#redeem-result').innerHTML = '<div class="note ok"><span class="ico">' + svgIcon('check') + '</span><div>兑换成功' +
        ('：' + R6T5.esc(describeCode(res || {}))) + '</div></div>';
      R6T5.toast('兑换成功', 'ok');
      $('#redeem-code').value = '';
      await refreshMe();
    } catch (e) {
      $('#redeem-result').innerHTML = '<div class="note danger"><span class="ico">' + svgIcon('alert') + '</span><div>' +
        R6T5.esc(redeemErrorText(e)) + '</div></div>';
      R6T5.toastError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  }

  async function refreshMe () {
    state.me = await R6T5.get('/api/store/me');
    renderMe();
  }

  function bindChrome () {
    var themeBtn = $('#theme-btn');
    var saved = localStorage.getItem('r6t5-theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    themeBtn && themeBtn.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', cur);
      localStorage.setItem('r6t5-theme', cur);
      themeBtn.textContent = cur === 'light' ? '☀' : '☾';
    });
    ['#logout-btn', '#logout-link'].forEach(function (sel) {
      var el = $(sel);
      el && el.addEventListener('click', async function (ev) {
        ev.preventDefault();
        try { await R6T5.post('/api/auth/logout'); } catch (_) { /* 忽略 */ }
        location.href = '/login';
      });
    });
  }

  async function init () {
    bindChrome();
    bindCards();

    try {
      state.me = await R6T5.get('/api/store/me');
    } catch (e) {
      if (e && e.status === 401) { location.href = '/login'; return; }
      throw e;
    }
    renderMe();
    $('#store-email').textContent = '';
    try {
      var products = await R6T5.get('/api/store/products');
      state.products = (products.items || []);
    } catch (e) {
      state.products = [];
      R6T5.toastError(e);
    }
    renderLists();

    $$('#store-tabs button').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
    });
    $('#redeem-preview-btn').addEventListener('click', previewCode);
    $('#redeem-form').addEventListener('submit', submitRedeem);
    $('#order-close').addEventListener('click', function () { R6T5.modal.close('#m-order'); });
    $('#order-ok').addEventListener('click', function () { R6T5.modal.close('#m-order'); });

    var tab = (location.hash || '').replace('#', '');
    if (tab === 'storage' || tab === 'redeem') setTab(tab);
  }

  document.addEventListener('DOMContentLoaded', function () {
    init().catch(function (e) {
      if (e && e.status === 401) return;
      R6T5.toastError(e);
    });
  });
})();
