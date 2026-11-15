// 阿里云 OSS 适配器（P9-D1）。
// 签名：SigV4 变体；头前缀 x-oss-，时间戳头 x-oss-date，内容哈希 x-oss-content-sha256。
// 默认 virtual-host：<bucket>.<region>.aliyuncs.com（region 形如 oss-cn-hangzhou）；
// config.endpoint 可覆盖为自定义域名 / 自建网关 / 本地假服务。
import { makeSigv4Driver } from './sigv4-family.js';

export const ossDriver = makeSigv4Driver({
  type: 'oss',
  label: '阿里云 OSS',
  service: 'oss',
  scheme: 'AWS4-HMAC-SHA256',
  authScheme: 'AWS4-HMAC-SHA256',
  signingPrefix: 'AWS4',
  scopeSuffix: 'aws4_request',
  dateHeader: 'x-oss-date',
  sha256Header: 'x-oss-content-sha256',
  required: ['region', 'bucket', 'accessKeyId', 'secretAccessKey'],
  hostBase: (cfg) => `${cfg.bucket}.${cfg.region}.aliyuncs.com`,
});
