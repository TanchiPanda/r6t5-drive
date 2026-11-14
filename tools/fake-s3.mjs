// 最小 S3 兼容假服务（纯内存，零依赖）。仅用于本地测试 / 驱动自测。
// 支持 path-style（/bucket/key）与 virtual-host（Host: bucket.localhost）。
// 校验请求必须带 Authorization: AWS4-HMAC-SHA256 … 与 x-amz-content-sha256，
// 但不对签名值做密码学校验（假服务不需要真实密钥）。
//
// 用法：
//   import { startFakeS3 } from './fake-s3.mjs';
//   const { port, close, requests, store } = await startFakeS3({ port: 0 });
//   node tools/fake-s3.mjs --port 9001

import http from 'node:http';
import crypto from 'node:crypto';

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

/** 解析请求路由：返回 { bucket, key, query }；key 可能为 ''（bucket 级操作） */
function route(req, hostHeader) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const host = (hostHeader || '').split(':')[0];

  // virtual-host：bucket.localhost[.localhost]
  if (host.endsWith('.localhost')) {
    const bucket = host.slice(0, -'.localhost'.length);
    const key = pathname.replace(/^\/+/, '');
    return { bucket, key, query: url.searchParams };
  }
  // path-style：/bucket/key
  const parts = pathname.split('/').filter(Boolean);
  const bucket = parts[0] || '';
  const key = parts.slice(1).join('/');
  return { bucket, key, query: url.searchParams };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** ListObjectsV2：prefix + delimiter='/' 归出 Contents / CommonPrefixes */
function listObjects(store, bucket, query) {
  const prefix = query.get('prefix') || '';
  const delimiter = query.get('delimiter') || '';
  const maxKeys = Number(query.get('max-keys') || '1000');
  const keys = Object.keys(store[bucket] || {})
    .filter((k) => k.startsWith(prefix))
    .sort()
    .slice(0, maxKeys);

  const contents = [];
  const common = [];
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    if (delimiter && rest.includes(delimiter)) {
      const commonKey = prefix + rest.slice(0, rest.indexOf(delimiter) + 1);
      if (!common.includes(commonKey)) common.push(commonKey);
    } else {
      contents.push({ key, ...store[bucket][key] });
    }
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    `<Name>${xmlEscape(bucket)}</Name>`,
    `<Prefix>${xmlEscape(prefix)}</Prefix>`,
    delimiter ? `<Delimiter>${xmlEscape(delimiter)}</Delimiter>` : '',
    `<MaxKeys>${maxKeys}</MaxKeys>`,
    '<IsTruncated>false</IsTruncated>',
    contents.map((c) => [
      '<Contents>',
      `<Key>${xmlEscape(c.key)}</Key>`,
      `<LastModified>${xmlEscape(c.lastModified)}</LastModified>`,
      `<Size>${c.size}</Size>`,
      `<ETag>"${c.etag}"</ETag>`,
      '<StorageClass>STANDARD</StorageClass>',
      '</Contents>',
    ].join('')).join('\n'),
    common.map((k) => `<CommonPrefixes><Prefix>${xmlEscape(k)}</Prefix></CommonPrefixes>`).join('\n'),
    '</ListBucketResult>',
  ].filter(Boolean).join('\n');
  return Buffer.from(xml, 'utf8');
}

export function createFakeS3() {
  const store = {}; // { [bucket]: { [key]: { body: Buffer, size, lastModified, etag, contentType } } } }
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const { bucket, key, query } = route(req, req.headers.host);
    const record = {
      method: req.method,
      bucket,
      key,
      path: req.url,
      status: null,
      at: new Date().toISOString(),
      headers: { ...req.headers },
    };
    requests.push(record);

    // 签名头校验（存在性即可，不校验值）
    const auth = req.headers['authorization'] || '';
    const signed = auth.startsWith('AWS4-HMAC-SHA256 ');
    const contentSha = req.headers['x-amz-content-sha256'];

    const send = (status, body, extraHeaders = {}) => {
      record.status = status;
      res.writeHead(status, {
        'Content-Length': body ? body.length : 0,
        ...extraHeaders,
      });
      res.end(body);
    };

    if (!signed || contentSha == null) {
      send(403, Buffer.from('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>请求缺少签名头</Message></Error>'),
        { 'Content-Type': 'application/xml' });
      return;
    }

    if (!bucket) {
      send(400, Buffer.from('<?xml version="1.0"?><Error><Code>InvalidBucketName</Code></Error>'));
      return;
    }

    try {
      switch (req.method) {
        case 'PUT': {
          const body = await readBody(req);
          if (!store[bucket]) store[bucket] = {};
          store[bucket][key] = {
            body,
            size: body.length,
            lastModified: new Date().toISOString(),
            etag: crypto.createHash('md5').update(body).digest('hex'),
            contentType: req.headers['content-type'] || 'application/octet-stream',
          };
          send(200, null, { ETag: `"${store[bucket][key].etag}"` });
          break;
        }
        case 'GET': {
          if (!store[bucket]) {
            send(404, Buffer.from('<?xml version="1.0"?><Error><Code>NoSuchBucket</Code><Message>bucket 不存在</Message></Error>'),
              { 'Content-Type': 'application/xml' });
            return;
          }
          // bucket 级 list
          if (key === '') {
            const body = listObjects(store, bucket, query);
            send(200, body, { 'Content-Type': 'application/xml' });
            return;
          }
          const obj = store[bucket][key];
          if (!obj) {
            send(404, Buffer.from('<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>对象不存在</Message></Error>'),
              { 'Content-Type': 'application/xml' });
            return;
          }
          send(200, obj.body, {
            'Content-Type': obj.contentType,
            'Content-Length': String(obj.size),
            ETag: `"${obj.etag}"`,
            'Last-Modified': obj.lastModified,
          });
          break;
        }
        case 'HEAD': {
          if (!store[bucket]) { send(404, null); return; }
          if (key === '') { send(200, null); return; }
          const obj = store[bucket][key];
          if (!obj) { send(404, null); return; }
          send(200, null, {
            'Content-Length': String(obj.size),
            ETag: `"${obj.etag}"`,
            'Last-Modified': obj.lastModified,
          });
          break;
        }
        case 'DELETE': {
          if (store[bucket]) delete store[bucket][key];
          send(204, null);
          break;
        }
        default:
          send(405, Buffer.from('Method Not Allowed'));
      }
    } catch (e) {
      record.error = e.message;
      send(500, Buffer.from(String(e.message)));
    }
    record.durationMs = Date.now() - startedAt;
  });

  return { server, store, requests };
}

export function startFakeS3({ port = 0 } = {}) {
  const { server, store, requests } = createFakeS3();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        store,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// CLI：node tools/fake-s3.mjs --port 9001
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.indexOf('--port');
  const port = arg >= 0 ? Number(process.argv[arg + 1]) : 0;
  const { port: actual, close } = await startFakeS3({ port });
  console.log(`fake-s3 listening on http://127.0.0.1:${actual}`);
  process.on('SIGINT', async () => { await close(); process.exit(0); });
}
