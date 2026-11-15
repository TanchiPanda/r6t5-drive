import express from 'express';
import path from 'node:path';
import { ENV } from './config.js';
import { db } from './db.js';
import { readUserSession, readAdminSession } from './lib/session.js';
import { ApiError, errorBody } from './lib/errors.js';
import { requireAdminApi, requireAdminPage, requireUser, resolveAdminAccess } from './middleware/auth.js';

import setupRouter, { adminSetupRouter } from './routes/setup.js';
import authRouter, { meRouter } from './routes/auth.js';
import adminAuthRouter from './routes/admin-auth.js';
import adminSupabaseRouter from './routes/admin-supabase.js';
import adminOverviewRouter from './routes/admin-overview.js';
import adminGroupsRouter from './routes/admin-groups.js';
import adminStorageRouter from './routes/admin-storage.js';
import adminBindingsRouter from './routes/admin-bindings.js';
import adminUsersRouter from './routes/admin-users.js';
import adminUserSourceRouter from './routes/admin-user-source.js';
import adminUpdateRouter from './routes/admin-update.js';
import adminSettingsRouter from './routes/admin-settings.js';
import adminAuditRouter from './routes/admin-audit.js';
import adminTrashRouter from './routes/admin-trash.js';
import filesRouter from './routes/files.js';
import trashRouter from './routes/trash.js';
import accountRouter from './routes/account.js';
import sharesRouter, { publicRouter as sharePublicRouter } from './routes/shares.js';
import adminSharesRouter from './routes/admin-shares.js';
import previewRouter from './routes/preview.js';
import uploadsRouter from './routes/uploads.js';
import archiveRouter from './routes/archive.js';
import mediaRouter from './routes/media.js';
import davRouter from './routes/dav.js';
import appPasswordsRouter from './routes/apppasswords.js';
import officeRouter, { officePublicRouter } from './routes/office.js';
import downloadsRouter from './routes/downloads.js';
import integrationsRouter from './routes/integrations.js';
import adminBrandingRouter from './routes/admin-branding.js';
import adminMailRouter from './routes/admin-mail.js';
import adminSecurityRouter from './routes/admin-security.js';
import authConfirmRouter from './routes/auth-confirm.js';
import authOauthRouter from './routes/auth-oauth.js';
import { brandingApiRouter, brandingAssetRouter, manifestHandler } from './routes/branding-public.js';

const app = express();

// WebDAV 必须在 JSON 解析之前：PUT 请求体是原始二进制，不能被 express.json 吃掉
app.use('/dav', davRouter);

app.use(express.json({ limit: '2mb' }));

// ---- 公开 / 自助接口 ----
app.use('/api/setup', setupRouter);
app.use('/api/auth', authRouter);
app.use('/api/auth/confirm', authConfirmRouter);
app.use('/api/auth/oauth', authOauthRouter);
app.use('/api/me', meRouter);
// 用户端分享（需登录）与公开访问（免登录）分开挂载
app.use('/api/shares', requireUser, sharesRouter);
app.use('/api/share', sharePublicRouter);

// ---- 管理员认证（登录/登出/会话本身不套 admin 守卫）----
app.use('/api/admin', adminAuthRouter);

// ---- 其余管理接口：普通用户 403 JSON，未登录 401 ----
const adminApi = express.Router();
adminApi.use(requireAdminApi);
adminApi.use('/setup', adminSetupRouter);
adminApi.use('/supabase', adminSupabaseRouter);
adminApi.use('/overview', adminOverviewRouter);
adminApi.use('/groups', adminGroupsRouter);
adminApi.use('/storage', adminStorageRouter);
adminApi.use('/bindings', adminBindingsRouter);
adminApi.use('/users', adminUsersRouter);
adminApi.use('/user-source', adminUserSourceRouter);
adminApi.use('/update-status', adminUpdateRouter);
adminApi.use('/settings', adminSettingsRouter);
adminApi.use('/audit', adminAuditRouter);
adminApi.use('/trash', adminTrashRouter);
adminApi.use('/shares', adminSharesRouter);
adminApi.use('/branding', adminBrandingRouter);
adminApi.use('/mail', adminMailRouter);
adminApi.use('/security', adminSecurityRouter);
app.use('/api/admin', adminApi);

