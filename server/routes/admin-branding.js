import { Router } from 'express';
import multer from 'multer';
import { ApiError, badRequest } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';
import {
  BRAND_SLOTS, UPLOAD_MAX_BYTES, readBranding, updateBranding, clearSlot,
  saveUploadedFile,
} from '../services/branding.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 },
});

function audit(actionDetail) {
  writeAudit({ email: 'admin', action: 'settings_update', detail: `branding:${actionDetail}` });
}

// GET /api/admin/branding
router.get('/', (req, res) => {
  res.json(readBranding());
});

// PATCH /api/admin/branding
router.patch('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const allowed = ['logoLightUrl', 'logoDarkUrl', 'faviconUrl', 'icon192Url', 'iconLargeUrl', 'sidebarHtml'];
    const patch = {};
    for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
    const { item, sidebarHtmlRaw } = updateBranding(patch);
    audit('patch');
    res.json({ item, sidebarHtmlRaw });
  } catch (e) { next(e); }
});

// POST /api/admin/branding/upload?slot=...  multipart 单文件 file
router.post('/upload', (req, res, next) => {
  const slot = String(req.query.slot || '');
  if (!BRAND_SLOTS[slot]) return next(badRequest('invalid_input', `未知资源位：${slot}`, { slot }));
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return next(new ApiError(413, 'payload_too_large', '品牌资源大小不能超过 512KB'));
      }
      return next(err);
    }
    try {
      if (!req.file) throw badRequest('invalid_input', '缺少上传文件（字段名 file）', {});
      const result = saveUploadedFile(slot, req.file.buffer, req.file.originalname);
      audit(`upload:${slot}`);
      res.status(201).json(result);
    } catch (e) { next(e); }
  });
});

// DELETE /api/admin/branding/:slot
router.delete('/:slot', (req, res, next) => {
  try {
    const item = clearSlot(req.params.slot);
    audit(`clear:${req.params.slot}`);
    res.json({ ok: true, item });
  } catch (e) { next(e); }
});

export default router;
