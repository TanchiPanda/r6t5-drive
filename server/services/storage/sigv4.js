// SigV4 家族共享签名核心（P9-D1）。
// S3 / OSS / COS / KS3 / OBS 都是 AWS Signature V4 的变体：派生密钥结构相同，
// 差异只在 service、时间戳头、内容哈希头、Authorization 方案前缀与 Host 形态。
// 本模块只放纯密码学 / 规范化逻辑，不绑定具体适配器；各厂商 spec 见 sigv4-family.js。
// 仅使用 node 内建 crypto。
import crypto from 'node:crypto';

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

export function encodePathSegment(seg) {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (ch) =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

export function encodeKeyPath(key) {
  return String(key || '').split('/').map(encodePathSegment).join('/');
}

export function encodeQueryValue(v) {
  return encodeURIComponent(String(v))
    .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

/** 规范查询串：key/value 均按 RFC3986 编码，按 key 字典序排列；空串值保留（如 cors= 子资源） */
export function canonicalQuery(queryParams) {
  return Object.entries(queryParams || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeQueryValue(k)}=${encodeQueryValue(String(v))}`)
    .join('&');
}

/**
 * SigV4 派生签名密钥。
 * @param {string} secret  SecretKey
 * @param {string} dateStamp  YYYYMMDD
 * @param {string} region
 * @param {string} service
 * @param {{prefix?:string, suffix?:string}} opts 前缀/后缀（AWS4…aws4_request；KSS 变体可覆盖）
 */
export function signingKey(secret, dateStamp, region, service, { prefix = 'AWS4', suffix = 'aws4_request' } = {}) {
  const kDate = hmac(`${prefix}${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, suffix);
}

/**
 * 生成 SigV4 时间戳：20261114T120000Z
 */
export function amzDateOf(now = new Date()) {
  return now.toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

/**
 * 按厂商 spec 计算签名请求头。
 *
 * spec:
 * {
 *   scheme: 'AWS4-HMAC-SHA256' | 'KSS-HMAC-SHA256',  // stringToSign 首行
 *   authScheme: 'AWS4-HMAC-SHA256' | 'KSS',          // Authorization 方案名
 *   service: 's3'|'oss'|'cos'|'ks3'|'obs',
 *   scopeSuffix: 'aws4_request',
 *   signingPrefix: 'AWS4' | 'KSS',
 *   dateHeader: 'x-amz-date' | 'x-oss-date' | ...,
 *   sha256Header: 'x-amz-content-sha256' | ...,
 * }
 *
 * @returns {{ headers: object, dateStamp: string, amzDate: string, scope: string }}
 */
export function signRequest(spec, cfg, url, method, { extraHeaders = {}, query = {}, payloadHash = UNSIGNED_PAYLOAD } = {}) {
  const amzDate = amzDateOf();
  const dateStamp = amzDate.slice(0, 8);
  const cQuery = canonicalQuery(query);

  const headers = {
    host: url.host,
    [spec.sha256Header]: payloadHash,
    [spec.dateHeader]: amzDate,
    ...extraHeaders,
  };
  const signedHeaderNames = ['host', spec.sha256Header, spec.dateHeader];
  const canonicalHeaders = signedHeaderNames
    .map((n) => `${n}:${String(headers[n]).trim().toLowerCase()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalUri = url.pathname || '/';
  const canonicalRequest = [
    method,
    canonicalUri,
    cQuery,
    canonicalHeaders,
    signedHeaders,
    headers[spec.sha256Header],
  ].join('\n');

  const scope = `${dateStamp}/${cfg.region}/${spec.service}/${spec.scopeSuffix || 'aws4_request'}`;
  const stringToSign = [
    spec.scheme,
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const key = signingKey(cfg.secretAccessKey, dateStamp, cfg.region, spec.service, {
    prefix: spec.signingPrefix || 'AWS4',
    suffix: spec.scopeSuffix || 'aws4_request',
  });
  const signature = hmacHex(key, stringToSign);
  const authorization =
    `${spec.authScheme} Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { headers: { ...headers, authorization }, dateStamp, amzDate, scope };
}
