// 通用 HTTP 请求辅助（P9-D1，供非 SigV4 家族适配器使用）。
// 仅 node 内建 http/https；错误统一抛 upstreamError。
import https from 'node:https';
import http from 'node:http';
import { upstreamError, notFound } from '../../lib/errors.js';

const TIMEOUT_MS = 15_000;

export function httpRequest(provider, { method, url, headers = {}, bodyStream, bodyBuffer, contentLength, streamBody, op }) {
  return new Promise((resolve, reject) => {
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
            res.on('end', () => reject(mapErr(provider, status, Buffer.concat(chunks).toString('utf8'), op)));
            res.on('error', () => reject(mapErr(provider, status, '', op)));
            return;
          }
          resolve({ status, headers: res.headers, stream: res });
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          if (status < 200 || status >= 300) reject(mapErr(provider, status, body.toString('utf8'), op));
          else resolve({ status, headers: res.headers, body });
        });
        res.on('error', (e) => reject(upstreamError(provider, `响应流错误：${e.message}`, { op })));
      }
    );

    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };

    req.on('timeout', () => {
      fail(upstreamError(provider, `请求超时（${TIMEOUT_MS}ms）`, { op }));
      req.destroy();
    });
    req.on('error', (e) => {
      if (e && e.status) return fail(e);
      fail(upstreamError(provider, `网络错误：${e.message}`, { op }));
    });

    if (bodyStream) {
      if (contentLength != null) req.setHeader('Content-Length', String(contentLength));
      bodyStream.on('error', (e) => reject(upstreamError(provider, `上传流错误：${e.message}`, { op })));
      bodyStream.pipe(req);
    } else if (bodyBuffer) {
      req.setHeader('Content-Length', String(bodyBuffer.length));
      req.end(bodyBuffer);
    } else {
      req.end();
    }
  });
}

function mapErr(provider, status, bodyText, op) {
  if (status === 404) return notFound('对象不存在', { status, op });
  if (status === 403) return upstreamError(provider, '权限或密钥被拒绝（403）', { status, op });
  if (status >= 500) return upstreamError(provider, `上游服务错误（${status}）`, { status, op });
  return upstreamError(provider, `意外响应状态 ${status}`, { status, op, body: bodyText?.slice(0, 300) });
}
