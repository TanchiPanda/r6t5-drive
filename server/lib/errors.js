export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (message = '未登录', details) => new ApiError(401, 'unauthorized', message, details);
export const forbidden = (message = '无权限', details) => new ApiError(403, 'forbidden', message, details);
export const notFound = (message = '不存在', details) => new ApiError(404, 'not_found', message, details);
export const conflict = (message = '同名节点已存在', details) => new ApiError(409, 'conflict', message, details);
export const quotaSpace = (details) => new ApiError(409, 'quota_space', '用户空间不足', details);
export const quotaFile = (details) => new ApiError(413, 'quota_file', '单文件大小超出上限', details);
export const quotaTraffic = (details) => new ApiError(429, 'quota_traffic', '7 天上传流量已耗尽', details);
export const supabaseUnreachable = (reason, details) =>
  new ApiError(400, 'supabase_unreachable', 'Supabase 配置校验失败', { reason, ...details });
export const notImplemented = (message = '该能力在 P2 规划中') =>
  new ApiError(501, 'not_implemented', message);
export const storageError = (message = '磁盘/适配器错误', details) =>
  new ApiError(500, 'storage_error', message, details);

export const strategyReadonly = (message = '该目录绑定的是只读存储策略，不能写入', details) =>
  new ApiError(403, 'strategy_readonly', message, details);
export const upstreamError = (provider, message, details) =>
  new ApiError(502, 'upstream_error', `${provider} 上游错误：${message}`, { provider, ...details });
export const storageUnsupported = (message = '该存储策略不支持此操作', details) =>
  new ApiError(400, 'storage_unsupported', message, details);


// ---- P3 分享 / 预览 ----
export const shareNotFound = () => new ApiError(404, 'share_not_found', '分享链接不存在或已被删除');
export const shareExpired = (details) => new ApiError(410, 'share_expired', '分享链接已过期', details);
export const shareRevoked = () => new ApiError(410, 'share_revoked', '分享链接已被撤销');
export const shareExceeded = (details) => new ApiError(410, 'share_exceeded', '分享链接的下载次数已用完', details);
export const shareCodeRequired = () => new ApiError(401, 'share_code_required', '该分享需要提取码');
export const shareCodeInvalid = (details) => new ApiError(403, 'share_code_invalid', '提取码不正确', details);
export const previewUnsupported = (details) => new ApiError(415, 'preview_unsupported', '该文件类型不支持在线预览', details);
export const previewTooLarge = (details) => new ApiError(413, 'preview_too_large', '文件过大，不适合在线预览', details);

export function errorBody(err) {
  const code = err.code || 'internal_error';
  const message = err.message || '内部错误';
  return { error: { code, message, details: err.details || {} } };
}
