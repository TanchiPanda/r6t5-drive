// 金山云 KS3 适配器（P9-D1）。
// 签名：SigV4 变体；时间戳头 x-kss-date，Authorization 方案名 KSS；
// 默认 virtual-host：<bucket>.<region>.ksyuncs.com。
import { makeSigv4Driver } from './sigv4-family.js';

export const ks3Driver = makeSigv4Driver({
  type: 'ks3',
  label: '金山云 KS3',
  service: 'ks3',
  scheme: 'AWS4-HMAC-SHA256',
  authScheme: 'KSS',
  signingPrefix: 'AWS4',
  scopeSuffix: 'aws4_request',
  dateHeader: 'x-kss-date',
  sha256Header: 'x-kss-content-sha256',
  required: ['region', 'bucket', 'accessKeyId', 'secretAccessKey'],
  hostBase: (cfg) => `${cfg.bucket}.${cfg.region}.ksyuncs.com`,
});
