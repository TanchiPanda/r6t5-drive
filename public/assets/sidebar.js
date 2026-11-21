/* 共享侧边栏：导航项与图标集中维护，页面只留空 nav 容器，由本脚本按当前地址高亮。 */
(function () {
  'use strict';

  /* ---- 用户端导航（图标取自 sprite.svg） ---- */
  var USER_NAV = [
    { href: '/files', icon: 'i-home', label: '文件' },
    { href: '/account', icon: 'i-chart', label: '我的容量' },
    { href: '/store', icon: 'i-bag', label: '商店' },
    { href: '#', id: 'nav-trash', icon: 'i-trash', label: '回收站' },
    { href: '#', id: 'nav-share', icon: 'i-share', label: '我的分享' }
  ];

  /* ---- 管理端导航（内联 SVG，与原页面图标一致） ---- */
  var ADMIN_GROUPS = [
    { name: '运行', items: ['/admin/home.html', '/admin/users.html', '/admin/storage.html', '/admin/groups.html', '/admin/shop.html'] },
    { name: '治理', items: ['/admin/shares.html', '/admin/trash.html', '/admin/audit.html'] },
    { name: '系统', items: ['/admin/settings.html', '/admin/blobs.html'] }
  ];

  var ADMIN_ITEMS = {
  '/admin/home.html': { href: '/admin/home.html', label: '概览', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>' },
  '/admin/users.html': { href: '/admin/users.html', label: '用户', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>' },
  '/admin/storage.html': { href: '/admin/storage.html', label: '文件系统', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h6l2 3h10v11H3z"/></svg>' },
  '/admin/groups.html': { href: '/admin/groups.html', label: '用户组', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2 2 2 0 0 1 2-2h13"/><path d="M8 7h7M8 11h7"/></svg>' },
  '/admin/shop.html': { href: '/admin/shop.html', label: '商店', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16l-1.5 12H5.5z"/><path d="M9 7a3 3 0 0 1 6 0"/></svg>' },
  '/admin/shares.html': { href: '/admin/shares.html', label: '分享', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1" fill="white"/></svg>' },
  '/admin/trash.html': { href: '/admin/trash.html', label: '回收站', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/><path d="M10 11v6M14 11v6"/></svg>' },
  '/admin/audit.html': { href: '/admin/audit.html', label: '审计', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-6 4 3 5-7"/></svg>' },
  '/admin/settings.html': { href: '/admin/settings.html', label: '站点设置', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.3.4.8.7 1.5.7H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>' },
  '/admin/blobs.html': { href: '/admin/blobs.html', label: '文件索引', icon: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/></svg>' },
  };

  function active(href) {
    var p = location.pathname;
    if (href === '/files' || href === '/account' || href === '/store') return p === href;
    return p === href || p.endsWith(href);
  }

  function spriteIcon(id) {
    return '<span class="ic" aria-hidden="true"><svg aria-hidden="true"><use href="/assets/icons/sprite.svg#' + id + '"></use></svg></span>';
  }

  function inlineIcon(svg) {
    return '<span class="ic" aria-hidden="true">' + svg + '</span>';
  }

  function renderUser() {
    var box = document.getElementById('nav-user');
    if (!box) return;
    box.innerHTML = USER_NAV.map(function (item) {
      var cls = active(item.href) ? ' class="active"' : '';
      var id = item.id ? ' id="' + item.id + '"' : '';
      return '<a href="' + item.href + '"' + id + cls + '>' + spriteIcon(item.icon) + item.label + '</a>';
    }).join('');
  }

  function renderAdmin() {
    var box = document.getElementById('nav-admin');
    if (!box) return;
    var html = '';
    ADMIN_GROUPS.forEach(function (group) {
      html += '<div class="nav-group">' + group.name + '</div>';
      group.items.forEach(function (href) {
        var item = ADMIN_ITEMS[href];
        if (!item) return;
        var cls = active(href) ? ' class="active"' : '';
        html += '<a href="' + href + '"' + cls + '>' + inlineIcon(item.icon) + item.label + '</a>';
      });
    });
    box.innerHTML = html;
  }

  document.addEventListener('DOMContentLoaded', function () {
    renderUser();
    renderAdmin();
  });
})();
