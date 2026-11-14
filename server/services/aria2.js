// aria2 JSON-RPC 客户端（Node 22 内置 fetch，零新增依赖）。
// 仅在 ARIA2_RPC 已配置时由路由层调用；未配置由路由层直接 503，不进这里。
// 超时 3s（AbortSignal.timeout）；网络 / RPC 错误统一抛 upstreamError('aria2', ...)。
// secret 只出现在 RPC 请求的 token 参数里，不进日志、不进响应。

import { upstreamError } from '../lib/errors.js';

const RPC_TIMEOUT_MS = 3000;

export class Aria2Client {
  constructor({ rpcUrl, secret } = {}) {
    this.rpcUrl = rpcUrl;
    this.secret = secret || '';
    this._id = 0;
  }

  /** 组装带 secret 的参数数组：aria2 约定首参为 "token:<secret>" */
  _params(args) {
    const list = Array.isArray(args) ? args : [];
    if (this.secret) return [`token:${this.secret}`, ...list];
    return list;
  }

  /**
   * 调用 JSON-RPC 方法。
   * @returns RPC result（error 字段非空时抛 upstreamError）
   */
  async call(method, args = [], { timeoutMs = RPC_TIMEOUT_MS } = {}) {
    if (!this.rpcUrl) throw upstreamError('aria2', 'RPC 地址未配置');
    const body = {
      jsonrpc: '2.0',
      id: ++this._id,
      method,
      params: this._params(args),
    };
    let res;
    try {
      res = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const reason = e?.name === 'TimeoutError' ? '请求超时（3s）' : (e?.message || '网络错误');
      throw upstreamError('aria2', reason, { method });
    }

    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }

    if (!res.ok || !json) {
      throw upstreamError('aria2', `HTTP ${res.status}`, { method });
    }
    if (json.error) {
      const msg = json.error.message || `RPC 错误 ${json.error.code ?? ''}`;
      throw upstreamError('aria2', msg, { method, rpcCode: json.error.code });
    }
    return json.result;
  }

  /** aria2.getVersion → { version, features }；探测可缩短超时 */
  async getVersion({ timeoutMs } = {}) {
    const r = await this.call('aria2.getVersion', [], timeoutMs ? { timeoutMs } : {});
    return r?.version || null;
  }

  /** aria2.addUri：uris 数组，options 写入 dir 等；返回 gid */
  async addUri(uris, options = {}) {
    const opts = { ...options };
    return this.call('aria2.addUri', [uris, opts]);
  }

  /** aria2.tellStatus：默认取常用字段 */
  async tellStatus(gid, keys) {
    return this.call('aria2.tellStatus', keys ? [gid, keys] : [gid]);
  }

  async remove(gid) {
    return this.call('aria2.remove', [gid]);
  }

  async removeDownloadResult(gid) {
    return this.call('aria2.removeDownloadResult', [gid]);
  }

  async tellActive(keys) {
    return this.call('aria2.tellActive', keys ? [keys] : []);
  }

  async tellWaiting(keys) {
    return this.call('aria2.tellWaiting', [0, 1000, keys]);
  }

  async tellStopped(keys) {
    return this.call('aria2.tellStopped', [0, 1000, keys]);
  }
}

export function createAria2Client(config) {
  return new Aria2Client(config);
}
