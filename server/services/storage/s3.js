// S3 兼容对象存储驱动（自研 AWS Signature V4，流式读写）。
// 接口冻结版见 docs/storage-drivers.md；策略 config 字段见 docs/api-contract.md「P2-1 s3」。
// 仅使用 node 内建模块：crypto / https / http / fs / url。
import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { notFound, upstreamError } from '../../lib/errors.js';

const TIMEOUT_MS = 15_000;
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

// ---------- 工具 ----------

function safeParse(s) {
  try { return s ? JSON.parse(s) : {}; } catch { return {}; }
}

function cfgOf(strategy) {
  const c = strategy && strategy.config ? safeParse(strategy.config) : {};
  return {
    endpoint: String(c.endpoint || '').replace(/\/+$/, ''),
    region: c.region || 'us-east-1',
    bucket: c.bucket || '',
    accessKeyId: c.accessKeyId || '',
    secretAccessKey: c.secretAccessKey || '',
    prefix: c.prefix ? String(c.prefix).replace(/^\/+|\/+$/g, '') : '',
    pathStyle: c.pathStyle === 'on' || c.pathStyle === 'off' ? c.pathStyle : 'auto',
  };
}

/** 逻辑路径 → 对象键（prefix/<email>/...） */
function objectKey(cfg, logicalPath) {
  const clean = String(logicalPath || '').replace(/^\/+|\/+$/g, '');
  // 上游 paths.js 已拦截 .. / . / 反斜杠 / 控制字符，这里再兜一道
  if (clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw upstreamError('s3', '逻辑路径非法', { op: 'path-guard', key: clean });
  }
  return cfg.prefix ? `${cfg.prefix}/${clean}` : clean;
}

/** RFC3986：对路径逐段编码，保留 `/`，保留未保留字符 */
function encodePathSegment(seg) {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (ch) =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function encodeKeyPath(key) {
  return key.split('/').map(encodePathSegment).join('/');
}

function encodeQueryValue(v) {
  return encodeURIComponent(v)
    .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

/** SigV4 派生签名密钥 */
function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * 计算请求上下文并返回签名所需信息。
 * signed headers：host、x-amz-content-sha256、x-amz-date。
 */
function signedRequest(cfg, url, method, extraHeaders = {}, queryParams = {}) {
  const now = new Date();
  // ISO 8601 → SigV4 时间戳：20261114T120000Z
  const amzDate = now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  // 规范查询串：key/value 均按 RFC3986 编码，按 key 字典序排列
  const qsEntries = Object.entries(queryParams)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeQueryValue(k)}=${encodeQueryValue(String(v))}`);
  const canonicalQuery = qsEntries.join('&');

  const headers = {
    host: url.host,
    'x-amz-content-sha256': UNSIGNED_PAYLOAD,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  const signedHeaderNames = ['host', 'x-amz-content-sha256', 'x-amz-date'];
  const canonicalHeaders = signedHeaderNames
    .map((n) => `${n}:${String(headers[n]).trim().toLowerCase()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  // 规范 URI：按 RFC3986 编码路径段，保留绝对路径里的 `/`
  const canonicalUri = url.pathname || '/';

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    headers['x-amz-content-sha256'],
  ].join('\n');

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signature = hmacHex(signingKey(cfg.secretAccessKey, dateStamp, cfg.region, 's3'), stringToSign);
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers: { ...headers, authorization }, amzDate };
}

/**
 * 构造目标 URL 与 host（pathStyle 三种形态）。
 * - on：    https://<endpoint-host>/<bucket>/<key>      Host = <endpoint-host>
 * - off：   https://<bucket>.<endpoint-host>/<key>      Host = <bucket>.<endpoint-host>
 * - auto：  一律 path-style（对 AWS S3 / R2 / MinIO / OSS / COS / 自建端点最兼容）
 */
function queryString(queryParams) {
  if (!queryParams) return '';
  const entries = Object.entries(queryParams)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return '';
  return '?' + entries.map(([k, v]) => `${encodeQueryValue(k)}=${encodeQueryValue(String(v))}`).join('&');
}

