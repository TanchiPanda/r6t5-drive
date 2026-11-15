// P8-B 管理接口：SMTP 配置读写 + 发信测试（本文件只建路由，挂载由 app.js 整合）。
import { Router } from 'express';
import { setSetting } from '../db.js';
import { badRequest, upstreamError } from '../lib/errors.js';
import { maskedConfig, smtpConfig } from '../services/mail-config.js';
import { sendPlain } from '../services/mailer.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

router.get('/', (req, res) => {
  res.json(maskedConfig());
});

router.patch('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const set = (key, value) => setSetting(key, value == null ? null : String(value));

    if (body.host != null) set('smtp.host', String(body.host).trim());
    if (body.port != null) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw badRequest('invalid_input', '端口需为 1–65535 整数', { field: 'port' });
      }
      set('smtp.port', port);
    }
    if (body.username != null) set('smtp.username', String(body.username).trim());
    // password：空串 = 不修改；传新值 = 覆盖；null 视为不修改
    if (body.password != null && body.password !== '') set('smtp.password', String(body.password));
    if (body.secure != null) set('smtp.secure', body.secure ? 'true' : 'false');
    if (body.fromName != null) set('smtp.fromName', String(body.fromName).trim());
    if (body.fromEmail != null) set('smtp.fromEmail', String(body.fromEmail).trim());
    if (body.replyTo != null) set('smtp.replyTo', String(body.replyTo).trim());
    if (body.connTimeoutMs != null) {
      const n = Number(body.connTimeoutMs);
      if (!Number.isFinite(n) || n < 1000) throw badRequest('invalid_input', '连接超时需 ≥1000ms', { field: 'connTimeoutMs' });
      set('smtp.connTimeoutMs', Math.trunc(n));
    }

    writeAudit({ email: 'admin', action: 'settings_update', detail: 'mail' });
    res.json({ item: maskedConfig() });
  } catch (e) { next(e); }
});

router.post('/test', async (req, res, next) => {
  try {
    const to = String(req.body?.to || '').trim();
    if (!to) throw badRequest('invalid_input', '收件人不能为空', { field: 'to' });
    const cfg = smtpConfig();
    const result = await sendPlain({
      to,
      subject: 'R6T5 Drive SMTP 测试邮件',
      text: '这是一封 SMTP 配置测试邮件，收到即说明发信链路正常。',
      html: '<p>这是一封 <strong>SMTP 配置测试邮件</strong>，收到即说明发信链路正常。</p>',
    });
    if (!result.ok) {
      throw upstreamError('smtp', result.response || '发信失败', { smtpCode: result.code });
    }
    res.json({ ok: true, code: result.code, response: result.response });
  } catch (e) { next(e); }
});

export default router;
