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

// ---- P6 账号来源 / 本地账号 ----
export const accountBanned = (details) =>
  new ApiError(403, 'account_banned', '账号已被封禁，请联系管理员', details || {});

// ---- P7 自助注册 ----
export const signupClosed = (details) =>
  new ApiError(403, 'signup_closed', '当前未开放自助注册', details || {});
export const quotaLimitExceeded = (details) =>
  new ApiError(400, 'invalid_input', '超出 SQLite INTEGER 上限（约 8 EB）', details || {});
export const invalidSignup = (details) =>
  new ApiError(400, 'invalid_signup', '注册信息无效', details || {});
export const signupRateLimited = (details) =>
  new ApiError(429, 'rate_limited', '注册尝试过多，请稍后再试', details || {});
export const notSupportedInSource = (message, details) =>
  new ApiError(409, 'not_supported_in_source', message || '当前账号来源不支持该操作', details || {});

// ---- P8-B 注册策略 / 邮箱确认 / 验证码 ----
export const signupDomainNotAllowed = (details) =>
  new ApiError(400, 'signup_domain_not_allowed', '该邮箱域名不在允许列表内', details || {});
export const signupDomainBlocked = (details) =>
  new ApiError(400, 'signup_domain_blocked', '该邮箱域名已被封禁', details || {});
export const signupSubAddressForbidden = (details) =>
  new ApiError(400, 'signup_subaddress_forbidden', '不允许使用带 + 子地址的邮箱', details || {});
export const emailUnconfirmed = (details) =>
  new ApiError(403, 'email_unconfirmed', '邮箱未确认，暂时无法上传或分享', details || {});
export const captchaFailed = (details) =>
  new ApiError(400, 'captcha_failed', '人机验证未通过，请重试', details || {});
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


// ---- P4 传输增强 ----
export const uploadSessionNotFound = () => new ApiError(404, 'upload_session_not_found', '上传会话不存在或已清理，请重新开始');
export const uploadSessionExpired = () => new ApiError(410, 'upload_session_expired', '上传会话已过期，请重新开始');
export const uploadPartRange = (details) => new ApiError(400, 'upload_part_out_of_range', '分片序号超出范围', details);
export const uploadIncomplete = (details) => new ApiError(409, 'upload_incomplete', '分片尚未全部上传完成', details);
export const zipTooLarge = (details) => new ApiError(413, 'zip_too_large', '打包/解压体积超出上限', details);
export const zipTooManyEntries = (details) => new ApiError(400, 'zip_too_many_entries', '条目数量超出上限', details);
export const zipInvalid = (message = '压缩包格式无效或已损坏', details) => new ApiError(400, 'zip_invalid', message, details);
export const zipSlipBlocked = (details) => new ApiError(400, 'zip_slip_blocked', '压缩包内含越界路径，已拒绝解压', details);


// ---- P5 扩展能力 ----
export const appPasswordInvalid = (message = '应用密码无效或已被撤销') =>
  new ApiError(401, 'app_password_invalid', message, {});
export const appPasswordNotFound = () => new ApiError(404, 'app_password_not_found', '应用密码不存在');
export const webdavUnsupported = (details) =>
  new ApiError(405, 'webdav_method_not_allowed', '该 WebDAV 方法暂不支持', details);
export const integrationNotConfigured = (provider, message, details = {}) =>
  new ApiError(503, 'integration_not_configured', message, { provider, ...details });

export function errorBody(err) {
  const code = err.code || 'internal_error';
  const message = err.message || '内部错误';
  return { error: { code, message, details: err.details || {} } };
}
