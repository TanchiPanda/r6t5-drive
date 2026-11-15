// P8-B 邮箱确认：GET /api/auth/confirm?token=xxx → HTML 结果页。
import { Router } from 'express';
import { db } from '../db.js';
import { getUserByEmail } from '../services/nodes.js';
import { findValidToken, consumeToken } from '../services/mailer.js';
import { contactEmail } from '../services/mail-config.js';
import { writeAudit } from '../services/audit.js';
import { nowIso } from '../lib/format.js';

const router = Router();

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function pageHtml({ title, badge, badgeClass, message, contact, cta }) {
  const contactBlock = contact
    ? `<p class="muted" style="margin:16px 0 8px">如有疑问，请联系：
         <span id="contact-email">${esc(contact)}</span>
         <button type="button" class="btn ghost" id="copy-btn" style="padding:4px 10px;font-size:13px">复制邮箱</button>
       </p>
       <select id="contact-fallback" style="position:absolute;left:-9999px" aria-hidden="true">
         <option>${esc(contact)}</option>
       </select>`
    : `<p class="muted" style="margin:16px 0 8px">请联系站点管理员处理。</p>`;

  const copyScript = contact ? `
    <script>
      (function () {
        var btn = document.getElementById('copy-btn');
        var email = document.getElementById('contact-email').textContent.trim();
        function fallback() {
          var sel = document.getElementById('contact-fallback');
          sel.style.position = 'static';
          sel.select();
          try { document.execCommand('copy'); } catch (e) {}
          sel.style.position = 'absolute';
          sel.style.left = '-9999px';
        }
        btn.addEventListener('click', function () {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(email).then(function () {
              btn.textContent = '已复制';
              setTimeout(function () { btn.textContent = '复制邮箱'; }, 2000);
            }).catch(fallback);
          } else { fallback(); }
        });
      })();
    </script>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/base.css">
</head><body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div class="card" style="max-width:520px;text-align:center">
    <div class="badge ${esc(badgeClass)}" style="margin-bottom:14px">${esc(badge)}</div>
    <h1 style="font-size:var(--fs-xl);margin-bottom:8px">${esc(title)}</h1>
    <p class="muted" style="font-size:var(--fs-sm);line-height:1.6">${esc(message)}</p>
    ${contactBlock}
    <div class="row" style="justify-content:center;margin-top:20px">${cta || ''}</div>
  </div>
</div>
${copyScript}
</body></html>`;
}

router.get('/', (req, res, next) => {
  try {
    const token = String(req.query.token || '');
    const row = token ? findValidToken(token) : null;
    const user = row ? getUserByEmail(row.email) : null;

    if (row && user && row.kind === 'confirm') {
      consumeToken(row);
      db.prepare("UPDATE users SET status = 'active', disabled = 0 WHERE id = ?").run(user.id);
      writeAudit({ email: user.email, action: 'email_confirm', detail: 'link' });
      return res.type('text/html; charset=utf-8').send(pageHtml({
        title: '邮箱已确认',
        badge: '成功',
        badgeClass: 'success',
        message: '你的邮箱已确认，账号已激活，现在可以上传文件与创建分享了。',
        contact: contactEmail(),
        cta: '<a class="btn primary" href="/files">前往文件页</a>',
      }));
    }

    // 失败：过期 / 已用 / 无效 / 用户不存在，统一「链接已失效」。
    let reason = '链接无效或已被使用。';
    if (row && !user) reason = '对应账号不存在，请联系管理员。';
    else if (row?.usedAt) reason = '该链接已被使用过。';
    else if (row && new Date(row.expiresAt).getTime() < Date.now()) reason = '该链接已过期（24 小时内有效）。';

    res.status(200).type('text/html; charset=utf-8').send(pageHtml({
      title: '链接已失效',
      badge: '失效',
      badgeClass: 'danger',
      message: `${reason}如仍需确认邮箱，请重新注册或联系管理员手动确认。`,
      contact: contactEmail(),
      cta: '<a class="btn ghost" href="/login">返回登录</a>',
    }));
  } catch (e) { next(e); }
});

export default router;
