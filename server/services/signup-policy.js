// P8-B 注册策略：邮箱域名白/黑名单 + 子地址（+）开关。
// 统一在 volume 自助注册、supabase 自助注册、管理员建号三个入口调用。
import { getSetting } from '../db.js';

/** 解析逗号 / 换行分隔的域名列表，去空白、去重、转小写。 */
export function parseDomainList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 单条规则匹配：
 *  - 精确：`example.com` 只匹配 `example.com`
 *  - 通配：`*.example.com` 匹配 `example.com` 及其任意一级子域 `a.example.com`
 */
export function domainMatches(rule, domain) {
  if (!rule || !domain) return false;
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return domain === base || domain.endsWith(`.${base}`);
  }
  return rule === domain;
}

function splitEmail(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at <= 0 || at === String(email).length - 1) return null;
  return { local: String(email).slice(0, at), domain: String(email).slice(at + 1).toLowerCase() };
}

/** 读取当前策略原始配置（供管理接口 / 安全配置回显）。 */
export function policySettings() {
  return {
    allowDomains: parseDomainList(getSetting('signup.allowDomains', '')),
    denyDomains: parseDomainList(getSetting('signup.denyDomains', '')),
    forbidSubAddress: getSetting('signup.forbidSubAddress', 'false') === 'true',
  };
}

/**
 * 校验邮箱是否允许注册。
 * @returns {{ok:true} | {ok:false, code:string, message:string}}
 */
export function checkEmailAllowed(email) {
  const parts = splitEmail(email);
  if (!parts) {
    return { ok: false, code: 'invalid_input', message: '邮箱格式不正确' };
  }
  const { local, domain } = parts;
  const { allowDomains, denyDomains, forbidSubAddress } = policySettings();

  // 子地址（+）开关：只看本地部分是否含 '+'
  if (forbidSubAddress && local.includes('+')) {
    return { ok: false, code: 'signup_subaddress_forbidden', message: '不允许使用带 + 子地址的邮箱' };
  }

  // 黑名单优先于白名单
  if (denyDomains.some((rule) => domainMatches(rule, domain))) {
    return { ok: false, code: 'signup_domain_blocked', message: '该邮箱域名已被封禁' };
  }

  // 白名单非空时，只允许命中其中一条
  if (allowDomains.length > 0) {
    const hit = allowDomains.some((rule) => domainMatches(rule, domain));
    if (!hit) {
      return { ok: false, code: 'signup_domain_not_allowed', message: '该邮箱域名不在允许列表内' };
    }
  }

  return { ok: true };
}
