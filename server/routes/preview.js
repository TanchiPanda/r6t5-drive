// P3 预览路由（登录态由上层挂载 requireUser；本文件不做鉴权）。
// 挂载点：/api/files/preview（需在既有 /api/files 之前挂载，避免被文件路由吞掉）。
import { Router } from 'express';
import { normalizeLogicalPath } from '../lib/paths.js';
import { ApiError, notFound } from '../lib/errors.js';
import { resolveStorage } from '../services/bindings.js';
import { getNodeByPath } from '../services/nodes.js';
import { sendPreview, classify, previewable, unsupportedReason, listZipEntries } from '../services/preview.js';
import { extOfPath, OFFICE_EXT, readPreviewConfig } from '../services/preview-config.js';

const router = Router();

/** 解析策略 + 节点；拿不到策略 → 412；文件本地与远端都取不到 → 404。 */
async function resolveTarget(req, logical) {
  const hit = resolveStorage({ email: req.user.email, logicalPath: logical, user: req.user });
  if (!hit || !hit.strategy) {
    throw new ApiError(412, 'storage_not_configured', '站点还没有可用的存储策略，请联系管理员在后台添加一条');
  }
  const node = getNodeByPath(logical);
  if (node && node.isDir) throw notFound('目录不支持预览');
  return { strategy: hit.strategy, node };
}

// GET /api/files/preview?path=<逻辑路径>&exif=0|1
router.get('/', async (req, res, next) => {
  try {
    const logical = normalizeLogicalPath(String(req.query.path || ''), req.user.email);
    const { strategy, node } = await resolveTarget(req, logical);
    await sendPreview({ req, res, strategy, logicalPath: logical, node });
  } catch (e) { next(e); }
});

// GET /api/files/preview/zip?path=
router.get('/zip', async (req, res, next) => {
  try {
    const logical = normalizeLogicalPath(String(req.query.path || ''), req.user.email);
    const { strategy, node } = await resolveTarget(req, logical);
    if (!logical.toLowerCase().endsWith('.zip')) throw new ApiError(415, 'preview_unsupported', '仅支持 ZIP 清单预览');
    const result = await listZipEntries({ strategy, logicalPath: logical, node });
    res.json(result);
  } catch (e) { next(e); }
});

// GET /api/files/preview/meta?path=
// 仅询问可预览性与视图类型；不可预览时不抛 415，返回 previewable:false + 中文 reason。
router.get('/meta', async (req, res, next) => {
  try {
    const logical = normalizeLogicalPath(String(req.query.path || ''), req.user.email);
    let strategy = null;
    let node = null;
    try {
      const hit = resolveStorage({ email: req.user.email, logicalPath: logical, user: req.user });
      strategy = hit?.strategy || null;
      node = getNodeByPath(logical);
    } catch { /* 策略解析失败也回 meta，由前端展示不可预览 */ }

    const classification = classify(logical, node?.mime);
    const cfg = readPreviewConfig();
    const ext = extOfPath(logical);
    const isOffice = OFFICE_EXT.includes(ext);
    const name = logical.split('/').pop();
    const sizeBytes = node ? Number(node.sizeBytes) : null;
    let ok = previewable(classification);
    let kind = classification.kind;
    let reason = ok ? '' : unsupportedReason(classification);
    if (isOffice) {
      // Office 文档由前端「打开方式」按关联表选择外部阅读器（gdocs / m365 / onlyoffice），
      // 后端不再按管理员开关放行或拦截；无匹配时前端弹窗给展开全部 / 下载提示。
      kind = 'office';
      ok = true;
      reason = '';
    }

    res.json({
      kind,
      ext,
      pdfMode: kind === 'pdf' ? cfg.pdf : undefined,
      name,
      sizeBytes,
      mime: classification.mime,
      language: classification.language || undefined,
      orientation: undefined, // 方向需在实际请求 exif=1 时由图片响应头给出
      strategy: strategy ? { type: strategy.type, name: strategy.name } : null,
      previewable: ok,
      reason,
    });
  } catch (e) { next(e); }
});

export default router;
