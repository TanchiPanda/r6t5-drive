// P5 可选外部集成：配置读取 + 连通性探测 + 状态汇总。
// 配置只从环境变量读，不落库、不进日志、不下发；secret 永不出现在响应里。
// 未配置就是明确的未启用状态，绝不假装成功。

/** aria2 JSON-RPC 配置 */
export function getAria2Config() {
  const rpcUrl = (process.env.ARIA2_RPC || '').trim();
  const secret = process.env.ARIA2_SECRET || '';
  return {
    configured: rpcUrl.length > 0,
    rpcUrl,
    secret,
    // 可选：aria2 侧目录前缀（目录映射用），缺省用逻辑目录名做子目录
    dirMapPrefix: (process.env.ARIA2_DIR_MAP || '').trim(),
  };
}

/** OnlyOffice Document Server 配置 */
export function getOnlyOfficeConfig() {
  const dsUrl = (process.env.OO_DS_URL || '').trim().replace(/\/+$/, '');
  const jwtSecret = process.env.OO_JWT_SECRET || '';
  return {
    configured: dsUrl.length > 0,
    jwtConfigured: jwtSecret.length > 0,
    documentServerUrl: dsUrl || null,
    jwtSecret,
    // 可选：服务端回连本实例取文件 / 收回调的内部基址；缺省走 127.0.0.1:<PORT>
    internalBase: (process.env.OO_INTERNAL_BASE || '').trim().replace(/\/+$/, ''),
  };
}

/**
 * 探测 aria2 连通性。仅在 configured 时调用；探测失败不抛 500，
 * 返回 reachable:false + 中文 message。
 * @param {import('./aria2.js').Aria2Client} [client] 可注入客户端（便于自测）
 */
export async function probeAria2(client) {
  const cfg = getAria2Config();
  if (!cfg.configured) {
    return { configured: false, reachable: null, version: null, message: '未配置 ARIA2_RPC，离线下载未启用' };
  }
  let c = client;
  if (!c) {
    const { createAria2Client } = await import('./aria2.js');
    c = createAria2Client(cfg);
  }
  try {
    const version = await c.getVersion({ timeoutMs: 2000 });
    return {
      configured: true,
      reachable: true,
      version: version || null,
      message: 'aria2 连接正常',
    };
  } catch (e) {
    return {
      configured: true,
      reachable: false,
      version: null,
      message: `aria2 不可达：${e?.message || '连接失败'}`,
    };
  }
}

/** OnlyOffice 状态汇总（不发起网络探测；DS 地址本身可回传） */
export function onlyOfficeStatus() {
  const cfg = getOnlyOfficeConfig();
  if (!cfg.configured) {
    return {
      configured: false,
      jwtConfigured: false,
      documentServerUrl: null,
      message: '未配置 OO_DS_URL，OnlyOffice 在线编辑未启用',
    };
  }
  if (!cfg.jwtConfigured) {
    return {
      configured: true,
      jwtConfigured: false,
      documentServerUrl: cfg.documentServerUrl,
      message: '已配置 OO_DS_URL 但缺少 OO_JWT_SECRET，出于安全未启用编辑器',
    };
  }
  return {
    configured: true,
    jwtConfigured: true,
    documentServerUrl: cfg.documentServerUrl,
    message: 'OnlyOffice 已配置（只读预览模式）',
  };
}

/** GET /api/integrations/status 汇总 */
export async function summarizeStatus() {
  const aria2 = await probeAria2();
  return { aria2, onlyoffice: onlyOfficeStatus() };
}
