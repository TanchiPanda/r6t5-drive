// OnlyOffice Document Server 集成：配置生成 + JWT(HS256) 签名（node:crypto 自实现）。
// 另含免登录取文件 / 回调的一次性 HMAC 签名（10 分钟有效，密钥由 getSecret(db) 派生）。
// 仅在 OO_DS_URL 与 OO_JWT_SECRET 都配置后才签发真实 JWT；secret 不进日志、不进响应。

import crypto from 'node:crypto';

// ---------- 扩展名 → documentType ----------

const DOC_TYPES = {
  word: ['doc', 'docx', 'odt', 'rtf', 'txt'],
  cell: ['xls', 'xlsx', 'ods', 'csv'],
  slide: ['ppt', 'pptx', 'odp'],
};

export function documentTypeOf(fileName) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  for (const [type, exts] of Object.entries(DOC_TYPES)) {
    if (exts.includes(ext)) return type;
  }
  return null;
}

// ---------- JWT (HS256, base64url) ----------

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(s) {
  return Buffer.from(s, 'base64url');
}

/** 签发 OnlyOffice JWT：payload 至少含 document 与 editorConfig（7.x 要求 token 内含 config） */
export function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const head = b64url(JSON.stringify(header));
  const body = b64url(JSON.stringify(payload));
  const data = `${head}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** 校验 JWT 签名（不校验 exp，OnlyOffice 自身管理有效期）；通过返回 payload，失败返回 null */
export function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
}

// ---------- 免登录取文件 / 回调的一次性 HMAC 签名 ----------

const FILE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** 签发文件访问 token：payload { p: 逻辑路径, e: 过期时间戳(ms) } */
export function signFileToken({ path, email, expMs }, secret) {
  const payload = { p: path, e: expMs || Date.now() + FILE_TOKEN_TTL_MS };
  if (email) payload.u = email;
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** 校验文件访问 token：签名 + 过期 + 路径一致；通过返回 payload，失败返回 null */
export function verifyFileToken(token, secret, expectedPath) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload.e !== 'number' || Date.now() > payload.e) return null;
  if (expectedPath != null && payload.p !== expectedPath) return null;
  return payload;
}

// ---------- 编辑器配置 ----------

/**
 * 生成 OnlyOffice 编辑器 config（只读预览模式）。
 * @param {object} opts
 * @param {string} opts.documentServerUrl DS 对外地址
 * @param {string} opts.title 文件名
 * @param {string} opts.docKey 文档唯一 key
 * @param {string} opts.fileUrl 内部下载地址（带 HMAC）
 * @param {string} opts.callbackUrl 回调地址（带 HMAC）
 * @param {string} opts.documentType word|cell|slide
 * @param {object} opts.user { id, name }
 */
export function buildEditorConfig({ documentServerUrl, title, docKey, fileUrl, callbackUrl, documentType, user }) {
  const document = {
    key: docKey,
    title,
    url: fileUrl,
    fileType: String(title || '').split('.').pop().toLowerCase(),
    permissions: {
      edit: false,
      download: true,
      print: true,
      review: false,
      comment: false,
      fillForms: false,
    },
  };
  const editorConfig = {
    mode: 'view', // 只读预览：不提供保存回写
    lang: 'zh-CN',
    callbackUrl,
    user: { id: user?.id || 'anon', name: user?.name || '用户' },
    customization: {
      forcesave: false,
      autosave: false,
      comments: false,
      review: false,
      toolbarNoTabs: false,
    },
  };
  return {
    documentServerUrl,
    config: {
      document,
      documentType,
      editorConfig,
    },
  };
}
