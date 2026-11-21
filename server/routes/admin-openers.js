// 管理端：打开方式关联表 CRUD。
// 内置条目不可删除、kind 不可改；可改名称 / 扩展名绑定 / 平台 / 启用 / 排序。
// 自定义外部阅读器（kind=external）可新增，需提供含 {src} 占位的 URL 模板。
import { Router } from 'express';
import {
  listOpeners, getOpener, createOpener, updateOpener, deleteOpener,
  OPENER_KINDS, PLATFORMS,
} from '../services/openers.js';
import { writeAudit } from '../services/audit.js';
import { badRequest, notFound, forbidden } from '../lib/errors.js';

const router = Router();

router.get('/', (req, res, next) => {
  try {
    res.json({
      items: listOpeners({ includeDisabled: true }),
      kinds: Object.entries(OPENER_KINDS).map(([value, k]) => ({
        value, label: k.label, fixed: !!k.fixed, needsTemplate: !!k.needsTemplate,
      })),
      platforms: PLATFORMS,
    });
  } catch (e) { next(e); }
});

router.post('/', (req, res, next) => {
  try {
    const result = createOpener(req.body || {});
    if (result.errors) throw badRequest('invalid_input', '表单校验失败', { fields: result.errors });
    writeAudit({ email: adminEmail(req), action: 'opener_create', target: result.item.id, detail: result.item.name });
    res.json({ item: result.item });
  } catch (e) { next(e); }
});

router.patch('/:id', (req, res, next) => {
  try {
    const existing = getOpener(req.params.id);
    if (!existing) throw notFound('打开方式不存在');
    // 内置条目锁定 kind，禁止改写成别的类型
    if (existing.builtin && req.body && req.body.kind && req.body.kind !== existing.kind) {
      throw forbidden('内置打开方式的类型不可修改', { code: 'builtin_kind_locked' });
    }
    const result = updateOpener(req.params.id, req.body || {});
    if (result.notFound) throw notFound('打开方式不存在');
    if (result.errors) throw badRequest('invalid_input', '表单校验失败', { fields: result.errors });
    writeAudit({ email: adminEmail(req), action: 'opener_update', target: existing.id, detail: result.item.name });
    res.json({ item: result.item });
  } catch (e) { next(e); }
});

router.delete('/:id', (req, res, next) => {
  try {
    const result = deleteOpener(req.params.id);
    if (result.notFound) throw notFound('打开方式不存在');
    if (result.builtin) throw forbidden('内置打开方式不可删除', { code: 'builtin_delete_locked' });
    writeAudit({ email: adminEmail(req), action: 'opener_delete', target: req.params.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

function adminEmail(req) {
  return req.sudoUser?.email || 'admin';
}

export default router;