function targetUrl(cfg, key, queryParams) {
  const base = new URL(cfg.endpoint);
  let host = base.host; // 含端口，如 127.0.0.1:9001
  let hostname = base.hostname;
  let pathname;
  if (cfg.pathStyle === 'off') {
    hostname = `${cfg.bucket}.${base.hostname}`;
    host = base.port ? `${hostname}:${base.port}` : hostname;
    pathname = `/${encodeKeyPath(key)}`;
  } else {
    // on 与 auto 都走 path-style
    pathname = `/${encodeKeyPath(cfg.bucket)}${key ? '/' + encodeKeyPath(key) : ''}`;
  }
  const u = new URL(`${base.protocol}//${host}${pathname}`);
  u.hostname = hostname;
  if (base.port) u.port = base.port;
  // query 已手工按 RFC3986 编码，直接挂 search，避免 searchParams 二次转义 %
  const qs = queryString(queryParams);
  if (qs) u.search = qs.slice(1);
  return u;
}

function mapHttpError(status, bodyText, op) {
  if (status === 404) return notFound('对象不存在', { status, op });
  if (status === 403) {
    return upstreamError('s3', '权限或密钥被拒绝（403），请检查 AccessKey / SecretKey / Bucket 权限', {
      status, op,
    });
  }
  if (status >= 500) return upstreamError('s3', `上游服务错误（${status}）`, { status, op });
  return upstreamError('s3', `意外响应状态 ${status}`, { status, op, body: bodyText?.slice(0, 300) });
}

/**
 * 发一次 HTTP 请求。返回 { status, headers, body(buffer) }；
 * streamBody=true 时把 IncomingMessage 作为 stream 直接交回（下载用，不缓冲）。
 */
