// P8-B 管理接口：注册策略 + 验证码配置 + SMTP 就绪状态（挂载由 app.js 整合）。
import { Router } from 'express';
import { setSetting, getSetting } from '../db.js';
import { badRequest } from '../lib/errors.js';
import { policySettings } from '../services/signup-policy.js';
import * as captcha from '../services/captcha.js';
import { isConfigured as smtpConfigured } from '../services/mail-config.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

function readSecurity() {
  const signup = policySettings();
  const cap = captcha.getConfig();
  return {
    signup: {
      allowDomains: signup.allowDomains.join(', '),
      denyDomains: signup.denyDomains.join(', '),
      forbidSubAddress: signup.forbidSubAddress,
    },
    captcha: {
      ...cap,
      providers: captcha.providerStatus(),
      secretSet: !!getSetting('captcha.secretKey', ''),
    },
    smtp: { configured: smtpConfigured() },
  };
}

router.get('/', (req, res) => {
  res.json(readSecurity());
});

router.patch('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const signup = body.signup || {};
    const cap = body.captcha || {};

    if (signup.allowDomains != null) setSetting('signup.allowDomains', String(signup.allowDomains));
    if (signup.denyDomains != null) setSetting('signup.denyDomains', String(signup.denyDomains));
    if (signup.forbidSubAddress != null) setSetting('signup.forbidSubAddress', signup.forbidSubAddress ? 'true' : 'false');

    if (cap.provider != null) {
      const p = String(cap.provider).trim().toLowerCase();
      if (!['turnstile', 'hcaptcha', 'recaptcha'].includes(p)) {
        throw badRequest('invalid_input', 'captcha.provider 仅支持 turnstile/hcaptcha/recaptcha', { field: 'provider' });
      }
      setSetting('captcha.provider', p);
    }
    if (cap.siteKey != null) setSetting('captcha.siteKey', String(cap.siteKey).trim());
    // secretKey：空串 = 不修改；传新值 = 覆盖
    if (cap.secretKey != null && cap.secretKey !== '') setSetting('captcha.secretKey', String(cap.secretKey));
    if (cap.onLogin != null) setSetting('captcha.onLogin', cap.onLogin ? 'true' : 'false');
    if (cap.onSignup != null) setSetting('captcha.onSignup', cap.onSignup ? 'true' : 'false');
    if (cap.onRecover != null) setSetting('captcha.onRecover', cap.onRecover ? 'true' : 'false');

    writeAudit({ email: 'admin', action: 'settings_update', detail: 'security' });
    res.json({ item: readSecurity() });
  } catch (e) { next(e); }
});

export default router;
