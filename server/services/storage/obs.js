// 华为云 OBS 适配器（P9-D1）。
// 签名：SigV4 兼容；默认 virtual-host：<bucket>.obs.<region>.myhuaweicloud.com
// （region 形如 cn-north-4）。
import { makeSigv4Driver } from './sigv4-family.js';

export const obsDriver = makeSigv4Driver({
  type: 'obs',
  label: '华为云 OBS',
  service: 'obs',
  scheme: 'AWS4-HMAC-SHA256',
  authScheme: 'AWS4-HMAC-SHA256',
  signingPrefix: 'AWS4',
  scopeSuffix: 'aws4_request',
  dateHeader: 'x-obs-date',
  sha256Header: 'x-obs-content-sha256',
  required: ['region', 'bucket', 'accessKeyId', 'secretAccessKey'],
  hostBase: (cfg) => `${cfg.bucket}.obs.${cfg.region}.myhuaweicloud.com`,
});
