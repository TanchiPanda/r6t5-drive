// 通用对象存储假服务（P9-D1，纯内存、零依赖）。
// 用于在没有真实 OSS / COS / KS3 / OBS / 七牛 / 又拍 服务的环境里，验证各适配器
// 构造的签名头 / 鉴权头 / 路径 / 时间戳格式是否符合预期。
//
// 校验规则按厂商推断（依据请求头前缀与 Authorization 方案）：
//  - SigV4 家族（s3/oss/cos/ks3/obs）：Authorization 带 Credential/SignedHeaders/Signature，
//    厂商时间戳头与内容哈希头存在，时间戳格式 YYYYMMDDTHHMMSSZ；
//  - qiniu：Authorization: QBox <ak>:<base64-hmac-sha1>；
//  - upyun：Authorization: UPYUN <operator>:<md5>:<rfc1123-date>。
// 校验失败回 403 并在 requests[].violation 记录原因；不做密码学真值校验（假服务无真实密钥）。
//
// 用法：
//   import { startFakeObjStore } from './fake-objstore.mjs';
//   const fake = await startFakeObjStore({ port: 0 });
//   node tools/fake-objstore.mjs --port 9101

import http from 'node:http';
import crypto from 'node:crypto';

const VENDOR_HEADERS = {
  oss: { date: 'x-oss-date', sha: 'x-oss-content-sha256', scheme: 'AWS4-HMAC-SHA256' },
  cos: { date: 'x-cos-date', sha: 'x-cos-content-sha256', scheme: 'AWS4-HMAC-SHA256' },
  ks3: { date: 'x-kss-date', sha: 'x-kss-content-sha256', scheme: 'KSS' },
  obs: { date: 'x-obs-date', sha: 'x-obs-content-sha256', scheme: 'AWS4-HMAC-SHA256' },
  s3: { date: 'x-amz-date', sha: 'x-amz-content-sha256', scheme: 'AWS4-HMAC-SHA256' },
};

function detectVendor(headers) {
  if (headers['authorization']?.startsWith('QBox ')) return 'qiniu';
  if (headers['authorization']?.startsWith('UPYUN ')) return 'upyun';
  for (const [vendor, spec] of Object.entries(VENDOR_HEADERS)) {
    if (headers[spec.date]) return vendor;
  }
  return 'unknown';
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function route(req) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const parts = pathname.split('/').filter(Boolean);
  return { bucket: parts[0] || '', key: parts.slice(1).join('/'), query: url.searchParams };
}

/** 校验鉴权头；返回 { ok, violation?, vendor } */
function validateAuth(vendor, headers) {
  const auth = headers['authorization'] || '';
  if (vendor === 'qiniu') {
    const m = auth.match(/^QBox (\S+):(\S+)$/);
    if (!m) return { ok: false, violation: 'QBox Authorization 格式应为 QBox <ak>:<sign>' };
    const sign = m[2];
    let decoded;
    try { decoded = Buffer.from(sign, 'base64'); } catch { decoded = null; }
    if (!decoded || decoded.length !== 20) return { ok: false, violation: 'QBox sign 不是合法 base64 HMAC-SHA1（20 字节）' };
    return { ok: true, vendor };
  }
  if (vendor === 'upyun') {
    const parts = auth.split(':');
    if (parts.length !== 3) return { ok: false, violation: 'UPYUN Authorization 应为 UPYUN <operator>:<signature>:<date>' };
    const [, signature, date] = parts;
    if (!/^[0-9a-f]{32}$/i.test(signature)) return { ok: false, violation: 'UPYUN signature 不是 32 位 MD5 十六进制' };
    if (!date || isNaN(Date.parse(date))) return { ok: false, violation: 'UPYUN date 不是合法时间戳' };
    return { ok: true, vendor };
  }
  const spec = VENDOR_HEADERS[vendor];
  if (!spec) return { ok: false, violation: `未知厂商 ${vendor}` };
  if (!auth.startsWith(spec.scheme + ' ')) return { ok: false, violation: `Authorization 方案应为 ${spec.scheme}` };
  if (!/Credential=/.test(auth) || !/SignedHeaders=/.test(auth) || !/Signature=[0-9a-f]{64}/.test(auth)) {
    return { ok: false, violation: 'SigV4 Authorization 缺少 Credential / SignedHeaders / 64 位 Signature' };
  }
  const dateHdr = headers[spec.date];
  if (!dateHdr || !/^\d{8}T\d{6}Z$/.test(dateHdr)) return { ok: false, violation: `时间戳头 ${spec.date} 格式非法（需 YYYYMMDDTHHMMSSZ）` };
  if (!headers[spec.sha]) return { ok: false, violation: `缺少内容哈希头 ${spec.sha}` };
  return { ok: true, vendor };
}