// 品牌外观：公开配置（登录页免登录读取）与品牌静态文件 / manifest
app.use('/api/branding', brandingApiRouter);
app.use('/branding', brandingAssetRouter);
app.get('/manifest.webmanifest', manifestHandler);

// ---- 用户端文件 / 回收站 / 账号 ----
// 预览必须挂在 /api/files 之前，否则会被 filesRouter 的根路由吃掉
app.use('/api/files/preview', requireUser, previewRouter);
// Office 免登录 HMAC 回源/回调必须挂在登录守卫之前
app.use('/api/files', officePublicRouter);
app.use('/api/files', requireUser, officeRouter);
app.use('/api/files/info', requireUser, mediaRouter);
// 打包/压缩/解压：同样要挂在 filesRouter 之前，避免 /zip、/compress、/extract 落到根路由
app.use('/api/files', requireUser, archiveRouter);
app.use('/api/files', requireUser, filesRouter);
app.use('/api/uploads', requireUser, uploadsRouter);
app.use('/api/downloads', requireUser, downloadsRouter);
app.use('/api/integrations', requireUser, integrationsRouter);
app.use('/api/trash', requireUser, trashRouter);
app.use('/api/account/app-passwords', requireUser, appPasswordsRouter);
app.use('/api/account', requireUser, accountRouter);

// ---- 页面守卫 ----
function userPageGuard(req, res, next) {
  const session = readUserSession(req, db);
  if (session && session.email) return next();
  res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

// /admin 页面：除 /admin/login 与根路径外均需管理员会话，否则 403 HTML
app.use('/admin', (req, res, next) => {
  if (['/login', '/login.html', '/', ''].includes(req.path)) return next();
  return requireAdminPage(req, res, next);
});

app.get(['/admin', '/admin/'], (req, res) => {
  const admin = readAdminSession(req, db);
  const hasAdmin = (admin && admin.admin) || !!resolveAdminAccess(req);
  res.redirect(hasAdmin ? '/admin/home.html' : '/admin/login');
});

app.get('/files', userPageGuard, (req, res, next) => {
  res.sendFile(path.join(ENV.PUBLIC_DIR, 'files.html'), err => (err ? next() : undefined));
});
app.get('/account', userPageGuard, (req, res, next) => {
  res.sendFile(path.join(ENV.PUBLIC_DIR, 'account.html'), err => (err ? next() : undefined));
});

// 分享页：/share/:token 一律落到同一张骨架页，token 由前端从路径解析
app.get(['/share', '/share/:token', '/s', '/s/:token'], (req, res, next) => {
  res.sendFile(path.join(ENV.PUBLIC_DIR, 'share.html'), err => (err ? next() : undefined));
});

// 页面短链（无扩展名）显式映射，避免依赖静态中间件的行为
// 介绍页：仓库根目录的 index.html（GitHub Pages 与容器内共用同一份）
app.get(['/', '/index.html'], (req, res, next) => {
  res.sendFile(path.join(ENV.ROOT, 'index.html'), err => (err ? next() : undefined));
});

// 页面短链（无扩展名）显式映射，避免依赖静态中间件的行为
const PAGES = {
  '/login': 'login.html',
  '/admin/login': 'admin/login.html',
};
for (const [route, file] of Object.entries(PAGES)) {
  app.get(route, (req, res, next) => {
    res.sendFile(path.join(ENV.PUBLIC_DIR, file), err => (err ? next() : undefined));
  });
}

// ---- 静态资源（public 为空时缺文件返回 404，不 crash）----
app.use(express.static(ENV.PUBLIC_DIR, { extensions: ['html'], index: 'index.html' }));

// ---- 404 ----
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json(errorBody(new ApiError(404, 'not_found', '接口不存在')));
  }
  res.status(404).type('text/html; charset=utf-8').send('<h1>404</h1><p>页面不存在</p>');
});

// ---- 错误处理 ----
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json(errorBody(err));
  }
  if (err?.status && err?.code) {
    return res.status(err.status).json(errorBody(new ApiError(err.status, err.code, err.message, err.details)));
  }
  console.error('[error]', err);
  res.status(500).json(errorBody(new ApiError(500, 'internal_error', '内部错误')));
});

export default app;
