// 腾讯云 COS 适配器（P9-D1）。
// 签名：SigV4 近似 S3，service 固定为 cos；
// 默认 virtual-host：<bucket>-<appid>.cos.<region>.myqcloud.com（如 ap-guangzhou）。
// 与 S3 的主要差异：Host 带 APPID 后缀，scope service = cos。
import { makeSigv4Driver } from './sigv4-family.js';

export const cosDriver = makeSigv4Driver({
  type: 'cos',
  label: '腾讯云 COS',
  service: 'cos',
  scheme: 'AWS4-HMAC-SHA256',
  authScheme: 'AWS4-HMAC-SHA256',
  signingPrefix: 'AWS4',
  scopeSuffix: 'aws4_request',
  dateHeader: 'x-cos-date',
  sha256Header: 'x-cos-content-sha256',
  required: ['region', 'bucket', 'appid', 'accessKeyId', 'secretAccessKey'],
  hostBase: (cfg) => `${cfg.bucket}-${cfg.appid}.cos.${cfg.region}.myqcloud.com`,
});