function listXml(store, bucket, query) {
  const prefix = query.get('prefix') || '';
  const delimiter = query.get('delimiter') || '';
  const keys = Object.keys(store[bucket] || {}).filter((k) => k.startsWith(prefix)).sort();
  const contents = [];
  const common = [];
  for (const key of keys) {
    const rest = key.slice(prefix.length);
    if (delimiter && rest.includes(delimiter)) {
      const c = prefix + rest.slice(0, rest.indexOf(delimiter) + 1);
      if (!common.includes(c)) common.push(c);
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
    '<MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>',
    contents.map((c) => [
      '<Contents>', `<Key>${xmlEscape(c.key)}</Key>`,
      `<LastModified>${xmlEscape(c.lastModified)}</LastModified>`,
      `<Size>${c.size}</Size>`, `<ETag>"${c.etag}"</ETag>`, '</Contents>',
    ].join('')).join('\n'),
    common.map((k) => `<CommonPrefixes><Prefix>${xmlEscape(k)}</Prefix></CommonPrefixes>`).join('\n'),
    '</ListBucketResult>',
  ].filter(Boolean).join('\n');
  return Buffer.from(xml, 'utf8');
}

export function createFakeObjStore() {
  const store = {};
  const requests = [];

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const { bucket, key, query } = route(req);
    const vendor = detectVendor(req.headers);
    const record = {
      method: req.method, vendor, bucket, key, path: req.url,
      status: null, violation: null, at: new Date().toISOString(),
      headers: { ...req.headers },
    };
    requests.push(record);

    const send = (status, body, extra = {}) => {
      record.status = status;
      res.writeHead(status, { 'Content-Length': body ? body.length : 0, ...extra });
      res.end(body);
    };

    const authCheck = validateAuth(vendor, req.headers);
    if (!authCheck.ok) {
      record.violation = authCheck.violation;
      send(403, Buffer.from(`<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>${xmlEscape(authCheck.violation)}</Message></Error>`),
        { 'Content-Type': 'application/xml' });
      return;
    }
    record.vendor = authCheck.vendor;

    if (!bucket) { send(400, Buffer.from('<?xml version="1.0"?><Error><Code>InvalidBucketName</Code></Error>')); return; }

    try {
      switch (req.method) {
        case 'PUT': {
          const body = await readBody(req);
          if (!store[bucket]) store[bucket] = {};
          store[bucket][key] = {
            body, size: body.length, lastModified: new Date().toISOString(),
            etag: crypto.createHash('md5').update(body).digest('hex'),
            contentType: req.headers['content-type'] || 'application/octet-stream',
          };
          send(200, null, { ETag: `"${store[bucket][key].etag}"` });
          break;
        }
        case 'GET': {
          if (!store[bucket]) { send(404, Buffer.from('<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>'), { 'Content-Type': 'application/xml' }); return; }
          if (key === '') { send(200, listXml(store, bucket, query), { 'Content-Type': 'application/xml' }); return; }
          const obj = store[bucket][key];
          if (!obj) { send(404, Buffer.from('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>'), { 'Content-Type': 'application/xml' }); return; }
          const range = req.headers.range;
          if (range) {
            const m = /bytes=(\d*)-(\d*)/.exec(range);
            let start = m?.[1] ? Number(m[1]) : 0;
            let end = m?.[2] ? Number(m[2]) : obj.size - 1;
            if (Number.isNaN(start)) start = 0;
            if (Number.isNaN(end) || end >= obj.size) end = obj.size - 1;
            const slice = obj.body.slice(start, end + 1);
            send(206, slice, {
              'Content-Type': obj.contentType,
              'Content-Length': String(slice.length),
              'Content-Range': `bytes ${start}-${end}/${obj.size}`,
              ETag: `"${obj.etag}"`,
            });
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
          send(200, null, { 'Content-Length': String(obj.size), ETag: `"${obj.etag}"`, 'Last-Modified': obj.lastModified });
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

export function startFakeObjStore({ port = 0 } = {}) {
  const { server, store, requests } = createFakeObjStore();
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ port: actual, store, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = process.argv.indexOf('--port');
  const port = arg >= 0 ? Number(process.argv[arg + 1]) : 0;
  const fake = await startFakeObjStore({ port });
  console.log(`fake-objstore listening on http://127.0.0.1:${fake.port}`);
  process.on('SIGINT', async () => { await fake.close(); process.exit(0); });
}
