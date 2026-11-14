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

export function errorBody(err) {
  const code = err.code || 'internal_error';
  const message = err.message || '内部错误';
  return { error: { code, message, details: err.details || {} } };
}
