// 七牛云 Qiniu 适配器（P9-D1）。
// 鉴权：QBox 管理凭证（**非 SigV4**）：
//   StringToSign = RequestURI + "\n" + Body
//   Sign         = Base64(HMAC-SHA1(SecretKey, StringToSign))
//   Authorization: QBox <AccessKey>:<Sign>
// 上传走表单直传（需客户端 / 服务端签发上传 Policy），本适配器未实现上传通道：
// 任何写操作显式抛 upload_not_supported，绝不假装成功。
import crypto from 'node:crypto';
import { httpRequest } from './http-helper.js';
import { encodeKeyPath, canonicalQuery } from './sigv4.js';
import {
  driverNotSupported, uploadNotSupported, upstreamError,
} from '../../lib/errors.js';

const PROVIDER = '七牛云 Qiniu';

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function cfgOf(strategy) {
  const c = strategy && strategy.config ? safeParse(strategy.config) : {};
  return {
    endpoint: String(c.endpoint || 'https://rs.qiniu.com').replace(/\/+$/, ''),
    bucket: c.bucket || '',
    accessKey: c.accessKey || '',
    secretKey: c.secretKey || '',
    prefix: c.prefix ? String(c.prefix).replace(/^\/+|\/+$/g, '') : '',
  };
}

function objectKey(cfg, logicalPath) {
  const clean = String(logicalPath || '').replace(/^\/+|\/+$/g, '');
  if (clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw upstreamError(PROVIDER, '逻辑路径非法', { op: 'path-guard', key: clean });
  }
  return cfg.prefix ? `${cfg.prefix}/${clean}` : clean;
}

function pathOf(cfg, key, query) {
  const qs = canonicalQuery(query);
  const path = `/${encodeKeyPath(cfg.bucket)}${key ? '/' + encodeKeyPath(key) : ''}`;
  return qs ? `${path}?${qs}` : path;
}

/** QBox 签名：hmac-sha1 → base64 */
function qboxSign(secretKey, stringToSign) {
  return crypto.createHmac('sha1', secretKey).update(stringToSign).digest('base64');
}

function authHeaders(cfg, method, pathAndQuery, bodyBuf) {
  const body = bodyBuf ? bodyBuf.toString('binary') : '';
  const stringToSign = `${pathAndQuery}\n${body}`;
  const sign = qboxSign(cfg.secretKey, stringToSign);
  return { Authorization: `QBox ${cfg.accessKey}:${sign}` };
}

function call(cfg, method, key, { query, extraHeaders, bodyStream, bodyBuffer, contentLength, streamBody, op } = {}) {
  const pathAndQuery = pathOf(cfg, key, query);
  const url = new URL(cfg.endpoint + pathAndQuery);
  const headers = { ...authHeaders(cfg, method, pathAndQuery, bodyBuffer), ...extraHeaders };
  return httpRequest(PROVIDER, {
    method, url, headers, bodyStream, bodyBuffer, contentLength, streamBody, op,
  });
}

export const qiniuDriver = {
  type: 'qiniu',
  caps: { read: true, write: false, list: false, range: true, stat: true, delete: true, get: true, put: false, presign: false },

  ensureDir() {},

  writeFromTemp() {
    // 表单直传 Policy 通道未实现：明确报错，不静默降级
    throw uploadNotSupported(PROVIDER, { op: 'put-object' });
  },

  readStream(strategy, logicalPath, meta = {}) {
    const cfg = cfgOf(strategy);
    const key = objectKey(cfg, logicalPath);
    const headers = {};
    if (meta && meta.range) headers.Range = meta.range;
    return call(cfg, 'GET', key, { streamBody: true, extraHeaders: headers, op: 'get-object' })
      .then(({ stream, headers: respHeaders, status }) => {
        stream.meta = { status, headers: respHeaders };
        return stream;
      });
  },

  async remove(strategy, logicalPath) {
    const cfg = cfgOf(strategy);
    const key = objectKey(cfg, logicalPath);
    await call(cfg, 'DELETE', key, { op: 'delete-object' });
  },

  async stat(strategy, logicalPath) {
    const cfg = cfgOf(strategy);
    const key = objectKey(cfg, logicalPath);
    const head = await call(cfg, 'HEAD', key, { op: 'head-object' });
    return {
      sizeBytes: Number(head.headers['content-length'] || 0) || 0,
      updatedAt: head.headers['last-modified'] || null,
      remote: true,
    };
  },

  list() { throw driverNotSupported('list', { provider: PROVIDER }); },
  rename() { throw driverNotSupported('rename', { provider: PROVIDER }); },
  presign() { throw driverNotSupported('presign', { provider: PROVIDER }); },

  async test(strategy) {
    const started = Date.now();
    const cfg = cfgOf(strategy);
    const missing = ['bucket', 'accessKey', 'secretKey'].filter((f) => !cfg[f]);
    if (missing.length) {
      return { ok: false, message: `配置不完整，缺少：${missing.join(' / ')}`, details: { missing } };
    }
    try {
      await call(cfg, 'HEAD', '', { op: 'head-bucket' });
      return {
        ok: true,
        message: `连接正常，bucket「${cfg.bucket}」可访问`,
        details: { bucket: cfg.bucket, endpoint: cfg.endpoint, latencyMs: Date.now() - started },
      };
    } catch (e) {
      return {
        ok: false,
        message: `${PROVIDER} 自检失败：${e.message || e.code || '未知错误'}`,
        details: { bucket: cfg.bucket, latencyMs: Date.now() - started, status: e.details?.status },
      };
    }
  },
};

