// 又拍云 UPYUN 适配器（P9-D1）。
// 鉴权（REST API v2，**非 SigV4**）：
//   md5Body    = MD5(body)（空体为 MD5("")）
//   signStr    = METHOD & URI & DATE & POLICY & md5Body
//   signature  = MD5(signStr)
//   Authorization: UPYUN <operator>:<signature>:<timestamp>
// 上传走表单直传（需 policy 签名），本适配器未实现上传通道：
// 任何写操作显式抛 upload_not_supported，绝不假装成功。
import crypto from 'node:crypto';
import { httpRequest } from './http-helper.js';
import { encodeKeyPath, canonicalQuery } from './sigv4.js';
import {
  driverNotSupported, uploadNotSupported, upstreamError,
} from '../../lib/errors.js';

const PROVIDER = '又拍云 UPYUN';

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function cfgOf(strategy) {
  const c = strategy && strategy.config ? safeParse(strategy.config) : {};
  return {
    endpoint: String(c.endpoint || 'https://v0.api.upyun.com').replace(/\/+$/, ''),
    bucket: c.bucket || '',
    operator: c.operator || '',
    password: c.password || '',
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

function md5Hex(buf) {
  return crypto.createHash('md5').update(buf).digest('hex');
}

function pathOf(cfg, key, query) {
  const qs = canonicalQuery(query);
  const path = `/${encodeKeyPath(cfg.bucket)}${key ? '/' + encodeKeyPath(key) : ''}`;
  return qs ? `${path}?${qs}` : path;
}

function authHeaders(cfg, method, uri, bodyBuf) {
  const date = new Date().toUTCString();
  const md5Body = md5Hex(bodyBuf || Buffer.alloc(0));
  const policy = '';
  const signStr = [method, uri, date, policy, md5Body].join('&');
  const signature = md5Hex(signStr);
  return { Authorization: `UPYUN ${cfg.operator}:${signature}:${date}` };
}

function call(cfg, method, key, { query, extraHeaders, bodyStream, bodyBuffer, contentLength, streamBody, op } = {}) {
  const uri = pathOf(cfg, key, query);
  const url = new URL(cfg.endpoint + uri);
  const headers = { ...authHeaders(cfg, method, uri, bodyBuffer), ...extraHeaders };
  return httpRequest(PROVIDER, {
    method, url, headers, bodyStream, bodyBuffer, contentLength, streamBody, op,
  });
}

export const upyunDriver = {
  type: 'upyun',
  caps: { read: true, write: false, list: false, range: true, stat: true, delete: true, get: true, put: false, presign: false },

  ensureDir() {},

  writeFromTemp() {
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
    const missing = ['bucket', 'operator', 'password'].filter((f) => !cfg[f]);
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
