// 预览方式配置：只读 settings，不缓存（后台保存后立即生效）。
import { getSetting } from '../db.js';

export const OFFICE_EXT = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
export const OFFICE_MIME = {
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
};

export function extOfPath(logicalPath) {
  const name = String(logicalPath || '').split('/').pop() || '';
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : '';
}

/** pdf：pdfjs | native；office 方式已由 openers 关联表接管，不再读旧开关 */
export function readPreviewConfig() {
  const pdf = String(getSetting('preview_pdf', 'pdfjs') || 'pdfjs');
  return {
    pdf: ['pdfjs', 'native'].includes(pdf) ? pdf : 'pdfjs',
  };
}
