// P4 归档路由：打包下载 / 在线压缩 / 解压 / 打包计划。
// 挂载点：/api/files（需登录，requireUser 由 app.js 统一套）。
// 注意：本路由应挂在 filesRouter 之前，与 previewRouter 同理。
import { Router } from 'express';
import * as archive from '../services/archive.js';
import { badRequest } from '../lib/errors.js';

const router = Router();

function bodyPaths(req) {
  const paths = req.body?.paths;
  if (!Array.isArray(paths)) throw badRequest('invalid_input', 'paths 必须是数组', { field: 'paths' });
  return paths;
}

// 4) 打包计划（预检，不落盘）
router.post('/zip/plan', async (req, res, next) => {
  try {
    res.json(archive.planArchive(req.user, bodyPaths(req)));
  } catch (e) { next(e); }
});

// 1) 打包下载（流式响应）
router.post('/zip', async (req, res, next) => {
  try {
    await archive.streamZipDownload({ user: req.user, paths: bodyPaths(req), req, res });
  } catch (e) { next(e); }
});

// 2) 在线压缩（在指定目录生成 zip）
router.post('/compress', async (req, res, next) => {
  try {
    const { targetPath, name } = req.body || {};
    const result = await archive.compress({ user: req.user, paths: bodyPaths(req), targetPath, name });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

// 3) 解压（防 zip slip）
router.post('/extract', async (req, res, next) => {
  try {
    const { path, targetPath } = req.body || {};
    if (path == null || typeof path !== 'string') {
      throw badRequest('invalid_input', 'path 不能为空', { field: 'path' });
    }
    const result = await archive.extract({ user: req.user, path, targetPath });
    res.status(201).json(result);
  } catch (e) { next(e); }
});

export default router;
