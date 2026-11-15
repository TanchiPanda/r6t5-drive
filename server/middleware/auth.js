import { db } from '../db.js';
import { readUserSession, readAdminSession, setUserCookie } from '../lib/session.js';
import { unauthorized, forbidden, accountBanned } from '../lib/errors.js';
import * as supabase from '../services/supabase.js';
import { getUserByEmail, publicUser } from '../services/nodes.js';
import { resolveGroup } from '../services/quota.js';
import { isVolumeSource } from '../services/user-source.js';

/** 校验用户会话；生产路径走 Supabase 校验 access token，过期用 refresh_token 续签。 */
async function resolveUser(req) {
  const session = readUserSession(req, db);
  if (!session || !session.email) throw unauthorized('未登录');

  // 本地账号会话（local:true）或当前站点已切到 volume 来源时，跳过 Supabase access token 校验。
  const localSession = !!session.local || session.dev || isVolumeSource();
  if (!localSession) {
    let validated = false;
    if (session.accessToken) {
      const res = await supabase.fetchUser(session.accessToken);
      if (res.status === 200) validated = true;
      else if (res.status === 401 || res.status === 403) {
        if (session.refreshToken) {
          const refreshed = await supabase.refreshTokens(session.refreshToken);
          if (refreshed.status === 200 && refreshed.body?.access_token) {
            session.accessToken = refreshed.body.access_token;
            session.refreshToken = refreshed.body.refresh_token || session.refreshToken;
            session.exp = Date.now() + (refreshed.body.expires_in || 3600) * 1000;
            validated = true;
          }
        }
      }
    }
    if (!validated) throw unauthorized('会话已失效，请重新登录');
  }

  const email = String(session.email).toLowerCase();
  const user = getUserByEmail(email);
  if (!user) throw unauthorized('账号不存在');
  // 每次请求都查库校验封禁状态：被封禁立即让既有 session 失效（不依赖会话过期）。
  // 读取以 status 为准，disabled 作为老列兜底；两列保持同步。
  if (user.status === 'banned' || user.disabled === 1) throw accountBanned();
  req.user = user;
  req.sessionPayload = session;
  req.publicUser = publicUser(user, resolveGroup(user));
  return user;
}

export function requireUser(req, res, next) {
  resolveUser(req)
    .then(() => {
      // 续签后重写 cookie
      if (!req.sessionPayload.dev && req.sessionPayload.accessToken) {
        setUserCookie(res, db, req.sessionPayload);
      }
      next();
    })
    .catch(next);
}

/**
 * P7 sudo 用户组判定：
 * 1) 管理密码会话有效 → 通过（via='password'）；
 * 2) 否则读 user 会话 → 查库得 user 与其 group，group.is_sudo === 1 且未被封禁 → 通过
 *    （via='sudo'，req.sudoUser = { email, groupId, groupName }）；
 * 3) 都不是 → 普通登录用户 403，未登录 401。
 * 每次请求都查库：组改 is_sudo 后立即生效，被移出 sudo 组的下一个请求即 403。
 */
export function resolveAdminAccess(req) {
  const admin = readAdminSession(req, db);
  if (admin && admin.admin) return { via: 'password' };

  const session = readUserSession(req, db);
  if (!session || !session.email) return null;

  const email = String(session.email).toLowerCase();
  const user = getUserByEmail(email);
  if (!user) return null;
  if (user.status === 'banned' || user.disabled === 1) return null;

  const group = resolveGroup(user);
  if (group && group.is_sudo === 1) {
    return { via: 'sudo', email, groupId: group.id, groupName: group.name };
  }
  return null;
}

export function requireAdminApi(req, res, next) {
  const access = resolveAdminAccess(req);
  if (access) {
    if (access.via === 'sudo') req.sudoUser = { email: access.email, groupId: access.groupId, groupName: access.groupName };
    return next();
  }
  const user = readUserSession(req, db);
  if (user) return next(forbidden('普通用户无权访问管理接口'));
  return next(unauthorized('未登录管理员'));
}

const ADMIN_403_HTML = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>需要管理员权限 · R6T5 Drive</title>
<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
<link rel="stylesheet" href="/assets/tokens.css">
<link rel="stylesheet" href="/assets/base.css">
</head><body>
<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div class="card" style="max-width:520px;text-align:center">
    <div class="badge danger" style="margin-bottom:14px">403 · 无权限</div>
    <h1 style="font-size:var(--fs-xl);margin-bottom:8px">需要管理员权限</h1>
    <p class="muted" style="font-size:var(--fs-sm);margin-bottom:20px">当前会话不是管理员会话，无法访问管理后台页面。请使用管理密码登录后再访问。</p>
    <div class="row" style="justify-content:center">
      <a class="btn primary" href="/admin/login">前往管理员登录</a>
      <a class="btn ghost" href="/">返回首页</a>
    </div>
  </div>
</div></body></html>`;

export function requireAdminPage(req, res, next) {
  const access = resolveAdminAccess(req);
  if (access) {
    if (access.via === 'sudo') req.sudoUser = { email: access.email, groupId: access.groupId, groupName: access.groupName };
    return next();
  }
  res.status(403).type('text/html; charset=utf-8').send(ADMIN_403_HTML);
}

// ---- 登录失败限流（内存态：5 次 / 10 分钟）----
const failMap = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX_FAIL = 5;

export function loginFails(key) {
  const now = Date.now();
  const rec = failMap.get(key);
  if (!rec || now - rec.at > WINDOW) return 0;
  return rec.count;
}

export function recordLoginFail(key) {
  const now = Date.now();
  const rec = failMap.get(key);
  if (!rec || now - rec.at > WINDOW) failMap.set(key, { count: 1, at: now });
  else rec.count += 1;
}

export function clearLoginFails(key) {
  failMap.delete(key);
}
