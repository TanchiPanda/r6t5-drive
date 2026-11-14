// WebDAV PROPFIND 响应 XML 生成与转义（零依赖，手写字符串）。
// 命名空间：D = DAV:。href 逐段 URL 编码；文本节点统一做 XML 转义。

const XML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/** XML 文本 / 属性值转义 */
export function escapeXml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => XML_ESCAPE[ch]);
}

/**
 * 相对用户根的路径（'' 表示根）→ WebDAV href，形如 /dav/inbox/a.txt。
 * 对每一段分别做 encodeURIComponent，再用 '/' 拼接；根返回 '/dav/'。
 */
export function davHref(relPath) {
  const segs = String(relPath || '').split('/').filter((s) => s !== '');
  if (segs.length === 0) return '/dav/';
  return `/dav/${segs.map(encodeURIComponent).join('/')}`;
}

function rfc1123(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toUTCString();
}

/**
 * 拼装一条 response。
 * @param {object} props
 * @param {string} props.relPath 相对用户根的逻辑路径（'' = 根）
 * @param {boolean} props.isDir
 * @param {number} [props.sizeBytes] 文件大小
 * @param {string} [props.mime]
 * @param {string} [props.updatedAt] ISO 时间
 * @param {string} [props.displayName]
 */
export function responseXml(props) {
  const href = davHref(props.relPath);
  const displayName = props.displayName || props.relPath.split('/').pop() || '';
  const modified = rfc1123(props.updatedAt);

  const propstat = [];

  let prop = '<D:prop>';
  prop += `<D:displayname>${escapeXml(displayName)}</D:displayname>`;

  if (props.isDir) {
    prop += '<D:resourcetype><D:collection/></D:resourcetype>';
  } else {
    prop += '<D:resourcetype/>';
    const size = props.sizeBytes == null ? null : Number(props.sizeBytes);
    if (size != null) prop += `<D:getcontentlength>${size}</D:getcontentlength>`;
    prop += `<D:getcontenttype>${escapeXml(props.mime || 'application/octet-stream')}</D:getcontenttype>`;
    const etag = weakEtag(size, props.updatedAt);
    if (etag) prop += `<D:getetag>${escapeXml(etag)}</D:getetag>`;
  }
  if (modified) prop += `<D:getlastmodified>${escapeXml(modified)}</D:getlastmodified>`;
  prop += '</D:prop>';

  propstat.push(
    `<D:propstat><D:prop>${prop}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>`
  );

  return `<D:response><D:href>${escapeXml(href)}</D:href>${propstat.join('')}</D:response>`;
}

/** 弱 ETag：size + updatedAt 拼一个 W/ 引号串 */
export function weakEtag(size, updatedAt) {
  if (size == null && !updatedAt) return '';
  const raw = `${size ?? 0}-${updatedAt || ''}`;
  return `W/"${escapeXml(raw)}"`;
}

/** 把多条 response 拼成完整 207 Multi-Status XML 文档 */
export function multiStatusXml(responses) {
  const body = responses.map(responseXml).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`;
}