function request(cfg, method, key, { query, extraHeaders, bodyStream, bodyBuffer, contentLength, streamBody, op } = {}) {
  return new Promise((resolve, reject) => {
    const url = targetUrl(cfg, key, query);
    const { headers } = signedRequest(cfg, url, method, extraHeaders, query || {});
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
          // 下载流：调用方负责 pipe/destroy；错误状态在拿到流前由这里处理
          if (status < 200 || status >= 300) {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const text = Buffer.concat(chunks).toString('utf8');
              reject(mapHttpError(status, text, op));
            });
            res.on('error', () => reject(mapHttpError(status, '', op)));
            return;
          }
          resolve({ status, headers: res.headers, stream: res });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (status < 200 || status >= 300) {
            reject(mapHttpError(status, body.toString('utf8'), op));
            return;
          }
          resolve({ status, headers: res.headers, body });
        });
        res.on('error', (e) => reject(upstreamError('s3', `响应流错误：${e.message}`, { op })));
      }
    );

    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };

    req.on('timeout', () => {
      fail(upstreamError('s3', `请求超时（${TIMEOUT_MS}ms）`, { op }));
      req.destroy();
    });
    req.on('error', (e) => {
      // destroy 携带的是已构造的 ApiError，直接透传；其余网络错误再包装
      if (e && e.code === 'storage_error') return fail(e);
      if (e && e.status) return fail(e);
      fail(upstreamError('s3', `网络错误：${e.message}`, { op }));
    });

    if (bodyStream) {
      if (contentLength != null) req.setHeader('Content-Length', String(contentLength));
      bodyStream.on('error', (e) => reject(upstreamError('s3', `上传流错误：${e.message}`, { op })));
      bodyStream.pipe(req);
    } else if (bodyBuffer) {
      req.setHeader('Content-Length', String(bodyBuffer.length));
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

// ---------- XML 解析（轻量，只取 ListObjectsV2 需要的字段） ----------

function xmlEscapeText(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function parseXmlText(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function parseListXml(xml) {
  const items = [];
  // 逐个 <Contents> / <CommonPrefixes> 块抽取
  const blockRe = /<Contents>([\s\S]*?)<\/Contents>|<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
  let bm;
  while ((bm = blockRe.exec(xml)) !== null) {
    const block = bm[1] || bm[2] || '';
    const isCommon = !!bm[2];
    const keyMatch = block.match(isCommon ? /<Prefix>([\s\S]*?)<\/Prefix>/ : /<Key>([\s\S]*?)<\/Key>/);
    if (!keyMatch) continue;
    let key = keyMatch[1];
    key = key.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
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

/** 对象键 → 逻辑路径（剥掉 prefix） */
function toLogical(cfg, key) {
  if (cfg.prefix && key.startsWith(cfg.prefix + '/')) return key.slice(cfg.prefix.length + 1);
  if (key === cfg.prefix) return '';
  return key;
}

// ---------- 驱动实现 ----------

export const s3Driver = {
  type: 's3',
  caps: { read: true, write: true, list: true, range: true },

  // 远端无目录概念，空实现
  ensureDir() {},

  async writeFromTemp(strategy, logicalPath, tmpFile, meta = {}) {
    const cfg = cfgOf(strategy);
    const key = objectKey(cfg, logicalPath);
    // Content-Length 以本地临时文件 stat 为准（meta.size 不可信，避免长度不匹配挂住上游）
    let size;
    try { size = fs.statSync(tmpFile).size; } catch { size = meta.size; }
    const stream = fs.createReadStream(tmpFile);
    const headers = {};
    if (meta.mime) headers['Content-Type'] = meta.mime;
    await request(cfg, 'PUT', key, {
      bodyStream: stream,
      contentLength: size,
      extraHeaders: headers,
      op: 'put-object',
    });
    return { key, size };
  },

  /**
   * 流式读取对象。兼容既有签名 readStream(strategy, logicalPath)：返回可直接
   * pipe 的 IncomingMessage；可选第三参 meta：{ range: 'bytes=start-end' } 时带
   * Range 请求（206 部分内容），响应头挂在返回流的 `.meta` 上（不缓冲）。
   */
  readStream(strategy, logicalPath, meta = {}) {
    const cfg = cfgOf(strategy);
    const key = objectKey(cfg, logicalPath);
    const headers = {};
    if (meta && meta.range) headers.Range = meta.range;
    return request(cfg, 'GET', key, { streamBody: true, extraHeaders: headers, op: 'get-object' })
      .then(({ stream, headers: respHeaders, status }) => {
        stream.meta = { status, headers: respHeaders };
        return stream;
      });
  },

  async remove(strategy, logicalPath) {
    const cfg = cfgOf(strategy);
    const key = objectKey(cfg, logicalPath);
    await request(cfg, 'DELETE', key, { op: 'delete-object' });
  },

  async rename(strategy, fromLogical, toLogical) {
    const cfg = cfgOf(strategy);
    const fromKey = objectKey(cfg, fromLogical);
    const toKey = objectKey(cfg, toLogical);

    // Copy+Delete 语义，全程流式：先 HEAD 取长度，再 GET 源对象管道到 PUT 目标对象，成功后删源。
    let size;
    try {
      const head = await request(cfg, 'HEAD', fromKey, { op: 'head-object-copy' });
      size = Number(head.headers['content-length'] || 0) || undefined;
    } catch { size = undefined; }

    const srcStream = await request(cfg, 'GET', fromKey, { streamBody: true, op: 'get-object-copy' })
      .then(({ stream }) => stream);
    await request(cfg, 'PUT', toKey, {
      bodyStream: srcStream,
      contentLength: size,
      op: 'copy-object-put',
    });
    await request(cfg, 'DELETE', fromKey, { op: 'delete-object-copy' });
  },

  async list(strategy, logicalDir) {
    const cfg = cfgOf(strategy);
    const dirKey = objectKey(cfg, logicalDir || '');
    const prefix = dirKey ? dirKey + '/' : '';
    const query = {
      'list-type': '2',
      prefix,
      delimiter: '/',
      'max-keys': '1000',
    };
    const res = await request(cfg, 'GET', cfg.bucket ? '' : '', {
      query,
      op: 'list-objects-v2',
    }).catch((e) => { throw e; });

    const items = parseListXml(res.body.toString('utf8'));
    const out = [];
    for (const it of items) {
      const logical = toLogical(cfg, it.key);
      // 目录条目的 Key 以分隔符结尾（CommonPrefixes），剥掉尾斜杠取末段
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
      const cfg = cfgOf(strategy);
      if (!cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
        return { ok: false, message: '配置不完整：endpoint / bucket / AccessKey / SecretKey 必填', details: { bucket: cfg.bucket, endpoint: cfg.endpoint } };
      }
      // HeadBucket 自检，再 ListObjectsV2(max-keys=1) 验证读权限
      await request(cfg, 'HEAD', '', { op: 'head-bucket' });
      await request(cfg, 'GET', '', { query: { 'list-type': '2', 'max-keys': '1' }, op: 'list-objects-v2' });
      return {
        ok: true,
        message: `连接正常，bucket「${cfg.bucket}」可访问`,
        details: { bucket: cfg.bucket, endpoint: cfg.endpoint, latencyMs: Date.now() - started },
      };
    } catch (e) {
      const status = e.details?.status;
      const hint = status === 404 ? '：bucket 不存在（NoSuchBucket / 404）'
        : status === 403 ? '：权限或密钥被拒绝（403）'
        : `：${e.message || e.code || '未知错误'}`;
      return {
        ok: false,
        message: `S3 自检失败${hint}`,
        details: { bucket: cfgOf(strategy).bucket, endpoint: cfgOf(strategy).endpoint, latencyMs: Date.now() - started, status },
      };
    }
  },
};

export { xmlEscapeText };
