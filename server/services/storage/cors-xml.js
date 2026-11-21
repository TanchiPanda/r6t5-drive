// S3 兼容 PutBucketCors 策略 XML 构造（s3 / oss / cos / ks3 / obs 复用）。
// 仅使用内建转义，不引入 XML 解析依赖。

function xmlEscape(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 由归一化后的策略构造 PutBucketCors 请求体。
 * policy = { allowedOrigins[], allowedMethods[], allowedHeaders[], exposeHeaders[], maxAgeSeconds }
 */
export function buildCorsXml(policy = {}) {
  const origins = (policy.allowedOrigins || []).map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join('\n    ');
  const methods = (policy.allowedMethods || []).map((m) => `<AllowedMethod>${xmlEscape(m)}</AllowedMethod>`).join('\n    ');
  const headers = (policy.allowedHeaders || []).map((h) => `<AllowedHeader>${xmlEscape(h)}</AllowedHeader>`).join('\n    ');
  const expose = (policy.exposeHeaders || []).map((h) => `<ExposeHeader>${xmlEscape(h)}</ExposeHeader>`).join('\n    ');
  const maxAge = Number(policy.maxAgeSeconds) || 3000;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">',
    '  <CORSRule>',
    '    ' + origins,
    '    ' + methods,
    '    ' + headers,
    expose ? '    ' + expose : '',
    `    <MaxAgeSeconds>${maxAge}</MaxAgeSeconds>`,
    '  </CORSRule>',
    '</CORSConfiguration>',
  ].filter(Boolean).join('\n');
}

/** Cloudflare R2 等控制台使用的 JSON 形态（仅展示/手动粘贴用）。 */
export function buildCorsJson(policy = {}) {
  return JSON.stringify([{
    AllowedOrigins: policy.allowedOrigins || [],
    AllowedMethods: policy.allowedMethods || [],
    AllowedHeaders: policy.allowedHeaders || ['*'],
    ExposeHeaders: policy.exposeHeaders || [],
    MaxAgeSeconds: Number(policy.maxAgeSeconds) || 3000,
  }], null, 2);
}
