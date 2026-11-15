// [开发期临时脚手架，勿作为验收门] 该 harness 的 /api 反代会吞掉 POST 请求体，
// 已由 tools/p4ui-verify.mjs（直连真服务）取代；保留仅为历史排查参考。
// 临时自测 harness（8099 前端静态 + 归档 API；uploads/其他 API 由 8097 主服务提供）。
// 仅 P4 前端自测期间运行；不改 server/**。用完由自测脚本结束进程。
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.DB_PATH = path.join(REPO, '.p4ui/r6t5.db');
process.env.STORAGE_ROOT = path.join(REPO, '.p4ui/volume');
process.env.DEV_AUTH = '1';
process.env.ADMIN_PASSWORD = 'test123';

const { migrate } = await import(path.join(REPO, 'server/db.js'));
migrate();
const { requireUser } = await import(path.join(REPO, 'server/middleware/auth.js'));
const archiveRouter = (await import(path.join(REPO, 'server/routes/archive.js'))).default;
const { ApiError, errorBody } = await import(path.join(REPO, 'server/lib/errors.js'));

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(REPO, 'public'), { extensions: ['html'], index: 'index.html' }));

// 归档接口：harness 内直接挂（共享主服务 DB/存储）
app.use('/api/files', requireUser, archiveRouter);

// 其余 /api/** 反向代理到主服务 8097（uploads、files、auth、me 等）
const ARCHIVE_RE = /^\/api\/files\/(zip|zip\/plan|compress|extract)(\/|$)/;
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/files/') && ARCHIVE_RE.test(req.path)) return next();
  const proxy = http.request({ host: '127.0.0.1', port: 8110, path: req.originalUrl, method: req.method,
    headers: req.headers }, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', () => res.status(502).json({ error: { code: 'upstream_error', message: '主服务不可用' } }));
  req.pipe(proxy);
});

app.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json(errorBody(err));
  if (err?.status && err?.code) return res.status(err.status).json(errorBody(new ApiError(err.status, err.code, err.message, err.details)));
  console.error('[harness error]', err);
  res.status(500).json(errorBody(new ApiError(500, 'internal_error', '内部错误')));
});

app.listen(8111, '127.0.0.1', () => console.log('[harness] 前端静态 + 归档 API 已挂 8111'));
