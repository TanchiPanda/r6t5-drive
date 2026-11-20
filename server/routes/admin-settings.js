import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { nowIso } from '../lib/format.js';
import { badRequest, notFound } from '../lib/errors.js';
import { writeAudit } from '../services/audit.js';
import { readPreviewConfig } from '../services/preview-config.js';

const router = Router();

function readSettings() {
  const siteName = getSetting('siteName', 'R6T5 Drive');
  const publicUrl = getSetting('publicUrl', '');
  const defaultGroupId = getSetting('defaultGroupId', null);
  return {
    siteName,
    publicUrl,
    defaultGroupId,
    defaultStorageId: getSetting('defaultStorageId', null),
    allowSignup: getSetting('allowSignup', 'false') === 'true',
    trashRetentionDays: Number(getSetting('trashRetentionDays', '30')),
    themeDefault: getSetting('themeDefault', 'light'),
    maxUploadMb: Number(getSetting('maxUploadMb', '2048')),
    preview: readPreviewConfig(),
    updatedAt: getSetting('settings_updated_at', null),
    defaults: {
      siteName: !siteName || siteName === 'R6T5 Drive',
      publicUrl: !publicUrl || publicUrl.trim() === '',
      defaultGroupId: !defaultGroupId,
    },
  };
}

router.get('/', (req, res) => {
  res.json(readSettings());
});

router.patch('/', (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.siteName != null) {
      const v = String(body.siteName).trim();
      if (v.length > 64) throw badRequest('invalid_input', '站点名过长（≤64 字）', { field: 'siteName' });
      setSetting('siteName', v || 'R6T5 Drive');
    }
    if (body.publicUrl != null) {
      const v = String(body.publicUrl).trim();
      if (v && !/^https?:\/\/.+/.test(v)) throw badRequest('invalid_input', '对外地址需为 http(s) URL', { field: 'publicUrl' });
      setSetting('publicUrl', v);
    }
    if (body.defaultGroupId != null) {
      const g = body.defaultGroupId ? db.prepare('SELECT id FROM groups WHERE id = ?').get(body.defaultGroupId) : null;
      if (body.defaultGroupId && !g) throw notFound('默认用户组不存在');
      setSetting('defaultGroupId', body.defaultGroupId || null);
    }
    if (body.defaultStorageId !== undefined) {
      const v = body.defaultStorageId;
      if (v == null || v === '') {
        setSetting('defaultStorageId', null);
      } else {
        const s = db.prepare('SELECT id FROM storage_strategies WHERE id = ?').get(v);
        if (!s) throw badRequest('invalid_input', '默认存储策略不存在', { field: 'defaultStorageId' });
        setSetting('defaultStorageId', v);
      }
    }
    if (body.allowSignup != null) setSetting('allowSignup', body.allowSignup ? 'true' : 'false');
    if (body.preview != null) {
      const preview = body.preview || {};
      if (preview.office != null) {
        const v = String(preview.office);
        if (!['none', 'gdocs', 'm365'].includes(v)) throw badRequest('invalid_input', 'Office 打开方式非法', { field: 'preview.office' });
        setSetting('preview_office', v);
      }
      if (preview.pdf != null) {
        const v = String(preview.pdf);
        if (!['pdfjs', 'native'].includes(v)) throw badRequest('invalid_input', 'PDF 打开方式非法', { field: 'preview.pdf' });
        setSetting('preview_pdf', v);
      }
    }
    if (body.trashRetentionDays != null) {
      const n = Number(body.trashRetentionDays);
      if (!Number.isFinite(n) || n < 1 || n > 365) throw badRequest('invalid_input', '回收站保留天数需为 1–365', { field: 'trashRetentionDays' });
      setSetting('trashRetentionDays', String(Math.trunc(n)));
    }
    if (body.themeDefault != null) {
      if (!['dark', 'light'].includes(body.themeDefault)) throw badRequest('invalid_input', '主题默认值非法', { field: 'themeDefault' });
      setSetting('themeDefault', body.themeDefault);
    }
    setSetting('settings_updated_at', nowIso());
    writeAudit({ email: 'admin', action: 'settings_update', detail: Object.keys(body).join(',') });
    res.json({ item: readSettings() });
  } catch (e) { next(e); }
});

export default router;
