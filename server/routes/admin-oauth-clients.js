// 管理端：OAuth 应用 / 客户端凭据管理（P9-D1）。
// secret 只在创建（或轮换）时一次性返回明文；列表 / 详情仅回显 secretSet 布尔与掩码。
import { Router } from 'express';
import * as oauth from '../services/oauth/apps.js';
import { notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';

const router = Router();

function audit(action, target) {
  writeAudit({ email: 'admin', action, target });
}

router.get('/', (req, res) => {
  res.json({ items: oauth.listClients() });
});

router.post('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const { item, clientSecret } = oauth.createClient({
      name: body.name,
      description: body.description,
      scopes: body.scopes,
      redirectUris: body.redirectUris,
      enabled: body.enabled,
    });
    audit('oauth_client_create', item.name);
    res.status(201).json({
      item,
      clientSecret,
      secretWarning: 'clientSecret 仅本次展示一次，关闭后无法再次查看，请立即妥善保存。',
    });
  } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const item = oauth.getClient(req.params.id);
    if (!item) throw notFound('OAuth 应用不存在');
    res.json({ item });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const body = req.body || {};
    const { item, clientSecret } = oauth.updateClient(req.params.id, {
      name: body.name,
      description: body.description,
      scopes: body.scopes,
      redirectUris: body.redirectUris,
      enabled: body.enabled,
      rotateSecret: body.rotateSecret === true,
    });
    audit('oauth_client_update', item.name);
    const out = { item };
    if (clientSecret) {
      out.clientSecret = clientSecret;
      out.secretWarning = '新 clientSecret 仅本次展示一次；旧 Secret 已立即失效。';
    }
    res.json(out);
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const item = oauth.getClient(req.params.id);
    if (!item) throw notFound('OAuth 应用不存在');
    oauth.deleteClient(req.params.id);
    audit('oauth_client_delete', item.name);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/:id/tokens', (req, res, next) => {
  try {
    const item = oauth.getClient(req.params.id);
    if (!item) throw notFound('OAuth 应用不存在');
    res.json({ items: oauth.listTokens(item.clientId) });
  } catch (e) { next(e); }
});

export default router;
