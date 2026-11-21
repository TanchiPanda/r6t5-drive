// SigV4 家族适配器工厂（P9-D1）：OSS / COS / KS3 / OBS 复用同一套请求与签名流程，
// 差异通过 vendor spec 注入（service、头前缀、Authorization 方案、Host 形态）。
// 签名核心见 ./sigv4.js；S3 本体仍在 ./s3.js（既有行为不变）。
import fs from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { notFound, upstreamError, driverNotSupported } from '../../lib/errors.js';
import {
  signRequest, encodeKeyPath, encodeQueryValue, canonicalQuery,
} from './sigv4.js';
import { buildCorsXml } from './cors-xml.js';

const TIMEOUT_MS = 15_000;

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function cfgOf(strategy, spec) {
  const c = strategy && strategy.config ? safeParse(strategy.config) : {};
  return {
    endpoint: String(c.endpoint || '').replace(/\/+$/, ''),
    region: c.region || '',
    bucket: c.bucket || '',
    appid: c.appid || '',
    accessKeyId: c.accessKeyId || '',
    secretAccessKey: c.secretAccessKey || '',
    prefix: c.prefix ? String(c.prefix).replace(/^\/+|\/+$/g, '') : '',
  };
}

function objectKey(cfg, logicalPath) {
  const clean = String(logicalPath || '').replace(/^\/+|\/+$/g, '');
  if (clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw upstreamError(specLabel(cfg), '逻辑路径非法', { op: 'path-guard', key: clean });
  }
  return cfg.prefix ? `${cfg.prefix}/${clean}` : clean;
}

function specLabel(spec) { return spec.label; }

function queryString(queryParams) {
  if (!queryParams) return '';
  const entries = Object.entries(queryParams)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeQueryValue(k)}=${encodeQueryValue(String(v))}`).join('&');
}

function targetUrl(cfg, spec, key, query) {
  let host;
  let hostname;
  let pathname;
  if (cfg.endpoint) {
    // 自定义 endpoint（本地假服务 / 自建网关）：path-style 挂在 endpoint 下
    const base = new URL(cfg.endpoint);
    host = base.host;
    hostname = base.hostname;
    pathname = `/${encodeKeyPath(cfg.bucket)}${key ? '/' + encodeKeyPath(key) : ''}`;
    const u = new URL(`${base.protocol}//${host}${pathname}`);
    u.hostname = hostname;
    if (base.port) u.port = base.port;
    const qs = queryString(query);
    if (qs) u.search = qs.slice(1);
    return u;
  }
  // 默认 virtual-host 形态：<bucket>...厂商域名
  hostname = spec.hostBase(cfg);
  host = hostname;
  pathname = `/${encodeKeyPath(key)}`;
  const u = new URL(`https://${host}${pathname}`);
  const qs = queryString(query);
  if (qs) u.search = qs.slice(1);
  return u;
}

function mapHttpError(spec, status, bodyText, op) {
  if (status === 404) return notFound('对象不存在', { status, op });
  if (status === 403) {
    return upstreamError(spec.label, '权限或密钥被拒绝（403），请检查 AccessKey / SecretKey / Bucket 权限', { status, op });
  }
  if (status >= 500) return upstreamError(spec.label, `上游服务错误（${status}）`, { status, op });
  return upstreamError(spec.label, `意外响应状态 ${status}`, { status, op, body: bodyText?.slice(0, 300) });
}

