// P8-B 邮件 HTML / 纯文本模板（极简内联样式，不依赖外部 CSS）。

export function confirmMail({ siteName, link, contactEmail }) {
  const safeSite = String(siteName || 'R6T5 Drive').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const safeLink = String(link).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const contact = contactEmail ? `<p style="margin:16px 0 0;color:#888;font-size:13px">若按钮无法点击，可联系：<a href="mailto:${contactEmail}">${contactEmail}</a></p>` : '';
  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
    <h1 style="font-size:20px;margin:0 0 12px">确认你的邮箱 · ${safeSite}</h1>
    <p style="color:#444;font-size:15px;line-height:1.6">你正在注册 ${safeSite}。请点击下面的按钮完成邮箱确认，确认后即可正常使用上传与分享功能。</p>
    <p style="margin:24px 0"><a href="${safeLink}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px">确认邮箱</a></p>
    <p style="color:#888;font-size:13px;line-height:1.6">按钮无效？复制以下链接到浏览器打开：<br>${safeLink}</p>
    ${contact}
    <p style="color:#aaa;font-size:12px;margin:20px 0 0">本链接 24 小时内有效；如非本人操作，可忽略此邮件。</p>
  </div>
</body></html>`;
  const text = [
    `确认你的邮箱 · ${siteName}`,
    '',
    `你正在注册 ${siteName}。请打开下面的链接完成邮箱确认：`,
    link,
    '',
    contactEmail ? `若链接无法打开，可联系：${contactEmail}` : '',
    '本链接 24 小时内有效；如非本人操作，可忽略此邮件。',
  ].filter(Boolean).join('\n');
  return { html, text };
}