function request(spec, cfg, method, key, { query, extraHeaders, bodyStream, bodyBuffer, contentLength, streamBody, op } = {}) {
  return new Promise((resolve, reject) => {
    const url = targetUrl(cfg, spec, key, query);
    const { headers } = signRequest(spec, cfg, url, method, { extraHeaders, query: query || {} });
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ''),
        headers,
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (streamBody) {
          if (status < 200 || status >= 300) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => reject(mapHttpError(spec, status, Buffer.concat(chunks).toString('utf8'), op)));
            res.on('error', () => reject(mapHttpError(spec, status, '', op)));
            return;
          }
          resolve({ status, headers: res.headers, stream: res });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (status < 200 || status >= 300) reject(mapHttpError(spec, status, body.toString('utf8'), op));
          else resolve({ status, headers: res.headers, body });
        });
        res.on('error', (e) => reject(upstreamError(spec.label, `响应流错误：${e.message}`, { op })));
      }
    );

    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };

    req.on('timeout', () => {
      fail(upstreamError(spec.label, `请求超时（${TIMEOUT_MS}ms）`, { op }));
      req.destroy();
    });
    req.on('error', (e) => {
      if (e && e.status) return fail(e);
      fail(upstreamError(spec.label, `网络错误：${e.message}`, { op }));
    });

    if (bodyStream) {
      if (contentLength != null) req.setHeader('Content-Length', String(contentLength));
      bodyStream.on('error', (e) => reject(upstreamError(spec.label, `上传流错误：${e.message}`, { op })));
      bodyStream.pipe(req);
    } else if (bodyBuffer) {
      req.setHeader('Content-Length', String(bodyBuffer.length));
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

// ---------- 轻量 XML 列举解析（ListObjectsV2 兼容，OSS/COS/OBS/KS3 均返回同构 XML） ----------

function parseListXml(xml) {
  const items = [];
  const blockRe = /<Contents>([\s\S]*?)<\/Contents>|<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
  let bm;
  while ((bm = blockRe.exec(xml)) !== null) {
    const block = bm[1] || bm[2] || '';
    const isCommon = !!bm[2];
    const keyMatch = block.match(isCommon ? /<Prefix>([\s\S]*?)<\/Prefix>/ : /<Key>([\s\S]*?)<\/Key>/);
    if (!keyMatch) continue;
    let key = keyMatch[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
    const dateMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
    items.push({
      key,
      type: isCommon ? 'dir' : 'file',
      sizeBytes: sizeMatch ? Number(sizeMatch[1]) : 0,
      updatedAt: dateMatch ? dateMatch[1].trim() : null,
    });
  }
  return items;
}

function toLogical(cfg, key) {
  if (cfg.prefix && key.startsWith(cfg.prefix + '/')) return key.slice(cfg.prefix.length + 1);
  if (key === cfg.prefix) return '';
  return key;
}

/**
 * 工厂：按 vendor spec 生成一个 SigV4 家族驱动。
 * spec = {
 *   type, label, service, scheme, authScheme, signingPrefix, scopeSuffix,
 *   dateHeader, sha256Header, hostBase(cfg), required: [field...]
 * }
 */
export function makeSigv4Driver(spec) {
  const driver = {
    type: spec.type,
    caps: { read: true, write: true, list: true, range: true, stat: true, delete: true, get: true, put: true, presign: false },

    ensureDir() {},

    async writeFromTemp(strategy, logicalPath, tmpFile, meta = {}) {
      const cfg = cfgOf(strategy, spec);
      const key = objectKey(cfg, logicalPath);
      let size;
      try { size = fs.statSync(tmpFile).size; } catch { size = meta.size; }
      const stream = fs.createReadStream(tmpFile);
      const headers = {};
      if (meta.mime) headers['Content-Type'] = meta.mime;
      await request(spec, cfg, 'PUT', key, {
        bodyStream: stream,
        contentLength: size,
        extraHeaders: headers,
        op: 'put-object',
      });
      return { key, size };
    },

    readStream(strategy, logicalPath, meta = {}) {
      const cfg = cfgOf(strategy, spec);
      const key = objectKey(cfg, logicalPath);
      const headers = {};
      if (meta && meta.range) headers.Range = meta.range;
      return request(spec, cfg, 'GET', key, { streamBody: true, extraHeaders: headers, op: 'get-object' })
        .then(({ stream, headers: respHeaders, status }) => {
          stream.meta = { status, headers: respHeaders };
          return stream;
        });
    },

    async remove(strategy, logicalPath) {
      const cfg = cfgOf(strategy, spec);
      const key = objectKey(cfg, logicalPath);
      await request(spec, cfg, 'DELETE', key, { op: 'delete-object' });
    },

    async stat(strategy, logicalPath) {
      const cfg = cfgOf(strategy, spec);
      const key = objectKey(cfg, logicalPath);
      const head = await request(spec, cfg, 'HEAD', key, { op: 'head-object' });
      return {
        sizeBytes: Number(head.headers['content-length'] || 0) || 0,
        updatedAt: head.headers['last-modified'] || null,
        remote: true,
      };
    },

    async rename(strategy, fromLogical, toLogical) {
      const cfg = cfgOf(strategy, spec);
      const fromKey = objectKey(cfg, fromLogical);
      const toKey = objectKey(cfg, toLogical);

      let size;
      try {
        const head = await request(spec, cfg, 'HEAD', fromKey, { op: 'head-object-copy' });
        size = Number(head.headers['content-length'] || 0) || undefined;
      } catch { size = undefined; }

      const srcStream = await request(spec, cfg, 'GET', fromKey, { streamBody: true, op: 'get-object-copy' })
        .then(({ stream }) => stream);
      await request(spec, cfg, 'PUT', toKey, { bodyStream: srcStream, contentLength: size, op: 'copy-object-put' });
      await request(spec, cfg, 'DELETE', fromKey, { op: 'delete-object-copy' });
    },

    async list(strategy, logicalDir) {
      const cfg = cfgOf(strategy, spec);
      const dirKey = objectKey(cfg, logicalDir || '');
      const prefix = dirKey ? dirKey + '/' : '';
      const query = { 'list-type': '2', prefix, delimiter: '/', 'max-keys': '1000' };
      const res = await request(spec, cfg, 'GET', '', { query, op: 'list-objects-v2' });

      const items = parseListXml(res.body.toString('utf8'));
      const out = [];
      for (const it of items) {
        const logical = toLogical(cfg, it.key);
        const displayKey = it.type === 'dir' ? it.key.replace(/\/$/, '') : it.key;
        const displayLogical = toLogical(cfg, displayKey);
        const name = (it.type === 'dir' ? displayLogical : logical).split('/').pop();
        if (!name) continue;
        out.push({
          name,
          path: displayLogical,
          type: it.type,
          sizeBytes: it.type === 'file' ? it.sizeBytes : 0,
          updatedAt: it.updatedAt,
          remote: true,
        });
      }
      return out;
    },

    async test(strategy) {
      const started = Date.now();
      try {
        const cfg = cfgOf(strategy, spec);
        const missing = spec.required.filter((f) => !cfg[f]);
        if (missing.length) {
          return { ok: false, message: `配置不完整，缺少：${missing.join(' / ')}`, details: { missing } };
        }
        await request(spec, cfg, 'HEAD', '', { op: 'head-bucket' });
        await request(spec, cfg, 'GET', '', { query: { 'list-type': '2', 'max-keys': '1' }, op: 'list-objects-v2' });
        return {
          ok: true,
          message: `连接正常，bucket「${cfg.bucket}」可访问`,
          details: { bucket: cfg.bucket, endpoint: cfg.endpoint || spec.hostBase(cfg), latencyMs: Date.now() - started },
        };
      } catch (e) {
        const status = e.details?.status;
        const hint = status === 404 ? '：bucket 不存在（404）'
          : status === 403 ? '：权限或密钥被拒绝（403）'
          : `：${e.message || e.code || '未知错误'}`;
        return {
          ok: false,
          message: `${spec.label} 自检失败${hint}`,
          details: { bucket: cfgOf(strategy, spec).bucket, latencyMs: Date.now() - started, status },
        };
      }
    },

    /**
     * 一键写入 Bucket CORS：PUT /?cors（PutBucketCors，SigV4 变体兼容）。
     * policy = { allowedOrigins[], allowedMethods[], allowedHeaders[], exposeHeaders[], maxAgeSeconds }
     */
    async putBucketCors(strategy, policy = {}) {
      const cfg = cfgOf(strategy, spec);
      const missing = spec.required.filter((f) => !cfg[f]);
      if (missing.length) {
        return { ok: false, message: `配置不完整，缺少：${missing.join(' / ')}` };
      }
      const xml = buildCorsXml(policy);
      const res = await request(spec, cfg, 'PUT', '', {
        query: { cors: '' },
        bodyBuffer: Buffer.from(xml, 'utf8'),
        extraHeaders: { 'Content-Type': 'application/xml' },
        op: 'put-bucket-cors',
      });
      return { ok: true, message: `CORS 策略已写入 bucket「${cfg.bucket}」`, status: res.status };
    },
  };

  // presign 未实现：显式报错，不静默降级
  driver.presign = () => { throw driverNotSupported('presign'); };
  return driver;
}
